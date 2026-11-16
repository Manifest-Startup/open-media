import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import test from 'node:test';

import { authEmailsFor, connectionFromRedirect, emailSender, handleSendEmailHook, renderAuthEmail, verifyHookSignature } from './authEmail.js';

const key = randomBytes(32);
const secret = `v1,whsec_${key.toString('base64')}`;
const sign = (body: string, id = 'msg_1', timestamp = Math.floor(Date.now() / 1000)) => new Headers({
  'webhook-id': id, 'webhook-timestamp': String(timestamp),
  'webhook-signature': `v1,${createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64')}`,
});
const payload = { user: { email: 'ada@example.test' }, email_data: { token: '12345678', token_hash: 'pkce_abc', redirect_to: 'https://openmedia.site/auth', email_action_type: 'magiclink', site_url: 'https://openmedia.site' } };

test('Standard Webhooks signatures are checked exactly and expire after five minutes', async () => {
  const body = JSON.stringify(payload);
  assert.equal(await verifyHookSignature(sign(body), body, secret), true);
  assert.equal(await verifyHookSignature(sign(body), `${body} `, secret), false);
  assert.equal(await verifyHookSignature(sign(body, 'msg_1', Math.floor(Date.now() / 1000) - 600), body, secret), false);
  assert.equal(await verifyHookSignature(sign(body), body, `v1,whsec_${randomBytes(32).toString('base64')}`), false);
});

test('the sign-in email is Open Media’s own: code, one-tap link, plain-text twin, no Supabase branding', () => {
  const [email] = authEmailsFor(payload as never, 'https://db.example.supabase.co');
  assert.equal(email.to, 'ada@example.test');
  assert.equal(email.subject, 'Your Open Media sign-in code');
  assert.match(email.html, /1234 5678/);
  assert.match(email.html, /href="https:\/\/db\.example\.supabase\.co\/auth\/v1\/verify\?token=pkce_abc&amp;type=magiclink&amp;redirect_to=https%3A%2F%2Fopenmedia\.site%2Fauth"/);
  assert.match(email.html, /prefers-color-scheme:dark/);
  assert.match(email.text, /Your code: 1234 5678/);
  assert.doesNotMatch(`${email.html}${email.text}`, /supabase\.(io|com)\b|Supabase/);
  assert.match(renderAuthEmail({ to: 'x@example.test', action: 'signup', code: '123456', link: 'https://x.test/?a=<b>' }).html, /a=&lt;b&gt;/, 'links are escaped');
  const change = authEmailsFor({ user: { email: 'old@example.test', new_email: 'new@example.test' }, email_data: { token: '111111', token_hash: 'h1', token_new: '222222', token_hash_new: 'h2', redirect_to: '', email_action_type: 'email_change' } } as never, 'https://db.test');
  assert.deepEqual(change.map((item) => item.to), ['old@example.test', 'new@example.test']);
  const reauth = authEmailsFor({ user: { email: 'a@example.test' }, email_data: { token: '654321', token_hash: '', redirect_to: '', email_action_type: 'reauthentication' } } as never, 'https://db.test');
  assert.doesNotMatch(reauth[0].html, /class="button"/, 'a confirmation code has no button');
});

test('the hook sends from security@openmedia.site only for signed requests', async () => {
  const sent: { from: unknown; to: string; subject: string }[] = [];
  const env = { SUPABASE_URL: 'https://db.test', SEND_EMAIL_HOOK_SECRET: secret, EMAIL: { send: async (message: { from: unknown; to: string; subject: string }) => { sent.push(message); return { messageId: 'm1' }; } } };
  const body = JSON.stringify(payload);
  const ok = await handleSendEmailHook(new Request('https://api.test/auth/hooks/send-email', { method: 'POST', headers: sign(body), body }), env);
  assert.equal(ok.status, 200);
  assert.deepEqual(sent[0].from, { email: 'security@openmedia.site', name: 'Open Media' });
  const forged = await handleSendEmailHook(new Request('https://api.test/auth/hooks/send-email', { method: 'POST', headers: { 'webhook-id': 'x', 'webhook-timestamp': '1', 'webhook-signature': 'v1,AAAA' }, body }), env);
  assert.equal(forged.status, 401);
  assert.equal(sent.length, 1);
  const failing = await handleSendEmailHook(new Request('https://api.test/auth/hooks/send-email', { method: 'POST', headers: sign(body, 'msg_2'), body }), { ...env, EMAIL: { send: async () => { throw new Error('not onboarded'); } } });
  assert.equal(failing.status, 502);
  assert.equal(((await failing.json()) as { error: { http_code: number } }).error.http_code, 502, 'Supabase shows the hook’s error to the person');
});

