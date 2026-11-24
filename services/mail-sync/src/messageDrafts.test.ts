import assert from 'node:assert/strict';
import test from 'node:test';

import { Account, fullOpenApi } from './agentApi.js';

const env = { SUPABASE_URL: 'http://db.test', SUPABASE_PUBLISHABLE_KEY: 'publishable' };
const origin = 'https://api.test';
const person = 'a1000000-0000-4000-8000-0000000000a1';
const conversation = 'c1000000-0000-4000-8000-0000000000c1';

/** A tiny PostgREST stand-in for conversations, message_drafts and messages, as the person sees them. */
function fakeDatabase() {
  const drafts: Record<string, any>[] = [];
  const messages: Record<string, any>[] = [];
  const calls: { method: string; url: string }[] = [];
  const filters = (url: URL) => [...url.searchParams].filter(([key, value]) => !['select', 'order', 'limit', 'on_conflict'].includes(key) && value.startsWith('eq.')).map(([key, value]) => [key, decodeURIComponent(value.slice(3))]);
  const match = (row: Record<string, any>, url: URL) => filters(url).every(([key, value]) => String(row[key]) === value);
  const fetch = (async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    const method = init?.method ?? 'GET';
    calls.push({ method, url: input });
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const table = url.pathname.replace('/rest/v1/', '');
    if (table === 'conversations') return Response.json(url.searchParams.get('id') === `eq.${conversation}` ? [{ id: conversation }] : []);
    if (table === 'messages') {
      if (method === 'POST') {
        if (messages.some((m) => m.client_id === body.client_id)) return Response.json([]);
        const row = { id: crypto.randomUUID(), created_at: new Date().toISOString(), reply_to_message_id: null, ...body };
        messages.push(row);
        return Response.json([row]);
      }
      return Response.json(messages.filter((row) => match(row, url)));
    }
    if (table === 'message_drafts') {
      if (method === 'POST') {
        const row = { id: crypto.randomUUID(), status: 'draft', sent_message_id: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...body };
        drafts.push(row);
        return Response.json([row]);
      }
      const hits = drafts.filter((row) => match(row, url));
      if (method === 'PATCH') { hits.forEach((row) => Object.assign(row, body)); return Response.json(hits); }
      if (method === 'DELETE') { hits.forEach((row) => drafts.splice(drafts.indexOf(row), 1)); return Response.json(hits.map(({ id }) => ({ id }))); }
      return Response.json(hits);
    }
    return Response.json([]);
  }) as typeof globalThis.fetch;
  return { drafts, messages, calls, fetch };
}

async function withAccount(run: (account: Account, db: ReturnType<typeof fakeDatabase>) => Promise<void>) {
  const realFetch = globalThis.fetch;
  const db = fakeDatabase();
  globalThis.fetch = db.fetch;
  try { await run(new Account(env, 'person-token', person, origin), db); } finally { globalThis.fetch = realFetch; }
}

test('a draft is saved, not sent, and an app updates its own draft instead of duplicating it', async () => {
  await withAccount(async (account, db) => {
    const first = await account.saveDraft(conversation, '  Hi Ana, could we talk?  ', { app: 'manifest', ref: 'step-1' });
    assert.equal(first.created, true);
    assert.equal(first.draft.text, 'Hi Ana, could we talk?');
    assert.equal(first.draft.app, 'manifest');
    const again = await account.saveDraft(conversation, 'Hi Ana, could we talk about pilots?', { app: 'manifest', ref: 'step-1' });
    assert.equal(again.created, false);
    assert.equal(again.draft.id, first.draft.id);
    assert.equal(db.drafts.length, 1);
    assert.equal(db.messages.length, 0, 'saving never sends');
    assert.deepEqual((await account.drafts()).drafts.map((d) => d.text), ['Hi Ana, could we talk about pilots?']);
  });
});

test('sending a draft sends it once, with the draft id as the client id, and records the message', async () => {
  await withAccount(async (account, db) => {
    const { draft } = await account.saveDraft(conversation, 'Hello');
    const sent = await account.sendDraft(draft.id);
    assert.equal(sent.sent, true);
    assert.equal(db.messages.length, 1);
    assert.equal(db.messages[0].client_id, draft.id);
    assert.equal(db.drafts[0].status, 'sent');
    assert.equal(db.drafts[0].sent_message_id, sent.message?.id);
    const retried = await account.sendDraft(draft.id);
    assert.equal(db.messages.length, 1, 'a retried send lands once');
    assert.equal(retried.message?.id, sent.message?.id);
    assert.deepEqual((await account.drafts()).drafts, [], 'sent drafts leave the list');
    await assert.rejects(account.saveDraft(conversation, 'x'.repeat(10), { app: 'manifest', ref: 'r' }).then(() => account.sendDraft(db.drafts[1].id)).then(() => account.saveDraft(conversation, 'again', { app: 'manifest', ref: 'r' })), /already sent/);
  });
});

test('drafts are checked: words, length, ids, app names and conversations', async () => {
  await withAccount(async (account) => {
    await assert.rejects(account.saveDraft(conversation, '   '), /Write the draft first/);
    await assert.rejects(account.saveDraft(conversation, 'x'.repeat(8001)), /8,000/);
    await assert.rejects(account.saveDraft('not-a-uuid', 'Hi'), /Conversation not found/);
    await assert.rejects(account.saveDraft('c2000000-0000-4000-8000-0000000000c2', 'Hi'), /Conversation not found/);
    await assert.rejects(account.saveDraft(conversation, 'Hi', { app: 'Evil App!' }), /short lowercase name/);
    await assert.rejects(account.saveDraft(conversation, 'Hi', { ref: 'r' }), /Give app with ref/);
    await assert.rejects(account.sendDraft('d1000000-0000-4000-8000-0000000000d1'), /Draft not found/);
    await assert.rejects(account.drafts('nope'), /conversation_id/);
  });
});

test('a draft can be changed or discarded until it is sent', async () => {
  await withAccount(async (account, db) => {
    const { draft } = await account.saveDraft(conversation, 'First');
    assert.equal((await account.updateDraft(draft.id, 'Second')).draft.text, 'Second');
    assert.deepEqual(await account.discardDraft(draft.id), { discarded: true, id: draft.id });
    assert.equal(db.drafts.length, 0);
    await assert.rejects(account.discardDraft(draft.id), /not found/);
  });
});

test('every draft route is documented as account-only', () => {
  const paths = fullOpenApi(origin).paths as Record<string, Record<string, { security?: unknown }>>;
  for (const [path, verbs] of [['/v1/me/drafts', ['get']], ['/v1/me/conversations/{id}/drafts', ['post']], ['/v1/me/drafts/{id}', ['patch', 'delete']], ['/v1/me/drafts/{id}/send', ['post']]] as const) {
    for (const verb of verbs) assert.ok(paths[path]?.[verb]?.security, `${verb} ${path}`);
  }
});
