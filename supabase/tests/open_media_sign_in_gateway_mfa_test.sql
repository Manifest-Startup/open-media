begin;

select plan(16);

insert into auth.users (id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
values
  ('a1000000-0000-0000-0000-0000000000a1', 'authenticated', 'authenticated', 'pia@example.test', '', now(), now(), now()),
  ('b2000000-0000-0000-0000-0000000000b2', 'authenticated', 'authenticated', 'tom@example.test', '', now(), now(), now()),
  ('c3000000-0000-0000-0000-0000000000c3', 'authenticated', 'authenticated', 'noa@example.test', '', now(), now(), now());
-- Pia's second step is a passkey, Tom's is an authenticator app. Noa has none.
insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
values
  ('f1000000-0000-0000-0000-0000000000f1', 'a1000000-0000-0000-0000-0000000000a1', 'MacBook', 'webauthn', 'verified', now(), now()),
  ('f2000000-0000-0000-0000-0000000000f2', 'b2000000-0000-0000-0000-0000000000b2', 'Authenticator', 'totp', 'verified', now(), now());

set local role authenticated;

-- What GoTrue gives a passkey-first sign-in (verified locally): aal1, amr [{"method":"passkey"}].
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-0000-0000-0000000000a1","role":"authenticated","aal":"aal1","amr":[{"method":"passkey","timestamp":1}]}', true);
select is(public.open_media_session_meets_mfa(), true, 'a passkey-first sign-in is enough for someone whose second step is a passkey');
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-0000-0000-0000000000a1","role":"authenticated","aal":"aal1","amr":[{"method":"otp","timestamp":1}]}', true);
select is(public.open_media_session_meets_mfa(), false, 'an email code alone is not');

select set_config('request.jwt.claims', '{"sub":"b2000000-0000-0000-0000-0000000000b2","role":"authenticated","aal":"aal1","amr":[{"method":"passkey","timestamp":1}]}', true);
select is(public.open_media_session_meets_mfa(), false, 'with an authenticator app, a passkey sign-in still needs the code');
select throws_ok($$ select public.open_media_pre_request() $$, 'PGRST', null, 'and the API refuses it until then');
select set_config('request.jwt.claims', '{"sub":"b2000000-0000-0000-0000-0000000000b2","role":"authenticated","aal":"aal2","amr":[{"method":"totp","timestamp":2},{"method":"password","timestamp":1}]}', true);
select is(public.open_media_session_meets_mfa(), true, 'after the authenticator code (aal2) it is enough');

select set_config('request.jwt.claims', '{"sub":"c3000000-0000-0000-0000-0000000000c3","role":"authenticated","aal":"aal1","amr":[{"method":"otp","timestamp":1}]}', true);
select is(public.open_media_session_meets_mfa(), true, 'people without a second step are unaffected');

-- Recovery codes: Noa makes ten, sees them once, and only hashes are stored.
create temporary table codes as select unnest(public.open_media_new_recovery_codes()) as code;
select is((select count(*)::int from codes), 10, 'ten codes');
select ok((select bool_and(code ~ '^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$') from codes), 'each looks like xxxx-xxxx-xxxx-xxxx');
select is(public.open_media_recovery_codes_left(), 10, 'she can see how many are left');
select throws_ok($$ select count(*) from app_private.recovery_codes $$, '42501', null, 'the hashes are not readable through the API role');
select throws_ok($$ select public.open_media_use_recovery_code('c3000000-0000-0000-0000-0000000000c3', 'x') $$, '42501', null, 'people cannot use codes directly; only the Worker can');

-- Tom has not done his second step: he cannot make codes.
select set_config('request.jwt.claims', '{"sub":"b2000000-0000-0000-0000-0000000000b2","role":"authenticated","aal":"aal1"}', true);
select throws_ok($$ select public.open_media_new_recovery_codes() $$, '42501', null, 'codes need a full sign-in');

reset role;
select is(public.open_media_use_recovery_code('c3000000-0000-0000-0000-0000000000c3', upper((select code from codes limit 1))), 'ok', 'a code works once, whatever its case');
select is(public.open_media_use_recovery_code('c3000000-0000-0000-0000-0000000000c3', (select code from codes limit 1)), 'invalid', 'and never again');
select is(public.open_media_use_recovery_code('a1000000-0000-0000-0000-0000000000a1', (select code from codes offset 1 limit 1)), 'invalid', 'nobody else can use it');
select public.open_media_use_recovery_code('c3000000-0000-0000-0000-0000000000c3', 'wrong') from generate_series(1, 4);
select is(public.open_media_use_recovery_code('c3000000-0000-0000-0000-0000000000c3', (select code from codes offset 2 limit 1)), 'rate_limited', 'five wrong codes in 15 minutes stop further tries');

select * from finish();
rollback;
