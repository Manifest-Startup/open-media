/**
 * App context on conversations and posts (ADR 0041). An integrated app such as Manifest can mark a
 * conversation or a post as being about something in that app: `{app, idea_id?, title?, url?}`.
 * Open Media shows a small "From <App>" chip that links back to `url`.
 *
 * Only apps listed here are accepted, and `url` must point at that app's own site, so a chip that
 * says "From Manifest" can never send someone to another site. The database applies the same rule
 * (app_private.app_context_valid), so this module is the friendly first check, not the only one.
 */

export const integratedApps = {
  manifest: { name: 'Manifest', hosts: ['manifeststartup.com'] },
} as const;

export type AppId = keyof typeof integratedApps;

export interface AppContext {
  app: AppId;
  idea_id?: string;
  title?: string;
  url?: string;
}

/** The whole context, serialised, may be at most 2 KB. */
export const maxAppContextBytes = 2048;
const allowedKeys = new Set(['app', 'idea_id', 'title', 'url']);
// Control characters (including newlines) never belong in an id or a one-line title.
const controlCharacters = /[\u0000-\u001f\u007f]/;

export type AppContextCheck = { ok: true; context: AppContext } | { ok: false; reason: string };

export function isAppId(value: unknown): value is AppId {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(integratedApps, value);
}

/** Whether a URL is https on the app's own site (the host or one of its subdomains). */
export function isAppUrl(app: AppId, value: string): boolean {
  if (value.length > 2048) return false;
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
  const host = url.hostname.toLowerCase();
  return integratedApps[app].hosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

/** Validates a context sent by an app. Unknown keys, unknown apps and foreign links are refused. */
export function parseAppContext(value: unknown): AppContextCheck {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, reason: 'context must be an object like {"app": "manifest", "idea_id": "…"}.' };
  const input = value as Record<string, unknown>;
  const extra = Object.keys(input).find((key) => !allowedKeys.has(key));
  if (extra) return { ok: false, reason: `context may only have app, idea_id, title and url (not ${extra}).` };
  if (!isAppId(input.app)) return { ok: false, reason: `context.app must be one of: ${Object.keys(integratedApps).join(', ')}.` };
  const context: AppContext = { app: input.app };
  if (input.idea_id !== undefined) {
    if (typeof input.idea_id !== 'string' || !input.idea_id.trim() || input.idea_id.length > 200 || controlCharacters.test(input.idea_id)) {
      return { ok: false, reason: 'context.idea_id must be a string of 1 to 200 characters.' };
    }
    context.idea_id = input.idea_id;
  }
  if (input.title !== undefined) {
    if (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 300 || controlCharacters.test(input.title)) {
      return { ok: false, reason: 'context.title must be one line of 1 to 300 characters.' };
    }
    context.title = input.title;
  }
  if (input.url !== undefined) {
    if (typeof input.url !== 'string' || !isAppUrl(input.app, input.url)) {
      return { ok: false, reason: `context.url must be an https link on ${integratedApps[input.app].hosts.join(' or ')}.` };
    }
    context.url = input.url;
  }
  if (new TextEncoder().encode(JSON.stringify(context)).length > maxAppContextBytes) return { ok: false, reason: 'context must be at most 2 KB.' };
  return { ok: true, context };
}

/** A context read back from the server, or null when there is none or it is not one we show. */
export function appContextOf(value: unknown): AppContext | null {
  const check = parseAppContext(value);
  return check.ok ? check.context : null;
}

/** What the "From <App>" chip shows: a label, and a link only when it is on the app's own site. */
export function appChip(value: unknown): { label: string; url?: string; accessibilityLabel: string } | null {
  const context = appContextOf(value);
  if (!context) return null;
  const name = integratedApps[context.app].name;
  const about = context.title ? `: ${context.title}` : '';
  return { label: `From ${name}`, ...(context.url ? { url: context.url } : {}), accessibilityLabel: `From ${name}${about}${context.url ? `. Opens ${name}.` : ''}` };
}
