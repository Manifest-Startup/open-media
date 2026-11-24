import assert from 'node:assert/strict';
import test from 'node:test';

import { appReturnURL, authorizeURL, defaultLinkedInVersion, escapeLinkedIn, exchangeCode, linkedInCommentary, linkedInVersion, parseState, publishSocial, refreshSession, socialStatus } from './socialOAuth.js';

const env = { CONVO_APP_ORIGIN: 'https://openmedia.site', X_CLIENT_ID: 'xid', X_CLIENT_SECRET: 'xsecret', THREADS_APP_ID: 'tid', THREADS_APP_SECRET: 'tsecret' };
const state = `omc_${'a'.repeat(32)}_w`;

test('status reports only networks whose app is configured', () => {
  assert.deepEqual(socialStatus(env), { x: true, threads: true, linkedin: false, instagram: false, facebook: false });
});

test('states must come from Open Media and say where to return', () => {
  assert.deepEqual(parseState(state), { client: 'web' });
  assert.deepEqual(parseState(`omc_${'b'.repeat(32)}_n`), { client: 'native' });
  assert.equal(parseState('omc_short_w'), undefined);
  assert.throws(() => authorizeURL('x', env, 'https://openmedia.site', { state: 'evil', challenge: 'c'.repeat(43) }));
});

test('authorize URLs use the server callback and PKCE for X', () => {
  const url = new URL(authorizeURL('x', env, 'https://openmedia.site', { state, challenge: 'c'.repeat(43) }));
  assert.equal(url.origin, 'https://x.com');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://openmedia.site/v1/social/x/callback');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.throws(() => authorizeURL('linkedin', env, 'https://openmedia.site', { state }), /isn’t set up/);
});

test('the callback returns to the web app or the phone app, never elsewhere', () => {
  assert.equal(appReturnURL(env, 'https://openmedia.site', new URLSearchParams({ state, code: 'abc' })), `https://openmedia.site/auth?state=${state}&code=abc`);
  const native = `omc_${'c'.repeat(32)}_n`;
  assert.equal(appReturnURL(env, 'https://openmedia.site', new URLSearchParams({ state: native, error: 'access_denied' })), `openmedia://oauth?state=${native}&error=access_denied`);
  assert.throws(() => appReturnURL(env, 'https://openmedia.site', new URLSearchParams({ state: 'https://evil.example', code: 'x' })));
});

test('X code exchange returns the device session', async () => {
  const calls: string[] = [];
  const fetcher = (async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    if (url.endsWith('/oauth2/token')) {
      assert.match(String((init?.headers as Record<string, string>).authorization), /^Basic /);
      return new Response(JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_in: 7200 }));
    }
    return new Response(JSON.stringify({ data: { id: '42', username: 'alex' } }));
  }) as typeof fetch;
  const session = await exchangeCode('x', env, 'https://openmedia.site', { code: 'code', verifier: 'v'.repeat(43) }, fetcher);
  assert.equal(session.handle, '@alex');
  assert.equal(session.refreshToken, 'rt');
  assert.ok(session.expiresAt! > Date.now());
  assert.deepEqual(calls, ['POST https://api.x.com/2/oauth2/token', 'GET https://api.x.com/2/users/me']);
});

test('Threads publishes in two steps and returns the permalink', async () => {
  const fetcher = (async (url: string) => {
    if (url.endsWith('/me/threads')) return new Response(JSON.stringify({ id: 'container' }));
    if (url.endsWith('/threads_publish')) return new Response(JSON.stringify({ id: 'post1' }));
    return new Response(JSON.stringify({ permalink: 'https://www.threads.net/@alex/post/1' }));
  }) as typeof fetch;
  const result = await publishSocial('threads', { token: 't', accountId: '1', handle: '@alex' }, { text: 'Hello' }, fetcher);
  assert.deepEqual(result, { externalId: 'post1', url: 'https://www.threads.net/@alex/post/1' });
});

test('network errors become plain messages', async () => {
  const fetcher = (async () => new Response(JSON.stringify({ detail: 'You are not permitted to perform this action.' }), { status: 403 })) as unknown as typeof fetch;
  await assert.rejects(publishSocial('x', { token: 't', accountId: '1', handle: '@a' }, { text: 'hi' }, fetcher), /X: You are not permitted/);
});

test('LinkedIn commentary escapes its markup characters', () => {
  assert.equal(escapeLinkedIn('Hi (team) #launch @me'), 'Hi \\(team\\) \\#launch \\@me');
});

