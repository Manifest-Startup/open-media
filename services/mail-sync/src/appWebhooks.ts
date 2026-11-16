/**
 * Outbound webhooks to integrated apps (ADR 0041). Database triggers queue events in
 * app_private.app_webhook_outbox (20261124130000_app_webhooks.sql); the per-minute cron calls
 * runAppWebhooks, which claims due rows, POSTs each one signed with the app's secret, and settles
 * them: delivered rows are deleted and failed ones retried with backoff until they are 24 hours old.
 *
 * Configuration is the Worker secret APP_WEBHOOKS, e.g.
 *   {"manifest":{"url":"https://manifeststartup.com/api/webhooks/open-media","secret":"<hex>"}}
 *
 * Signature: X-Open-Media-Signature: sha256=<hex HMAC-SHA256(secret, timestamp + "." + raw body)>,
 * with the secret's UTF-8 bytes as the key and X-Open-Media-Timestamp in unix seconds.
 */
import { AppId, isAppId } from '../../../src/domain/appContext';
import { serviceRpc } from './marketplace.js';

export interface AppWebhookEnv {
  APP_WEBHOOKS?: string;
  SUPABASE_URL: string;
  SUPABASE_SECRET_KEY?: string;
}

export interface WebhookTarget { url: string; secret: string }

interface ClaimedDelivery { id: string; app: string; type: string; created_at: string; data: Record<string, unknown>; attempts: number }

const batchSize = 50;
const maxBatches = 4;
const timeoutMs = 10_000;

/** The apps that have a valid URL and secret. Anything malformed is left out (and logged once). */
export function webhookTargets(raw: string | undefined): Map<AppId, WebhookTarget> {
  const targets = new Map<AppId, WebhookTarget>();
  if (!raw?.trim()) return targets;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { console.error(JSON.stringify({ event: 'app_webhooks_config_invalid' })); return targets; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return targets;
  for (const [app, value] of Object.entries(parsed as Record<string, unknown>)) {
    const target = value as Partial<WebhookTarget> | null;
    if (!isAppId(app) || !target || typeof target.url !== 'string' || typeof target.secret !== 'string' || target.secret.length < 16) {
      console.error(JSON.stringify({ event: 'app_webhooks_target_invalid', app: app.slice(0, 40) }));
      continue;
    }
    if (!isAllowedWebhookUrl(target.url)) {
      console.error(JSON.stringify({ event: 'app_webhooks_target_invalid', app }));
      continue;
    }
    targets.set(app, { url: target.url, secret: target.secret });
  }
  return targets;
}

/** https anywhere; plain http only to this machine, for local development against `npm run local`. */
export function isAllowedWebhookUrl(value: string): boolean {
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  if (url.username || url.password) return false;
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
}

/** `sha256=<hex>` over `${timestamp}.${body}`. */
export async function signWebhook(secret: string, timestamp: number, body: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${body}`));
  return `sha256=${[...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

/** The exact request one delivery makes. */
export async function webhookRequest(delivery: ClaimedDelivery, target: WebhookTarget, now: number): Promise<{ url: string; init: RequestInit }> {
  const body = JSON.stringify({ id: delivery.id, type: delivery.type, created_at: delivery.created_at, data: delivery.data });
  const timestamp = Math.floor(now / 1000);
  return {
    url: target.url,
    init: {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'OpenMedia-Webhooks/1',
        'x-open-media-event': delivery.type,
        'x-open-media-delivery': delivery.id,
        'x-open-media-timestamp': String(timestamp),
        'x-open-media-signature': await signWebhook(target.secret, timestamp, body),
      },
      body,
    },
  };
}

export interface AppWebhookDeps { fetch?: typeof fetch; now?: () => number }

/** One cron run: a few batches of due deliveries, each sent once, then settled. */
export async function runAppWebhooks(env: AppWebhookEnv, deps: AppWebhookDeps = {}): Promise<{ delivered: number; failed: number }> {
  const targets = webhookTargets(env.APP_WEBHOOKS);
  if (!targets.size || !env.SUPABASE_SECRET_KEY) return { delivered: 0, failed: 0 };
  const fetchImpl = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  let delivered = 0;
  let failed = 0;
  for (let batch = 0; batch < maxBatches; batch += 1) {
    const claimed = await serviceRpc<ClaimedDelivery[]>(env, 'open_media_claim_app_webhooks', { p_apps: [...targets.keys()], p_limit: batchSize }, fetchImpl);
    if (!Array.isArray(claimed) || !claimed.length) break;
    const outcomes = await Promise.all(claimed.map(async (delivery) => {
      const target = targets.get(delivery.app as AppId);
      if (!target) return { id: delivery.id, error: 'not configured' };
      try {
        const { url, init } = await webhookRequest(delivery, target, now());
        const response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
        await response.body?.cancel().catch(() => undefined);
        return response.status >= 200 && response.status < 300 ? { id: delivery.id } : { id: delivery.id, error: `HTTP ${response.status}` };
      } catch (error) {
        return { id: delivery.id, error: error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'network error' };
      }
    }));
    const ok = outcomes.filter((outcome) => !('error' in outcome)).map((outcome) => outcome.id);
    const bad = outcomes.filter((outcome): outcome is { id: string; error: string } => 'error' in outcome);
    await serviceRpc(env, 'open_media_settle_app_webhooks', { p_delivered: ok, p_failed: bad }, fetchImpl);
    delivered += ok.length;
    failed += bad.length;
    if (claimed.length < batchSize) break;
  }
  return { delivered, failed };
}
