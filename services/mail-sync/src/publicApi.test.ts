import assert from 'node:assert/strict';
import test from 'node:test';

import { decodeCursor, encodeCursor, handlePublicApiRequest, PublicApiEnv } from './publicApi.js';

const env: PublicApiEnv = { SUPABASE_URL: 'https://db.example.test/', SUPABASE_PUBLISHABLE_KEY: 'publishable-key' };
const postId = '0f8fad5b-d9cb-469f-a165-70867728950e';
const post = {
  id: postId,
  body: 'Hello, open web',
  createdAt: '2026-09-27T10:00:00+00:00',
  author: { id: '10000000-0000-0000-0000-000000000009', handle: 'maya', displayName: 'Maya', avatarUrl: null },
};
const profile = { id: '10000000-0000-0000-0000-000000000009', handle: 'maya', displayName: 'Maya', bio: 'Hi', avatarUrl: null, joinedAt: '2026-09-01T00:00:00+00:00', postCount: 1 };

function fakeUpstream(results: Record<string, unknown>, calls: Array<{ url: string; body: Record<string, unknown>; apikey?: string }> = []) {
  return async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    calls.push({ url, body, apikey: (init?.headers as Record<string, string>)?.apikey });
    const name = url.split('/').pop()!;
    if (!(name in results)) return new Response('missing', { status: 500 });
    return new Response(JSON.stringify(results[name]), { status: 200, headers: { 'content-type': 'application/json' } });
  };
}

const get = (path: string, init?: RequestInit) => new Request(`https://api.openmedia.test${path}`, init);

test('lists public posts with a stable, email-free schema, plus the app-integration fields (ADR 0041)', async () => {
  const calls: Array<{ url: string; body: Record<string, unknown>; apikey?: string }> = [];
  const response = await handlePublicApiRequest(get('/v1/posts'), env, fakeUpstream({ open_media_public_posts: [post] }, calls));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  const json = await response.json() as { data: Array<Record<string, unknown>>; pagination: { nextCursor: string | null } };
  assert.deepEqual(json.data[0], {
    id: postId,
    type: 'post',
    text: 'Hello, open web',
    body: 'Hello, open web',
    createdAt: '2026-09-27T10:00:00+00:00',
    created_at: '2026-09-27T10:00:00+00:00',
    url: `https://api.openmedia.test/v1/posts/${postId}`,
    video: null,
    // The author id is the same public id that already names their video files.
    author: { id: '10000000-0000-0000-0000-000000000009', handle: 'maya', displayName: 'Maya', display_name: 'Maya', avatarUrl: null, avatar_url: null, verified: false, url: 'https://api.openmedia.test/v1/profiles/maya' },
    context: null,
    counts: { likes: 0, comments: 0, reshares: 0 },
  });
  assert.ok(!JSON.stringify(json).includes('@'), 'no email address anywhere');
  assert.equal(json.pagination.nextCursor, null);
  assert.equal(calls[0].url, 'https://db.example.test/rest/v1/rpc/open_media_public_posts');
  assert.equal(calls[0].apikey, 'publishable-key');
  assert.deepEqual(calls[0].body, { p_limit: 20, p_before_created_at: null, p_before_id: null, p_author_handle: null, p_media: null });
});

test('returns a next cursor and Link header for full pages', async () => {
  const response = await handlePublicApiRequest(get('/v1/posts?limit=1'), env, fakeUpstream({ open_media_public_posts: [post] }));
  const json = await response.json() as { pagination: { nextCursor: string; next: string } };
  assert.deepEqual(decodeCursor(json.pagination.nextCursor), { createdAt: post.createdAt, id: postId });
  assert.match(response.headers.get('link') ?? '', /rel="next"/);

  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  await handlePublicApiRequest(get(`/v1/posts?limit=1&cursor=${json.pagination.nextCursor}`), env, fakeUpstream({ open_media_public_posts: [] }, calls));
  assert.equal(calls[0].body.p_before_id, postId);
});

test('returns a post video as public file URLs and filters to video posts', async () => {
  const authorId = '10000000-0000-0000-0000-000000000001';
  const videoPost = {
    ...post,
    body: '',
    video: { path: `${authorId}/${postId}.mp4`, posterPath: `${authorId}/${postId}.jpg`, durationSeconds: 12.5, width: 720, height: 1280, contentType: 'video/mp4', sha256: 'a'.repeat(64) },
  };
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const response = await handlePublicApiRequest(get('/v1/posts?media=video&limit=1'), env, fakeUpstream({ open_media_public_posts: [videoPost] }, calls));
  const json = await response.json() as { data: Array<{ text: string; video: Record<string, unknown> }>; pagination: { next: string } };
  assert.equal(calls[0].body.p_media, 'video');
  assert.equal(json.data[0].text, '');
  assert.deepEqual(json.data[0].video, {
    url: `https://db.example.test/storage/v1/object/public/post-videos/${authorId}/${postId}.mp4`,
    posterUrl: `https://db.example.test/storage/v1/object/public/post-videos/${authorId}/${postId}.jpg`,
    poster_url: `https://db.example.test/storage/v1/object/public/post-videos/${authorId}/${postId}.jpg`,
    duration_ms: 12500,
    streaming: 'progressive',
    contentType: 'video/mp4',
    durationSeconds: 12.5,
    width: 720,
    height: 1280,
    sha256: 'a'.repeat(64),
  });
  assert.match(json.pagination.next, /media=video/);
  assert.equal((await handlePublicApiRequest(get('/v1/posts?media=audio'), env, fakeUpstream({ open_media_public_posts: [] }))).status, 400);
});

