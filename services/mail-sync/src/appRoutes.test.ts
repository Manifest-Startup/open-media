import assert from 'node:assert/strict';
import test from 'node:test';

import { Account, fullOpenApi, handleAgentRequest } from './agentApi.js';

// The account routes apps use (ADR 0041), against a fake Supabase that records every call.
const env = { SUPABASE_URL: 'http://db.test', SUPABASE_PUBLISHABLE_KEY: 'publishable' };
const origin = 'https://api.test';
const me = '11000000-0000-0000-0000-000000000001';
const ben = '22000000-0000-0000-0000-000000000002';
const conversationId = 'c3000000-0000-0000-0000-000000000003';
const context = { app: 'manifest', idea_id: '42', url: 'https://manifeststartup.com/ideas/42' };

type Call = { method: string; url: string; body: any; prefer?: string; authorization?: string };

async function withDatabase(answer: (call: Call) => unknown, run: (account: Account, calls: Call[]) => Promise<void>) {
  const realFetch = globalThis.fetch;
  const calls: Call[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const call = { method: init?.method ?? 'GET', url: decodeURIComponent(String(url)), body: init?.body ? JSON.parse(String(init.body)) : undefined, prefer: headers.prefer, authorization: headers.authorization };
    calls.push(call);
    return Response.json(answer(call) ?? null);
  }) as typeof fetch;
  try { await run(new Account(env, 'person-session', me, origin), calls); } finally { globalThis.fetch = realFetch; }
}

const message = (id: string, at: string, sender = ben) => ({ id, conversation_id: conversationId, sender_id: sender, body: `text ${id}`, created_at: at, reply_to_message_id: null });

test('conversations come in the contract shape, filtered by app, with members, the last message and unread count', async () => {
  await withDatabase((call) => {
    if (call.url.includes('/conversation_members?user_id')) return [{ conversation_id: conversationId }];
    if (call.url.includes('/conversations?')) return [{ id: conversationId, kind: 'direct', title: null, updated_at: '2026-11-15T10:00:00Z', context }];
    if (call.url.includes('/conversation_members?conversation_id')) return [{ conversation_id: conversationId, user_id: me }, { conversation_id: conversationId, user_id: ben }];
    if (call.url.includes('/messages?')) return [message('m2', '2026-11-15T10:00:00Z'), message('m1', '2026-11-15T09:00:00Z', me)];
    if (call.url.includes('open_media_profile_cards')) return [{ id: me, handle: 'ana', displayName: 'Ana', avatarUrl: null }, { id: ben, handle: 'ben', displayName: 'Ben', avatarUrl: 'https://img.test/ben.png' }];
    return [];
  }, async (account, calls) => {
    const result = await account.conversations(20, { app: 'manifest' });
    assert.ok(calls.some((call) => call.url.includes('/conversations?') && call.url.includes('source_app=eq.manifest')), 'the database filters by app');
    assert.deepEqual(result.conversations[0], {
      id: conversationId, kind: 'direct', title: 'Ben', context,
      members: [{ id: me, handle: 'ana', display_name: 'Ana', avatar_url: null }, { id: ben, handle: 'ben', display_name: 'Ben', avatar_url: 'https://img.test/ben.png' }],
      last_message: { id: 'm2', body: 'text m2', sender_id: ben, created_at: '2026-11-15T10:00:00Z' },
      unread_count: 1, updated_at: '2026-11-15T10:00:00Z',
    });
    assert.equal(result.data[0].title, 'Ben', 'the original shape is still there');
    await assert.rejects(account.conversations(20, { app: 'elsewhere' }), /integrated app/);
  });
});

