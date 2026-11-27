import assert from 'node:assert/strict';
import test from 'node:test';

import { Conversation } from './models';
import { applyMailReadIntents, applyReadIntents, mailIntentKey, readIntent, ReadIntents, readIntentTtlMs } from './readIntents';

const chat = (id: string, unreadCount: number, lastMessageAt = '2026-11-27T10:00:00Z'): Conversation => ({
  id, participants: [], messages: [], sourceSummary: ['open_media'], lastMessageAt, preview: '', unreadCount, labels: [],
});
const now = Date.parse('2026-11-27T10:00:05Z');

test('a reload that left before the read reached the server does not bring the unread back', () => {
  const intents: ReadIntents = new Map([['a', readIntent(false, '2026-11-27T10:00:00Z', now)]]);
  const shown = applyReadIntents([chat('a', 2), chat('b', 1)], intents, now);
  assert.deepEqual(shown.map((item) => item.unreadCount), [0, 1]);
});

test('a newer message after reading is news again', () => {
  const intents: ReadIntents = new Map([['a', readIntent(false, '2026-11-27T10:00:00Z', now)]]);
  const shown = applyReadIntents([chat('a', 1, '2026-11-27T10:00:04Z')], intents, now);
  assert.equal(shown[0].unreadCount, 1);
  assert.equal(intents.size, 0, 'the intent is done');
});

test('marked unread stays unread over a stale reload', () => {
  const intents: ReadIntents = new Map([['a', readIntent(true, undefined, now)]]);
  assert.equal(applyReadIntents([chat('a', 0)], intents, now)[0].unreadCount, 1);
  assert.equal(applyReadIntents([chat('a', 3)], intents, now)[0].unreadCount, 3);
});

test('intents expire, and nothing to change returns the same array', () => {
  const intents: ReadIntents = new Map([['a', readIntent(false, undefined, now)]]);
  const list = [chat('a', 1)];
  assert.equal(applyReadIntents(list, intents, now + readIntentTtlMs), list);
  assert.equal(intents.size, 0);
  const settled = [chat('a', 0)];
  assert.equal(applyReadIntents(settled, new Map([['a', readIntent(false, undefined, now)]]), now), settled);
});

test('email keeps the read or unread flag the person just set', () => {
  const stored = [
    { accountId: 'acct', sourceMessageId: 'm1', unread: true },
    { accountId: 'acct', sourceMessageId: 'm2', unread: false },
    { accountId: 'acct', sourceMessageId: 'm3', unread: true },
  ];
  const intents: ReadIntents = new Map([
    [mailIntentKey('acct', 'm1'), readIntent(false, undefined, now)],
    [mailIntentKey('acct', 'm2'), readIntent(true, undefined, now)],
  ]);
  assert.deepEqual(applyMailReadIntents(stored, intents, now).map((item) => item.unread), [false, true, true]);
  assert.equal(applyMailReadIntents(stored, intents, now + readIntentTtlMs), stored);
  assert.equal(intents.size, 0);
});
