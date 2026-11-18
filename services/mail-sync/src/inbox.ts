/**
 * One inbox for apps signed in with Open Media (`/v1/me/inbox`, also `/v1/connected/me/inbox`).
 *
 * It is the app's inbox, assembled on the server with the app's own code: native chats, bridged
 * chats (`mapBridgeSnapshot`) and email (`normalizeStoredEmail`: one conversation per person or
 * company), newest first. Threads use `layoutThread` (runs, time breaks, subjects only when they
 * change) and `formatEmailBody` (HTML to text, quoted history cut, links). Replies go through
 * `emailReply` for email, the same rules the app follows. Times are ISO; clients format them in
 * the person's own time zone.
 */
import { BridgeSnapshot, mapBridgeSnapshot } from '../../../src/domain/bridgedChats';
import { formatEmailBody } from '../../../src/domain/emailBody';
import { colorFor, initialsFor, normalizeStoredEmail, storedMailFromRows } from '../../../src/domain/emailNormalization';
import type { AppContext } from '../../../src/domain/appContext';
import type { Conversation, Message, MessageSource, Person } from '../../../src/domain/models';
import { conversationTitle } from '../../../src/domain/selectors';
import { layoutThread } from '../../../src/domain/threadLayout';

export type InboxKind = 'chat' | 'email' | 'bridged';

/** A native conversation as `AccountApi.conversations()` returns it (`conversations` shape). */
export interface NativeConversation {
  id: string;
  kind: string;
  title: string;
  context: AppContext | null;
  members: { id: string; handle: string | null; display_name: string; avatar_url: string | null }[];
  last_message: { id: string; body: string; sender_id: string; created_at: string } | null;
  unread_count: number;
  updated_at: string;
}

export interface NativeMessageRow { id: string; conversation_id: string; sender_id: string; body: string; created_at: string; reply_to_message_id: string | null }

export interface InboxSources {
  me: string;
  native: NativeConversation[];
  mailRows: Array<Record<string, unknown>>;
  unseenRows?: Array<{ account_id: string; source_message_id: string }>;
  bridged?: BridgeSnapshot;
}

export interface InboxEntry { conversation: Conversation; kind: InboxKind }

function nativePerson(member: NativeConversation['members'][number]): Person {
  const name = member.display_name || member.handle || 'Someone';
  return {
    id: member.id,
    name,
    initials: initialsFor(name),
    avatarColor: colorFor(member.id),
    identities: [],
    ...(member.avatar_url ? { avatarUrls: [member.avatar_url] } : {}),
  };
}

export function nativeMessage(row: NativeMessageRow, me: string): Message {
  return {
    id: row.id,
    sourceMessageId: row.id,
    conversationId: row.conversation_id,
    senderPersonId: row.sender_id,
    senderIdentityId: '',
    recipientPersonIds: [],
    sentAt: row.created_at,
    body: row.body,
    source: 'open_media',
    channel: 'native',
    direction: row.sender_id === me ? 'outbound' : 'inbound',
    deliveryState: 'sent',
    ...(row.reply_to_message_id ? { replyToMessageId: row.reply_to_message_id } : {}),
  };
}

function nativeConversation(raw: NativeConversation, me: string): Conversation {
  const others = raw.members.filter((member) => member.id !== me);
  const last = raw.last_message;
  return {
    id: raw.id,
    participants: (others.length ? others : raw.members).map(nativePerson),
    messages: last ? [nativeMessage({ ...last, conversation_id: raw.id, reply_to_message_id: null }, me)] : [],
    sourceSummary: ['open_media'],
    lastMessageAt: last?.created_at ?? raw.updated_at,
    preview: last?.body ?? '',
    unreadCount: raw.unread_count,
    labels: [],
    ...(raw.kind === 'group' && raw.title ? { groupTitle: raw.title } : {}),
    ...(raw.context ? { appContext: raw.context } : {}),
  } as Conversation;
}

/** Every conversation, newest first: the list the app shows. */
export function assembleInbox(sources: InboxSources): InboxEntry[] {
  const entries: InboxEntry[] = [
    ...sources.native.map((raw) => ({ conversation: nativeConversation(raw, sources.me), kind: 'chat' as const })),
    ...(sources.bridged ? mapBridgeSnapshot(sources.bridged).map((conversation) => ({ conversation, kind: 'bridged' as const })) : []),
    ...normalizeStoredEmail(storedMailFromRows(sources.mailRows, sources.unseenRows ?? [])).map((conversation) => ({ conversation, kind: 'email' as const })),
  ];
  return entries.sort((a, b) => Date.parse(b.conversation.lastMessageAt) - Date.parse(a.conversation.lastMessageAt));
}

function sourceOf(conversation: Conversation): MessageSource {
  return conversation.messages[conversation.messages.length - 1]?.source ?? conversation.sourceSummary[0] ?? 'open_media';
}

export function inboxSummary({ conversation, kind }: InboxEntry) {
  const person = conversation.participants[0];
  return {
    id: conversation.id,
    kind,
    source: sourceOf(conversation),
    title: conversationTitle(conversation) || 'Someone',
    initials: person?.initials ?? '?',
    avatar_color: person?.avatarColor ?? null,
    avatar_urls: person?.avatarUrls ?? [],
    group: conversation.participants.length > 1,
    company: conversation.company ?? null,
    preview: conversation.preview,
    last_message_at: conversation.lastMessageAt,
    unread_count: conversation.unreadCount,
    context: conversation.appContext ?? null,
    can_reply: kind !== 'email' || conversation.email?.canSend !== false,
  };
}

/** One conversation laid out as the app lays it out. `messages` replaces the summary's for chats. */
export function inboxThread(entry: InboxEntry, messages: Message[] = entry.conversation.messages) {
  const people = new Map(entry.conversation.participants.map((person) => [person.id, person.name]));
  const items = layoutThread(messages).map((item) => {
    if (item.kind === 'time') {
      const next = messages.find((message) => `time-${message.id}` === item.key) ?? messages[0];
      return { kind: 'time' as const, key: item.key, at: next?.sentAt ?? null };
    }
    const { message } = item;
    const body = message.channel === 'email' ? formatEmailBody(message.body) : { segments: [{ text: message.body }], plain: message.body, hadQuotedHistory: false };
    return {
      kind: 'message' as const,
      key: item.key,
      id: message.id,
      direction: message.direction,
      sender_name: message.direction === 'outbound' ? null : people.get(message.senderPersonId) ?? null,
      sent_at: message.sentAt,
      source: message.source,
      subject: item.subject ?? null,
      body: body.segments,
      plain: body.plain,
      quoted_history_hidden: body.hadQuotedHistory,
      attachments: (message.attachments ?? []).filter((attachment) => !attachment.inline).length,
      reply_to_message_id: message.replyToMessageId ?? null,
      group_start: item.groupStart,
      group_end: item.groupEnd,
    };
  });
  return { conversation: inboxSummary(entry), items };
}