test('LinkedIn hashtags stay hashtags, links stay links, and a video goes as a link', () => {
  assert.equal(linkedInCommentary('Launch day (finally) #Build_2026 with @team'), 'Launch day \\(finally\\) {hashtag|\\#|Build\\_2026} with \\@team');
  assert.equal(linkedInCommentary('C# and a#b are not hashtags'), 'C\\# and a\\#b are not hashtags');
  assert.equal(linkedInCommentary('Read https://example.com/a_b(1)?q=*x.'), 'Read https://example.com/a_b(1)?q=*x.');
  assert.equal(linkedInCommentary('(see https://openmedia.site/p/1)'), '\\(see https://openmedia.site/p/1\\)');
  assert.equal(linkedInCommentary('New clip', 'https://openmedia.site/v/abc_1'), 'New clip\n\nhttps://openmedia.site/v/abc_1');
  assert.equal(linkedInCommentary('', 'https://openmedia.site/v/abc'), 'https://openmedia.site/v/abc');
  assert.equal(linkedInCommentary('Watch https://openmedia.site/v/abc', 'https://openmedia.site/v/abc'), 'Watch https://openmedia.site/v/abc');
});

test('LinkedIn uses a supported API version, overridable without a new build', () => {
  assert.match(defaultLinkedInVersion, /^20\d{4}$/);
  assert.ok(Number(defaultLinkedInVersion) > 202510, '202510 was retired on 2026-10-15');
  assert.equal(linkedInVersion({ LINKEDIN_API_VERSION: '202701' }), '202701');
  assert.equal(linkedInVersion({ LINKEDIN_API_VERSION: 'latest' }), defaultLinkedInVersion);
  assert.equal(linkedInVersion(), defaultLinkedInVersion);
});

const linkedInEnv = { ...env, LINKEDIN_CLIENT_ID: 'lid', LINKEDIN_CLIENT_SECRET: 'lsecret' };

test('LinkedIn connects with OpenID and posts as the member', async () => {
  const authorize = new URL(authorizeURL('linkedin', linkedInEnv, 'https://openmedia.site', { state }));
  assert.equal(authorize.origin + authorize.pathname, 'https://www.linkedin.com/oauth/v2/authorization');
  assert.equal(authorize.searchParams.get('scope'), 'openid profile w_member_social');
  assert.equal(authorize.searchParams.get('redirect_uri'), 'https://openmedia.site/v1/social/linkedin/callback');

  const calls: { url: string; init?: RequestInit }[] = [];
  const fetcher = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.endsWith('/accessToken')) return new Response(JSON.stringify({ access_token: 'lat', expires_in: 5_184_000 }));
    if (url.endsWith('/userinfo')) return new Response(JSON.stringify({ sub: 'abc123', name: 'Alex Doe' }));
    return new Response(null, { status: 201, headers: { 'x-restli-id': 'urn:li:share:7' } });
  }) as typeof fetch;
  const session = await exchangeCode('linkedin', linkedInEnv, 'https://openmedia.site', { code: 'code' }, fetcher);
  assert.deepEqual({ accountId: session.accountId, handle: session.handle }, { accountId: 'abc123', handle: 'Alex Doe' });
  const tokenBody = new URLSearchParams(String(calls[0].init?.body));
  assert.equal(tokenBody.get('client_secret'), 'lsecret');
  assert.equal(tokenBody.get('redirect_uri'), 'https://openmedia.site/v1/social/linkedin/callback');

  const result = await publishSocial('linkedin', session, { text: 'Hello #OpenMedia' }, fetcher, { LINKEDIN_API_VERSION: '202612' });
  assert.deepEqual(result, { externalId: 'urn:li:share:7', url: 'https://www.linkedin.com/feed/update/urn%3Ali%3Ashare%3A7/' });
  const post = calls[2];
  assert.equal(post.url, 'https://api.linkedin.com/rest/posts');
  const headers = post.init?.headers as Record<string, string>;
  assert.equal(headers['LinkedIn-Version'], '202612');
  assert.equal(headers['X-Restli-Protocol-Version'], '2.0.0');
  const body = JSON.parse(String(post.init?.body));
  assert.equal(body.author, 'urn:li:person:abc123');
  assert.equal(body.commentary, 'Hello {hashtag|\\#|OpenMedia}');
  assert.equal(body.lifecycleState, 'PUBLISHED');
});

test('an expired LinkedIn sign-in without a refresh token asks to reconnect', async () => {
  await assert.rejects(refreshSession('linkedin', linkedInEnv, { token: 't', accountId: 'a', handle: 'A', expiresAt: 1 }), /Connect LinkedIn again/);
  const fetcher = (async () => new Response(JSON.stringify({ message: 'gone' }), { status: 426 })) as unknown as typeof fetch;
  await assert.rejects(publishSocial('linkedin', { token: 't', accountId: 'a', handle: 'A' }, { text: 'hi' }, fetcher), /LinkedIn needs Open Media to update/);
});
