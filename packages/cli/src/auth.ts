/**
 * Signing in from the command line.
 *
 * Browser login (the default) is OAuth 2.1 with PKCE and a loopback redirect (RFC 8252): the CLI
 * registers itself once per API origin as a public client named "Open Media CLI" (dynamic client
 * registration, cached), listens on http://127.0.0.1:<random port>/callback, and opens
 * /authorize?scope=account. The Worker sends the browser to the sign-in gateway (passkeys, email
 * code, second step), then back to the CLI with a code. The grant shows in Profile → Sign-in and
 * security → connected apps, and `logout` revokes it.
 *
 * The email-code fallback (`login <email>`, for headless machines and agents) keeps the session
 * the API returns. Either way the tokens live in ~/.config/open-media/credentials.json (0600; the
 * folder is 0700). The macOS Keychain isn't used: without a native module the only way in is the
 * `security` command, which would put the token on a process command line.
 */
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { OpenMedia, OpenMediaError, Session } from '../../sdk/src/index';

export type Env = Record<string, string | undefined>;

export const clientName = 'Open Media CLI';
export const accountScope = 'account';

export interface OAuthCredential { kind: 'oauth'; client_id: string; access_token: string; refresh_token?: string; expires_at: number; scope?: string; token_endpoint: string; revocation_endpoint?: string }
export interface SessionCredential { kind: 'session'; access_token: string; refresh_token: string; expires_at: number; user?: { id: string; email?: string } }
export type Credential = OAuthCredential | SessionCredential;

interface Store {
  version: 1;
  /** Signed-in credentials, one per API origin. */
  servers: Record<string, Credential>;
  /** This CLI's registered OAuth client, one per API origin. Kept across logout. */
  clients: Record<string, { client_id: string; redirect_uri: string; registered_at: string }>;
}

export function configDir(env: Env): string {
  return env.OPEN_MEDIA_CONFIG_DIR ?? join(env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'open-media');
}

export function cacheDir(env: Env): string {
  return env.OPEN_MEDIA_CACHE_DIR ?? join(env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'open-media');
}

export function credentialsFile(env: Env): string { return join(configDir(env), 'credentials.json'); }

function emptyStore(): Store { return { version: 1, servers: {}, clients: {} }; }

export function readStore(env: Env): Store {
  const file = credentialsFile(env);
  let store = emptyStore();
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<Store>;
      store = { version: 1, servers: parsed.servers ?? {}, clients: parsed.clients ?? {} };
    } catch { /* unreadable: start again */ }
  }
  // 0.1's session.json (email-code sign-in) is still honoured, and moved over on the next write.
  const legacy = join(configDir(env), 'session.json');
  if (existsSync(legacy)) {
    try {
      const saved = JSON.parse(readFileSync(legacy, 'utf8')) as Session & { expires_at: number; base_url: string };
      if (saved.base_url && !store.servers[saved.base_url]) store.servers[saved.base_url] = { kind: 'session', access_token: saved.access_token, refresh_token: saved.refresh_token, expires_at: saved.expires_at, user: saved.user };
    } catch { /* ignore */ }
  }
  return store;
}

