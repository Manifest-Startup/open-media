-- App context on conversations and posts (ADR 0041).
--
-- An integrated app (first: Manifest) marks a conversation or a post as being about
-- something in that app, e.g. {"app": "manifest", "idea_id": "42", "title": "…",
-- "url": "https://manifeststartup.com/ideas/42"}. Open Media shows a "From Manifest" chip
-- linking to `url`, filters lists with ?app=, and tells the app about activity on its
-- records (20261124130000_app_webhooks.sql).
--
-- The context is checked here, not only in the Worker: only listed apps, only the keys
-- app/idea_id/title/url, at most 2 KB, and `url` must be https on that app's own site, so
-- a chip can never point somewhere else. `source_app` is derived from the context for
-- indexing and filtering; nobody writes it.

create or replace function app_private.app_context_valid(p_context jsonb)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_app text;
  v_hosts text[];
  v_url text;
  v_host text;
begin
  if p_context is null then return true; end if;
  if jsonb_typeof(p_context) <> 'object' then return false; end if;
  if octet_length(p_context::text) > 2048 then return false; end if;
  if exists (select 1 from jsonb_object_keys(p_context) key where key not in ('app', 'idea_id', 'title', 'url')) then return false; end if;
  if jsonb_typeof(p_context -> 'app') is distinct from 'string' then return false; end if;
  v_app := p_context ->> 'app';
  -- The integrated apps and their own sites. Adding an app is a migration (ADR 0041).
  v_hosts := case v_app when 'manifest' then array['manifeststartup.com'] else null end;
  if v_hosts is null then return false; end if;
  if p_context ? 'idea_id' and (
    jsonb_typeof(p_context -> 'idea_id') <> 'string'
    or char_length(btrim(p_context ->> 'idea_id')) = 0
    or char_length(p_context ->> 'idea_id') > 200
    or (p_context ->> 'idea_id') ~ '[[:cntrl:]]'
  ) then return false; end if;
  if p_context ? 'title' and (
    jsonb_typeof(p_context -> 'title') <> 'string'
    or char_length(btrim(p_context ->> 'title')) = 0
    or char_length(p_context ->> 'title') > 300
    or (p_context ->> 'title') ~ '[[:cntrl:]]'
  ) then return false; end if;
  if p_context ? 'url' then
    if jsonb_typeof(p_context -> 'url') <> 'string' then return false; end if;
    v_url := p_context ->> 'url';
    if char_length(v_url) > 2048 or v_url ~ '[[:space:][:cntrl:]\\]' then return false; end if;
    -- https://host[/path…]: no credentials, no port.
    v_host := lower(substring(v_url from '^https://([a-zA-Z0-9.-]+)(?:[/?#]|$)'));
    if v_host is null then return false; end if;
    if not exists (select 1 from unnest(v_hosts) allowed where v_host = allowed or v_host like '%.' || allowed) then return false; end if;
  end if;
  return true;
end;
$$;

revoke all on function app_private.app_context_valid(jsonb) from public;
grant execute on function app_private.app_context_valid(jsonb) to anon, authenticated, service_role;

alter table public.conversations
  add column if not exists context jsonb,
  add column if not exists source_app text generated always as (context ->> 'app') stored;
alter table public.conversations drop constraint if exists conversations_context_check;
alter table public.conversations add constraint conversations_context_check check (app_private.app_context_valid(context));

alter table public.posts
  add column if not exists context jsonb,
  add column if not exists source_app text generated always as (context ->> 'app') stored;
alter table public.posts drop constraint if exists posts_context_check;
alter table public.posts add constraint posts_context_check check (app_private.app_context_valid(context));

comment on column public.conversations.context is 'Optional app context {app, idea_id?, title?, url?} set by an integrated app (ADR 0041). Set once, never replaced.';
comment on column public.posts.context is 'Optional app context {app, idea_id?, title?, url?} set by an integrated app when publishing (ADR 0041).';

create index if not exists conversations_source_app_idx on public.conversations (source_app, updated_at desc) where source_app is not null;
create index if not exists posts_public_app_order_idx
  on public.posts (source_app, created_at desc, id desc)
  where removed_at is null and source_app is not null;

