import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import type { AccountGrantProps } from './accountOAuth.js';
import { connectedCaller, connectedRequest, connectedResponse, IntegrationError, isConnectedPath, realtimeToken, storeUploadedVideo } from './appIntegrations.js';

const grant: AccountGrantProps = { kind: 'account', userId: '11000000-0000-0000-0000-000000000001', email: 'ana@example.test', accessToken: 'person-session', refreshToken: 'r', expiresAt: Date.now() + 3_600_000, scopes: ['account'] };

test('/v1/connected/me/… reaches /v1/me/… as the person, with their session and not the app’s token or cookies', async () => {
  const request = new Request('https://api.openmedia.site/v1/connected/me/conversations?app=manifest', { method: 'POST', headers: { authorization: 'Bearer app-oauth-token', cookie: 'sb=1', 'content-type': 'application/json' }, body: '{"handle":"ben"}' });
  const forwarded = connectedRequest(request, grant)!;
  const url = new URL(forwarded.url);
  assert.equal(url.pathname, '/v1/me/conversations');
  assert.equal(url.search, '?app=manifest');
  assert.equal(forwarded.headers.get('authorization'), 'Bearer person-session');
  assert.equal(forwarded.headers.get('cookie'), null);
  assert.equal(await forwarded.text(), '{"handle":"ben"}');
  assert.deepEqual(connectedCaller(forwarded), { userId: grant.userId }, 'rate limits count per person');
  assert.equal(connectedCaller(request), undefined, 'requests from outside are never treated as forwarded');
  assert.equal(new URL(connectedRequest(new Request('https://api.openmedia.site/v1/connected/me'), grant)!.url).pathname, '/v1/me');
  for (const path of ['/v1/connected/mcp', '/v1/connected/men', '/v1/connected/../me', '/v1/connected']) {
    assert.equal(isConnectedPath(new URL(path, 'https://x.test').pathname), false, path);
  }
});

test('connected errors use the OAuth shape; successes pass through untouched', async () => {
  const failed = await connectedResponse(Response.json({ error: { code: 'not_found', message: 'Post not found.' } }, { status: 404 }));
  assert.equal(failed.status, 404);
  assert.deepEqual(await failed.json(), { error: 'not_found', error_description: 'Post not found.' });
  const ok = Response.json({ id: 'x' }, { status: 201 });
  assert.equal(await connectedResponse(ok), ok);
});

test('the realtime token is the person’s own session with its expiry', () => {
  const payload = Buffer.from(JSON.stringify({ sub: grant.userId, exp: 1_900_000_000 })).toString('base64url');
  assert.deepEqual(realtimeToken('https://db.test/', 'sb_publishable_x', `h.${payload}.s`), { supabase_url: 'https://db.test', anon_key: 'sb_publishable_x', access_token: `h.${payload}.s`, expires_at: 1_900_000_000 });
  assert.equal(realtimeToken('https://db.test', 'k', 'not-a-jwt').expires_at, null);
});

// A minimal MP4: ftyp, mdat, then moov with an 8-second, 720×1280 video track.
const u32 = (value: number) => [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255];
const box = (type: string, payload: number[]) => [...u32(payload.length + 8), ...[...type].map((char) => char.charCodeAt(0)), ...payload];
const identity = [0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000].flatMap(u32);
const mvhd = box('mvhd', [0, 0, 0, 0, ...u32(0), ...u32(0), ...u32(1000), ...u32(8000), ...new Array(80).fill(0)]);
const tkhd = box('tkhd', [0, 0, 0, 3, ...u32(0), ...u32(0), ...u32(1), ...u32(0), ...u32(0), ...new Array(16).fill(0), ...identity, ...u32(720 * 65536), ...u32(1280 * 65536)]);
const ftyp = box('ftyp', [...'isom'].map((c) => c.charCodeAt(0)).concat(u32(512)));
const mp4 = Uint8Array.from([...ftyp, ...box('mdat', new Array(70_000).fill(9)), ...box('moov', [...mvhd, ...box('trak', tkhd)])]);
const noMoov = Uint8Array.from([...ftyp, ...box('mdat', new Array(500).fill(9))]);

