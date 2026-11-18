import assert from 'node:assert/strict';
import test from 'node:test';

import { assembleInbox, inboxSummary, inboxThread, nativeMessage } from './inbox.js';

const mailRow = (overrides: Record<string, unknown>) => ({
  account_id: 'acct-1', account_email: 'me@gmail.com', mailbox: 'INBOX', recipients: ['me@gmail.com'],
  source_message_id: '<a@x>', subject: 'Your order', sender: 'DoorDash <no-reply@doordash.com>', sent_at: '2026-11-17T10:00:00Z',
  body_text: '\n\n\n\n   DoorDash   \n\n\n\n\nYour order is on its way\n\n\n\nOn Mon, Ana wrote:\n> old', ...overrides,
});

const native = {
  id: '6f1c0a52-8f0b-4f0e-9a51-2b7d3f0f6a11', kind: 'direct', title: 'Ada', context: { app: 'manifest' as const, idea_id: 'i1', title: 'Tidy' },
  members: [{ id: 'me', handle: 'me', display_name: 'Me', avatar_url: null }, { id: 'ada', handle: 'ada', display_name: 'Ada Lovelace', avatar_url: 'https://a/ada.png' }],
  last_message: { id: 'm2', body: 'See you then', sender_id: 'ada', created_at: '2026-11-17T12:00:00Z' }, unread_count: 1, updated_at: '2026-11-17T12:00:00Z',
};

test('one inbox: chats and email together, newest first, with no tabs to pick', () => {
  const inbox = assembleInbox({ me: 'me', native: [native], mailRows: [mailRow({}), mailRow({ source_message_id: '<b@x>', sent_at: '2026-11-17T11:00:00Z', subject: 'Delivered' })], unseenRows: [{ account_id: 'acct-1', source_message_id: '<b@x>' }] });
  const summaries = inbox.map(inboxSummary);
  assert.deepEqual(summaries.map((item) => item.kind), ['chat', 'email'], 'DoorDash mail is one company conversation');
  assert.equal(summaries[0].title, 'Ada Lovelace');
  assert.deepEqual(summaries[0].avatar_urls, ['https://a/ada.png']);
  assert.deepEqual(summaries[0].context, native.context);
  assert.equal(summaries[1].company, 'doordash.com');
  assert.equal(summaries[1].unread_count, 1);
  assert.equal(summaries[1].preview.includes('\n'), false);
});

test('an email thread reads like the app: clean text, quoted history cut, subjects once', () => {
  const [entry] = assembleInbox({ me: 'me', native: [], mailRows: [mailRow({}), mailRow({ source_message_id: '<b@x>', sent_at: '2026-11-17T10:02:00Z' })] });
  const thread = inboxThread(entry);
  const messages = thread.items.filter((item) => item.kind === 'message');
  assert.equal(thread.items[0].kind, 'time');
  assert.equal(messages[0].kind === 'message' && messages[0].plain, 'DoorDash\n\nYour order is on its way');
  assert.equal(messages[0].kind === 'message' && messages[0].quoted_history_hidden, true);
  assert.equal(messages[0].kind === 'message' && messages[0].subject, 'Your order');
  assert.equal(messages[1].kind === 'message' && messages[1].subject, null, 'the same subject is not repeated');
});

test('a chat thread uses the full message history and marks your own messages', () => {
  const [entry] = assembleInbox({ me: 'me', native: [native], mailRows: [] });
  const thread = inboxThread(entry, [
    nativeMessage({ id: 'm1', conversation_id: native.id, sender_id: 'me', body: 'Coffee?', created_at: '2026-11-17T11:58:00Z', reply_to_message_id: null }, 'me'),
    nativeMessage({ id: 'm2', conversation_id: native.id, sender_id: 'ada', body: 'See you then', created_at: '2026-11-17T12:00:00Z', reply_to_message_id: 'm1' }, 'me'),
  ]);
  const messages = thread.items.flatMap((item) => (item.kind === 'message' ? [item] : []));
  assert.deepEqual(messages.map((item) => item.direction), ['outbound', 'inbound']);
  assert.deepEqual(messages.map((item) => item.sender_name), [null, 'Ada Lovelace']);
  assert.equal(messages[1].reply_to_message_id, 'm1');
});
