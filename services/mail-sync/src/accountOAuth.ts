/**
 * "Sign in with Open Media" for AI hosts and apps (ADR 0027, ADR 0041, ADR 0042): any person can
 * connect Claude, ChatGPT, Manifest or another app to their own account with OAuth 2.1 + PKCE.
 *
 * 1. The app sends the person to /authorize (resource …/account/mcp or scope "account"). The Worker
 *    keeps the request as a challenge (KV, 15 minutes), ties it to this browser with a cookie on
 *    path /authorize, and sends the person to the sign-in gateway, openmedia.site/signin?request=….
 * 2. The gateway (src/ui/SignInGateway.tsx) shows the app's name and icon from
 *    /authorize/account/request, signs the person in with a passkey, an email code or one-tap link,
 *    or a password, does their second step and new-profile setup, and asks them to continue. It
 *    uses its own in-memory session, never the web app's.
 * 3. It posts {challenge, access_token, refresh_token} to /authorize/account/session as a top-level
 *    form. The Worker checks the cookie, the session (Supabase /auth/v1/user) and the database's
 *    second-step rule, then completes the authorization and returns the person to the app.
 * 4. The sign-in email's button comes back through /authorize/account/link, which checks the cookie
 *    and hands the link's token hash to the gateway in the same browser.
 * 5. When the app refreshes its token, the session is refreshed with it, so the person signs in
 *    once. Revoking the grant (Profile → Sign-in and security) ends it.
 *
 * Requests to /account/mcp and /v1/connected are then answered by the same account server as
 * /me/mcp and /v1/me, with the same database rules and rate limits: nothing here widens what an
 * account can do.
 */
import type { AuthRequest, GrantType, OAuthHelpers, TokenExchangeCallbackOptions, TokenExchangeCallbackResult } from '@cloudflare/workers-oauth-provider';

import { refreshSignIn, SignInEnv, SignInError } from './personSignIn.js';
import { meetsPasskeyStep } from './session.js';

export const ACCOUNT_SCOPE = 'account';
export const accountMcpPath = '/account/mcp';

export interface AccountOAuthEnv extends SignInEnv {
  OAUTH_PROVIDER: OAuthHelpers;
  OAUTH_KV: KVNamespace;
  /** The sign-in gateway page; https://openmedia.site/signin unless set (local: http://localhost:8081/signin). */
  SIGN_IN_GATEWAY_URL?: string;
}

/** What the grant keeps: the person and their Open Media session (stored encrypted by the provider). */
export interface AccountGrantProps { kind: 'account'; userId: string; email: string; accessToken: string; refreshToken: string; expiresAt: number; scopes: string[] }

export function isAccountGrant(props: unknown): props is AccountGrantProps {
  const value = props as AccountGrantProps | undefined;
  return value?.kind === 'account' && typeof value.userId === 'string' && typeof value.accessToken === 'string' && typeof value.refreshToken === 'string';
}

/** An authorization request for the person's account, rather than the Events owner's planner. */
export function wantsAccount(request: Pick<AuthRequest, 'scope' | 'resource'>): boolean {
  const resources = Array.isArray(request.resource) ? request.resource : request.resource ? [request.resource] : [];
  return request.scope.includes(ACCOUNT_SCOPE) || resources.some((resource) => { try { return new URL(resource).pathname.replace(/\/+$/, '') === accountMcpPath; } catch { return false; } });
}

const challengeTtl = 900;
const cookieName = 'om_account_oauth';
const attemptLimit = 10;

interface Challenge { oauthRequest: AuthRequest; clientName: string; logoUri?: string; clientUri?: string; redirectHost: string; hint?: string }

const hintPattern = /^[^\s@<>"']{1,64}@[^\s@<>"']{1,190}\.[^\s@<>"']{2,}$/;
const challengePattern = /^[0-9a-f]{64}$/;

