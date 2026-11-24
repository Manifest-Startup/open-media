-- Message drafts (ADR 0045): a message the person (or an app or agent acting for them) has written
-- but not sent. A draft belongs to one person and one conversation they are in. Sending a draft
-- sends a normal message whose client_id is the draft id, so a retried send lands once, and the
-- draft records which message it became. Only the owner can see or change their drafts; the other
-- people in the conversation never see them.

create table if not exists public.message_drafts (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  body text not null check (char_length(btrim(body)) between 1 and 8000),
  -- Which app wrote it, e.g. 'manifest' (from the app context), or null when the person did.
  source_app text check (source_app is null or source_app ~ '^[a-z0-9][a-z0-9_-]{0,39}$'),
  -- The app's own reference (a goal step id, say), so the same draft is updated, not duplicated.
  external_ref text check (external_ref is null or char_length(external_ref) between 1 and 200),
  status text not null default 'draft' check (status in ('draft', 'sent')),
  -- The message it became. Null again if that message is later deleted; the draft stays 'sent'.
  sent_message_id uuid references public.messages(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists message_drafts_owner_idx on public.message_drafts (owner_id, status, updated_at desc);
create unique index if not exists message_drafts_external_ref_idx
  on public.message_drafts (owner_id, source_app, external_ref) where external_ref is not null;

alter table public.message_drafts enable row level security;
alter table public.message_drafts force row level security;

drop policy if exists "Owners read their drafts" on public.message_drafts;
drop policy if exists "Owners write drafts in their conversations" on public.message_drafts;
drop policy if exists "Owners change their drafts" on public.message_drafts;
drop policy if exists "Owners delete their drafts" on public.message_drafts;
create policy "Owners read their drafts" on public.message_drafts for select to authenticated
  using (owner_id = auth.uid());
create policy "Owners write drafts in their conversations" on public.message_drafts for insert to authenticated
  with check (owner_id = auth.uid() and app_private.is_conversation_member(conversation_id, auth.uid()));
create policy "Owners change their drafts" on public.message_drafts for update to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid() and app_private.is_conversation_member(conversation_id, auth.uid()));
create policy "Owners delete their drafts" on public.message_drafts for delete to authenticated
  using (owner_id = auth.uid());

revoke all on public.message_drafts from public, anon;
grant select, insert, update, delete on public.message_drafts to authenticated;

comment on table public.message_drafts is 'Unsent messages, owner-only (ADR 0045). Sending one creates a message with client_id = the draft id.';
