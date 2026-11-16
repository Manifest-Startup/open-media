/**
 * The sign-in gateway at openmedia.site/signin (ADR 0042): the rules that don't depend on React or
 * Supabase, so they are tested on their own.
 *
 * - Own mode (no `request`): the Open Media web app's sign-in, with its saved session.
 * - App mode (`request` = a challenge from the Worker's /authorize): signing in to connect an app,
 *   with a separate in-memory session that is posted to the Worker at the end.
 */

export const gatewayPath = '/signin';

/** A stable web address for Profile → Sign-in and security, for apps to link to (ADR 0042). */
export const securitySettingsPath = '/settings/security';

export type LinkType = 'magiclink' | 'signup';

export interface GatewayParams {
  /** The Worker's challenge id (app mode). */
  request?: string;
  /** The one-tap email link's token hash, handed over by /authorize/account/link (app mode). */
  tokenHash?: string;
  linkType: LinkType;
  /** A PKCE code from the email's link in own mode. */
  code?: string;
  /** An error the email link came back with. */
  linkError?: string;
  loginHint?: string;
  /** Where own mode goes afterwards: a path on this site only. */
  next: string;
}

const challengePattern = /^[0-9a-f]{64}$/;
const tokenHashPattern = /^[A-Za-z0-9_-]{16,200}$/;
const emailPattern = /^[^\s@<>"']{1,64}@[^\s@<>"']{1,190}\.[^\s@<>"']{2,}$/;

export function isEmail(value: string): boolean {
  return emailPattern.test(value.trim());
}

/** Reads the gateway's address. Anything malformed is dropped rather than trusted. */
export function readGatewayParams(search: string): GatewayParams {
  const query = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const request = query.get('request') ?? '';
  const tokenHash = query.get('token_hash') ?? '';
  const code = query.get('code') ?? '';
  const hint = (query.get('login_hint') ?? '').trim().toLowerCase();
  const linkError = query.get('error_description') ?? query.get('error') ?? '';
  return {
    request: challengePattern.test(request) ? request : undefined,
    tokenHash: tokenHashPattern.test(tokenHash) ? tokenHash : undefined,
    linkType: query.get('type') === 'signup' ? 'signup' : 'magiclink',
    code: /^[\w-]{8,200}$/.test(code) ? code : undefined,
    linkError: linkError ? linkError.slice(0, 200) : undefined,
    loginHint: isEmail(hint) && hint.length <= 254 ? hint : undefined,
    next: safeNext(query.get('next')),
  };
}

/** Only a path on this site, never another origin (`//evil.test`, `https:…`) or the gateway itself. */
export function safeNext(value: string | null | undefined): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\') || /[\u0000-\u001f]/.test(value)) return '/';
  if (value === gatewayPath || value.startsWith(`${gatewayPath}?`) || value.startsWith(`${gatewayPath}/`)) return '/';
  return value.slice(0, 512);
}

/** The address to show once one-time values have been read: never keep a token in the address bar. */
export function cleanGatewaySearch(params: Pick<GatewayParams, 'request' | 'next'>): string {
  const query = new URLSearchParams();
  if (params.request) query.set('request', params.request);
  if (params.next !== '/') query.set('next', params.next);
  const text = query.toString();
  return text ? `?${text}` : '';
}

export type GatewayStep = 'sign-in' | 'second-step' | 'profile' | 'consent' | 'done';

/** What the gateway shows next, once the person is signed in or not. */
export function nextGatewayStep(state: { signedIn: boolean; secondStepNeeded: boolean; hasProfile: boolean; appMode: boolean }): GatewayStep {
  if (!state.signedIn) return 'sign-in';
  if (state.secondStepNeeded) return 'second-step';
  if (!state.hasProfile) return 'profile';
  return state.appMode ? 'consent' : 'done';
}

/** The Worker route the gateway posts the session to (app mode). */
export function sessionEndpoint(apiURL: string): string {
  return `${apiURL.replace(/\/$/, '')}/authorize/account/session`;
}

/** Where the email's one-tap button returns in app mode: the Worker checks this browser's cookie, then hands back to the gateway. */
export function appLinkRedirect(apiURL: string, challenge: string): string {
  return `${apiURL.replace(/\/$/, '')}/authorize/account/link?challenge=${challenge}`;
}

/** What an app may do once connected; the same short list for every app. */
export const consentList = [
  'See your profile, email and whether it is confirmed',
  'Read your Feed, inbox, email, chats and contacts',
  'Post, reply, message and change settings for you',
] as const;

/** Recovery codes as a plain text file the person can keep. */
export function recoveryCodesFile(codes: readonly string[], email: string | undefined, now = new Date()): string {
  return [
    'Open Media recovery codes',
    ...(email ? [`Account: ${email}`] : []),
    `Made: ${now.toISOString().slice(0, 10)}`,
    '',
    'Each code works once. Use one if you lose your passkey or authenticator app:',
    'sign in with your email, then choose "Use a recovery code".',
    '',
    ...codes,
    '',
    'Keep this file somewhere safe. Making new codes replaces all of these.',
    '',
  ].join('\n');
}

/** Typed recovery codes: lowercase, letters and digits only, shown as xxxx-xxxx-xxxx-xxxx. */
export function normalizeRecoveryCode(value: string): string {
  const raw = value.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 16);
  return raw.match(/.{1,4}/g)?.join('-') ?? '';
}
