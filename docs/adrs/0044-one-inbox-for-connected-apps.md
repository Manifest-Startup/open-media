# ADR 0044: One inbox for connected apps, built from the app's own code

- Status: **accepted** (2026-11-17). Builds on [ADR 0041](0041-app-integrations.md) (apps signed in with Open Media), [ADR 0023](0023-editable-contacts-and-one-conversation-per-person.md) (one conversation per person or company) and [ADR 0043](0043-agent-parity-and-every-marketplace.md) (agent parity).

## Context

Manifest shows a person's Open Media messages. Its first version listed only native chats tagged for Manifest and then added a separate Email tab: it grouped `GET /v1/me/email` rows by subject in Python and printed raw `body_text`. That copied the app's inbox logic badly. Plain-text mail rendered as large blank gaps, and replying to email was impossible, because `/v1/connected` reached no send or mark-read route for mail.

The app builds its inbox on the device from pure modules in `src/domain`. Those are `normalizeStoredEmail`, `mapBridgeSnapshot`, `layoutThread` and `formatEmailBody`; the reply rules lived inline in `OpenMediaApp.tsx`.

## Decision

- `/v1/me/inbox` (and therefore `/v1/connected/me/inbox`) returns the app's inbox, assembled in the Worker (`services/mail-sync/src/inbox.ts`) with those same modules:
  - `GET /v1/me/inbox`: chats, bridged chats and email in one list, newest first.
  - `GET /v1/me/inbox/{id}`: one conversation laid out with `layoutThread`, email bodies as `formatEmailBody` segments.
  - `POST /v1/me/inbox/{id}/messages`: replies.
  - `POST /v1/me/inbox/{id}/read`: marks the conversation read wherever it came from.
- The reply rules move to `emailReply` in `src/domain/emailNormalization.ts`. These are who it goes to, reply all in a group, the subject, threading and the mailbox it is sent from. The app and the Worker both call it. The stored-mail row mapping moves to `storedMailFromRows` there too.
- Times are ISO. Clients format them in the person's time zone, because the Worker runs in UTC.
- MCP tools: `list_inbox`, `open_inbox_conversation`, `reply_in_inbox` and `mark_inbox_read`.

## Consequences

- Connected apps show one inbox with the app's grouping, text cleaning and reply behaviour, and never re-implement it. A fix in `src/domain` reaches the app, the API and every connected app at once.
- Each request re-reads up to 500 stored emails and the person's chats. That is fine at current sizes; paging can come later without changing the shape.
- Contact merging (ADR 0023 `mergeByContact`) needs the person's decrypted contact cards. The server inbox doesn't merge yet, so a person's chat and email stay two rows.
