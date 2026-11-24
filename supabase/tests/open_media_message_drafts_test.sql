begin;

select plan(10);

insert into auth.users (id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
values
  ('a1000000-0000-0000-0000-0000000000d1', 'authenticated', 'authenticated', 'drafter@example.test', '', now(), now(), now()),
  ('b2000000-0000-0000-0000-0000000000d2', 'authenticated', 'authenticated', 'friend@example.test', '', now(), now(), now()),
  ('c3000000-0000-0000-0000-0000000000d3', 'authenticated', 'authenticated', 'stranger@example.test', '', now(), now(), now());
insert into public.conversations (id, kind, created_by)
values ('d4000000-0000-0000-0000-0000000000d4', 'direct', 'a1000000-0000-0000-0000-0000000000d1'),
       ('d5000000-0000-0000-0000-0000000000d5', 'direct', 'b2000000-0000-0000-0000-0000000000d2');
insert into public.conversation_members (conversation_id, user_id)
values ('d4000000-0000-0000-0000-0000000000d4', 'a1000000-0000-0000-0000-0000000000d1'),
       ('d4000000-0000-0000-0000-0000000000d4', 'b2000000-0000-0000-0000-0000000000d2'),
       ('d5000000-0000-0000-0000-0000000000d5', 'b2000000-0000-0000-0000-0000000000d2'),
       ('d5000000-0000-0000-0000-0000000000d5', 'c3000000-0000-0000-0000-0000000000d3');

set local role authenticated;
select set_config('request.jwt.claim.sub', 'a1000000-0000-0000-0000-0000000000d1', true);

insert into public.message_drafts (id, conversation_id, body, source_app, external_ref)
values ('e6000000-0000-0000-0000-0000000000e6', 'd4000000-0000-0000-0000-0000000000d4', 'Hi Ben, could we talk?', 'manifest', 'step-1');
select is((select count(*)::integer from public.message_drafts), 1, 'a person drafts in their own conversation');
select throws_ok($$ insert into public.message_drafts (conversation_id, body) values ('d5000000-0000-0000-0000-0000000000d5', 'sneaky') $$, '42501', null, 'but not in a conversation they are not in');
select throws_ok($$ insert into public.message_drafts (owner_id, conversation_id, body) values ('b2000000-0000-0000-0000-0000000000d2', 'd4000000-0000-0000-0000-0000000000d4', 'as Ben') $$, '42501', null, 'or as someone else');
select throws_ok($$ insert into public.message_drafts (conversation_id, body) values ('d4000000-0000-0000-0000-0000000000d4', '   ') $$, '23514', null, 'a draft has words');
select throws_ok($$ insert into public.message_drafts (conversation_id, body, source_app, external_ref) values ('d4000000-0000-0000-0000-0000000000d4', 'again', 'manifest', 'step-1') $$, '23505', null, 'one draft per app reference');
select throws_ok($$ update public.message_drafts set status = 'sent' $$, '23514', null, 'a sent draft names the message it became');
select throws_ok($$ update public.message_drafts set owner_id = 'b2000000-0000-0000-0000-0000000000d2' $$, '42501', null, 'a draft cannot be handed to someone else');

-- The other person in the conversation never sees it.
select set_config('request.jwt.claim.sub', 'b2000000-0000-0000-0000-0000000000d2', true);
select is((select count(*)::integer from public.message_drafts), 0, 'the other person cannot read the draft');
delete from public.message_drafts;
select set_config('request.jwt.claim.sub', 'a1000000-0000-0000-0000-0000000000d1', true);
select is((select count(*)::integer from public.message_drafts), 1, 'or delete it');

set local role anon;
select throws_ok($$ select count(*) from public.message_drafts $$, '42501', null, 'anonymous visitors have no access');

select * from finish();
rollback;