test('starting a conversation sets an app context once, after checking it, and answers with the conversation', async () => {
  await withDatabase((call) => {
    if (call.url.endsWith('open_media_public_profile')) return { id: ben };
    if (call.url.endsWith('open_media_start_direct_conversation')) return conversationId;
    if (call.url.endsWith('open_media_set_conversation_context')) return context;
    if (call.url.includes('/conversations?')) return [{ id: conversationId, kind: 'direct', title: null, updated_at: '2026-11-15T10:00:00Z', context }];
    return [];
  }, async (account, calls) => {
    const started = await account.startConversation('@ben', context);
    assert.equal(started.id, conversationId);
    assert.deepEqual(started.conversation?.context, context);
    const set = calls.find((call) => call.url.endsWith('open_media_set_conversation_context'))!;
    assert.deepEqual(set.body, { p_conversation_id: conversationId, p_context: context });
    calls.length = 0;
    await assert.rejects(account.startConversation('ben', { app: 'manifest', url: 'https://evil.test' }), /context.url/);
    assert.equal(calls.length, 0, 'a bad context is refused before anything happens');
  });
});

test('messages page newest-last, and before= accepts a message id', async () => {
  await withDatabase((call) => {
    if (call.url.includes('/conversations?id=eq.')) return [{ id: conversationId }];
    if (call.url.includes(`/messages?id=eq.`)) return [{ created_at: '2026-11-15T09:30:00Z' }];
    if (call.url.includes('/messages?conversation_id')) return [message('m2', '2026-11-15T09:00:00Z'), message('m1', '2026-11-15T08:00:00Z')];
    return [];
  }, async (account, calls) => {
    const page = await account.messages(conversationId, { limit: '2', before: 'a4000000-0000-0000-0000-000000000004' });
    assert.deepEqual(page.messages.map((item) => item.id), ['m1', 'm2']);
    const list = calls.find((call) => call.url.includes('/messages?conversation_id'))!;
    assert.ok(list.url.includes('created_at=lt.2026-11-15T09:30:00Z') && list.url.includes('limit=2') && list.url.includes('reply_to_message_id'));
    await assert.rejects(account.messages(conversationId, { limit: '500' }), /limit/);
  });
});

test('sending with a client_id is idempotent: a retry returns the first message', async () => {
  const clientId = 'b5000000-0000-0000-0000-000000000005';
  let inserted = false;
  await withDatabase((call) => {
    if (call.method === 'POST' && call.url.includes('/messages?on_conflict=sender_id,client_id')) {
      if (inserted) return []; // ignore-duplicates: nothing new
      inserted = true;
      return [message('m9', '2026-11-15T11:00:00Z', me)];
    }
    if (call.url.includes(`client_id=eq.${clientId}`)) return [message('m9', '2026-11-15T11:00:00Z', me)];
    return [];
  }, async (account, calls) => {
    const first = await account.send(conversationId, 'Hello', clientId);
    const again = await account.send(conversationId, 'Hello', clientId);
    assert.equal(first.message?.id, 'm9');
    assert.equal(again.message?.id, 'm9');
    const insert = calls.find((call) => call.method === 'POST')!;
    assert.equal(insert.body.client_id, clientId);
    assert.match(insert.prefer!, /resolution=ignore-duplicates/);
    await assert.rejects(account.send(conversationId, 'Hello', 'not-a-uuid'), /client_id/);
  });
});

test('publishing passes only the person’s own uploaded video and a checked context', async () => {
  const uploaded = { path: `${me}/d6000000-0000-0000-0000-000000000006.mp4`, posterPath: null, durationSeconds: 8, width: 720, height: 1280, contentType: 'video/mp4', sha256: 'a'.repeat(64), sizeBytes: 10, url: 'https://db.test/x.mp4' };
  await withDatabase((call) => {
    if (call.url.endsWith('open_media_create_post')) return { id: 'p1', body: '', createdAt: '2026-11-15T12:00:00Z', author: { id: me, handle: 'ana', displayName: 'Ana', avatarUrl: null }, video: { ...uploaded }, context, engagement: { likes: 0, replies: 0, reposts: 0 } };
    return null;
  }, async (account, calls) => {
    const result = await account.publish('', 'e7000000-0000-0000-0000-000000000007', { video: uploaded, context }) as { post: { id: string; context: unknown; video: { duration_ms: number } } };
    assert.equal(result.post.id, 'p1');
    assert.deepEqual(result.post.context, context);
    assert.equal(result.post.video.duration_ms, 8000);
    const create = calls.find((call) => call.url.endsWith('open_media_create_post'))!;
    assert.deepEqual(create.body.p_video, { path: uploaded.path, posterPath: null, durationSeconds: 8, width: 720, height: 1280, contentType: 'video/mp4', sha256: 'a'.repeat(64) }, 'only the stored fields, nothing extra');
    assert.deepEqual(create.body.p_context, context);
    assert.equal(create.authorization, 'Bearer person-session');
    await assert.rejects(account.publish('', undefined, { video: { ...uploaded, path: `${ben}/d6000000-0000-0000-0000-000000000006.mp4` } }), /video must be/, 'someone else’s file is refused');
    await assert.rejects(account.publish('hi', undefined, { context: { app: 'manifest', extra: true } }), /context may only/);
  });
});