export function signInGateway(env: Pick<AccountOAuthEnv, 'SIGN_IN_GATEWAY_URL'>): URL {
  return new URL(env.SIGN_IN_GATEWAY_URL || 'https://openmedia.site/signin');
}

function cookieChallenge(request: Request): string | undefined {
  return new RegExp(`(?:^|;\\s*)${cookieName}=([0-9a-f]{64})`).exec(request.headers.get('cookie') ?? '')?.[1];
}

async function readChallenge(env: AccountOAuthEnv, id: string): Promise<Challenge | undefined> {
  if (!challengePattern.test(id)) return undefined;
  const raw = await env.OAUTH_KV.get(`account-challenge:${id}`);
  return raw ? JSON.parse(raw) as Challenge : undefined;
}

function gatewayRedirect(env: AccountOAuthEnv, params: Record<string, string>, headers: Record<string, string> = {}): Response {
  const target = signInGateway(env);
  for (const [key, value] of Object.entries(params)) target.searchParams.set(key, value);
  return new Response(null, { status: 302, headers: { location: target.toString(), 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', ...headers } });
}

/** Only https icons (or none): the gateway shows it as an image and nothing else. */
function safeLogo(uri: string | undefined): string | undefined {
  try { const url = new URL(uri ?? ''); return url.protocol === 'https:' && uri!.length <= 2048 ? url.toString() : undefined; } catch { return undefined; }
}

/** /authorize for account connections; answers undefined for anything else so the Events flow runs. */
export async function handleAccountAuthorization(request: Request, env: AccountOAuthEnv, fetchImpl: typeof fetch = fetch): Promise<Response | undefined> {
  const url = new URL(request.url);
  if (url.pathname === '/authorize' && request.method === 'GET') {
    let oauthRequest: AuthRequest;
    try { oauthRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request); }
    catch {
      // A web app's Client ID Metadata Document may have changed (a new redirect URI) while the
      // provider still holds the old one in its cache: drop it and read the document again, once.
      if (!(await forgetClientMetadata(url.searchParams.get('client_id')))) return undefined;
      try { oauthRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request); } catch { return undefined; }
    }
    if (!wantsAccount(oauthRequest)) return undefined;
    const client = await env.OAUTH_PROVIDER.lookupClient(oauthRequest.clientId);
    if (!client) return page(400, 'Unknown app', '<h1>This app isn’t registered</h1><p>Open Media doesn’t recognise the app asking to connect. Close this page and try again from the app.</p>');
    const id = randomHex(32);
    const hint = url.searchParams.get('login_hint')?.trim().toLowerCase();
    const challenge: Challenge = {
      oauthRequest: { ...oauthRequest, scope: [ACCOUNT_SCOPE] },
      clientName: client.clientName?.slice(0, 120) || 'An AI app',
      logoUri: safeLogo(client.logoUri),
      clientUri: safeLogo(client.clientUri),
      redirectHost: hostOf(oauthRequest.redirectUri),
      ...(hint && hintPattern.test(hint) ? { hint } : {}),
    };
    await env.OAUTH_KV.put(`account-challenge:${id}`, JSON.stringify(challenge), { expirationTtl: challengeTtl });
    // The gateway does the signing in; this browser's cookie proves it is where the request started.
    return gatewayRedirect(env, { request: id }, { 'set-cookie': `${cookieName}=${id}; Path=/authorize; Max-Age=${challengeTtl}; HttpOnly; Secure; SameSite=Lax` });
  }
  if (url.pathname === '/authorize/account/request' && (request.method === 'GET' || request.method === 'OPTIONS')) {
    // What the gateway shows about the app: only its public name, icon and where it returns to.
    const cors = { 'access-control-allow-origin': signInGateway(env).origin, 'access-control-allow-methods': 'GET', 'cache-control': 'no-store', vary: 'Origin' };
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const challenge = await readChallenge(env, String(url.searchParams.get('challenge') ?? ''));
    if (!challenge) return Response.json({ error: 'expired', error_description: 'This sign-in has expired. Go back to the app and connect again.' }, { status: 404, headers: cors });
    return Response.json({ client_name: challenge.clientName, logo_uri: challenge.logoUri ?? null, client_uri: challenge.clientUri ?? null, redirect_host: challenge.redirectHost, login_hint: challenge.hint ?? null }, { headers: cors });
  }
  if (url.pathname === '/authorize/account/link' && request.method === 'GET') {
    // The sign-in email's button. It only hands the token hash to the gateway, which asks before
    // using it, so link scanners that open emails can't use up the sign-in.
    const id = String(url.searchParams.get('challenge') ?? '');
    const challenge = await readChallenge(env, id);
    if (!challenge) return page(400, 'Expired', '<h1>This sign-in has expired</h1><p>Go back to the app and connect Open Media again.</p>');
    if (cookieChallenge(request) !== id) return page(400, 'Open in the same browser', '<h1>Finish in the window you started from</h1><p>This link only works in the browser where you asked to connect. Go back to that window and type the code from the email instead.</p>');
    const tokenHash = String(url.searchParams.get('token_hash') ?? '');
    if (!/^[A-Za-z0-9_-]{16,200}$/.test(tokenHash)) return gatewayRedirect(env, { request: id });
    return gatewayRedirect(env, { request: id, token_hash: tokenHash, type: url.searchParams.get('type') === 'signup' ? 'signup' : 'magiclink' });
  }
  if (url.pathname !== '/authorize/account/session' || request.method !== 'POST') return undefined;

  // The gateway's top-level form post. Same-site, so the Lax challenge cookie comes with it.
  if (Number(request.headers.get('content-length') ?? '0') > 16_384) return page(413, 'Too large', '<h1>That request was too large</h1>');
  const origin = request.headers.get('origin');
  if (origin && origin !== url.origin && origin !== signInGateway(env).origin) return page(403, 'Not allowed', '<h1>Not allowed</h1>');
  const form = new URLSearchParams(await request.text());
  const id = String(form.get('challenge') ?? '');
  const challenge = cookieChallenge(request) === id ? await readChallenge(env, id) : undefined;
  if (!challenge) return page(400, 'Expired', '<h1>This sign-in has expired</h1><p>Go back to the app and connect Open Media again. Use the same browser from start to finish.</p>');
  if (!(await allowAttempt(request, env))) return page(429, 'Too many attempts', '<h1>Too many attempts</h1><p>Wait 15 minutes, then try again from the app.</p>');
  const accessToken = String(form.get('access_token') ?? '');
  const refreshToken = String(form.get('refresh_token') ?? '');
  const retry = (message: string) => page(400, 'Sign in again', `<h1>Sign in again</h1><p>${escapeHtml(message)}</p><p><a href="${escapeHtml(gatewayURLFor(env, id))}">Back to sign-in</a></p>`);
  if (!/^[\w-]+\.[\w-]+\.[\w-]+$/.test(accessToken) || accessToken.length > 8192 || refreshToken.length < 8 || refreshToken.length > 512) return retry('That sign-in didn’t come through.');
  const base = env.SUPABASE_URL.replace(/\/$/, '');
  // The session must be real (Supabase answers for it) and have done its second step, if any.
  const userResponse = await fetchImpl(`${base}/auth/v1/user`, { headers: { apikey: env.SUPABASE_PUBLISHABLE_KEY, authorization: `Bearer ${accessToken}` } });
  if (!userResponse.ok) return retry('That sign-in has expired.');
  const user = await userResponse.json() as { id?: string; email?: string };
  if (!user.id) return retry('That sign-in has expired.');
  if (!(await meetsPasskeyStep(base, env.SUPABASE_PUBLISHABLE_KEY, accessToken, fetchImpl).catch(() => false))) return retry('Finish the second step (passkey, authenticator app or recovery code) first.');
  const props: AccountGrantProps = { kind: 'account', userId: user.id, email: user.email ?? '', accessToken, refreshToken, expiresAt: tokenExpiry(accessToken), scopes: [ACCOUNT_SCOPE] };
  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({ request: challenge.oauthRequest, userId: user.id, metadata: { clientName: challenge.clientName, logoUri: challenge.logoUri }, scope: [ACCOUNT_SCOPE], props });
  await env.OAUTH_KV.delete(`account-challenge:${id}`);
  return new Response(null, { status: 302, headers: { location: redirectTo, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'set-cookie': `${cookieName}=; Path=/authorize; Max-Age=0; HttpOnly; Secure; SameSite=Lax` } });
}

/**
 * The OAuth provider caches each Client ID Metadata Document in the Workers Cache API
 * ("workers-oauth-provider:cimd:v1", keyed by the document URL) for as long as the document's own
 * Cache-Control allows, at most 7 days, and not at all with no-store/no-cache or no max-age. When a
 * request no longer matches the cached copy, this removes it so the next lookup fetches it fresh.
 * Only https document URLs with a path (what the provider treats as CIMD) are touched.
 */
export async function forgetClientMetadata(clientId: string | null, cacheStorage: { open(name: string): Promise<{ delete(key: string): Promise<boolean> }> } | undefined = (globalThis as { caches?: CacheStorage }).caches as never): Promise<boolean> {
  if (!clientId || !cacheStorage) return false;
  try {
    const url = new URL(clientId);
    if (url.protocol !== 'https:' || url.pathname === '/' || !url.pathname) return false;
    return await (await cacheStorage.open('workers-oauth-provider:cimd:v1')).delete(url.toString());
  } catch { return false; }
}

function gatewayURLFor(env: AccountOAuthEnv, id: string): string {
  const target = signInGateway(env);
  target.searchParams.set('request', id);
  return target.toString();
}

/** When a Supabase access token expires (its exp claim), in milliseconds; an hour from now if unreadable. */
function tokenExpiry(token: string): number {
  try {
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))) as { exp?: number };
    if (typeof payload.exp === 'number') return payload.exp * 1000;
  } catch { /* fall through */ }
  return Date.now() + 3_600_000;
}

