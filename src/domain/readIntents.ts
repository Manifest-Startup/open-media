import { Conversation } from './models';

/**
 * What the person just did to a chat or an email on this device: read it, or marked it unread.
 *
 * Messages reloads all the time (a realtime nudge, the 5 s bridged poll, live mail), and a reload
 * that left before the change reached the server comes back with the old state. Without this the
 * row blinks back to unread (and back into the Unread list) a moment after it was read. An intent
 * holds the person's choice over those stale reloads until the server has surely caught up.
 */
export interface ReadIntent {
  unread: boolean;
  /**
   * The newest message from someone else when the person acted (see newestInboundAt); only a newer
   * one is news again. The person's own reply right after reading doesn't count.
   */
  lastMessageAt?: string;
  expiresAt: number;
}

export type ReadIntents = Map<string, ReadIntent>;

/** Long enough for the slowest path (a Matrix receipt through a bridge), short enough to self-heal. */
export const readIntentTtlMs = 20_000;

export function readIntent(unread: boolean, lastMessageAt?: string, now = Date.now()): ReadIntent {
  return { unread, lastMessageAt, expiresAt: now + readIntentTtlMs };
}

/**
 * When someone else last wrote in a conversation: its newest inbound message, or lastMessageAt when
 * the reload carries no messages to tell by.
 */
export function newestInboundAt(conversation: Conversation): string | undefined {
  if (!conversation.messages.length) return conversation.lastMessageAt;
  let newest: string | undefined;
  for (const message of conversation.messages) {
    if (message.direction !== 'inbound') continue;
    if (!newest || Date.parse(message.sentAt) > Date.parse(newest)) newest = message.sentAt;
  }
  return newest;
}

/**
 * Forgets an intent after its write failed, but only when it is still the one that write set: a
 * newer choice for the same chat or email stays. True when it was forgotten.
 */
export function dropReadIntent(intents: ReadIntents, key: string, intent: ReadIntent): boolean {
  if (intents.get(key) !== intent) return false;
  intents.delete(key);
  return true;
}

/**
 * Chats (by their own id) with the person's recent read or unread choice laid over what the server
 * returned. Read wins until a newer message arrives; unread keeps at least one unread. Expired
 * intents are dropped. The same array comes back when nothing changed.
 */
export function applyReadIntents(conversations: Conversation[], intents: ReadIntents, now = Date.now()): Conversation[] {
  if (!intents.size) return conversations;
  let changed = false;
  const result = conversations.map((conversation) => {
    const intent = intents.get(conversation.id);
    if (!intent) return conversation;
    if (now >= intent.expiresAt) {
      intents.delete(conversation.id);
      return conversation;
    }
    if (intent.unread) {
      if (conversation.unreadCount > 0) return conversation;
      changed = true;
      return { ...conversation, unreadCount: 1 };
    }
    const inbound = newestInboundAt(conversation);
    if (inbound && (!intent.lastMessageAt || Date.parse(inbound) > Date.parse(intent.lastMessageAt))) {
      // Someone else wrote again since it was read: that is new, so the server's count stands.
      intents.delete(conversation.id);
      return conversation;
    }
    if (conversation.unreadCount === 0) return conversation;
    changed = true;
    return { ...conversation, unreadCount: 0 };
  });
  return changed ? result : conversations;
}

/** The key an email's intent is stored under. */
export function mailIntentKey(accountId: string, sourceMessageId: string): string {
  return `${accountId}:${sourceMessageId}`;
}

/** Stored email with the person's recent read or unread choice laid over each message's flag. */
export function applyMailReadIntents<T extends { accountId: string; sourceMessageId: string; unread?: boolean }>(
  stored: T[],
  intents: ReadIntents,
  now = Date.now(),
): T[] {
  if (!intents.size) return stored;
  for (const [key, intent] of intents) if (now >= intent.expiresAt) intents.delete(key);
  let changed = false;
  const result = stored.map((message) => {
    const intent = intents.get(mailIntentKey(message.accountId, message.sourceMessageId));
    if (!intent || Boolean(message.unread) === intent.unread) return message;
    changed = true;
    return { ...message, unread: intent.unread };
  });
  return changed ? result : stored;
}
