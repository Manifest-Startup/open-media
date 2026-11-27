import { aiConversationId } from './aiChat';
import { Conversation, PeopleFilter } from './models';

/** Open Media's own notices account (listing checks and other service messages), seeded in `20261030120000_marketplace_trust.sql`. */
export const openMediaNoticesId = '0e4d0000-0000-4000-8000-000000000001';

export interface ConversationFilters {
  peopleFilter: PeopleFilter;
  query: string;
  unreadOnly: boolean;
  /**
   * With unread only: conversations that stay listed though they are read now, like Apple Mail's
   * Unread mailbox. Reading a conversation from the list must not pull it out from under the person.
   */
  keep?: ReadonlySet<string>;
}

/** Whether a conversation stays in the Unread list: unread, or kept there by its id or a channel's. */
export function listedAsUnread(conversation: Conversation, keep?: ReadonlySet<string>): boolean {
  if (conversation.unreadCount > 0) return true;
  if (!keep?.size) return false;
  return keep.has(conversation.id) || Boolean(conversation.channels?.some((channel) => keep.has(channel.id)));
}

/**
 * A company rather than a person: company mail (no-reply, newsletter and support addresses, mail
 * subdomains, brand-verified senders), a contact saved as a company, or a business text sender
 * (a short code such as 57575, or a named sender such as "AX-HDFCBK").
 */
export function isCompanyConversation(conversation: Conversation): boolean {
  if (conversation.company) return true;
  if (conversation.participants.length !== 1) return false;
  if (conversation.participants[0].id === openMediaNoticesId) return true;
  return conversation.participants[0].identities.some((identity) => identity.kind === 'phone' && isBusinessNumber(identity.value));
}

/** Short codes (6 digits or fewer) and alphanumeric sender IDs belong to businesses, not people. */
export function isBusinessNumber(value: string): boolean {
  const text = value.trim();
  if (!text) return false;
  if (/[a-z]/i.test(text)) return true;
  const digits = text.replace(/\D/g, '');
  return digits.length > 0 && digits.length <= 6;
}

export function filterConversations(
  conversations: Conversation[],
  filters: ConversationFilters,
): Conversation[] {
  const normalizedQuery = filters.query.trim().toLocaleLowerCase();

  return conversations
    .filter((conversation) => {
      // People means individuals: one person's own email or number, never a company's.
      // Open Media AI is neither a person nor a company: it shows under All only.
      if (filters.peopleFilter === 'direct') return conversation.participants.length === 1 && conversation.id !== aiConversationId && !isCompanyConversation(conversation);
      if (filters.peopleFilter === 'companies') return isCompanyConversation(conversation);
      if (filters.peopleFilter === 'groups') return conversation.participants.length > 1;
      if (filters.peopleFilter === 'favorites') return conversation.participants.some((person) => person.favorite);
      return true;
    })
    .filter((conversation) => !filters.unreadOnly || listedAsUnread(conversation, filters.keep))
    .filter((conversation) => {
      if (!normalizedQuery) return true;
      const searchable = [
        conversation.groupTitle,
        conversation.preview,
        ...conversation.labels,
        ...conversation.participants.flatMap((person) => [
          person.name,
          ...person.identities.flatMap((identity) => [identity.value, identity.label, identity.source]),
        ]),
        ...conversation.messages.flatMap((message) => [message.body, message.emailContext?.subject]),
      ]
        .filter(Boolean)
        .join(' ')
        .toLocaleLowerCase();
      return searchable.includes(normalizedQuery);
    })
    // Newest first, with the Open Media AI chat pinned on top (ADR 0028).
    .sort((a, b) => Number(b.sourceSummary.includes('ai')) - Number(a.sourceSummary.includes('ai')) || Date.parse(b.lastMessageAt) - Date.parse(a.lastMessageAt));
}

export function conversationTitle(conversation: Conversation): string {
  return conversation.groupTitle ?? conversation.participants.map((person) => person.name).join(', ');
}
