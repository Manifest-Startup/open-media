/** The tools that bring the app's own screens to agents (ADR 0043) call what the app calls. */
import assert from 'node:assert/strict';
import test from 'node:test';

import { Account, AgentEnv } from './agentApi.js';

const user = '0b6f3c1e-8d2a-4e5f-9a7b-1c2d3e4f5a6b';
const conversation = '6f1c2a0e-6b1d-4c39-9d7e-2f4b8a1c0d11';
const message = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';

function fakeAccount(reply: (url: URL, body: any) => unknown = () => ({})) {
  const calls: { method: string; url: URL; body: any }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method: init.method ?? 'GET', url, body });
    return Response.json(reply(url, body));
  }) as typeof fetch;
  const internal = async (request: Request) => {
    calls.push({ method: request.method, url: new URL(request.url), body: await request.json().catch(() => undefined) });
    return Response.json({ ok: true });
  };
  const env = { SUPABASE_URL: 'https://db.test', SUPABASE_PUBLISHABLE_KEY: 'publishable' } as AgentEnv;
  return { account: new Account(env, 'token', user, 'https://api.test', internal), calls, restore: () => { globalThis.fetch = realFetch; } };
}

test('edit_profile changes only the name and bio, within the app’s limits', async () => {
  const { account, calls, restore } = fakeAccount(() => [{ handle: 'sam', display_name: 'Sam Lee', bio: 'Hi' }]);
  try {
    assert.deepEqual(await account.editProfile({ displayName: ' Sam Lee ', bio: 'Hi' }), { handle: '@sam', displayName: 'Sam Lee', bio: 'Hi' });
    assert.equal(calls[0].method, 'PATCH');
    assert.equal(calls[0].url.pathname, '/rest/v1/profiles');
    assert.equal(calls[0].url.searchParams.get('id'), `eq.${user}`);
    assert.deepEqual(Object.keys(calls[0].body).sort(), ['bio', 'display_name', 'updated_at']);
    await assert.rejects(() => account.editProfile({}), /displayName, bio or both/);
    await assert.rejects(() => account.editProfile({ bio: 'x'.repeat(241) }), /240/);
  } finally { restore(); }
});

test('replies, reactions and mark-unread use the app’s own database calls', async () => {
  const { account, calls, restore } = fakeAccount((url) => url.pathname.endsWith('/open_media_set_reaction') ? '👍' : [{ id: message, conversation_id: conversation, sender_id: user, body: 'yes', created_at: '2026-11-17T00:00:00Z', reply_to_message_id: message }]);
  try {
    await account.send(conversation, 'yes', undefined, message);
    assert.equal(calls[0].body.reply_to_message_id, message);
    await assert.rejects(() => account.send(conversation, 'yes', undefined, 'nope'), /replyTo/);
    assert.deepEqual(await account.reactToMessage(message, '👍'), { messageId: message, reaction: '👍' });
    assert.deepEqual(calls.at(-1)!.body, { p_message_id: message, p_emoji: '👍' });
    await account.reactToMessage(message, null);
    assert.equal(calls.at(-1)!.body.p_emoji, null);
    await assert.rejects(() => account.reactToMessage(message, 'not one emoji at all'), /one emoji/);
    await account.markUnread(conversation);
    assert.equal(calls.at(-1)!.url.pathname, '/rest/v1/rpc/open_media_mark_unread');
  } finally { restore(); }
});

test('web-feed items, interests and people search call the app’s RPCs', async () => {
  const { account, calls, restore } = fakeAccount(() => []);
  try {
    await account.likeWebItem('https://example.com/a', undefined);
    assert.deepEqual(calls.at(-1)!.body, { p_url: 'https://example.com/a', p_liked: true });
    await account.reshareWebItem('https://example.com/a', false);
    assert.deepEqual(calls.at(-1)!.body, { p_url: 'https://example.com/a', p_reshared: false });
    await account.commentOnWebItem('https://example.com/a', ' Nice ');
    assert.equal(calls.at(-1)!.body.p_body, 'Nice');
    await assert.rejects(() => account.likeWebItem('javascript:alert(1)', true), /https link/);
    await account.setFeedInterests(['design', ' cooking ']);
    assert.deepEqual(calls.at(-1)!.body, { p_interests: ['design', 'cooking'] });
    await assert.rejects(() => account.setFeedInterests('design'), /topics/);
    await assert.rejects(() => account.setFeedInterests(Array.from({ length: 21 }, (_, i) => `topic ${i}`)), /20 topics/);
    await assert.rejects(() => account.setFeedInterests(['x'.repeat(41)]), /40 characters/);
    await account.findPeople('@sa');
    assert.deepEqual(calls.at(-1)!.body, { p_query: 'sa' });
    await assert.rejects(() => account.findPeople('s'), /two characters/);
  } finally { restore(); }
});