/** A refresh the token endpoint must answer with an OAuth error (worker.ts turns it into the provider's OAuthError). */
export class AccountRefreshError extends Error {
  constructor(readonly code: 'invalid_grant' | 'temporarily_unavailable', message: string, readonly statusCode: number) { super(message); }
}

/**
 * Keeps the person's Open Media session in step with the host's token: on every refresh the
 * session is refreshed too (its refresh token rotates), and the host's token never outlives it.
 */
export async function accountTokenExchange(options: TokenExchangeCallbackOptions, env: SignInEnv, fetchImpl: typeof fetch = fetch): Promise<TokenExchangeCallbackResult | void> {
  if (!isAccountGrant(options.props)) return undefined;
  const props = options.props;
  const ttl = (expiresAt: number) => Math.max(60, Math.min(3600, Math.floor((expiresAt - Date.now()) / 1000) - 120));
  // GrantType is a runtime enum in a Workers-only module, so compare with its value.
  if (options.grantType !== ('refresh_token' as GrantType)) return { accessTokenTTL: ttl(props.expiresAt) };
  let session: Awaited<ReturnType<typeof refreshSignIn>>;
  try {
    session = await refreshSignIn(env, 'https://api.openmedia.site', { refresh_token: props.refreshToken }, fetchImpl);
  } catch (error) {
    // Supabase no longer accepts the person's session (signed out, revoked or expired): the host
    // must reconnect. Anything else is a temporary failure the host can retry.
    if (error instanceof SignInError && error.status < 500 && error.status !== 429) throw new AccountRefreshError('invalid_grant', 'This Open Media sign-in has ended. Connect Open Media again.', 400);
    throw new AccountRefreshError('temporarily_unavailable', 'Open Media sign-in is unavailable right now. Try again shortly.', 503);
  }
  const next: AccountGrantProps = { ...props, accessToken: session.access_token, refreshToken: session.refresh_token, expiresAt: Date.now() + session.expires_in * 1000 };
  return { newProps: next, accessTokenTTL: ttl(next.expiresAt) };
}