function upload(bytes: Uint8Array, headers: Record<string, string> = {}, query = '') {
  // Deliver the body in small chunks, as a network would.
  const body = new ReadableStream<Uint8Array>({
    start(controller) { for (let offset = 0; offset < bytes.length; offset += 4096) controller.enqueue(bytes.slice(offset, offset + 4096)); controller.close(); },
  });
  return new Request(`https://api.openmedia.site/v1/me/media/videos${query}`, { method: 'POST', headers: { 'content-type': 'video/mp4', 'content-length': String(bytes.length), ...headers }, body, duplex: 'half' } as RequestInit);
}

function storage() {
  const calls: { url: string; method: string; headers: Record<string, string>; bytes?: Uint8Array; body?: string }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    if (init.body instanceof ReadableStream) {
      const bytes = new Uint8Array(await new Response(init.body).arrayBuffer());
      calls.push({ url, method: String(init.method), headers, bytes });
    } else calls.push({ url, method: String(init.method), headers, body: String(init.body ?? '') });
    return Response.json({ Key: 'ok' });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const input = (request: Request) => ({ supabaseUrl: 'https://db.test', publishableKey: 'sb_publishable_x', token: 'person-session', userId: grant.userId, request });

test('an MP4 streams into the person’s own folder unchanged, with its hash, length and size', async () => {
  const { calls, fetchImpl } = storage();
  const video = await storeUploadedVideo(input(upload(mp4)), fetchImpl);
  assert.match(video.path, new RegExp(`^${grant.userId}/[0-9a-f-]{36}\\.mp4$`));
  assert.equal(video.sha256, createHash('sha256').update(mp4).digest('hex'));
  assert.deepEqual({ d: video.durationSeconds, w: video.width, h: video.height, t: video.contentType, n: video.sizeBytes, p: video.posterPath }, { d: 8, w: 720, h: 1280, t: 'video/mp4', n: mp4.length, p: null });
  assert.equal(video.url, `https://db.test/storage/v1/object/public/post-videos/${video.path}`);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `https://db.test/storage/v1/object/post-videos/${video.path}`);
  assert.equal(calls[0].headers.authorization, 'Bearer person-session', 'stored as the person, so Storage keeps it in their folder');
  assert.equal(calls[0].headers['x-upsert'], 'false');
  assert.deepEqual(calls[0].bytes, mp4, 'the file is stored byte for byte');
});

test('uploads are refused before storing when they are not a video, too big or unsized', async () => {
  const { calls, fetchImpl } = storage();
  const refused = async (request: Request) => {
    try { await storeUploadedVideo(input(request), fetchImpl); } catch (error) { assert.ok(error instanceof IntegrationError); return error.status; }
    return 0;
  };
  assert.equal(await refused(upload(mp4, { 'content-type': 'image/png' })), 415);
  assert.equal(await refused(upload(mp4, { 'content-type': 'video/webm' })), 415, 'the bytes must match the Content-Type');
  assert.equal(await refused(upload(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]))), 415);
  assert.equal(await refused(upload(mp4, { 'content-length': String(101 * 1024 * 1024) })), 413);
  assert.equal(await refused(new Request('https://api.openmedia.site/v1/me/media/videos', { method: 'POST', headers: { 'content-type': 'video/mp4' } })), 411);
  assert.equal(calls.length, 0, 'nothing was stored');
});

test('a video whose length cannot be read is removed again unless the app says its length and size', async () => {
  const { calls, fetchImpl } = storage();
  await assert.rejects(storeUploadedVideo(input(upload(noMoov)), fetchImpl), (error: IntegrationError) => error.status === 422);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].method, 'DELETE');
  assert.ok(calls[1].body!.includes(grant.userId), 'the stored file is deleted');
  const video = await storeUploadedVideo(input(upload(noMoov, {}, '?duration_ms=8000&width=720&height=1280')), fetchImpl);
  assert.deepEqual([video.durationSeconds, video.width, video.height], [8, 720, 1280]);
});

test('a body longer or shorter than its Content-Length is refused', async () => {
  const { fetchImpl } = storage();
  await assert.rejects(storeUploadedVideo(input(upload(mp4, { 'content-length': String(mp4.length - 10) })), fetchImpl), (error: IntegrationError) => error.status === 400);
  await assert.rejects(storeUploadedVideo(input(upload(mp4, { 'content-length': String(mp4.length + 10) })), fetchImpl), (error: IntegrationError) => error.status === 400);
});