test('mail and chat read state go through the same routes the app uses', async () => {
  const { account, calls, restore } = fakeAccount();
  try {
    await account.markEmailSeen('box-1', ['<a@b>'], true);
    assert.equal(calls.at(-1)!.url.pathname, '/v1/mail-accounts/box-1/seen');
    assert.deepEqual(calls.at(-1)!.body, { messageIds: ['<a@b>'], unseen: true });
    await account.setBridgedChatRead('!room:server', false);
    assert.equal(calls.at(-1)!.url.pathname, `/v1/bridges/rooms/${encodeURIComponent('!room:server')}/unread`);
    await account.setBridgedChatRead('!room:server', true, '$event');
    assert.deepEqual(calls.at(-1)!.body, { eventId: '$event' });
    await account.cancelChatSignIn('whatsapp', 'login-1');
    assert.equal(calls.at(-1)!.url.pathname, '/v1/bridges/whatsapp/login/cancel');
  } finally { restore(); }
});

test('apps send a new email from the person’s own mailbox, idempotently, and never see credentials', async () => {
  const calls: { method: string; path: string; body: any; key: string | null }[] = [];
  let accounts = [
    { id: 'box-read', email: 'read@me.test', status: 'connected', canSend: false },
    { id: 'box-send', email: 'me@me.test', status: 'connected', canSend: true, encryptedSecret: 'never' },
  ];
  const internal = async (request: Request) => {
    const url = new URL(request.url);
    calls.push({ method: request.method, path: url.pathname, body: await request.json().catch(() => undefined), key: request.headers.get('idempotency-key') });
    if (url.pathname === '/v1/mail-accounts') return Response.json({ accounts });
    return Response.json({ message: { sourceMessageId: '<om-1@openmedia.site>', subject: 'Hi' } }, { status: 201 });
  };
  const env = { SUPABASE_URL: 'https://db.test', SUPABASE_PUBLISHABLE_KEY: 'publishable' } as AgentEnv;
  const account = new Account(env, 'token', user, 'https://api.test', internal);
  assert.deepEqual(await account.mailboxes(), { mailboxes: [
    { id: 'box-read', email: 'read@me.test', status: 'connected', can_send: false },
    { id: 'box-send', email: 'me@me.test', status: 'connected', can_send: true },
  ] });
  const sent = await account.composeEmail({ to: ['ana@co.test'], subject: ' Hi ', text: ' Hello Ana ' }, 'goal-task-12345');
  assert.equal(sent.mailbox_id, 'box-send');
  assert.equal(sent.from, 'me@me.test');
  const send = calls.at(-1)!;
  assert.equal(send.path, '/v1/mail-accounts/box-send/send');
  assert.deepEqual(send.body, { to: ['ana@co.test'], subject: 'Hi', text: 'Hello Ana' });
  assert.equal(send.key, 'goal-task-12345');
  await account.composeEmail({ to: ['ana@co.test'], subject: 'Re: Hi', text: 'Following up', in_reply_to: '<om-1@openmedia.site>' }, 'goal-task-67890');
  assert.equal(calls.at(-1)!.body.inReplyTo, '<om-1@openmedia.site>');
  await account.composeEmail({ to: ['ana@co.test'], subject: 'x', text: 'y', in_reply_to: 'bad\r\nBcc: z' }, 'goal-task-67891');
  assert.equal(calls.at(-1)!.body.inReplyTo, undefined);
  await assert.rejects(() => account.composeEmail({ mailbox_id: 'box-read', to: ['a@b.test'], subject: 's', text: 't' }), /no outgoing mail/);
  await assert.rejects(() => account.composeEmail({ to: [], subject: 's', text: 't' }), /one to ten/);
  await assert.rejects(() => account.composeEmail({ to: ['a@b.test'], subject: '', text: 't' }), /subject/);
  accounts = [];
  await assert.rejects(() => account.composeEmail({ to: ['a@b.test'], subject: 's', text: 't' }), /Connect a mailbox/);
});

test('an Idempotency-Key gives a stable Message-ID per person and mailbox, and a bad key gives none', async () => {
  const { idempotentMessageId } = await import('./mailHandler.js');
  const a = await idempotentMessageId('goal-task-12345', user, 'box-1', 'Me@Founder.dev');
  // The sender's own domain, shaped like a mail app's Message-ID.
  assert.match(a!, /^<[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}@founder\.dev>$/);
  assert.equal(await idempotentMessageId('goal-task-12345', user, 'box-1', 'Me@Founder.dev'), a);
  assert.notEqual(await idempotentMessageId('goal-task-12345', user, 'box-2', 'Me@Founder.dev'), a);
  assert.match((await idempotentMessageId('goal-task-12345', user, 'box-1'))!, /@openmedia\.site>$/);
  assert.equal(await idempotentMessageId('short', user, 'box-1'), undefined);
  assert.equal(await idempotentMessageId('bad key with spaces!', user, 'box-1'), undefined);
  assert.equal(await idempotentMessageId(null, user, 'box-1'), undefined);
});
