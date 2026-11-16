import assert from 'node:assert/strict';
import test from 'node:test';

import { OpenMedia, OpenMediaError } from './index';

function fake(responses: (Response | (() => Response))[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: URL | string, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const next = responses.shift()!;
    return typeof next === 'function' ? next() : next;
  }) as typeof fetch;
  return { impl, calls };
}

test('public reads need no token and build the query', async () => {
  const net = fake([Response.json({ data: [], unavailable: [], nextCursor: null, next: null })]);
  const om = new OpenMedia({ baseUrl: 'https://api.test/', fetch: net.impl });
  await om.feed({ sources: ['farcaster', 'lens'], mode: 'raw' });
  assert.equal(net.calls[0].url, 'https://api.test/v1/feed?sources=farcaster%2Clens&mode=raw');
  assert.equal((net.calls[0].init.headers as Record<string, string>).authorization, undefined);
});

test('writes carry the token and one idempotency key across a 429 retry', async () => {
  const net = fake([new Response('{}', { status: 429, headers: { 'retry-after': '0' } }), Response.json({ id: 'p1' }, { status: 201 })]);
  const om = new OpenMedia({ baseUrl: 'https://api.test', token: 'tok', fetch: net.impl });
  assert.deepEqual(await om.publish('hello'), { id: 'p1' });
  const [first, second] = net.calls.map((call) => call.init.headers as Record<string, string>);
  assert.equal(first.authorization, 'Bearer tok');
  assert.match(first['idempotency-key'], /^[0-9a-f-]{36}$/);
  assert.equal(first['idempotency-key'], second['idempotency-key']);
  assert.deepEqual(JSON.parse(String(net.calls[0].init.body)), { text: 'hello' });
});

test('errors keep the server’s code and message', async () => {
  const net = fake([Response.json({ error: { code: 'unauthorized', message: 'Send your token.' } }, { status: 401 })]);
  await assert.rejects(new OpenMedia({ baseUrl: 'https://api.test', fetch: net.impl }).me(), (error: unknown) => error instanceof OpenMediaError && error.status === 401 && error.code === 'unauthorized' && error.message === 'Send your token.');
});

test('signing in with an email code makes the client act as that person', async () => {
  const net = fake([Response.json({ sent: true, email: 'ada@example.test', expires_in: 3600 }), Response.json({ access_token: 'at1', token_type: 'Bearer', expires_in: 3600, refresh_token: 'rt1', user: { id: 'u1' } }), Response.json({ id: 'u1', handle: 'ada' })]);
  const om = new OpenMedia({ baseUrl: 'https://api.test', fetch: net.impl });
  await om.requestSignInCode('ada@example.test');
  const session = await om.signInWithCode('ada@example.test', '12345678');
  assert.equal(session.refresh_token, 'rt1');
  await om.me();
  assert.equal(net.calls[1].url, 'https://api.test/v1/auth/verify');
  assert.equal((net.calls[2].init.headers as Record<string, string>).authorization, 'Bearer at1');
});

test('a connected app’s account calls go to /v1/connected/me and read OAuth-style errors', async () => {
  const net = fake([Response.json({ conversations: [], data: [] }), Response.json({ error: 'not_found', error_description: 'Post not found.' }, { status: 404 })]);
  const om = new OpenMedia({ baseUrl: 'https://api.test', token: 'oauth', connected: true, fetch: net.impl });
  await om.conversations({ app: 'manifest' });
  assert.equal(net.calls[0].url, 'https://api.test/v1/connected/me/conversations?app=manifest');
  await assert.rejects(om.deletePost('p1'), (error: OpenMediaError) => error.status === 404 && error.code === 'not_found' && error.message === 'Post not found.');
  assert.equal(net.calls[1].url, 'https://api.test/v1/connected/me/posts/p1');
});

test('videos upload as the raw body, then publish with the returned object and a context', async () => {
  const video = { path: 'u/v.mp4', posterPath: null, durationSeconds: 8, width: 720, height: 1280, contentType: 'video/mp4', sha256: 'a'.repeat(64), sizeBytes: 3, url: 'https://x' };
  const net = fake([Response.json({ video }, { status: 201 }), Response.json({ id: 'p1' }, { status: 201 })]);
  const om = new OpenMedia({ baseUrl: 'https://api.test', token: 'tok', fetch: net.impl });
  const bytes = new Uint8Array([1, 2, 3]);
  assert.deepEqual(await om.uploadVideo(bytes, 'video/mp4'), video);
  assert.equal((net.calls[0].init.headers as Record<string, string>)['content-type'], 'video/mp4');
  assert.equal(net.calls[0].init.body, bytes);
  await om.publish('', { video, context: { app: 'manifest', idea_id: '42' } });
  assert.deepEqual(JSON.parse(String(net.calls[1].init.body)), { text: '', video, context: { app: 'manifest', idea_id: '42' } });
});

test('webhook signatures are checked over timestamp.body, within five minutes', async () => {
  const { createHmac } = await import('node:crypto');
  const { verifyWebhook } = await import('./index');
  const body = '{"id":"d1","type":"message.created"}';
  const headers = (timestamp: number, secret = 's'.repeat(32)) => new Headers({ 'x-open-media-timestamp': String(timestamp), 'x-open-media-signature': `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}` });
  assert.equal(await verifyWebhook('s'.repeat(32), headers(1_800_000_000), body, { now: 1_800_000_100_000 }), true);
  assert.equal(await verifyWebhook('s'.repeat(32), headers(1_800_000_000), body, { now: 1_800_000_400_000 }), false, 'too old');
  assert.equal(await verifyWebhook('s'.repeat(32), headers(1_800_000_000, 'w'.repeat(32)), body, { now: 1_800_000_000_000 }), false, 'wrong secret');
  assert.equal(await verifyWebhook('s'.repeat(32), headers(1_800_000_000), `${body} `, { now: 1_800_000_000_000 }), false, 'changed body');
});
