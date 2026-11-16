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

test('the sign-in pages refuse forged posts and expired or missing challenges', async () => {
  const kv = new Map<string, string>();
  const env = { ...signIn, OAUTH_KV: { get: async (key: string) => kv.get(key) ?? null, put: async (key: string, value: string) => { kv.set(key, value); }, delete: async (key: string) => { kv.delete(key); } } as unknown as KVNamespace, OAUTH_PROVIDER: {} as never };
  const post = (path: string, body: string, headers: Record<string, string> = {}) => handleAccountAuthorization(new Request(`https://api.openmedia.site${path}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body }), env);
  assert.equal((await post('/authorize/account/email', 'challenge=x', { origin: 'https://evil.test' }))!.status, 403, 'another site cannot post the form');
  const id = 'a'.repeat(64);
  assert.equal((await post('/authorize/account/complete', `challenge=${id}&code=123456&approve=yes`, { cookie: `om_account_oauth=${'b'.repeat(64)}` }))!.status, 400, 'the challenge must match the browser that started it');
  assert.equal((await post('/authorize/account/complete', `challenge=${id}&code=123456&approve=yes`, { cookie: `om_account_oauth=${id}` }))!.status, 400, 'an unknown challenge has expired');
  assert.equal(await handleAccountAuthorization(new Request('https://api.openmedia.site/somewhere-else', { method: 'POST' }), env), undefined);
});

test('a web app identified by a Client ID Metadata Document gets the account sign-in (Manifest, ADR 0041)', async () => {
  const kv = new Map<string, string>();
  const clientId = 'https://manifeststartup.com/oauth/open-media-client.json';
  const redirectUri = 'https://manifeststartup.com/api/integrations/open-media/callback';
  const looked: string[] = [];
  // The provider resolves the document (its own CIMD support) and checks the redirect URI against it.
  const provider = {
    parseAuthRequest: async () => ({ responseType: 'code', clientId, redirectUri, scope: ['account'], state: 's', codeChallenge: 'c', codeChallengeMethod: 'S256' }),
    lookupClient: async (id: string) => { looked.push(id); return { clientId: id, clientName: 'Manifest', redirectUris: [redirectUri], tokenEndpointAuthMethod: 'none' }; },
  };
  const env = { ...signIn, OAUTH_KV: { get: async (key: string) => kv.get(key) ?? null, put: async (key: string, value: string) => { kv.set(key, value); }, delete: async (key: string) => { kv.delete(key); } } as unknown as KVNamespace, OAUTH_PROVIDER: provider as never };
  const response = (await handleAccountAuthorization(new Request(`https://api.openmedia.site/authorize?client_id=${encodeURIComponent(clientId)}&scope=account`), env))!;
  assert.equal(response.status, 200);
  assert.deepEqual(looked, [clientId]);
  const page = await response.text();
  assert.ok(page.includes('Connect Manifest'), 'the person sees which app is asking');
  const [challenge] = [...kv.values()].map((value) => JSON.parse(value) as { oauthRequest: { scope: string[]; redirectUri: string }; redirectHost: string });
  assert.deepEqual(challenge.oauthRequest.scope, ['account'], 'the grant is for the account, nothing else');
  assert.equal(challenge.redirectHost, 'manifeststartup.com');
});