/** /account/mcp, once OAuth has checked the host's token: the account server, as the person. */
export function accountMcpRequest(request: Request, props: AccountGrantProps): Request {
  const url = new URL(request.url);
  url.pathname = '/me/mcp';
  const forwarded = new Request(url, request);
  forwarded.headers.set('authorization', `Bearer ${props.accessToken}`);
  return forwarded;
}

async function allowAttempt(request: Request, env: AccountOAuthEnv): Promise<boolean> {
  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
  const bucket = Math.floor(Date.now() / 900_000);
  const key = `account-auth-attempts:${await sha256Hex(`${ip}:${bucket}`)}`;
  const count = Number((await env.OAUTH_KV.get(key)) ?? '0');
  if (count >= attemptLimit) return false;
  await env.OAUTH_KV.put(key, String(count + 1), { expirationTtl: 960 });
  return true;
}

function page(status: number, title: string, body: string, headers: Record<string, string> = {}): Response {
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><meta name="robots" content="noindex"><title>${escapeHtml(title)} · Open Media</title>
<style>
:root{--fg:#111;--fg2:#5c5c58;--line:#e4e4df;--bg:#fafaf8;--card:#fff;--danger:#b42318}
@media (prefers-color-scheme:dark){:root{--fg:#f6f6f2;--fg2:#a8a8a3;--line:#2a2a28;--bg:#0a0a0a;--card:#121211;--danger:#ff8a80}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px 16px;background:var(--bg);color:var(--fg);font:15px/1.5 -apple-system,BlinkMacSystemFont,"SF Pro Text","Inter","Segoe UI",system-ui,sans-serif;-webkit-font-smoothing:antialiased}
main{width:100%;max-width:400px;padding:28px 24px;border:1px solid var(--line);border-radius:20px;background:var(--card)}
.brand{display:flex;align-items:center;gap:8px;font-weight:700;font-size:14px}.mark{width:18px;height:18px;border-radius:50%;background:var(--fg);position:relative}.mark:after{content:"";position:absolute;inset:5px;border-radius:50%;background:var(--card)}
h1{margin:22px 0 4px;font-size:24px;letter-spacing:-.02em;line-height:1.2}.lead{margin:0 0 20px;color:var(--fg2)}
label{display:block;margin:14px 0 6px;font-size:13px;font-weight:600}
input[type=email],input[inputmode=numeric]{width:100%;min-height:46px;padding:0 14px;border:1px solid var(--line);border-radius:12px;background:transparent;color:var(--fg);font:inherit;font-size:16px;outline:none}
input:focus{border-color:var(--fg2)}
button{width:100%;min-height:48px;margin-top:18px;border:0;border-radius:999px;background:var(--fg);color:var(--card);font:inherit;font-weight:700;cursor:pointer}
.grants{margin-top:18px;padding:14px;border-radius:14px;background:color-mix(in srgb,var(--fg) 5%,transparent)}.grants p{margin:0 0 6px;font-size:13px}.grants ul{margin:0;padding-left:18px;color:var(--fg2);font-size:13px}
.check{display:flex;gap:10px;align-items:flex-start;font-weight:500}.check input{margin-top:3px}
.error{margin:10px 0 0;color:var(--danger);font-size:13px;font-weight:600}.fine{margin:16px 0 0;color:var(--fg2);font-size:12px}
</style></head><body><main>${body}</main></body></html>`;
  return new Response(html, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'", 'referrer-policy': 'no-referrer', ...headers } });
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}

function hostOf(uri: string): string { try { return new URL(uri).host || uri; } catch { return uri; } }

function randomHex(bytes: number): string { return [...crypto.getRandomValues(new Uint8Array(bytes))].map((byte) => byte.toString(16).padStart(2, '0')).join(''); }

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