test('a sign-in started on an app’s Connect page gets a button that finishes that connection, not a Supabase link', async () => {
  const sent: { to: string; text: string; html: string }[] = [];
  const challenge = 'a'.repeat(64);
  const env = { SUPABASE_URL: 'https://db.test', SEND_EMAIL_HOOK_SECRET: secret, EMAIL: { send: async (message: { to: string; text: string; html: string }) => { sent.push(message); return {}; } } };
  const connect = { ...payload, email_data: { ...payload.email_data, redirect_to: `https://api.test/authorize/account/link?challenge=${challenge}` } };
  const body = JSON.stringify(connect);
  assert.equal((await handleSendEmailHook(new Request('https://api.test/auth/hooks/send-email', { method: 'POST', headers: sign(body, 'msg_c1'), body }), env)).status, 200);
  assert.ok(sent[0].text.includes(`https://api.test/authorize/account/link?challenge=${challenge}&token_hash=pkce_abc&type=magiclink`));
  assert.ok(!sent[0].text.includes('db.test/auth/v1/verify'));
  assert.ok(sent[0].text.includes('1234 5678') || sent[0].text.includes('12345678'), 'the code is still there for another device');
  // Another site's redirect never turns into a connect link.
  assert.equal(connectionFromRedirect(`https://evil.test/authorize/account/link?challenge=${challenge}`, 'https://api.test'), undefined);
  assert.equal(connectionFromRedirect('https://api.test/authorize/account/link?challenge=nope', 'https://api.test'), undefined);
  // An ordinary sign-in keeps the normal link.
  assert.ok(authEmailsFor(payload as never, 'https://db.test')[0].text.includes('https://db.test/auth/v1/verify'));
});

test('with a Resend key, sign-in emails go through Resend from security@openmedia.site, and its errors become a 502', async () => {
  const calls: { url: string; headers: Record<string, string>; body: { from: string; to: string[]; subject: string; html: string; text: string } }[] = [];
  const ok = (async (url: string, init: RequestInit) => { calls.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) }); return new Response('{"id":"e1"}', { status: 200 }); }) as unknown as typeof fetch;
  const env = { SUPABASE_URL: 'https://db.test', SEND_EMAIL_HOOK_SECRET: secret, RESEND_API_KEY: 're_test_key' };
  const body = JSON.stringify(payload);
  assert.equal((await handleSendEmailHook(new Request('https://api.test/auth/hooks/send-email', { method: 'POST', headers: sign(body, 'msg_r1'), body }), env, ok)).status, 200);
  assert.equal(calls[0].url, 'https://api.resend.com/emails');
  assert.equal(calls[0].headers.authorization, 'Bearer re_test_key');
  assert.equal(calls[0].body.from, 'Open Media <security@openmedia.site>');
  assert.deepEqual(calls[0].body.to, ['ada@example.test']);
  assert.ok(calls[0].body.text.includes('1234 5678') || calls[0].body.text.includes('12345678'));
  const refused = (async () => new Response('{"message":"The openmedia.site domain is not verified."}', { status: 403 })) as unknown as typeof fetch;
  assert.equal((await handleSendEmailHook(new Request('https://api.test/auth/hooks/send-email', { method: 'POST', headers: sign(body, 'msg_r2'), body }), env, refused)).status, 502);
  assert.equal(emailSender({}), undefined, 'no sender configured');
});
