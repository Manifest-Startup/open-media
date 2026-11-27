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
  /** The conversation's newest message when the person acted; anything newer is news again. */
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
    if (intent.lastMessageAt && Date.parse(conversation.lastMessageAt) > Date.parse(intent.lastMessageAt)) {
      // Someone wrote again since it was read: that is new, so the server's count stands.
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
