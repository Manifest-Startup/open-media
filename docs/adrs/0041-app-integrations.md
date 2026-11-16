# ADR 0041: App integrations (Manifest first): REST over OAuth, app context, video upload and webhooks

- Status: **accepted; built, not deployed** (2026-11-15). Unit, route and database tests pass, and the whole flow ran against the local stack (sign-in session, context, idempotent send, a streamed MP4 upload through Supabase Storage, publish, like, comment, the app feed, deletion and a webhook drain). The "From Manifest" chip on a post was seen in the web app at 375 px, signed out. On the iOS Simulator (iPhone 17 Pro, debug build against local Metro and the local stack, signed in with a synthetic account), the chip was seen on a conversation in the inbox list and in the chat header, on a video post in the feed, on a text post (in search results), and on the clip in Clips, in light and dark mode at phone size. Tapping the chip (it opens manifeststartup.com) was not tried, and the synthetic test video has no frames, so playback was not checked. Not yet run against production. Android has not been checked (the Mac has JDK 11; Android needs 17+).
- Contract: [MANIFEST_INTEGRATION_CONTRACT.md](../MANIFEST_INTEGRATION_CONTRACT.md) (v1). Builds on [ADR 0009](0009-short-video-posting.md) (post videos) and [ADR 0027](0027-one-agent-plugin-for-every-marketplace.md) ("Sign in with Open Media").

## Context

Manifest, a startup-ideas site, wants its messages and pitch videos to live in Open Media: a founder and an investor talk in an Open Media conversation, and Veo pitch clips are Open Media video posts. Manifest's backend calls Open Media for people who connected their account, shows clips from Open Media, and needs to hear about new messages, likes and comments without polling.

Until now, "Sign in with Open Media" only reached `/account/mcp`. The REST API took Supabase session tokens only, posts could not carry a video through the API, nothing recorded which app a record belongs to, and Open Media never called anyone back.

## Decision

1. **REST over OAuth at `/v1/connected/me/*`.** The OAuth provider protects the prefix (`apiRoute`). For an account grant, the Worker rewrites the request to `/v1/me/*` with the person's own Supabase session from the grant, exactly as `/account/mcp` reaches `/me/mcp`. The same code, database rules and checks answer it. Differences on the prefix:
   - errors use OAuth's `{error, error_description}`;
   - the rate limit counts per person, because one app server speaks for many people from one address;
   - an Events grant gets 403 `insufficient_scope`.
   `/v1/me/*` with a Supabase token is unchanged. New fields are only added to it.
2. **Web apps are OAuth clients by Client ID Metadata Document.** Manifest's `client_id` is `https://manifeststartup.com/oauth/open-media-client.json`. The provider fetches and validates that document (it needs the `global_fetch_strictly_public` flag, which the Worker has), and checks the `redirect_uri` against it and PKCE S256. Asking for `scope=account` starts the account sign-in. No allowlist secret is needed.
3. **App context.** `conversations.context` and `posts.context` are optional JSON objects `{app, idea_id?, title?, url?}`, with a generated `source_app` column for `?app=` filters.
   - The database checks every context (`app_private.app_context_valid`): it must be at most 2 KB, use only those keys, name a listed app, and its `url` must be https on that app's own site. So a "From Manifest" chip can never link somewhere else.
   - A conversation's context is set once and never replaced. A post's is set when it is published.
   - Adding an app means a migration (the database list) and an entry in `src/domain/appContext.ts`.
4. **Video upload through the API.** `POST /v1/me/media/videos` takes the raw file (MP4, MOV or WebM, at most 100 MB, with Content-Length). The Worker streams it into `post-videos/<uid>/<uuid>.<ext>` as the person, so Storage's folder rule applies, and never holds the whole file. On the way it:
   - checks the container from the file's first bytes;
   - hashes it (SHA-256);
   - reads the length and frame size from `moov` or the WebM header (`src/domain/videoInfo.ts`).
   The file is not changed. A file that is unreadable, too long or not a video is deleted again. `POST /v1/me/posts` accepts the returned object as `video`, through the existing `open_media_create_post` checks.
5. **Webhooks from an outbox.** Triggers write `message.created`, `post.liked`, `post.commented` and `post.deleted` (deletion or moderation removal) for records with a context into `app_private.app_webhook_outbox`.
   - The per-minute cron claims rows with the service role (a five-minute lease), POSTs each one and settles it. Delivered rows are deleted. Failures back off 1, 2, 4 … minutes, at most 3 hours, and are dropped after 24 hours.
   - Each request is signed: `X-Open-Media-Signature: sha256=HMAC(secret, timestamp + "." + body)`.
   - Targets come from the `APP_WEBHOOKS` Worker secret.
   - Payloads carry IDs, recipients and the context, never message or comment text.
6. **Realtime.** `POST /v1/me/realtime-token` returns the person's own short-lived session, so a browser can subscribe to `postgres_changes` on `messages`, limited by row-level security.
7. **UI.** Posts, clips and conversations with a valid context show a small "From Manifest" chip linking to `context.url`. In list rows it is a plain label, so the row stays one tap target.

## Consequences

- An app with an account grant can do over REST what an agent can do on `/account/mcp`. Nothing it can do is new for the account.
- The realtime token is the person's real session (about an hour), handed to the app's browser. It can do what the person can do through Supabase directly, within row-level security. That is no more than the grant already allows, but it is broader than "Realtime only". A narrower, Realtime-only token would need Open Media to mint its own JWTs.
- Public posts now include the author's id. It was already public in every video's file path. Webhook recipients and conversation members are named by these ids.
- Uploads that are never published stay in Storage, as they do for the app. A clean-up job is future work.
- Cloudflare limits request bodies to 100 MB on the Free and Pro plans, so a file of exactly 100 MB plus headers may be refused at the edge. Supabase's project-wide upload limit must be at least 100 MB.
- Veo clips have no location metadata, so nothing is stripped on the server. A phone video uploaded through the API keeps its metadata. The app strips it on the device before uploading.
