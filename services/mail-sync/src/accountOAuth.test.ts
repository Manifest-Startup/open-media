import assert from 'node:assert/strict';
import test from 'node:test';

import type { GrantType } from '@cloudflare/workers-oauth-provider';

import { AccountGrantProps, accountMcpRequest, accountTokenExchange, handleAccountAuthorization, isAccountGrant, wantsAccount } from './accountOAuth.js';

const signIn = { SUPABASE_URL: 'https://db.test', SUPABASE_PUBLISHABLE_KEY: 'publishable' };
const grant: AccountGrantProps = { kind: 'account', userId: 'u1', email: 'ana@example.test', accessToken: 'old-access', refreshToken: 'old-refresh', expiresAt: Date.now() + 3_600_000, scopes: ['account'] };

test('account connections are told apart from the Events owner flow', () => {
  assert.equal(wantsAccount({ scope: ['account'], resource: undefined }), true);
  assert.equal(wantsAccount({ scope: [], resource: 'https://api.openmedia.site/account/mcp' }), true);
  assert.equal(wantsAccount({ scope: [], resource: ['https://api.openmedia.site/account/mcp/'] }), true);
  assert.equal(wantsAccount({ scope: ['events:read'], resource: 'https://api.openmedia.site/mcp' }), false);
  assert.equal(wantsAccount({ scope: [], resource: undefined }), false, 'a request naming nothing stays on the Events flow');
  assert.equal(isAccountGrant(grant), true);
  assert.equal(isAccountGrant({ userId: 'owner', scopes: ['events:read'] }), false, 'an Events grant is never an account grant');
});

test('a refresh renews the person’s session, rotating its refresh token, and the host token never outlives it', async () => {
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(`${String(input)} ${String(init?.body)}`);
    return Response.json({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600, token_type: 'bearer', user: { id: 'u1', email: 'ana@example.test' } });
  }) as typeof fetch;
  const result = await accountTokenExchange({ grantType: 'refresh_token' as GrantType, clientId: 'c', userId: 'u1', grantId: 'g', scope: ['account'], requestedScope: ['account'], props: grant }, signIn, fetchImpl);
  assert.ok(calls[0].includes('/auth/v1/token?grant_type=refresh_token') && calls[0].includes('old-refresh'));
  const next = result!.newProps as AccountGrantProps;
  assert.equal(next.accessToken, 'new-access');
  assert.equal(next.refreshToken, 'new-refresh');
  assert.ok(result!.accessTokenTTL! <= 3600 - 120 && result!.accessTokenTTL! >= 60);
  // The first exchange keeps the session it was given, with a matching lifetime.
  const first = await accountTokenExchange({ grantType: 'authorization_code' as GrantType, clientId: 'c', userId: 'u1', grantId: 'g', scope: ['account'], requestedScope: ['account'], props: grant }, signIn, fetchImpl);
  assert.equal(first!.newProps, undefined);
  assert.equal(calls.length, 1);
  // Events grants are left to the provider.
  assert.equal(await accountTokenExchange({ grantType: 'refresh_token' as GrantType, clientId: 'c', userId: 'owner', grantId: 'g', scope: ['events:read'], requestedScope: [], props: { userId: 'owner', scopes: ['events:read'] } }, signIn, fetchImpl), undefined);
});