export function writeStore(env: Env, store: Store) {
  const dir = configDir(env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = credentialsFile(env);
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(store, null, 2), { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, file);
  rmSync(join(dir, 'session.json'), { force: true });
}

export function saveCredential(env: Env, baseUrl: string, credential: Credential) {
  const store = readStore(env);
  store.servers[baseUrl] = credential;
  writeStore(env, store);
}

export function forgetCredential(env: Env, baseUrl: string) {
  const store = readStore(env);
  delete store.servers[baseUrl];
  writeStore(env, store);
}

export function sessionCredential(session: Session, now = Date.now()): SessionCredential {
  return { kind: 'session', access_token: session.access_token, refresh_token: session.refresh_token, expires_at: Math.floor(now / 1000) + session.expires_in, user: session.user };
}

export interface Access { token: string; kind: 'oauth' | 'session' | 'env' }

/**
 * The token to use for account calls: OPEN_MEDIA_TOKEN wins; otherwise the saved credential,
 * renewed when it has under a minute left (or when `force` says the server refused it).
 */
export async function currentAccess(env: Env, baseUrl: string, options: { fetch?: typeof fetch; force?: boolean; now?: () => number } = {}): Promise<Access | undefined> {
  if (env.OPEN_MEDIA_TOKEN) return { token: env.OPEN_MEDIA_TOKEN, kind: 'env' };
  const credential = readStore(env).servers[baseUrl];
  if (!credential) return undefined;
  const now = (options.now ?? Date.now)() / 1000;
  if (!options.force && credential.expires_at - 60 > now) return { token: credential.access_token, kind: credential.kind };
  if (credential.kind === 'session') {
    const renewed = await new OpenMedia({ baseUrl, fetch: options.fetch }).refreshSession(credential.refresh_token).catch(() => undefined);
    if (!renewed) return undefined;
    saveCredential(env, baseUrl, sessionCredential(renewed));
    return { token: renewed.access_token, kind: 'session' };
  }
  if (!credential.refresh_token) return undefined;
  const tokens = await tokenRequest(credential.token_endpoint, { grant_type: 'refresh_token', refresh_token: credential.refresh_token, client_id: credential.client_id }, options.fetch).catch((error) => {
    // A revoked or expired grant: forget it so the next command says to sign in again.
    if (error instanceof OpenMediaError && (error.code === 'invalid_grant' || error.code === 'invalid_client')) forgetCredential(env, baseUrl);
    return undefined;
  });
  if (!tokens) return undefined;
  saveCredential(env, baseUrl, { ...credential, access_token: tokens.access_token, refresh_token: tokens.refresh_token ?? credential.refresh_token, expires_at: Math.floor(Date.now() / 1000) + (tokens.expires_in ?? 3600), scope: tokens.scope ?? credential.scope });
  return { token: tokens.access_token, kind: 'oauth' };
}

// ─── OAuth ───────────────────────────────────────────────────────────────────

export interface ServerMetadata { issuer?: string; authorization_endpoint: string; token_endpoint: string; registration_endpoint?: string; revocation_endpoint?: string }

export async function discover(baseUrl: string, fetchImpl: typeof fetch = globalThis.fetch): Promise<ServerMetadata> {
  const fallback = { authorization_endpoint: `${baseUrl}/authorize`, token_endpoint: `${baseUrl}/oauth/token`, registration_endpoint: `${baseUrl}/oauth/register`, revocation_endpoint: `${baseUrl}/oauth/token` };
  try {
    const response = await fetchImpl(`${baseUrl}/.well-known/oauth-authorization-server`, { headers: { accept: 'application/json' } });
    if (!response.ok) return fallback;
    const metadata = await response.json() as Partial<ServerMetadata>;
    if (!metadata.authorization_endpoint || !metadata.token_endpoint) return fallback;
    return { ...fallback, ...metadata } as ServerMetadata;
  } catch { return fallback; }
}

interface TokenResponse { access_token: string; token_type?: string; expires_in?: number; refresh_token?: string; scope?: string }

async function tokenRequest(endpoint: string, form: Record<string, string>, fetchImpl: typeof fetch = globalThis.fetch): Promise<TokenResponse> {
  const response = await fetchImpl(endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: new URLSearchParams(form).toString() });
  const text = await response.text();
  let payload: Record<string, unknown> = {};
  try { payload = JSON.parse(text); } catch { /* not JSON */ }
  if (!response.ok || typeof payload.access_token !== 'string') {
    throw new OpenMediaError(response.status, typeof payload.error === 'string' ? payload.error : `http_${response.status}`, typeof payload.error_description === 'string' ? payload.error_description : 'Open Media didn’t issue a token.');
  }
  return payload as unknown as TokenResponse;
}

/** The redirect URI the CLI registers. The provider matches loopback URIs on any port (RFC 8252 §7.3). */
export const registeredRedirectUri = 'http://127.0.0.1/callback';

/** This CLI's client_id for this API origin: registered once, then reused. */
export async function ensureClient(env: Env, baseUrl: string, metadata: ServerMetadata, fetchImpl: typeof fetch = globalThis.fetch, options: { fresh?: boolean } = {}): Promise<string> {
  const store = readStore(env);
  const known = store.clients[baseUrl];
  if (known && !options.fresh) return known.client_id;
  if (!metadata.registration_endpoint) throw new OpenMediaError(400, 'registration_unavailable', 'This server doesn’t accept new OAuth clients. Use open-media login <email> instead.');
  const response = await fetchImpl(metadata.registration_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      client_name: clientName,
      client_uri: 'https://openmedia.site',
      redirect_uris: [registeredRedirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: accountScope,
      software_id: 'open-media-cli',
    }),
  });
  const payload = await response.json().catch(() => ({})) as { client_id?: string; error?: string; error_description?: string };
  if (!response.ok || !payload.client_id) throw new OpenMediaError(response.status, payload.error ?? `http_${response.status}`, payload.error_description ?? 'Open Media didn’t register the CLI.');
  const latest = readStore(env);
  latest.clients[baseUrl] = { client_id: payload.client_id, redirect_uri: registeredRedirectUri, registered_at: new Date().toISOString() };
  writeStore(env, latest);
  return payload.client_id;
}

function base64url(buffer: Buffer): string { return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(48));
  return { verifier, challenge: base64url(createHash('sha256').update(verifier).digest()) };
}

/** Opens a URL in the default browser; never throws (the URL is printed as well). */
export function openInBrowser(url: string): void {
  try {
    const [command, args] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url.replace(/&/g, '^&')]] : ['xdg-open', [url]];
    const child = spawn(command as string, args as string[], { stdio: 'ignore', detached: true });
    child.on('error', () => undefined);
    child.unref();
  } catch { /* printed URL is the fallback */ }
}

const donePage = (title: string, message: string) => `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>${title} · Open Media</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;font:16px/1.5 -apple-system,system-ui,sans-serif;padding:16px}main{max-width:380px;text-align:center}h1{font-size:22px}</style></head><body><main><h1>${title}</h1><p>${message}</p></main></body></html>`;

