import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';

import { isAllowedWebhookUrl, runAppWebhooks, signWebhook, webhookTargets } from './appWebhooks.js';

const secret = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const config = JSON.stringify({ manifest: { url: 'https://manifeststartup.com/api/webhooks/open-media', secret } });

test('only known apps with an https URL and a real secret are configured', () => {
  assert.deepEqual([...webhookTargets(config).keys()], ['manifest']);
  assert.equal(webhookTargets(undefined).size, 0);
  assert.equal(webhookTargets('not json').size, 0);
  assert.equal(webhookTargets(JSON.stringify({ other: { url: 'https://x.test', secret } })).size, 0, 'unknown apps are ignored');
  assert.equal(webhookTargets(JSON.stringify({ manifest: { url: 'https://manifeststartup.com/h', secret: 'short' } })).size, 0, 'a short secret is refused');
  assert.equal(webhookTargets(JSON.stringify({ manifest: { url: 'http://manifeststartup.com/h', secret } })).size, 0, 'plain http is refused');
  assert.equal(isAllowedWebhookUrl('http://localhost:8000/api/webhooks/open-media'), true, 'except to this machine, for local development');
  assert.equal(isAllowedWebhookUrl('https://user:pass@manifeststartup.com/'), false);
});

test('the signature is HMAC-SHA256 of timestamp + "." + body with the secret’s bytes', async () => {
  const body = '{"id":"x"}';
  assert.equal(await signWebhook(secret, 1_800_000_000, body), `sha256=${createHmac('sha256', secret).update(`1800000000.${body}`).digest('hex')}`);
});

const delivery = (id: string, type: string) => ({
  id, app: 'manifest', type, created_at: '2026-11-15T12:00:00Z', attempts: 1,
  data: { conversation_id: 'c1', message_id: 'm1', actor_id: 'u1', recipient_ids: ['u2'], context: { app: 'manifest', idea_id: '42' } },
});

test('a run claims due deliveries, sends each signed with IDs only, and settles successes and failures', async () => {
  const sent: { url: string; init: RequestInit }[] = [];
  const rpc: { name: string; body: Record<string, unknown>; key: string }[] = [];
  let claims = 0;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    if (url.includes('/rest/v1/rpc/')) {
      const name = url.split('/').pop()!;
      rpc.push({ name, body: JSON.parse(String(init.body)), key: (init.headers as Record<string, string>).authorization });
      if (name === 'open_media_claim_app_webhooks') return Response.json(claims++ === 0 ? [delivery('d1', 'message.created'), delivery('d2', 'post.liked'), delivery('d3', 'post.commented')] : []);
      return Response.json(3);
    }
    sent.push({ url, init });
    const id = (init.headers as Record<string, string>)['x-open-media-delivery'];
    if (id === 'd2') return new Response('nope', { status: 500 });
    if (id === 'd3') throw new TypeError('fetch failed');
    return new Response(null, { status: 204 });
  }) as typeof fetch;

  const result = await runAppWebhooks({ APP_WEBHOOKS: config, SUPABASE_URL: 'https://db.test', SUPABASE_SECRET_KEY: 'service-key' }, { fetch: fetchImpl, now: () => 1_800_000_000_000 });
  assert.deepEqual(result, { delivered: 1, failed: 2 });
  assert.deepEqual(rpc[0].body, { p_apps: ['manifest'], p_limit: 50 });
  assert.equal(rpc[0].key, 'Bearer service-key', 'the outbox is reached with the service role only');
  assert.equal(sent.length, 3);
  const first = sent.find((item) => (item.init.headers as Record<string, string>)['x-open-media-delivery'] === 'd1')!;
  const headers = first.init.headers as Record<string, string>;
  assert.equal(first.url, 'https://manifeststartup.com/api/webhooks/open-media');
  assert.equal(first.init.redirect, 'manual', 'redirects are not followed');
  assert.equal(headers['x-open-media-event'], 'message.created');
  assert.equal(headers['x-open-media-timestamp'], '1800000000');
  assert.equal(headers['x-open-media-signature'], `sha256=${createHmac('sha256', secret).update(`1800000000.${String(first.init.body)}`).digest('hex')}`);
  assert.deepEqual(JSON.parse(String(first.init.body)), { id: 'd1', type: 'message.created', created_at: '2026-11-15T12:00:00Z', data: delivery('d1', 'message.created').data });
  const settle = rpc.find((call) => call.name === 'open_media_settle_app_webhooks')!;
  assert.deepEqual(settle.body, { p_delivered: ['d1'], p_failed: [{ id: 'd2', error: 'HTTP 500' }, { id: 'd3', error: 'network error' }] });
});

test('nothing runs without a configured app or the service key', async () => {
  const fetchImpl = (async () => { throw new Error('no calls expected'); }) as unknown as typeof fetch;
  assert.deepEqual(await runAppWebhooks({ SUPABASE_URL: 'https://db.test', SUPABASE_SECRET_KEY: 'k' }, { fetch: fetchImpl }), { delivered: 0, failed: 0 });
  assert.deepEqual(await runAppWebhooks({ APP_WEBHOOKS: config, SUPABASE_URL: 'https://db.test' }, { fetch: fetchImpl }), { delivered: 0, failed: 0 });
});
