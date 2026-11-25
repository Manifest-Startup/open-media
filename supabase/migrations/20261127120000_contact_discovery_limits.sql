-- Contact discovery limits (ADR 0037).
--   * Each person can look up at most 1,000 new addresses and numbers a day. Asking again about
--     ones already looked up that day is free, so an address book re-syncing never runs out.
--     Only a hash of each value, salted with the person's id, is kept, for one day.
--   * People who chose to show only their handle (name_disclosure = 'handle_only') are not found
--     by email or number, which keeps that choice meaningful.

create table if not exists app_private.contact_discovery_lookups (
  user_id uuid not null references auth.users (id) on delete cascade,
  value_hash bytea not null,
  looked_up_at timestamptz not null default now(),
  primary key (user_id, value_hash)
);
create index if not exists contact_discovery_lookups_time on app_private.contact_discovery_lookups (looked_up_at);
alter table app_private.contact_discovery_lookups enable row level security;
revoke all on app_private.contact_discovery_lookups from public, anon, authenticated;

create or replace function public.open_media_discover_contacts(p_emails text[], p_phones text[])
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_viewer uuid := auth.uid();
  v_emails text[];
  v_phones text[];
  v_hashes bytea[];
  v_new integer;
  v_used integer;
begin
  if v_viewer is null then
    raise exception 'sign in to find your contacts' using errcode = '42501';
  end if;
  if coalesce(cardinality(p_emails), 0) + coalesce(cardinality(p_phones), 0) > 500 then
    raise exception 'send at most 500 addresses and numbers at a time' using errcode = '22023';
  end if;
  select coalesce(array_agg(distinct lower(btrim(value))), '{}') into v_emails
    from unnest(coalesce(p_emails, '{}')) as value where btrim(value) like '%_@_%';
  -- Numbers compare as digits with their country code; one without "+" is too ambiguous to match.
  select coalesce(array_agg(distinct regexp_replace(value, '\D', '', 'g')), '{}') into v_phones
    from unnest(coalesce(p_phones, '{}')) as value where btrim(value) like '+%' and length(regexp_replace(value, '\D', '', 'g')) between 8 and 15;

  -- Daily budget of new lookups per person (hashes only, salted with the person's id).
  delete from app_private.contact_discovery_lookups where looked_up_at < now() - interval '1 day';
  select coalesce(array_agg(distinct extensions.digest(v_viewer::text || ':' || value, 'sha256')), '{}') into v_hashes
    from unnest(v_emails || v_phones) as value;
  select count(*) into v_new from unnest(v_hashes) as h
    where not exists (select 1 from app_private.contact_discovery_lookups l where l.user_id = v_viewer and l.value_hash = h);
  select count(*) into v_used from app_private.contact_discovery_lookups where user_id = v_viewer;
  if v_new > 0 and v_used + v_new > 1000 then
    raise exception 'too many new contact lookups today; try again tomorrow' using errcode = '54000';
  end if;
  insert into app_private.contact_discovery_lookups (user_id, value_hash)
    select v_viewer, h from unnest(v_hashes) as h
    on conflict do nothing;

  return coalesce((
    select jsonb_agg(jsonb_build_object('kind', match.kind, 'value', match.value, 'handle', p.handle) order by match.kind, match.value)
    from (
      select 'email' as kind, lower(u.email) as value, u.id
        from auth.users u
        where u.email_confirmed_at is not null and lower(u.email) = any (v_emails)
      union all
      select 'phone', '+' || regexp_replace(u.phone, '\D', '', 'g'), u.id
        from auth.users u
        where u.phone_confirmed_at is not null and coalesce(u.phone, '') <> '' and regexp_replace(u.phone, '\D', '', 'g') = any (v_phones)
    ) as match
    join public.profiles p on p.id = match.id
    where p.discoverable
      and p.name_disclosure <> 'handle_only'
      and p.id <> v_viewer
      and not app_private.users_are_blocked(v_viewer, p.id)
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.open_media_discover_contacts(text[], text[]) from public, anon;
grant execute on function public.open_media_discover_contacts(text[], text[]) to authenticated;