export interface BrowserLoginOptions {
  baseUrl: string;
  env: Env;
  fetch?: typeof fetch;
  /** Opens the authorization URL; by default the system browser. Tests drive the redirect here. */
  openBrowser?: (url: string) => void | Promise<void>;
  log?: (line: string) => void;
  timeoutMs?: number;
  loginHint?: string;
}

/** OAuth 2.1 + PKCE with a loopback redirect. Saves and returns the credential. */
export async function browserLogin(options: BrowserLoginOptions): Promise<OAuthCredential> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const log = options.log ?? ((line: string) => console.error(line));
  const metadata = await discover(options.baseUrl, fetchImpl);
  const clientId = await ensureClient(options.env, options.baseUrl, metadata, fetchImpl);
  const { verifier, challenge } = pkcePair();
  const state = base64url(randomBytes(24));

  let settle!: (value: { code: string } | { error: string }) => void;
  // RFC 9207: when the server names itself on the redirect, it must be the server we asked.
  const issuerMatches = (iss: string | null) => !iss || !metadata.issuer || iss === metadata.issuer;
  const outcome = new Promise<{ code: string } | { error: string }>((resolve) => { settle = resolve; });
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/callback') { response.writeHead(404).end(); return; }
    const send = (status: number, title: string, message: string) => response.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(donePage(title, message));
    if (url.searchParams.get('state') !== state || !issuerMatches(url.searchParams.get('iss'))) { send(400, 'Something went wrong', 'This sign-in didn’t come from the command you ran. Run open-media login again.'); return; }
    const error = url.searchParams.get('error');
    if (error) { send(400, 'Not connected', 'The Open Media CLI wasn’t connected. You can close this tab.'); settle({ error: url.searchParams.get('error_description') ?? error }); return; }
    const code = url.searchParams.get('code');
    if (!code) { send(400, 'Something went wrong', 'No code came back. Run open-media login again.'); return; }
    send(200, 'You’re signed in', 'The Open Media CLI is connected to your account. You can close this tab and go back to the terminal.');
    settle({ code });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve()); });
  const port = (server.address() as { port: number }).port;
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  try {
    const authorize = new URL(metadata.authorization_endpoint);
    authorize.search = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: redirectUri, scope: accountScope, state, code_challenge: challenge, code_challenge_method: 'S256', ...(options.loginHint ? { login_hint: options.loginHint } : {}) }).toString();
    log(`Opening your browser to sign in to Open Media. If it doesn’t open, visit:\n\n  ${authorize}\n`);
    await (options.openBrowser ?? openInBrowser)(authorize.toString());
    const timeout = options.timeoutMs ?? 5 * 60 * 1000;
    let timer: NodeJS.Timeout | undefined;
    const result = await Promise.race([outcome, new Promise<{ error: string }>((resolve) => { timer = setTimeout(() => resolve({ error: 'Timed out waiting for the browser. Run open-media login again.' }), timeout); })]);
    clearTimeout(timer);
    if ('error' in result) throw new OpenMediaError(400, 'access_denied', result.error);
    const tokens = await tokenRequest(metadata.token_endpoint, { grant_type: 'authorization_code', code: result.code, redirect_uri: redirectUri, client_id: clientId, code_verifier: verifier }, fetchImpl).catch((error) => {
      // The cached client was deleted on the server: register again next time.
      if (error instanceof OpenMediaError && error.code === 'invalid_client') {
        const store = readStore(options.env);
        delete store.clients[options.baseUrl];
        writeStore(options.env, store);
      }
      throw error;
    });
    const credential: OAuthCredential = { kind: 'oauth', client_id: clientId, access_token: tokens.access_token, refresh_token: tokens.refresh_token, expires_at: Math.floor(Date.now() / 1000) + (tokens.expires_in ?? 3600), scope: tokens.scope, token_endpoint: metadata.token_endpoint, revocation_endpoint: metadata.revocation_endpoint };
    saveCredential(options.env, options.baseUrl, credential);
    return credential;
  } finally {
    server.close();
    server.closeAllConnections?.();
  }
}

/** Revokes the saved grant (or ends the email-code session) and forgets it. Never throws for network trouble. */
export async function signOut(env: Env, baseUrl: string, fetchImpl: typeof fetch = globalThis.fetch): Promise<{ revoked: boolean; kind?: Credential['kind'] }> {
  const credential = readStore(env).servers[baseUrl];
  let revoked = false;
  if (credential?.kind === 'oauth') {
    // Revoking the refresh token ends the whole grant (RFC 7009), so the app disappears from connected apps.
    const endpoint = credential.revocation_endpoint ?? credential.token_endpoint;
    const token = credential.refresh_token ?? credential.access_token;
    const response = await fetchImpl(endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token, token_type_hint: credential.refresh_token ? 'refresh_token' : 'access_token', client_id: credential.client_id }).toString() }).catch(() => undefined);
    revoked = Boolean(response?.ok);
  } else if (credential?.kind === 'session') {
    revoked = await new OpenMedia({ baseUrl, token: credential.access_token, fetch: fetchImpl }).signOut().then(() => true, () => false);
  }
  if (credential) forgetCredential(env, baseUrl);
  return { revoked, kind: credential?.kind };
}
