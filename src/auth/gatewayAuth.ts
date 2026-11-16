/**
 * Signing in on the sign-in gateway (ADR 0042), with whichever Supabase client the gateway uses:
 * the web app's saved one (own mode) or a separate in-memory one (app mode). Web only.
 *
 * - Passkey first: Supabase passkeys (`/auth/v1/passkeys/*`). The browser offers them in the
 *   email field's autofill (conditional UI) where it can, and behind the primary button.
 * - Email: a one-tap link and a code. Password: behind a quiet link.
 * - Second step, when the account has one and this session hasn't done it: a passkey (WebAuthn
 *   MFA), the authenticator app's code (TOTP), or a one-time recovery code.
 */
import type { Factor, Session, SupabaseClient } from '@supabase/supabase-js';

import { getAPIURL } from '../connectors/mailApiConnector';
import { passkeyRelyingParty, passkeysSwitchedOffError } from '../domain/passwordRules';
import { signInEmailError } from '../domain/signInErrors';

export type SecondStep = { needed: false } | { needed: true; passkey: boolean; totpFactorId?: string };

function readable(error: { message?: string; code?: string; name?: string } | null | undefined, fallback: string): Error {
  const message = error?.message ?? '';
  const detail = `${error?.name ?? ''} ${message} ${error?.code ?? ''}`;
  if (passkeysSwitchedOffError(detail) || /passkey.*(disabled|not enabled)/i.test(detail)) return new Error('Passkeys aren’t switched on for Open Media yet. Continue with email instead.');
  if (/NotAllowedError|cancel|abort|timed out/i.test(detail)) return new Error('The passkey prompt was closed or timed out. Try again, or continue with email.');
  if (/InvalidStateError|already registered/i.test(detail)) return new Error('This device already has a passkey for your account.');
  if (/SecurityError|rp ?id|origin/i.test(detail)) return new Error('Passkeys aren’t available at this web address.');
  if (/credential.*(not found|unknown)|passkey.*not found/i.test(detail)) return new Error('That passkey isn’t linked to an Open Media account. Continue with email instead.');
  if (error?.code === 'invalid_credentials' || /invalid login credentials/i.test(message)) return new Error('That email and password don’t match. Check them, or continue with email instead.');
  if (error?.code === 'email_not_confirmed' || /email not confirmed/i.test(message)) return new Error('Confirm your email first: continue with email and use the code we send.');
  if (/invalid.*(totp|code)|mfa_verification_failed/i.test(detail)) return new Error('That code isn’t right. Check the time on your phone and try the newest code.');
  if (/otp|token|expired|invalid/i.test(message)) return new Error('That code or link is invalid or has expired. Ask for a new one.');
  return new Error(message || fallback);
}

export function passkeysAvailableHere(): boolean {
  return typeof window !== 'undefined' && typeof window.PublicKeyCredential === 'function' && window.isSecureContext;
}

/** Whether the browser can offer passkeys in the email field's autofill (conditional UI). */
export async function passkeyAutofillAvailable(): Promise<boolean> {
  if (!passkeysAvailableHere()) return false;
  const credential = window.PublicKeyCredential as unknown as { isConditionalMediationAvailable?: () => Promise<boolean>; parseRequestOptionsFromJSON?: unknown };
  if (typeof credential.parseRequestOptionsFromJSON !== 'function' || typeof credential.isConditionalMediationAvailable !== 'function') return false;
  return credential.isConditionalMediationAvailable().catch(() => false);
}

/** "Continue with passkey": the browser asks which passkey, and one tap signs in. */
export async function signInWithPasskey(client: SupabaseClient): Promise<Session> {
  if (!passkeysAvailableHere()) throw new Error('This browser can’t use passkeys here. Continue with email instead.');
  const { data, error } = await client.auth.signInWithPasskey();
  if (error || !data?.session) throw readable(error, 'Could not sign in with your passkey.');
  return data.session;
}

/**
 * Waits for the person to pick a passkey from the email field's autofill. Resolves undefined when
 * aborted (for example, when they press "Continue with passkey" instead, or type their email).
 */
export async function passkeyAutofill(client: SupabaseClient, signal: AbortSignal): Promise<Session | undefined> {
  const { data: options, error } = await client.auth.passkey.startAuthentication();
  if (error || !options || signal.aborted) return undefined;
  const parse = (window.PublicKeyCredential as unknown as { parseRequestOptionsFromJSON: (json: unknown) => PublicKeyCredentialRequestOptions }).parseRequestOptionsFromJSON;
  let credential: Credential | null;
  try {
    credential = await navigator.credentials.get({ publicKey: parse(options.options), mediation: 'conditional', signal } as CredentialRequestOptions);
  } catch {
    return undefined;
  }
  if (!credential || signal.aborted) return undefined;
  const { data, error: verifyError } = await client.auth.passkey.verifyAuthentication({ challengeId: options.challenge_id, credential: (credential as PublicKeyCredential & { toJSON: () => unknown }).toJSON() as never });
  if (verifyError || !data?.session) throw readable(verifyError, 'Could not sign in with your passkey.');
  return data.session;
}

