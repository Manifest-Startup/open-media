# ADR 0045: Message drafts, written now and sent later

- Status: **accepted** (2026-11-23). Builds on [ADR 0041](0041-app-integrations.md) (apps signed in with Open Media) and [ADR 0043](0043-agent-parity-and-every-marketplace.md) (agent parity).

## Context

Manifest's goals (Manifest ADR 0020) prepare an outreach message, ask the person to approve the exact text, and only then send it through `/v1/connected`. Open Media had no drafts. So the prepared text lived only in Manifest, the person couldn't see or edit it in Open Media, and an agent had no way to leave a message for the person to send themselves.

## Decision

- Add a `public.message_drafts` table, readable and writable only by its owner (RLS), and only in conversations the owner belongs to. The other people in the conversation never see a draft.
- Add these REST routes (and the same under `/v1/connected/me/…`):
  - `POST /v1/me/conversations/{id}/drafts` saves a draft. An app may pass `app` and `ref` (its own id for the draft, such as a goal step), and saving again with the same pair updates that draft instead of adding another.
  - `GET /v1/me/drafts[?conversation_id=&limit=&before=]` lists unsent drafts a page at a time (`next_before`).
  - `PATCH /v1/me/drafts/{id}` changes the text.
  - `DELETE /v1/me/drafts/{id}` discards a draft.
  - `POST /v1/me/drafts/{id}/send` sends the draft as it is. The message's `client_id` is the draft id, so a retried send lands once. The draft is then marked `sent` with the message id and kept as the record of what was sent (if that message is later deleted, the draft stays `sent` with no message id).
- The account MCP server gets matching tools: `list_message_drafts`, `save_message_draft`, `update_message_draft`, `discard_message_draft` and `send_message_draft`. `send_message_draft` tells agents to confirm the exact text and recipient first.
- The account export (`GET /v1/me/export`) includes `messageDrafts`. Deleting the account deletes the drafts (`on delete cascade`).

## Consequences

- An app can put a prepared message where the person reads their messages, and the person can edit or send it there. Sending stays the person's decision, or the app's after the person approves the exact text, as before.
- Draft text written by an app is data, not instructions, for any agent that reads it.
- Not in this change:
  - the composer UI that shows a conversation's draft (web, iOS, Android);
  - delivery status beyond "sent" (delivered, read).
  These come next and need testing on every platform.
