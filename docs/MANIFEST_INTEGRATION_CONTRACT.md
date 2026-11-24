# Manifest ⇄ Open Media integration contract (v1)

Base: `https://api.openmedia.site` (local: the URL `npm run local` prints for the Worker). JSON everywhere. Errors: `{error, error_description}` with 4xx/5xx.

## 1. Identity — "Sign in with Open Media" for a web app (OAuth 2.1, PKCE, no client secret)
- Manifest is a public OAuth client identified by a **Client ID Metadata Document** URL:
  `client_id = https://manifeststartup.com/oauth/open-media-client.json`
  (doc: `{client_id, client_name:"Manifest", client_uri:"https://manifeststartup.com", redirect_uris:["https://manifeststartup.com/api/integrations/open-media/callback"], grant_types:["authorization_code","refresh_token"], response_types:["code"], token_endpoint_auth_method:"none", scope:"account"}`).
  Open Media must accept this client for scope `account` (the "Sign in with Open Media" grant). If CIMD is not supported for this grant, OM adds an allowlist secret `OAUTH_TRUSTED_CLIENTS` instead — but the Manifest side must not change.
- Endpoints (existing provider): `GET /authorize`, `POST /oauth/token` (authorization_code + refresh_token; read `token_endpoint` from discovery), discovery `/.well-known/oauth-authorization-server`. Access token ~1 h, refresh 90 d.
- **REST with OAuth (new):** every `/v1/me/*` route is also reachable as `/v1/connected/me/*` with `Authorization: Bearer <OAuth access token>`. Same request/response bodies. `/v1/me/*` with Supabase session tokens keeps working unchanged.

## 2. Messaging (under `/v1/connected`)
- `GET  /v1/connected/me` → `{id, handle, display_name, avatar_url, email, email_verified, has_profile}` (at least these fields). A brand-new account answers `has_profile: false` with `handle`, `display_name` and `avatar_url` null, instead of a 404 (ADR 0042). The sign-in gateway always asks new people for a name and handle before returning to the app, so this is rare.
- People manage their sign-in and the apps they connected at `https://openmedia.site/settings/security` (a stable address; signed out, it signs them in first).
- `GET  /v1/connected/me/conversations?app=manifest` → `{conversations:[{id, kind, title, context|null, members:[{id,handle,display_name,avatar_url}], last_message:{id,body,sender_id,created_at}|null, unread_count, updated_at}]}`. `app` filter optional (omit = all).
- `POST /v1/connected/me/conversations` `{handle, context?}` → 201 `{conversation:{…same shape…}}`. Re-uses the existing direct conversation with that person; sets `context` only if the conversation has none. `context` = `{app:"manifest", idea_id:string, title?:string, url?:string}` (≤ 2 KB, validated).
- `GET  /v1/connected/me/conversations/{id}/messages?limit=&before=` → `{messages:[{id, conversation_id, sender_id, body, created_at, reply_to_message_id|null}]}` newest-last.
- `POST /v1/connected/me/conversations/{id}/messages` `{body, client_id?}` (header `Idempotency-Key` also accepted) → 201 `{message:{…}}`.
- `POST /v1/connected/me/conversations/{id}/read` → 200.
- One inbox (ADR 0044): `GET /v1/connected/me/inbox?limit=` → `{conversations:[{id, kind:chat|email|bridged, source, title, initials, avatar_color, avatar_urls, group, company, preview, last_message_at, unread_count, context, can_reply}]}` newest first; `GET /v1/connected/me/inbox/{id}` → `{conversation, items:[{kind:'time', at} | {kind:'message', id, direction, sender_name, sent_at, source, subject, body:[{text,url?}], plain, attachments, reply_to_message_id, group_start, group_end}]}`; `POST /v1/connected/me/inbox/{id}/messages` `{body, reply_to_message_id?, client_id?}` → 201 (chat message or threaded email); `POST /v1/connected/me/inbox/{id}/read` → 200. Built from the app's own `src/domain` code.
- Drafts (ADR 0045): `POST /v1/connected/me/conversations/{id}/drafts` `{body, app?, ref?}` → 201 `{draft:{id, conversationId, text, app, ref, status:draft|sent, sentMessageId, createdAt, updatedAt}, created}` (same `app`+`ref` updates the draft; 409 `already_sent` once sent); `GET /v1/connected/me/drafts?conversation_id=` → `{drafts:[…]}` unsent only; `PATCH /v1/connected/me/drafts/{id}` `{body}`; `DELETE /v1/connected/me/drafts/{id}`; `POST /v1/connected/me/drafts/{id}/send` → 201 `{sent, conversationId, message, draftId}` (message `client_id` = draft id, so retries land once). Drafts are visible only to their owner.
- `POST /v1/connected/me/realtime-token` → `{supabase_url, anon_key, access_token, expires_at}` — the person's own short-lived Supabase access token so a browser can subscribe to Realtime `postgres_changes` on `messages` (RLS-limited).

## 3. Video clips
- `POST /v1/connected/me/media/videos` — raw request body, `Content-Type: video/mp4|video/quicktime|video/webm`, ≤ 100 MB → 201 `{video:{…opaque…}}`. OM stores it in `post-videos/<uid>/…`, computes sha256, strips nothing server-side (Veo output has no location data). The returned `video` object is passed back verbatim.
- `POST /v1/connected/me/posts` `{body, video?, context?, client_id?}` → 201 `{post:{id,…}}`. `video` = object from the upload. `context` same shape as above (`app`, `idea_id`, `title`, `url`).
- `DELETE /v1/connected/me/posts/{id}` → 200 (author only).
- Existing interactions, now also under `/v1/connected`: `POST|DELETE /v1/connected/me/posts/{id}/like`, `GET|POST /v1/connected/me/posts/{id}/comments` (`{body}`), reshare unchanged.
- Public read (no auth): `GET /v1/posts?media=video&app=manifest&limit=` and `GET /v1/feed?kind=clips&app=manifest`. Each post: `{id, body, created_at, author:{id,handle,display_name,avatar_url}, video:{url, poster_url|null, width|null, height|null, duration_ms|null}, context|null, counts:{likes, comments, reshares}}`. With a `/v1/connected` (or Supabase) bearer the same list is at `GET /v1/connected/me/feed?kind=clips&app=manifest` and adds `viewer:{liked:boolean}`.
- `GET /v1/posts/{id}` and `GET /v1/posts/{id}/comments` public.
- Open Media UI shows a small "From Manifest" chip on posts/conversations whose `context.app = "manifest"`, linking to `context.url`.

## 4. Outbound webhooks (new)
- Configured per app by Worker secret `APP_WEBHOOKS` = JSON `{"manifest":{"url":"https://manifeststartup.com/api/webhooks/open-media","secret":"<hex>"}}`.
- DB triggers write to `app_private.app_webhook_outbox` for: `message.created` (conversation has `context.app`), `post.liked`, `post.commented`, `post.deleted` (post has `context.app`). The existing `* * * * *` cron drains it (batch, retry with backoff up to ~24 h, then drop).
- Request: `POST <url>`, headers `Content-Type: application/json`, `X-Open-Media-Event: <type>`, `X-Open-Media-Delivery: <uuid>`, `X-Open-Media-Timestamp: <unix seconds>`, `X-Open-Media-Signature: sha256=<hex HMAC-SHA256(secret, timestamp + "." + raw_body)>`.
- Body (IDs only, never message text): `{id:<delivery uuid>, type, created_at, data:{conversation_id?, message_id?, post_id?, actor_id, recipient_ids:[om user ids], context}}`. Receivers reject timestamps older than 5 min and dedupe on `id`.