test('an app’s feed is its own posts only, with viewer.liked when signed in', async () => {
  const row = { id: 'f8000000-0000-0000-0000-000000000008', body: 'Pitch', createdAt: '2026-11-15T12:00:00Z', author: { id: me, handle: 'ana', displayName: 'Ana', avatarUrl: null }, video: null, context, engagement: { likes: 3, replies: 1, reposts: 0, liked: true } };
  await withDatabase((call) => call.url.endsWith('open_media_public_posts') ? [row] : null, async (account, calls) => {
    const page = await account.myFeed({ kind: 'clips', app: 'manifest' });
    assert.deepEqual(calls[0].body, { p_limit: 20, p_before_created_at: null, p_before_id: null, p_author_handle: null, p_media: 'video', p_app: 'manifest' });
    assert.equal(calls[0].authorization, 'Bearer person-session');
    const [post] = page.data as Array<Record<string, any>>;
    assert.deepEqual(post.viewer, { liked: true });
    assert.deepEqual(post.counts, { likes: 3, comments: 1, reshares: 0 });
    assert.equal(post.engagement, undefined);
  });
});

test('the public /v1/feed?app= reads only that app’s posts, anonymously', async () => {
  const realFetch = globalThis.fetch;
  const calls: { url: string; body: any; authorization?: string }[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')), authorization: (init?.headers as Record<string, string>)?.authorization });
    return Response.json([]);
  }) as typeof fetch;
  try {
    const response = await handleAgentRequest(new Request(`${origin}/v1/feed?kind=clips&app=manifest`), env);
    assert.equal(response.status, 200);
    const page = await response.json() as { app: string; data: unknown[] };
    assert.equal(page.app, 'manifest');
    assert.equal(calls.length, 1, 'no other network is asked');
    assert.equal(calls[0].body.p_app, 'manifest');
    assert.equal(calls[0].authorization, undefined);
    assert.equal((await handleAgentRequest(new Request(`${origin}/v1/feed?app=elsewhere`), env)).status, 400);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('the new account routes need the person’s token, and the OpenAPI document mirrors every /v1/me route under /v1/connected', async () => {
  for (const [method, path] of [['POST', '/v1/me/media/videos'], ['POST', '/v1/me/realtime-token'], ['GET', `/v1/me/conversations/${conversationId}/messages`]]) {
    assert.equal((await handleAgentRequest(new Request(`${origin}${path}`, { method }), env)).status, 401, `${method} ${path}`);
  }
  const document = fullOpenApi(origin) as { paths: Record<string, Record<string, { security?: unknown; operationId?: string }>> };
  for (const path of ['/v1/me/media/videos', '/v1/me/realtime-token', '/v1/connected/me', '/v1/connected/me/conversations', '/v1/connected/me/conversations/{id}/messages', '/v1/connected/me/media/videos', '/v1/connected/me/posts/{id}/like', '/v1/connected/me/feed']) {
    assert.ok(document.paths[path], path);
  }
  assert.ok(document.paths['/v1/me/conversations/{id}/messages'].get);
  assert.ok(document.paths['/v1/connected/me/posts/{id}/like'].post);
  assert.deepEqual(document.paths['/v1/connected/me/posts'].post.security, [{ accountOAuth: ['account'] }]);
  const ids = Object.values(document.paths).flatMap((operations) => Object.values(operations).map((operation) => operation.operationId).filter(Boolean));
  assert.equal(new Set(ids).size, ids.length, 'operationIds stay unique');
});
