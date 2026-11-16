import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { browserLogin, currentAccess, readStore, registeredRedirectUri } from './auth';
import { capture, fakeOpenMedia, sampleAccountTools, sampleTools, tempDirs } from './testing';

const origin = 'https://api.test';

/** A fake OAuth 2.1 server shaped like the Worker's (workers-oauth-provider + the account gateway). */
function fakeProvider() {
  const state = { registrations: [] as Record<string, unknown>[], codes: new Map<string, { challenge: string; redirect: string; clientId: string }>(), refreshes: 0, revoked: [] as string[], authorizeUrls: [] as URL[] };
  const realFetch = globalThis.fetch;
  const mcp = fakeOpenMedia({ publicTools: sampleTools, accountTools: sampleAccountTools });
  const fetchImpl = (async (input: URL | string, init: RequestInit = {}) => {
    const url = new URL(String(input));
    if (url.origin !== origin) return realFetch(input, init);
    const form = () => new URLSearchParams(String(init.body));
    switch (url.pathname) {
      case '/.well-known/oauth-authorization-server':
        return Response.json({ issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/oauth/token`, registration_endpoint: `${origin}/oauth/register`, revocation_endpoint: `${origin}/oauth/token`, code_challenge_methods_supported: ['S256'] });
      case '/oauth/register': {
        const body = JSON.parse(String(init.body));
        state.registrations.push(body);
        return Response.json({ client_id: `client-${state.registrations.length}`, ...body }, { status: 201 });
      }
      case '/oauth/token': {
        const params = form();
        if (params.get('token')) { state.revoked.push(params.get('token')!); return new Response('', { status: 200 }); }
        if (params.get('grant_type') === 'authorization_code') {
          const saved = state.codes.get(params.get('code')!);
          const challenge = createHash('sha256').update(params.get('code_verifier') ?? '').digest('base64url');
          if (!saved || saved.challenge !== challenge || saved.redirect !== params.get('redirect_uri') || saved.clientId !== params.get('client_id')) return Response.json({ error: 'invalid_grant' }, { status: 400 });
          return Response.json({ access_token: 'oauth-access-1', token_type: 'bearer', expires_in: 3600, refresh_token: 'oauth-refresh-1', scope: 'account' });
        }
        if (params.get('grant_type') === 'refresh_token') {
          state.refreshes += 1;
          if (params.get('refresh_token') === 'revoked') return Response.json({ error: 'invalid_grant' }, { status: 400 });
          return Response.json({ access_token: `oauth-access-r${state.refreshes}`, token_type: 'bearer', expires_in: 3600, refresh_token: `oauth-refresh-r${state.refreshes}`, scope: 'account' });
        }
        return Response.json({ error: 'unsupported_grant_type' }, { status: 400 });
      }
      case '/v1/connected/me': return Response.json({ handle: 'ada' });
      default: return mcp.fetch(input, init);
    }
  }) as typeof fetch;
  /** Stands in for the browser and the sign-in gateway: approve, then follow the redirect to the loopback. */
  const browser = (outcome: 'approve' | 'deny' | 'wrong-state' = 'approve') => async (link: string) => {
    const url = new URL(link);
    state.authorizeUrls.push(url);
    const redirect = url.searchParams.get('redirect_uri')!;
    const back = new URL(redirect);
    if (outcome === 'deny') { back.searchParams.set('error', 'access_denied'); back.searchParams.set('state', url.searchParams.get('state')!); }
    else {
      const code = `code-${state.codes.size + 1}`;
      state.codes.set(code, { challenge: url.searchParams.get('code_challenge')!, redirect, clientId: url.searchParams.get('client_id')! });
      back.searchParams.set('code', code);
      back.searchParams.set('state', outcome === 'wrong-state' ? 'forged' : url.searchParams.get('state')!);
      back.searchParams.set('iss', origin);
    }
    const page = await realFetch(back);
    assert.equal(page.headers.get('content-type'), 'text/html; charset=utf-8');
    if (outcome === 'wrong-state') {
      assert.equal(page.status, 400);
      // The real browser would stop here; finish the attempt with the right state so the test ends.
      back.searchParams.set('state', url.searchParams.get('state')!);
      back.searchParams.delete('code');
      back.searchParams.set('error', 'access_denied');
      await realFetch(back);
    }
  };
  return { state, fetch: fetchImpl, browser, mcp };
}

test('browser login: registers once as a public client, PKCE S256, a random loopback port, scope account', async () => {
  const provider = fakeProvider();
  const env = tempDirs();
  const credential = await browserLogin({ baseUrl: origin, env, fetch: provider.fetch, openBrowser: provider.browser(), log: () => undefined });
  assert.equal(credential.access_token, 'oauth-access-1');
  const [registration] = provider.state.registrations;
  assert.equal(registration.client_name, 'Open Media CLI');
  assert.equal(registration.token_endpoint_auth_method, 'none');
  assert.deepEqual(registration.redirect_uris, [registeredRedirectUri]);
  const authorize = provider.state.authorizeUrls[0];
  assert.equal(authorize.pathname, '/authorize');
  assert.equal(authorize.searchParams.get('scope'), 'account');
  assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
  assert.match(authorize.searchParams.get('redirect_uri')!, /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  assert.notEqual(new URL(authorize.searchParams.get('redirect_uri')!).port, '');

  const file = join(env.OPEN_MEDIA_CONFIG_DIR, 'credentials.json');
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(env.OPEN_MEDIA_CONFIG_DIR).mode & 0o777, 0o700);
  const store = readStore(env);
  assert.equal(store.servers[origin].kind, 'oauth');
  assert.equal(store.clients[origin].client_id, 'client-1');

  // A second login reuses the registered client.
  await browserLogin({ baseUrl: origin, env, fetch: provider.fetch, openBrowser: provider.browser(), log: () => undefined });
  assert.equal(provider.state.registrations.length, 1);
  assert.equal(provider.state.authorizeUrls[1].searchParams.get('client_id'), 'client-1');
  assert.notEqual(provider.state.authorizeUrls[1].searchParams.get('state'), authorize.searchParams.get('state'));
});

test('browser login fails cleanly when the person says no, or the redirect is forged', async () => {
  const provider = fakeProvider();
  await assert.rejects(browserLogin({ baseUrl: origin, env: tempDirs(), fetch: provider.fetch, openBrowser: provider.browser('deny'), log: () => undefined }), /access_denied/);
  await assert.rejects(browserLogin({ baseUrl: origin, env: tempDirs(), fetch: provider.fetch, openBrowser: provider.browser('wrong-state'), log: () => undefined }), /access_denied/);
  await assert.rejects(browserLogin({ baseUrl: origin, env: tempDirs(), fetch: provider.fetch, openBrowser: () => undefined, log: () => undefined, timeoutMs: 50 }), /Timed out/);
});

test('the OAuth token renews itself, and a revoked grant is forgotten', async () => {
  const provider = fakeProvider();
  const env = tempDirs();
  await browserLogin({ baseUrl: origin, env, fetch: provider.fetch, openBrowser: provider.browser(), log: () => undefined });
  assert.equal((await currentAccess(env, origin, { fetch: provider.fetch }))!.token, 'oauth-access-1');
  const later = () => Date.now() + 2 * 3600 * 1000;
  const renewed = await currentAccess(env, origin, { fetch: provider.fetch, now: later });
  assert.deepEqual(renewed, { token: 'oauth-access-r1', kind: 'oauth' });
  assert.equal(readStore(env).servers[origin].refresh_token, 'oauth-refresh-r1', 'the rotated refresh token is kept');
  const store = readStore(env);
  (store.servers[origin] as { refresh_token: string }).refresh_token = 'revoked';
  writeFileSync(join(env.OPEN_MEDIA_CONFIG_DIR, 'credentials.json'), JSON.stringify({ ...store, servers: { [origin]: { ...store.servers[origin], expires_at: 0 } } }));
  assert.equal(await currentAccess(env, origin, { fetch: provider.fetch }), undefined);
  assert.equal(readStore(env).servers[origin], undefined);
  assert.equal(readStore(env).clients[origin].client_id, 'client-1', 'the registration survives');
});

test('`login` signs in through the browser; account tools then use /account/mcp; `logout` revokes the grant', async () => {
  const provider = fakeProvider();
  const env = { ...tempDirs(), OPEN_MEDIA_BASE_URL: origin };
  const login = await capture(['login'], env, provider.fetch, { openBrowser: provider.browser() });
  assert.equal(login.code, 0, login.err);
  assert.match(login.out, /Signed in as @ada/);
  assert.match(login.err, /http:\/\/127\.0\.0\.1:\d+\/callback|Opening your browser/);

  const me = await capture(['get-me', '--json'], env, provider.fetch);
  assert.equal(me.code, 0, me.err);
  const call = provider.mcp.calls.find((item) => item.rpc?.method === 'tools/call')!;
  assert.equal(call.url, '/account/mcp');
  assert.equal(call.auth, 'Bearer oauth-access-1');

  const out = await capture(['logout'], env, provider.fetch);
  assert.match(out.out, /access was revoked/);
  assert.deepEqual(provider.state.revoked, ['oauth-refresh-1']);
  assert.equal(readStore(env).servers[origin], undefined);
  assert.equal((await capture(['token'], env, provider.fetch)).code, 2);
  assert.equal((await capture(['login', '--no-browser'], env, provider.fetch)).code, 2, 'without a browser it asks for an email');
});

test('a 0.1 session.json still signs you in, and moves to credentials.json', async () => {
  const env = { ...tempDirs(), OPEN_MEDIA_BASE_URL: origin };
  mkdirSync(env.OPEN_MEDIA_CONFIG_DIR, { recursive: true });
  writeFileSync(join(env.OPEN_MEDIA_CONFIG_DIR, 'session.json'), JSON.stringify({ access_token: 'old', refresh_token: 'r', expires_in: 3600, token_type: 'Bearer', user: { id: 'u' }, expires_at: Math.floor(Date.now() / 1000) + 3600, base_url: origin }));
  const token = await capture(['token'], env);
  assert.equal(token.out, 'old');
  assert.equal(readFileSync(join(env.OPEN_MEDIA_CONFIG_DIR, 'session.json'), 'utf8').includes('old'), true, 'reading alone changes nothing');
});