-- A member sets a conversation's context once; a second app or a second idea never replaces it.
create or replace function public.open_media_set_conversation_context(p_conversation_id uuid, p_context jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_context jsonb;
begin
  if v_user_id is null then
    raise exception 'A valid Open Media session is required.' using errcode = '42501';
  end if;
  if p_conversation_id is null or not app_private.is_conversation_member(p_conversation_id, v_user_id) then
    raise exception 'Conversation not found.' using errcode = 'P0002';
  end if;
  if p_context is null or not app_private.app_context_valid(p_context) then
    raise exception 'The app context is invalid.' using errcode = '22023';
  end if;
  update public.conversations set context = p_context where id = p_conversation_id and context is null;
  select context into v_context from public.conversations where id = p_conversation_id;
  return v_context;
end;
$$;

revoke all on function public.open_media_set_conversation_context(uuid, jsonb) from public, anon;
grant execute on function public.open_media_set_conversation_context(uuid, jsonb) to authenticated;

-- Public posts carry their context (or null).
create or replace function app_private.public_post_json(p_post public.posts, p_profile public.profiles)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', p_post.id,
    'body', p_post.body,
    'createdAt', p_post.created_at,
    'author', jsonb_build_object(
      'id', p_profile.id,
      'handle', p_profile.handle,
      'displayName', app_private.shown_name(p_profile),
      'avatarUrl', p_profile.avatar_url,
      'verified', app_private.is_verified(p_profile.id),
      'tipsEnabled', p_profile.tips_enabled
    ),
    'video', case when p_post.video_path is null then null else jsonb_build_object(
      'path', p_post.video_path,
      'posterPath', p_post.video_poster_path,
      'durationSeconds', p_post.video_duration_seconds,
      'width', p_post.video_width,
      'height', p_post.video_height,
      'contentType', p_post.video_content_type,
      'sha256', p_post.video_sha256
    ) end,
    'listing', app_private.listing_json(p_post.id),
    'paid', app_private.paid_json(p_post.id),
    'engagement', app_private.post_engagement_json(p_post.id, auth.uid()),
    'context', p_post.context
  );
$$;

-- Listing gains ?app=: only posts an integrated app published with its context.
drop function if exists public.open_media_public_posts(integer, timestamptz, uuid, text, text);
create or replace function public.open_media_public_posts(
  p_limit integer default 20,
  p_before_created_at timestamptz default null,
  p_before_id uuid default null,
  p_author_handle text default null,
  p_media text default null,
  p_app text default null
)
returns jsonb language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(item.post order by item.created_at desc, item.id desc), '[]'::jsonb)
  from (
    select app_private.public_post_json(post, profile) as post, post.created_at, post.id
    from public.posts post
    join public.profiles profile on profile.id = post.author_id
    where post.removed_at is null
      and (p_author_handle is null or profile.handle = lower(p_author_handle))
      and (p_media is distinct from 'video' or post.video_path is not null)
      and (p_app is null or post.source_app = p_app)
      and (
        p_before_created_at is null
        or (post.created_at, post.id) < (p_before_created_at, coalesce(p_before_id, 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid))
      )
      and app_private.can_view_profile(auth.uid(), post.author_id)
      and not app_private.listing_hidden(post.id, auth.uid())
    order by post.created_at desc, post.id desc
    limit least(greatest(coalesce(p_limit, 20), 1), 50)
  ) item;
$$;

revoke all on function public.open_media_public_posts(integer, timestamptz, uuid, text, text, text) from public;
grant execute on function public.open_media_public_posts(integer, timestamptz, uuid, text, text, text) to anon, authenticated;
comment on function public.open_media_public_posts(integer, timestamptz, uuid, text, text, text) is 'Public, anonymous-safe post listing with keyset pagination (max 50). p_media = ''video'' returns only video posts; p_app returns only posts with that app context.';

-- Publishing gains an optional context, set with the post (and kept on an idempotent retry).
drop function if exists public.open_media_create_post(uuid, text, jsonb);
create or replace function public.open_media_create_post(p_client_id uuid, p_body text, p_video jsonb default null, p_context jsonb default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_post jsonb;
  v_id uuid;
begin
  if p_context is not null and not app_private.app_context_valid(p_context) then
    raise exception 'The app context is invalid.' using errcode = '22023';
  end if;
  v_post := app_private.create_post(p_client_id, p_body, p_video);
  if p_context is null then return v_post; end if;
  v_id := (v_post ->> 'id')::uuid;
  update public.posts set context = p_context where id = v_id and author_id = auth.uid() and context is null;
  return (
    select app_private.public_post_json(post, profile)
    from public.posts post join public.profiles profile on profile.id = post.author_id
    where post.id = v_id
  );
end;
$$;

revoke all on function public.open_media_create_post(uuid, text, jsonb, jsonb) from public, anon;
grant execute on function public.open_media_create_post(uuid, text, jsonb, jsonb) to authenticated;
