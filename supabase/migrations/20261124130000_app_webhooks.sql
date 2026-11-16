-- Outbound webhooks for integrated apps (ADR 0041).
--
-- When something happens on a record that carries an app context, a trigger writes one row to
-- app_private.app_webhook_outbox. The Worker's per-minute cron claims rows with the service role,
-- POSTs each to the app's URL with an HMAC signature, then settles them: delivered rows are deleted,
-- failed ones are retried with exponential backoff, and anything older than 24 hours is dropped.
--
-- Payloads hold IDs and the context only, never message text or comment text. The outbox is in
-- app_private, which PostgREST does not expose, and only the service role can claim or settle.

create table if not exists app_private.app_webhook_outbox (
  id uuid primary key default gen_random_uuid(),
  app text not null,
  event_type text not null check (event_type in ('message.created', 'post.liked', 'post.commented', 'post.deleted')),
  payload jsonb not null,
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default pg_catalog.clock_timestamp(),
  last_error text
);

create index if not exists app_webhook_outbox_due_idx on app_private.app_webhook_outbox (app, next_attempt_at);
alter table app_private.app_webhook_outbox enable row level security;
revoke all on app_private.app_webhook_outbox from public, anon, authenticated;

comment on table app_private.app_webhook_outbox is 'Pending webhook deliveries to integrated apps (ADR 0041). IDs and app context only; never message or comment text.';

create or replace function app_private.enqueue_app_webhook(p_type text, p_context jsonb, p_data jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_context is null or (p_context ->> 'app') is null then return; end if;
  insert into app_private.app_webhook_outbox (app, event_type, payload)
  values (p_context ->> 'app', p_type, p_data || jsonb_build_object('context', p_context));
end;
$$;

revoke all on function app_private.enqueue_app_webhook(text, jsonb, jsonb) from public, anon, authenticated;

-- Everyone involved except the person who acted.
create or replace function app_private.app_webhook_recipients(p_people uuid[], p_actor uuid)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select coalesce(jsonb_agg(distinct person), '[]'::jsonb)
  from unnest(p_people) person
  where person is not null and person is distinct from p_actor;
$$;

revoke all on function app_private.app_webhook_recipients(uuid[], uuid) from public, anon, authenticated;

create or replace function app_private.app_webhook_message_created()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_context jsonb;
begin
  select context into v_context from public.conversations where id = new.conversation_id;
  if v_context is null then return null; end if;
  perform app_private.enqueue_app_webhook('message.created', v_context, jsonb_build_object(
    'conversation_id', new.conversation_id,
    'message_id', new.id,
    'actor_id', new.sender_id,
    'recipient_ids', app_private.app_webhook_recipients(
      array(select member.user_id from public.conversation_members member where member.conversation_id = new.conversation_id),
      new.sender_id
    )
  ));
  return null;
end;
$$;

create or replace function app_private.app_webhook_post_liked()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_post public.posts;
begin
  select * into v_post from public.posts where id = new.post_id;
  if v_post.context is null then return null; end if;
  perform app_private.enqueue_app_webhook('post.liked', v_post.context, jsonb_build_object(
    'post_id', v_post.id,
    'actor_id', new.user_id,
    'recipient_ids', app_private.app_webhook_recipients(array[v_post.author_id], new.user_id)
  ));
  return null;
end;
$$;

create or replace function app_private.app_webhook_post_commented()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_post public.posts;
begin
  select * into v_post from public.posts where id = new.post_id;
  if v_post.context is null then return null; end if;
  perform app_private.enqueue_app_webhook('post.commented', v_post.context, jsonb_build_object(
    'post_id', v_post.id,
    'comment_id', new.id,
    'actor_id', new.author_id,
    'recipient_ids', app_private.app_webhook_recipients(array[v_post.author_id], new.author_id)
  ));
  return null;
end;
$$;

-- A post is gone for the app when its author deletes it or moderation removes it.
create or replace function app_private.app_webhook_post_deleted()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := coalesce(auth.uid(), old.author_id);
begin
  if old.context is null then return null; end if;
  if tg_op = 'UPDATE' and not (old.removed_at is null and new.removed_at is not null) then return null; end if;
  perform app_private.enqueue_app_webhook('post.deleted', old.context, jsonb_build_object(
    'post_id', old.id,
    'actor_id', v_actor,
    'recipient_ids', app_private.app_webhook_recipients(array[old.author_id], v_actor)
  ));
  return null;
end;
$$;

revoke all on function app_private.app_webhook_message_created() from public, anon, authenticated;
revoke all on function app_private.app_webhook_post_liked() from public, anon, authenticated;
revoke all on function app_private.app_webhook_post_commented() from public, anon, authenticated;
revoke all on function app_private.app_webhook_post_deleted() from public, anon, authenticated;

drop trigger if exists messages_app_webhook on public.messages;
create trigger messages_app_webhook after insert on public.messages
  for each row execute function app_private.app_webhook_message_created();

drop trigger if exists post_likes_app_webhook on public.post_likes;
create trigger post_likes_app_webhook after insert on public.post_likes
  for each row execute function app_private.app_webhook_post_liked();

drop trigger if exists post_comments_app_webhook on public.post_comments;
create trigger post_comments_app_webhook after insert on public.post_comments
  for each row execute function app_private.app_webhook_post_commented();

drop trigger if exists posts_app_webhook_deleted on public.posts;
create trigger posts_app_webhook_deleted after delete on public.posts
  for each row execute function app_private.app_webhook_post_deleted();

drop trigger if exists posts_app_webhook_removed on public.posts;
create trigger posts_app_webhook_removed after update of removed_at on public.posts
  for each row execute function app_private.app_webhook_post_deleted();

-- The cron claims due deliveries for the apps it has a URL and secret for. A claimed row is leased
-- for five minutes, so a Worker that dies mid-batch never loses it and two runs never send it twice
-- at once. Rows older than 24 hours are dropped here.
create or replace function public.open_media_claim_app_webhooks(p_apps text[], p_limit integer default 50)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rows jsonb;
begin
  delete from app_private.app_webhook_outbox where created_at < pg_catalog.clock_timestamp() - interval '24 hours';
  with picked as (
    select outbox.id
    from app_private.app_webhook_outbox outbox
    where outbox.app = any(coalesce(p_apps, '{}'::text[])) and outbox.next_attempt_at <= pg_catalog.clock_timestamp()
    order by outbox.created_at, outbox.id
    limit least(greatest(coalesce(p_limit, 50), 1), 200)
    for update skip locked
  ), claimed as (
    update app_private.app_webhook_outbox outbox
    set attempts = outbox.attempts + 1, next_attempt_at = pg_catalog.clock_timestamp() + interval '5 minutes'
    from picked
    where outbox.id = picked.id
    returning outbox.*
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', claimed.id, 'app', claimed.app, 'type', claimed.event_type, 'created_at', claimed.created_at,
    'data', claimed.payload, 'attempts', claimed.attempts
  ) order by claimed.created_at, claimed.id), '[]'::jsonb)
  into v_rows
  from claimed;
  return v_rows;