/** Emails a one-tap link and a code. `redirectTo` is where the link's button comes back to. */
export async function sendEmailSignIn(client: SupabaseClient, email: string, redirectTo: string): Promise<void> {
  const { error } = await client.auth.signInWithOtp({ email: email.trim().toLowerCase(), options: { emailRedirectTo: redirectTo, shouldCreateUser: true } });
  if (error) throw signInEmailError(error);
}

export async function verifyEmailCode(client: SupabaseClient, email: string, code: string): Promise<Session> {
  const token = code.replace(/\s+/g, '');
  if (!/^\d{6,10}$/.test(token)) throw new Error('Enter the code from your sign-in email.');
  const { data, error } = await client.auth.verifyOtp({ email: email.trim().toLowerCase(), token, type: 'email' });
  if (error || !data.session) throw readable(error, 'Could not sign in with that code.');
  return data.session;
}

/** The email's one-tap link, by its token hash (app mode: handed over by the Worker). */
export async function verifyLinkToken(client: SupabaseClient, tokenHash: string, type: 'magiclink' | 'signup'): Promise<Session> {
  const { data, error } = await client.auth.verifyOtp({ token_hash: tokenHash, type });
  if (error || !data.session) throw readable(error, 'That sign-in link didn’t work. Type the code from the email instead.');
  return data.session;
}

/** The email's link in own mode (PKCE): only works in the browser that asked for it. */
export async function exchangeLinkCode(client: SupabaseClient, code: string): Promise<Session> {
  const { data, error } = await client.auth.exchangeCodeForSession(code);
  if (error || !data.session) {
    if (/code.?verifier/i.test(`${error?.name} ${error?.message} ${(error as { code?: string })?.code}`)) throw new Error('This link was opened in a different browser than the one that asked for it. Type the code from the email instead.');
    throw readable(error, 'That sign-in link didn’t work. Type the code from the email instead.');
  }
  return data.session;
}

export async function signInWithPassword(client: SupabaseClient, email: string, password: string): Promise<Session> {
  const { data, error } = await client.auth.signInWithPassword({ email: email.trim(), password });
  if (error || !data.session) throw readable(error, 'Could not sign in. Try again.');
  return data.session;
}

/** Whether this session still owes its second step, by the database's own rule (open_media_session_meets_mfa). */
export async function secondStepFor(client: SupabaseClient): Promise<SecondStep> {
  const { data, error } = await client.rpc('open_media_session_meets_mfa');
  if (!error && data === true) return { needed: false };
  if (error && error.code !== 'open_media_passkey_required' && !/passkey/i.test(error.message ?? '')) throw readable(error, 'Could not check your sign-in.');
  const { data: factors, error: factorError } = await client.auth.mfa.listFactors();
  if (factorError) throw readable(factorError, 'Could not check your sign-in.');
  const verified = (factors?.all ?? []).filter((factor: Factor) => factor.status === 'verified');
  return { needed: true, passkey: verified.some((factor) => factor.factor_type === 'webauthn'), totpFactorId: verified.find((factor) => factor.factor_type === 'totp')?.id };
}

/** The passkey second step (WebAuthn MFA): the browser offers the right passkey. */
export async function confirmWithPasskey(client: SupabaseClient): Promise<void> {
  if (!passkeysAvailableHere()) throw new Error('This browser can’t use passkeys here. Use your authenticator app or a recovery code.');
  const { data } = await client.auth.mfa.listFactors();
  const passkeys = (data?.all ?? []).filter((factor) => factor.factor_type === 'webauthn' && factor.status === 'verified').sort((a, b) => b.created_at.localeCompare(a.created_at));
  if (!passkeys.length) throw new Error('No passkey was found for this account.');
  let last: unknown;
  for (const passkey of passkeys) {
    const { error } = await client.auth.mfa.webauthn.authenticate({ factorId: passkey.id, webauthn: passkeyRelyingParty(window.location) });
    if (!error) { await client.auth.refreshSession(); return; }
    last = error;
    if (/NotAllowedError|cancel|abort/i.test(`${error.name} ${error.message}`)) break;
  }
  throw readable(last as Error, 'Could not confirm with your passkey.');
}

/** The authenticator app's 6-digit code. */
export async function confirmWithTotp(client: SupabaseClient, factorId: string, code: string): Promise<void> {
  const token = code.replace(/\s+/g, '');
  if (!/^\d{6}$/.test(token)) throw new Error('Enter the 6-digit code from your authenticator app.');
  const { error } = await client.auth.mfa.challengeAndVerify({ factorId, code: token });
  if (error) throw readable(error, 'Could not check that code.');
}

/**
 * A recovery code: the Worker uses it up and removes this account's second-step factors, so this
 * same session is then fully signed in. The person should set a second step up again.
 */
export async function useRecoveryCode(client: SupabaseClient, code: string): Promise<void> {
  const { data } = await client.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error('Sign in with your email or password first.');
  const response = await fetch(`${getAPIURL()}/v1/auth/recovery`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ code }) });
  if (!response.ok) {
    const body = await response.json().catch(() => undefined) as { error?: { message?: string } } | undefined;
    throw new Error(body?.error?.message ?? 'Couldn’t use that recovery code. Try again shortly.');
  }
  // A fresh token, so nothing still remembers the removed factors.
  await client.auth.refreshSession();
}