test('?app= lists one integrated app’s posts with their context and counts', async () => {
  const appPost = { ...post, context: { app: 'manifest', idea_id: '42', url: 'https://manifeststartup.com/ideas/42' }, engagement: { replies: 2, reposts: 1, likes: 5, liked: false, reshared: false } };
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const response = await handlePublicApiRequest(get('/v1/posts?media=video&app=manifest&limit=1'), env, fakeUpstream({ open_media_public_posts: [appPost] }, calls));
  const json = await response.json() as { data: Array<Record<string, unknown>>; pagination: { next: string } };
  assert.equal(calls[0].body.p_app, 'manifest');
  assert.deepEqual(json.data[0].context, appPost.context);
  assert.deepEqual(json.data[0].counts, { likes: 5, comments: 2, reshares: 1 });
  assert.match(json.pagination.next, /app=manifest/);
  assert.equal((await handlePublicApiRequest(get('/v1/posts?app=elsewhere'), env, fakeUpstream({ open_media_public_posts: [] }))).status, 400);
});

test('rejects invalid limits and cursors', async () => {
  const upstream = fakeUpstream({ open_media_public_posts: [] });
  assert.equal((await handlePublicApiRequest(get('/v1/posts?limit=500'), env, upstream)).status, 400);
  assert.equal((await handlePublicApiRequest(get('/v1/posts?cursor=nope'), env, upstream)).status, 400);
  assert.equal(decodeCursor(encodeCursor({ createdAt: 'not a date', id: postId })), undefined);
});

test('reads a single post and a profile', async () => {
  const upstream = fakeUpstream({ open_media_public_post: post, open_media_public_profile: profile });
  const postResponse = await handlePublicApiRequest(get(`/v1/posts/${postId}`), env, upstream);
  assert.equal(postResponse.status, 200);
  const profileResponse = await handlePublicApiRequest(get('/v1/profiles/@Maya'), env, upstream);
  const profileJson = await profileResponse.json() as { data: Record<string, unknown> };
  assert.equal(profileJson.data.handle, 'maya');
  assert.equal(profileJson.data.postsUrl, 'https://api.openmedia.test/v1/profiles/maya/posts');
  assert.equal('id' in profileJson.data, false, 'internal account IDs are not exposed');
});

test('returns 404 for missing or malformed resources', async () => {
  const upstream = fakeUpstream({ open_media_public_post: null, open_media_public_profile: null });
  assert.equal((await handlePublicApiRequest(get(`/v1/posts/${postId}`), env, upstream)).status, 404);
  assert.equal((await handlePublicApiRequest(get('/v1/posts/not-a-uuid'), env, upstream)).status, 404);
  assert.equal((await handlePublicApiRequest(get('/v1/profiles/nobody/posts'), env, upstream)).status, 404);
  assert.equal((await handlePublicApiRequest(get('/v1/messages'), env, upstream)).status, 404);
});

test('is read-only and handles CORS preflight', async () => {
  const upstream = fakeUpstream({});
  const post = await handlePublicApiRequest(get('/v1/posts', { method: 'POST', body: '{}' }), env, upstream);
  assert.equal(post.status, 405);
  const preflight = await handlePublicApiRequest(get('/v1/posts', { method: 'OPTIONS' }), env, upstream);
  assert.equal(preflight.status, 204);
});

test('hides upstream failures and enforces the rate limit', async () => {
  const failing = await handlePublicApiRequest(get('/v1/posts'), env, fakeUpstream({}));
  assert.equal(failing.status, 502);
  assert.doesNotMatch(await failing.text(), /db\.example\.test|publishable/);

  const limited = await handlePublicApiRequest(get('/v1/posts'), { ...env, PUBLIC_API_RATE_LIMITER: { limit: async () => ({ success: false }) } }, fakeUpstream({}));
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '60');
});

test('describes itself for agents and allows crawling', async () => {
  const index = await (await handlePublicApiRequest(get('/'), env, fakeUpstream({}))).json() as { endpoints: Record<string, string> };
  assert.equal(index.endpoints.posts, 'https://api.openmedia.test/v1/posts');
  const openapi = await (await handlePublicApiRequest(get('/v1/openapi.json'), env, fakeUpstream({}))).json() as { openapi: string };
  assert.equal(openapi.openapi, '3.1.0');
  assert.equal(await (await handlePublicApiRequest(get('/robots.txt'), env, fakeUpstream({}))).text(), 'User-agent: *\nAllow: /\n');
});

test('routes only public paths to the public API', async () => {
  const { isPublicApiPath } = await import('./publicApi.js');
  for (const path of ['/', '/robots.txt', '/v1', '/v1/', '/v1/openapi.json', '/v1/posts', '/v1/posts/abc', '/v1/profiles/maya/posts']) {
    assert.equal(isPublicApiPath(path), true, path);
  }
  for (const path of ['/health', '/v1/mail-accounts', '/v1/mail-accounts/1/sync', '/v1/postsX', '/v2/posts']) {
    assert.equal(isPublicApiPath(path), false, path);
  }
});

test('lists a post’s public comments for signed-out readers, such as Manifest’s clip viewers', async () => {
  const comment = { id: '1f8fad5b-d9cb-469f-a165-70867728950e', postId, body: 'Great pitch', createdAt: '2026-11-15T10:00:00+00:00', author: { id: profile.id, handle: 'maya', displayName: 'Maya', avatarUrl: null } };
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const response = await handlePublicApiRequest(get(`/v1/posts/${postId}/comments?limit=500`), env, fakeUpstream({ open_media_post_comments: [comment] }, calls));
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json() as { data: unknown[] }).data, [comment]);
  assert.deepEqual(calls[0].body, { p_post_id: postId, p_limit: 200 });
  assert.equal((await handlePublicApiRequest(get('/v1/posts/not-a-uuid/comments'), env, fakeUpstream({}))).status, 404);
});