end;
$$;

-- Delivered rows are deleted. A failure waits 1, 2, 4 … minutes (at most 3 hours) before the next
-- try, which gives about a dozen attempts before the 24-hour cut-off.
create or replace function public.open_media_settle_app_webhooks(p_delivered uuid[], p_failed jsonb default '[]'::jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer := 0;
  v_more integer := 0;
begin
  delete from app_private.app_webhook_outbox where id = any(coalesce(p_delivered, '{}'::uuid[]));
  get diagnostics v_count = row_count;
  if jsonb_typeof(p_failed) = 'array' then
    update app_private.app_webhook_outbox outbox
    set next_attempt_at = pg_catalog.clock_timestamp()
          + least(interval '1 minute' * power(2, least(greatest(outbox.attempts - 1, 0), 10)), interval '3 hours'),
        last_error = left(failed.error, 300)
    from jsonb_to_recordset(p_failed) as failed(id uuid, error text)
    where outbox.id = failed.id;
    get diagnostics v_more = row_count;
  end if;
  return v_count + v_more;
end;
$$;

revoke all on function public.open_media_claim_app_webhooks(text[], integer) from public, anon, authenticated;
revoke all on function public.open_media_settle_app_webhooks(uuid[], jsonb) from public, anon, authenticated;
grant execute on function public.open_media_claim_app_webhooks(text[], integer) to service_role;
grant execute on function public.open_media_settle_app_webhooks(uuid[], jsonb) to service_role;
