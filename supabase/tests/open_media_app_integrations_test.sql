begin;

select plan(42);

insert into auth.users (id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
values
  ('a1000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 'ana@example.test', '', now(), now(), now()),
  ('b2000000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 'ben@example.test', '', now(), now(), now()),
  ('c3000000-0000-0000-0000-000000000003', 'authenticated', 'authenticated', 'cat@example.test', '', now(), now(), now());
insert into public.profiles (id, handle, display_name, bio)
values ('a1000000-0000-0000-0000-000000000001', 'ana', 'Ana', ''), ('b2000000-0000-0000-0000-000000000002', 'ben', 'Ben', ''), ('c3000000-0000-0000-0000-000000000003', 'cat', 'Cat', '');
insert into public.conversations (id, kind, created_by)
values ('d4000000-0000-0000-0000-000000000004', 'direct', 'a1000000-0000-0000-0000-000000000001'),
       ('d5000000-0000-0000-0000-000000000005', 'direct', 'a1000000-0000-0000-0000-000000000001');
insert into public.conversation_members (conversation_id, user_id)
values ('d4000000-0000-0000-0000-000000000004', 'a1000000-0000-0000-0000-000000000001'), ('d4000000-0000-0000-0000-000000000004', 'b2000000-0000-0000-0000-000000000002'),
       ('d5000000-0000-0000-0000-000000000005', 'a1000000-0000-0000-0000-000000000001'), ('d5000000-0000-0000-0000-000000000005', 'c3000000-0000-0000-0000-000000000003');

-- The context rule, as the database enforces it.
select ok(app_private.app_context_valid('{"app":"manifest","idea_id":"42","title":"Solar kiosks","url":"https://manifeststartup.com/ideas/42"}'), 'a Manifest context with a link on Manifest is valid');
select ok(app_private.app_context_valid('{"app":"manifest","url":"https://www.manifeststartup.com/x?y=1"}'), 'subdomains of the app are its own site');
select ok(not app_private.app_context_valid('{"app":"other"}'), 'unknown apps are refused');
select ok(not app_private.app_context_valid('{"app":"manifest","secret":"x"}'), 'unknown keys are refused');
select ok(not app_private.app_context_valid('{"app":"manifest","url":"https://manifeststartup.com.evil.test/"}'), 'look-alike hosts are refused');
select ok(not app_private.app_context_valid('{"app":"manifest","url":"https://user@manifeststartup.com/"}'), 'credentials in links are refused');
select ok(not app_private.app_context_valid('{"app":"manifest","url":"http://manifeststartup.com/"}'), 'plain http is refused');
select ok(not app_private.app_context_valid(jsonb_build_object('app', 'manifest', 'title', repeat('t', 300), 'idea_id', repeat('i', 200), 'url', 'https://manifeststartup.com/' || repeat('p', 1600))), 'contexts over 2 KB are refused');
select ok(not app_private.app_context_valid('["manifest"]'), 'only objects are contexts');
select throws_ok($$ update public.conversations set context = '{"app":"other"}' where id = 'd4000000-0000-0000-0000-000000000004' $$, '23514', null, 'the table refuses an invalid context even from the owner role');

set local role authenticated;
select set_config('request.jwt.claim.sub', 'a1000000-0000-0000-0000-000000000001', true);

-- Conversations: set once by a member, never replaced.
select is(public.open_media_set_conversation_context('d4000000-0000-0000-0000-000000000004', '{"app":"manifest","idea_id":"42"}') ->> 'idea_id', '42', 'a member sets the context');
select is(public.open_media_set_conversation_context('d4000000-0000-0000-0000-000000000004', '{"app":"manifest","idea_id":"99"}') ->> 'idea_id', '42', 'a second context does not replace the first');
select is((select source_app from public.conversations where id = 'd4000000-0000-0000-0000-000000000004'), 'manifest', 'source_app follows the context');
select throws_ok($$ select public.open_media_set_conversation_context('d4000000-0000-0000-0000-000000000004', '{"app":"other"}') $$, '22023', 'The app context is invalid.', 'an invalid context is refused');
select throws_ok($$ update public.conversations set context = null $$, '42501', null, 'people cannot write the context directly');
select set_config('request.jwt.claim.sub', 'c3000000-0000-0000-0000-000000000003', true);
select throws_ok($$ select public.open_media_set_conversation_context('d4000000-0000-0000-0000-000000000004', '{"app":"manifest"}') $$, 'P0002', 'Conversation not found.', 'a non-member cannot set it');

-- Messages in an app conversation are announced by ID only; others are not announced.
select set_config('request.jwt.claim.sub', 'a1000000-0000-0000-0000-000000000001', true);
insert into public.messages (id, conversation_id, sender_id, client_id, body)
values ('e6000000-0000-0000-0000-000000000006', 'd4000000-0000-0000-0000-000000000004', 'a1000000-0000-0000-0000-000000000001', gen_random_uuid(), 'Private pitch details');
insert into public.messages (conversation_id, sender_id, client_id, body)
values ('d5000000-0000-0000-0000-000000000005', 'a1000000-0000-0000-0000-000000000001', gen_random_uuid(), 'Not about an app');

-- Posts: published with a context, listed with ?app=.
select is(public.open_media_create_post('f7000000-0000-0000-0000-000000000007', 'Our pitch', null, '{"app":"manifest","idea_id":"42","url":"https://manifeststartup.com/ideas/42"}') -> 'context' ->> 'idea_id', '42', 'a post is published with its context');
select is(public.open_media_create_post('f7000000-0000-0000-0000-000000000007', 'Our pitch', null, '{"app":"manifest","idea_id":"99"}') -> 'context' ->> 'idea_id', '42', 'a retry keeps the first context');
select lives_ok($$ select public.open_media_create_post('f8000000-0000-0000-0000-000000000008', 'Plain post') $$, 'posts without a context still work, with the old arguments');
select throws_ok($$ select public.open_media_create_post(gen_random_uuid(), 'x', null, '{"app":"manifest","url":"https://evil.test"}') $$, '22023', 'The app context is invalid.', 'an invalid post context is refused');
select is(jsonb_array_length(public.open_media_public_posts(p_app => 'manifest')), 1, '?app= lists only that app''s posts');
select is(jsonb_array_length(public.open_media_public_posts()), 2, 'without ?app= every post is listed');
select is((public.open_media_public_posts(p_app => 'manifest') -> 0 -> 'context' ->> 'app'), 'manifest', 'public posts carry their context');

-- Ben likes and comments: Ana's app hears about it, without the comment text.
select set_config('request.jwt.claim.sub', 'b2000000-0000-0000-0000-000000000002', true);
select lives_ok($$ select public.open_media_set_post_like((select (public.open_media_public_posts(p_app => 'manifest') -> 0 ->> 'id')::uuid), true) $$, 'Ben likes the post');
select lives_ok($$ select public.open_media_add_post_comment((select (public.open_media_public_posts(p_app => 'manifest') -> 0 ->> 'id')::uuid), gen_random_uuid(), 'Secret comment text') $$, 'Ben comments');
select throws_ok($$ select * from app_private.app_webhook_outbox $$, '42501', null, 'people cannot read the outbox');
select throws_ok($$ select public.open_media_claim_app_webhooks(array['manifest']) $$, '42501', null, 'people cannot claim deliveries');

-- Ana deletes the post.
select set_config('request.jwt.claim.sub', 'a1000000-0000-0000-0000-000000000001', true);
select lives_ok($$ select public.open_media_delete_post((select id from public.posts where client_id = 'f7000000-0000-0000-0000-000000000007')) $$, 'Ana deletes her app post');

reset role;
select is(
  (select array_agg(event_type order by created_at, event_type) from app_private.app_webhook_outbox),
  array['message.created', 'post.liked', 'post.commented', 'post.deleted'],
  'one event each for the message, like, comment and deletion, and none for the plain conversation'
);
select is(
  (select payload - 'context' from app_private.app_webhook_outbox where event_type = 'message.created'),
  '{"conversation_id":"d4000000-0000-0000-0000-000000000004","message_id":"e6000000-0000-0000-0000-000000000006","actor_id":"a1000000-0000-0000-0000-000000000001","recipient_ids":["b2000000-0000-0000-0000-000000000002"]}'::jsonb,
  'message events carry IDs and recipients only'
);
select ok((select bool_and(payload::text not like '%Private pitch%' and payload::text not like '%Secret comment%') from app_private.app_webhook_outbox), 'no payload contains message or comment text');
select is((select payload -> 'recipient_ids' from app_private.app_webhook_outbox where event_type = 'post.liked'), '["a1000000-0000-0000-0000-000000000001"]'::jsonb, 'the post author hears about a like');
select is((select payload -> 'recipient_ids' from app_private.app_webhook_outbox where event_type = 'post.deleted'), '[]'::jsonb, 'nobody else is told about the author''s own deletion');

-- The service role claims, leases, settles and retries.
select set_config('test.delivered', (select string_agg(id::text, ',') from app_private.app_webhook_outbox where event_type <> 'post.liked'), true);
select set_config('test.failed', (select jsonb_build_array(jsonb_build_object('id', id, 'error', 'HTTP 500'))::text from app_private.app_webhook_outbox where event_type = 'post.liked'), true);
set local role service_role;
select throws_ok($$ select * from app_private.app_webhook_outbox $$, '42501', null, 'even the service role goes through the functions');
select is(jsonb_array_length(public.open_media_claim_app_webhooks(array['other'])), 0, 'apps without a configured webhook are not claimed');
select is(jsonb_array_length(public.open_media_claim_app_webhooks(array['manifest'], 10)), 4, 'due deliveries are claimed');
select is(jsonb_array_length(public.open_media_claim_app_webhooks(array['manifest'], 10)), 0, 'claimed deliveries are leased, not sent twice');
select is(
  public.open_media_settle_app_webhooks(string_to_array(current_setting('test.delivered'), ',')::uuid[], current_setting('test.failed')::jsonb),
  4,
  'three delivered and one failed are settled'
);
reset role;
select is((select count(*)::integer from app_private.app_webhook_outbox), 1, 'delivered rows are deleted');
select ok((select next_attempt_at > now() and last_error = 'HTTP 500' and attempts = 1 from app_private.app_webhook_outbox), 'a failed delivery waits before its next try');
update app_private.app_webhook_outbox set created_at = now() - interval '25 hours', next_attempt_at = now() - interval '1 minute';
set local role service_role;
select is(jsonb_array_length(public.open_media_claim_app_webhooks(array['manifest'])), 0, 'after 24 hours a delivery is dropped');
reset role;
select is((select count(*)::integer from app_private.app_webhook_outbox), 0, 'and removed from the outbox');

select * from finish();
rollback;
