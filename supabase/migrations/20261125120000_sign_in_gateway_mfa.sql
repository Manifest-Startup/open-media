-- One sign-in gateway, passkey-first sign-in and MFA (ADR 0042).
--
-- 1. open_media_session_meets_mfa() (ADR 0034) now also knows about:
--    - an authenticator app (TOTP). A verified TOTP factor already counted as "has a second step";
--      it is now named explicitly, and finishing it gives aal2 as before.
--    - a passkey-first sign-in. Verified on the local stack (GoTrue v2.195): /passkeys/authentication
--      gives an aal1 session whose amr is [{"method":"passkey"}]. That sign-in is phishing-resistant
--      and checks the person (user verification), so it is enough for people whose second step is a
--      passkey. People with an authenticator app still do that step (it is a different factor).
-- 2. One-time recovery codes, stored only as hashes in app_private (not reachable through the API).
--    Generating them needs a full session; using one goes through the Worker with the service key,
--    which then removes the person's factors (services/mail-sync/src/recoveryCodes.ts).

create or replace function public.open_media_session_meets_mfa()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select auth.uid() is null
    or coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2'
    or not exists (
      select 1 from auth.mfa_factors factor
      where factor.user_id = auth.uid() and factor.status = 'verified'
    )
    or (
      -- A passkey-first sign-in stands in for a passkey second step, not for an authenticator app.
      coalesce(auth.jwt() -> 'amr', '[]'::jsonb) @> '[{"method": "passkey"}]'::jsonb
      and not exists (
        select 1 from auth.mfa_factors factor
        where factor.user_id = auth.uid() and factor.status = 'verified' and factor.factor_type = 'totp'
      )
    );
$$;

comment on function public.open_media_session_meets_mfa() is
  'True unless the signed-in person has a second step (passkey or authenticator app) this session has not done yet. A passkey-first sign-in counts for passkeys, not for an authenticator app (ADR 0034, ADR 0042).';

-- 2. Recovery codes ------------------------------------------------------------------------------

create table app_private.recovery_codes (
  user_id uuid not null references auth.users (id) on delete cascade,
  code_hash text not null check (code_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  primary key (user_id, code_hash)
);

create table app_private.recovery_code_attempts (
  user_id uuid not null references auth.users (id) on delete cascade,
  attempted_at timestamptz not null default now()
);
create index recovery_code_attempts_user on app_private.recovery_code_attempts (user_id, attempted_at);

alter table app_private.recovery_codes enable row level security;
alter table app_private.recovery_code_attempts enable row level security;
revoke all on app_private.recovery_codes, app_private.recovery_code_attempts from public, anon, authenticated;

-- The same normalising and hashing for creating and using a code: lowercase letters and digits,
-- hashed with the person's id so equal codes of two people never share a hash.
create or replace function app_private.recovery_code_hash(p_user uuid, p_code text)
returns text
language sql
immutable
set search_path = ''
as $$
  select encode(extensions.digest(p_user::text || ':' || regexp_replace(lower(coalesce(p_code, '')), '[^a-z0-9]', '', 'g'), 'sha256'), 'hex');
$$;

revoke all on function app_private.recovery_code_hash(uuid, text) from public, anon, authenticated;

/**
 * Ten new one-time codes for the signed-in person, replacing any old ones. Each is 16 characters
 * from a 32-letter alphabet (80 random bits), shown as xxxx-xxxx-xxxx-xxxx. They are returned once
 * and only their hashes are kept.
 */
create or replace function public.open_media_new_recovery_codes()
returns text[]
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  alphabet constant text := 'abcdefghijkmnpqrstuvwxyz23456789';
  person uuid := auth.uid();
  codes text[] := '{}';
  code text;
  bytes bytea;
begin
  if person is null then raise exception 'Sign in first.' using errcode = '42501'; end if;
  -- The pre-request check already refuses such sessions; this keeps the function safe on its own.
  if not public.open_media_session_meets_mfa() then raise exception 'Confirm it''s you first.' using errcode = '42501'; end if;
  delete from app_private.recovery_codes where user_id = person;
  for i in 1..10 loop
    bytes := extensions.gen_random_bytes(16);
    code := '';
    for j in 0..15 loop
      code := code || substr(alphabet, (get_byte(bytes, j) % 32) + 1, 1);
    end loop;
    code := substr(code, 1, 4) || '-' || substr(code, 5, 4) || '-' || substr(code, 9, 4) || '-' || substr(code, 13, 4);
    insert into app_private.recovery_codes (user_id, code_hash) values (person, app_private.recovery_code_hash(person, code));
    codes := codes || code;
  end loop;
  return codes;
end;
$$;

revoke all on function public.open_media_new_recovery_codes() from public, anon;
grant execute on function public.open_media_new_recovery_codes() to authenticated;

/** How many unused recovery codes the signed-in person has (never the codes themselves). */
create or replace function public.open_media_recovery_codes_left()
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)::integer from app_private.recovery_codes where user_id = auth.uid();
$$;

revoke all on function public.open_media_recovery_codes_left() from public, anon;
grant execute on function public.open_media_recovery_codes_left() to authenticated;

/**
 * Uses up one code. Only the Worker calls this (service role), after checking the person's own
 * signed session; it then removes their factors. At most 5 wrong codes per person per 15 minutes.
 * Answers 'ok', 'invalid' or 'rate_limited'.
 */
create or replace function public.open_media_use_recovery_code(p_user uuid, p_code text)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  used integer;
begin
  if p_user is null then return 'invalid'; end if;
  delete from app_private.recovery_code_attempts where attempted_at < now() - interval '1 day';
  if (select count(*) from app_private.recovery_code_attempts where user_id = p_user and attempted_at > now() - interval '15 minutes') >= 5 then
    return 'rate_limited';
  end if;
  delete from app_private.recovery_codes where user_id = p_user and code_hash = app_private.recovery_code_hash(p_user, p_code);
  get diagnostics used = row_count;
  if used = 0 then
    insert into app_private.recovery_code_attempts (user_id) values (p_user);
    return 'invalid';
  end if;
  return 'ok';
end;
$$;

revoke all on function public.open_media_use_recovery_code(uuid, text) from public, anon, authenticated;
grant execute on function public.open_media_use_recovery_code(uuid, text) to service_role;