test('the account server is reached as the person, with their own session and nothing from the host', async () => {
  const forwarded = accountMcpRequest(new Request('https://api.openmedia.site/account/mcp', { method: 'POST', headers: { authorization: 'Bearer host-token', 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0"}' }), grant);
  assert.equal(new URL(forwarded.url).pathname, '/me/mcp');
  assert.equal(forwarded.headers.get('authorization'), 'Bearer old-access');
  assert.equal(await forwarded.text(), '{"jsonrpc":"2.0"}');
});

const kvStore = () => {
  const kv = new Map<string, string>();
  return { kv, binding: { get: async (key: string) => kv.get(key) ?? null, put: async (key: string, value: string) => { kv.set(key, value); }, delete: async (key: string) => { kv.delete(key); } } as unknown as KVNamespace };
};
const gateway = 'https://openmedia.site/signin';
const jwt = (claims: Record<string, unknown>) => `e30.${btoa(JSON.stringify(claims)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')}.sig`;

test('the session post refuses forged posts and expired or missing challenges', async () => {
  const { binding } = kvStore();
  const env = { ...signIn, OAUTH_KV: binding, OAUTH_PROVIDER: {} as never, SIGN_IN_GATEWAY_URL: gateway };
  const post = (body: string, headers: Record<string, string> = {}) => handleAccountAuthorization(new Request('https://api.openmedia.site/authorize/account/session', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body }), env);
  assert.equal((await post('challenge=x', { origin: 'https://evil.test' }))!.status, 403, 'another site cannot post the form');
  const id = 'a'.repeat(64);
  assert.equal((await post(`challenge=${id}&access_token=a.b.c&refresh_token=rrrrrrrrrr`, { cookie: `om_account_oauth=${'b'.repeat(64)}`, origin: 'https://openmedia.site' }))!.status, 400, 'the challenge must match the browser that started it');
  assert.equal((await post(`challenge=${id}&access_token=a.b.c&refresh_token=rrrrrrrrrr`, { cookie: `om_account_oauth=${id}` }))!.status, 400, 'an unknown challenge has expired');
  assert.equal(await handleAccountAuthorization(new Request('https://api.openmedia.site/somewhere-else', { method: 'POST' }), env), undefined);
  // The old Worker forms are gone: the gateway does the signing in.
  assert.equal(await handleAccountAuthorization(new Request('https://api.openmedia.site/authorize/account/email', { method: 'POST', body: 'challenge=x' }), env), undefined);
  assert.equal(await handleAccountAuthorization(new Request('https://api.openmedia.site/authorize/account/complete', { method: 'POST', body: 'challenge=x' }), env), undefined);
});

test('a web app identified by a Client ID Metadata Document is sent to the sign-in gateway (Manifest, ADR 0041/0042)', async () => {
  const { kv, binding } = kvStore();
  const clientId = 'https://manifeststartup.com/oauth/open-media-client.json';
  const redirectUri = 'https://manifeststartup.com/api/integrations/open-media/callback';
  const looked: string[] = [];
  // The provider resolves the document (its own CIMD support) and checks the redirect URI against it.
  const provider = {
    parseAuthRequest: async () => ({ responseType: 'code', clientId, redirectUri, scope: ['account'], state: 's', codeChallenge: 'c', codeChallengeMethod: 'S256' }),
    lookupClient: async (id: string) => { looked.push(id); return { clientId: id, clientName: 'Manifest', logoUri: 'https://manifeststartup.com/icon.png', redirectUris: [redirectUri], tokenEndpointAuthMethod: 'none' }; },
  };
  const env = { ...signIn, OAUTH_KV: binding, OAUTH_PROVIDER: provider as never, SIGN_IN_GATEWAY_URL: gateway };
  const response = (await handleAccountAuthorization(new Request(`https://api.openmedia.site/authorize?client_id=${encodeURIComponent(clientId)}&scope=account&login_hint=${encodeURIComponent('Ana@Example.test')}`), env))!;
  assert.equal(response.status, 302);
  assert.deepEqual(looked, [clientId]);
  const id = /om_account_oauth=([0-9a-f]{64}); Path=\/authorize;.*HttpOnly; Secure; SameSite=Lax/.exec(response.headers.get('set-cookie') ?? '')![1];
  assert.equal(response.headers.get('location'), `${gateway}?request=${id}`, 'the gateway gets the challenge, nothing else');
  const [challenge] = [...kv.values()].map((value) => JSON.parse(value) as { oauthRequest: { scope: string[]; redirectUri: string }; redirectHost: string });
  assert.deepEqual(challenge.oauthRequest.scope, ['account'], 'the grant is for the account, nothing else');
  assert.equal(challenge.redirectHost, 'manifeststartup.com');

  // What the gateway shows: the app's public name and icon, and the pre-filled email.
  const info = (await handleAccountAuthorization(new Request(`https://api.openmedia.site/authorize/account/request?challenge=${id}`), env))!;
  assert.equal(info.headers.get('access-control-allow-origin'), 'https://openmedia.site');
  assert.deepEqual(await info.json(), { client_name: 'Manifest', logo_uri: 'https://manifeststartup.com/icon.png', client_uri: null, redirect_host: 'manifeststartup.com', login_hint: 'ana@example.test' });
  assert.equal((await handleAccountAuthorization(new Request(`https://api.openmedia.site/authorize/account/request?challenge=${'0'.repeat(64)}`), env))!.status, 404);
});

test('one tap and the gateway post: the email’s button and the session finish the connection in the same browser', async () => {
  const { kv, binding } = kvStore();
  const clientId = 'https://manifeststartup.com/oauth/open-media-client.json';
  const redirectUri = 'https://manifeststartup.com/api/integrations/open-media/callback';
  const completed: Array<{ userId: string; props: AccountGrantProps; metadata: unknown }> = [];
  const provider = {
    parseAuthRequest: async () => ({ responseType: 'code', clientId, redirectUri, scope: ['account'], state: 's', codeChallenge: 'c', codeChallengeMethod: 'S256' }),
    lookupClient: async (id: string) => ({ clientId: id, clientName: 'Manifest', redirectUris: [redirectUri], tokenEndpointAuthMethod: 'none' }),
    completeAuthorization: async (options: { userId: string; props: AccountGrantProps; metadata: unknown }) => { completed.push(options); return { redirectTo: `${redirectUri}?code=abc&state=s` }; },
  };
  const env = { ...signIn, OAUTH_KV: binding, OAUTH_PROVIDER: provider as never, SIGN_IN_GATEWAY_URL: gateway };
  const start = (await handleAccountAuthorization(new Request('https://api.openmedia.site/authorize?client_id=x&scope=account'), env))!;
  const id = /om_account_oauth=([0-9a-f]{64})/.exec(start.headers.get('set-cookie') ?? '')![1];
  const cookie = `om_account_oauth=${id}`;

  // The email's button: only in the browser that started, and it hands the token hash to the gateway.
  const link = (headers: Record<string, string>) => handleAccountAuthorization(new Request(`https://api.openmedia.site/authorize/account/link?challenge=${id}&token_hash=abcdefghijklmnopqrst&type=magiclink`, { headers }), env);
  assert.equal((await link({}))!.status, 400, 'another browser cannot finish this connection');
  const landed = (await link({ cookie }))!;
  assert.equal(landed.status, 302);
  assert.equal(landed.headers.get('location'), `${gateway}?request=${id}&token_hash=abcdefghijklmnopqrst&type=magiclink`);
  assert.equal(completed.length, 0, 'opening the link never completes anything by itself');

  const calls: string[] = [];
  let meets = true;
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input); calls.push(url);
    if (url.endsWith('/auth/v1/user')) return Response.json({ id: 'u9', email: 'ana@example.test' });
    if (url.endsWith('/rpc/open_media_session_meets_mfa')) return meets ? Response.json(true) : new Response('{}', { status: 403 });
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  const post = (fields: Record<string, string>, token: string) => handleAccountAuthorization(new Request('https://api.openmedia.site/authorize/account/session', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://openmedia.site', cookie }, body: new URLSearchParams({ challenge: id, access_token: token, refresh_token: 'refresh-123456', ...fields }).toString() }), env, fetchImpl);

  meets = false;
  const owesStep = (await post({}, jwt({ sub: 'u9', exp: 2_000_000_000, aal: 'aal1', s: 1 })))!;
  assert.equal(owesStep.status, 400, 'a session that still owes its second step is refused');
  assert.ok((await owesStep.text()).includes('second step'));
  assert.equal(completed.length, 0);

  meets = true;
  const done = (await post({}, jwt({ sub: 'u9', exp: 2_000_000_000, aal: 'aal2', s: 2 })))!;
  assert.equal(done.status, 302);
  assert.equal(done.headers.get('location'), `${redirectUri}?code=abc&state=s`);
  assert.ok(done.headers.get('set-cookie')!.includes('Max-Age=0'), 'the challenge cookie is cleared');
  assert.ok(calls.some((url) => url === 'https://db.test/auth/v1/user'), 'Supabase vouches for the session');
  assert.equal(completed[0].userId, 'u9');
  assert.equal(completed[0].props.refreshToken, 'refresh-123456');
  assert.equal(completed[0].props.expiresAt, 2_000_000_000_000, 'the grant knows when the session expires');
  assert.equal([...kv.keys()].filter((key) => key.startsWith('account-challenge:')).length, 0, 'the challenge is gone');
  assert.equal((await post({}, jwt({ sub: 'u9', exp: 2_000_000_000, s: 3 })))!.status, 400, 'and cannot be used twice');
});

test('a changed Client ID Metadata Document is read again when a request no longer matches the cached copy', async () => {
  const clientId = 'https://manifeststartup.com/oauth/open-media-client.json';
  const deleted: string[] = [];
  const cacheStorage = { open: async (name: string) => { assert.equal(name, 'workers-oauth-provider:cimd:v1'); return { delete: async (key: string) => { deleted.push(key); return true; } }; } };
  const { forgetClientMetadata } = await import('./accountOAuth.js');
  assert.equal(await forgetClientMetadata(clientId, cacheStorage), true);
  assert.deepEqual(deleted, [clientId]);
  assert.equal(await forgetClientMetadata('dynamic-client-id', cacheStorage), false, 'registered clients are not documents');
  assert.equal(await forgetClientMetadata('http://manifeststartup.com/x.json', cacheStorage), false);

  // /authorize: the first parse fails on the stale copy, the second (after eviction) succeeds.
  let parses = 0;
  const { binding } = kvStore();
  const redirectUri = 'https://manifeststartup.com/api/auth/open-media/callback';
  const provider = {
    parseAuthRequest: async () => { parses += 1; if (parses === 1) throw new Error('Invalid redirect URI'); return { responseType: 'code', clientId, redirectUri, scope: ['account'], state: 's', codeChallenge: 'c', codeChallengeMethod: 'S256' }; },
    lookupClient: async () => ({ clientId, clientName: 'Manifest', redirectUris: [redirectUri], tokenEndpointAuthMethod: 'none' }),
  };
  const realCaches = (globalThis as { caches?: unknown }).caches;
  (globalThis as { caches?: unknown }).caches = cacheStorage;
  try {
    const response = (await handleAccountAuthorization(new Request(`https://api.openmedia.site/authorize?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=account`), { ...signIn, OAUTH_KV: binding, OAUTH_PROVIDER: provider as never, SIGN_IN_GATEWAY_URL: gateway }))!;
    assert.equal(response.status, 302);
    assert.equal(parses, 2);
  } finally {
    (globalThis as { caches?: unknown }).caches = realCaches;
  }
});
