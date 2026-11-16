/**
 * Passwords and passkeys for Open Media accounts (ADR 0034).
 *
 * - Password accounts sit alongside email codes. Signing up confirms the address with a 6-digit code;
 *   a forgotten password is reset with a code too, so nothing depends on opening a link in a
 *   particular browser.
 * - Passkeys are an optional second step after the password or email code (Supabase WebAuthn MFA).
 *   Once someone adds one, the database refuses their sessions until it is used (aal2).
 *   The web app uses the browser's WebAuthn. The iPhone app opens openmedia.site/passkey in a
 *   secure browser sheet for the prompt only and verifies the answer with its own session
 *   (src/domain/passkeyBridge.ts, ADR 0034 "Phones").
 */
import * as WebBrowser from 'expo-web-browser';
import { Platform } from 'react-native';
import type { Factor } from '@supabase/supabase-js';

import { apiConfigured, getAPIURL } from '../connectors/mailApiConnector';
import { optionsToJSON, passkeyBridgeReturn, passkeyBridgeSite, passkeyBridgeURL, readBridgeResponse, type PasskeyCeremony } from '../domain/passkeyBridge';
import { passkeyRelyingParty, passkeysSwitchedOffError, passwordProblem, weakPasswordMessage } from '../domain/passwordRules';
import { getSupabaseClient } from './supabase';

function client() {
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error('Supabase Auth is not configured for this build.');
  return supabase;
}

function friendly(error: { message?: string; code?: string; reasons?: string[] } | null | undefined, fallback: string): Error {
  const message = error?.message ?? '';
  if (error?.code === 'invalid_credentials' || /invalid login credentials/i.test(message)) return new Error('That email and password don’t match. Check them, or reset your password.');
  if (error?.code === 'email_not_confirmed' || /email not confirmed/i.test(message)) return new Error('Confirm your email first: enter the code we sent when you signed up, or sign up again to get a new one.');
  if (error?.code === 'weak_password' || /password should (be|contain)/i.test(message)) return new Error(weakPasswordMessage((error as { reasons?: string[] } | null)?.reasons ?? (/contain/i.test(message) ? ['characters'] : ['length']), message));
  if (error?.code === 'over_email_send_rate_limit' || /rate limit|security purposes/i.test(message)) return new Error('Too many emails were sent just now. Wait a minute, then try again.');
  if (error?.code === 'same_password') return new Error('That is already your password. Choose a different one.');
  if (/otp|token|expired|invalid/i.test(message)) return new Error('That code is invalid or has expired. Request a new one and try again.');
  return new Error(message || fallback);
}

function cleanCode(code: string) {
  const token = code.replace(/\s+/g, '');
  if (!/^\d{6,10}$/.test(token)) throw new Error('Enter the code from your email.');
  return token;
}

function checkPassword(password: string, email?: string) {
  const problem = passwordProblem(password, email);
  if (problem) throw new Error(problem);
}

export async function signInWithPassword(email: string, password: string): Promise<void> {
  const { error } = await client().auth.signInWithPassword({ email: email.trim(), password });
  if (error) throw friendly(error, 'Could not sign in. Try again.');
}

/**
 * Creates a password account. The address is confirmed with a code before the account can sign in.
 * If the address already has an account, Supabase deliberately answers the same way (so no one can
 * probe which addresses exist); the person then gets no code and can sign in or reset instead.
 */
export async function signUpWithPassword(email: string, password: string): Promise<void> {
  checkPassword(password, email);
  const { error } = await client().auth.signUp({ email: email.trim(), password });
  if (error) throw friendly(error, 'Could not create the account. Try again.');
}

/** Confirms a new account's email with the code from the sign-up email, which signs it in. */
export async function confirmSignUp(email: string, code: string): Promise<void> {
  const { error } = await client().auth.verifyOtp({ email: email.trim(), token: cleanCode(code), type: 'email' });
  if (error) throw friendly(error, 'Could not confirm the code.');
}

export async function sendPasswordResetCode(email: string): Promise<void> {
  const { error } = await client().auth.resetPasswordForEmail(email.trim());
  if (error) throw friendly(error, 'Could not send the reset code. Try again.');
}

/** Uses the reset code (which signs the person in) and then sets the new password. */
export async function resetPasswordWithCode(email: string, code: string, newPassword: string): Promise<void> {
  checkPassword(newPassword, email);
  const supabase = client();
  const { error } = await supabase.auth.verifyOtp({ email: email.trim(), token: cleanCode(code), type: 'recovery' });
  if (error) throw friendly(error, 'Could not confirm the code.');
  const { error: updateError } = await supabase.auth.updateUser({ password: newPassword });
  // With a passkey, Supabase only changes the password after the passkey step (aal2). Keep the new
  // password in memory until then; completePasskeyStep saves it. It is never stored anywhere.
  if (updateError && (updateError as { code?: string }).code === 'insufficient_aal') { pendingNewPassword = newPassword; return; }
  if (updateError) throw friendly(updateError, 'Could not save the new password.');
}

let pendingNewPassword: string | undefined;

/** True while a password reset is waiting for the passkey step before it can be saved. */
export function passwordResetWaitingForPasskey(): boolean { return pendingNewPassword !== undefined; }

/** Forgets a reset that was waiting for the passkey (for example after signing out). */
export function forgetPendingPasswordReset(): void { pendingNewPassword = undefined; }

/** Whether the signed-in person's account has a password (open_media_has_password; true or false only). */
export async function hasPassword(): Promise<boolean> {
  const { data, error } = await client().rpc('open_media_has_password');
  if (error) throw friendly(error, 'Could not check your password.');
  return data === true;
}

/** Sets or changes the signed-in person's password (accounts made with email codes can add one). */
export async function setPassword(newPassword: string, email?: string): Promise<void> {
  checkPassword(newPassword, email);
  const { error } = await client().auth.updateUser({ password: newPassword });
  if (error) throw friendly(error, 'Could not save the password.');
}

// Passkeys ------------------------------------------------------------------------------------

export interface Passkey { id: string; name: string; addedAt: string }

/** Whether this app can add or use a passkey here: the web app in a browser with WebAuthn, or the iPhone app (through openmedia.site). */
export function passkeysSupportedHere(): boolean {
  if (Platform.OS === 'ios') return apiConfigured();
  return Platform.OS === 'web' && typeof window !== 'undefined' && typeof window.PublicKeyCredential === 'function' && window.isSecureContext;
}

function relyingParty() {
  if (Platform.OS !== 'web') {
    const { rpId, rpOrigins } = passkeyBridgeSite(getAPIURL());
    return { rpId, rpOrigins };
  }
  return passkeyRelyingParty(window.location);
}

/** An error carrying a WebAuthn name (NotAllowedError…), so the same messages apply on phones. */
function webAuthnError(name: string, message = name): Error {
  return Object.assign(new Error(message), { name });
}

/**
 * One passkey ceremony from the phone: the challenge comes from Supabase with this app's session,
 * the prompt runs on openmedia.site/passkey in a secure sheet, and the signed answer is verified
 * here with this app's session again. Nothing secret passes through the browser.
 */
async function phonePasskeyCeremony(factorId: string, friendlyName?: string): Promise<void> {
  const supabase = client();
  const rp = relyingParty();
  const { data: challenge, error } = await supabase.auth.mfa.challenge({ factorId, webauthn: rp });
  if (!challenge) throw passkeyError(error as Error, 'Could not start the passkey.');
  const ceremony = (challenge as unknown as { webauthn: { type: PasskeyCeremony; credential_options: { publicKey: Record<string, unknown> } } }).webauthn;
  const publicKey = optionsToJSON(ceremony.credential_options.publicKey) as Record<string, unknown>;
  if (ceremony.type === 'create') {
    // Passkeys need a user name; Supabase leaves it blank, as its own web helper fills it in.
    const user = { ...(publicKey.user as { id: string; name?: string; displayName?: string }) };
    if (!user.name) {
      const email = (await supabase.auth.getUser()).data.user?.email;
      user.name = `${user.id}:${friendlyName || email || 'Open Media'}`;
    }
    user.displayName ||= user.name;
    publicKey.user = user;
  }
  const site = passkeyBridgeSite(getAPIURL());
  const result = await WebBrowser.openAuthSessionAsync(passkeyBridgeURL(site.webOrigin, { v: 1, kind: ceremony.type, publicKey }), passkeyBridgeReturn);
  if (result.type !== 'success') throw webAuthnError('NotAllowedError', 'cancelled');
  const answer = readBridgeResponse(result.url);
  if (!answer) throw new Error('The passkey page answered in a way Open Media doesn’t understand. Update the app and try again.');
  if (!answer.ok) throw webAuthnError(answer.error);
  const credential = answer.credential;
  const { error: verifyError } = await supabase.auth.mfa.verify({
    factorId,
    challengeId: challenge.id,
    // Supabase serializes the credential with its toJSON, which is what the page sent back.
    webauthn: { type: ceremony.type, rpId: rp.rpId, rpOrigins: rp.rpOrigins, credential_response: { toJSON: () => credential } },
  } as unknown as Parameters<typeof supabase.auth.mfa.verify>[0]);
  if (verifyError) throw passkeyError(verifyError, 'Could not confirm the passkey.');
}

function toPasskey(factor: Factor): Passkey {
  return { id: factor.id, name: factor.friendly_name || 'Passkey', addedAt: factor.created_at };
}

export async function listPasskeys(): Promise<Passkey[]> {
  const { data, error } = await client().auth.mfa.listFactors();
  if (error) throw friendly(error, 'Could not load your passkeys.');
  return data.all.filter((factor) => factor.factor_type === 'webauthn' && factor.status === 'verified').map(toPasskey);
}

/** Creates a passkey on this device (Touch ID, Face ID, Windows Hello, a phone or security key). */
export async function addPasskey(name: string): Promise<void> {
  if (!passkeysSupportedHere()) throw new Error('Add a passkey from Open Media on the web, in a browser that supports passkeys.');
  const supabase = client();
  // A passkey started but never finished leaves an unverified factor behind; clear those first so the
  // name can be reused and the limit isn't reached.
  const { data } = await supabase.auth.mfa.listFactors();
  for (const factor of data?.all ?? []) {
    if (factor.factor_type === 'webauthn' && factor.status === 'unverified') await supabase.auth.mfa.unenroll({ factorId: factor.id });
  }
  const friendlyName = uniqueName(name.trim() || 'Passkey', data?.all ?? []);
  if (Platform.OS !== 'web') {
    const { data: factor, error: enrollError } = await supabase.auth.mfa.enroll({ factorType: 'webauthn', friendlyName });
    if (!factor) throw passkeyError(enrollError as Error, 'Could not add the passkey.');
    try {
      await phonePasskeyCeremony(factor.id, friendlyName);
    } catch (reason) {
      // A passkey that wasn't finished must not stay behind half-made.
      await supabase.auth.mfa.unenroll({ factorId: factor.id }).catch(() => undefined);
      throw reason instanceof Error && /NotAllowedError|cancel|abort|InvalidStateError/i.test(`${reason.name} ${reason.message}`) ? passkeyError(reason, 'Could not add the passkey.') : reason;
    }
    return;
  }
  const { error } = await supabase.auth.mfa.webauthn.register({ friendlyName, webauthn: relyingParty() });
  if (error) throw passkeyError(error, 'Could not add the passkey.');
}

function uniqueName(name: string, factors: Factor[]): string {
  const taken = new Set(factors.filter((factor) => factor.status === 'verified').map((factor) => factor.friendly_name));
  if (!taken.has(name)) return name;
  for (let index = 2; ; index += 1) if (!taken.has(`${name} ${index}`)) return `${name} ${index}`;
}

export async function removePasskey(id: string): Promise<void> {
  const supabase = client();
  const { error } = await supabase.auth.mfa.unenroll({ factorId: id });
  if (error) throw friendly(error, 'Could not remove the passkey.');
  // The session stays aal2 for the remaining passkeys; refresh so the database sees the change.
  await supabase.auth.refreshSession();
}

/** True when this person has a passkey and this session hasn't used it yet. */
export async function passkeyStepNeeded(): Promise<boolean> {
  const { data, error } = await client().auth.mfa.getAuthenticatorAssuranceLevel();
  if (error) throw friendly(error, 'Could not check your sign-in.');
  if (data.nextLevel !== 'aal2' || data.currentLevel === 'aal2') return false;
  // The database has the last word: a passkey-first sign-in can already be enough (ADR 0042).
  const { data: meets, error: rpcError } = await client().rpc('open_media_session_meets_mfa');
  return rpcError !== null || meets !== true;
}

/** The authenticator app (TOTP) this account uses as its second step, if any (ADR 0042). */
export async function authenticatorStepFactor(): Promise<string | undefined> {
  const { data } = await client().auth.mfa.listFactors();
  return data?.all.find((factor) => factor.factor_type === 'totp' && factor.status === 'verified')?.id;
}

/** Confirms this sign-in with the authenticator app's 6-digit code. */
export async function completeAuthenticatorStep(factorId: string, code: string): Promise<void> {
  const token = code.replace(/\s+/g, '');
  if (!/^\d{6}$/.test(token)) throw new Error('Enter the 6-digit code from your authenticator app.');
  const supabase = client();
  const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId, code: token });
  if (error) throw new Error('That code isn’t right. Check the time on your phone and try the newest code.');
  if (pendingNewPassword !== undefined) {
    const password = pendingNewPassword;
    pendingNewPassword = undefined;
    const { error: updateError } = await supabase.auth.updateUser({ password });
    if (updateError) throw friendly(updateError, 'Signed in, but the new password couldn’t be saved. Set it again in Profile → Sign-in and security.');
  }
}

/** Confirms this sign-in with one of the person's passkeys (the browser offers the right one). */
export async function completePasskeyStep(): Promise<void> {
  if (!passkeysSupportedHere()) throw new Error('This account uses a passkey. Sign in at openmedia.site in a browser to use it.');
  const passkeys = await listPasskeys();
  if (!passkeys.length) throw new Error('No passkey was found for this account.');
  const supabase = client();
  let lastError: unknown;
  // The browser asks for one specific passkey at a time; try the newest first.
  for (const passkey of [...passkeys].sort((a, b) => b.addedAt.localeCompare(a.addedAt))) {
    const { error } = Platform.OS === 'web'
      ? await supabase.auth.mfa.webauthn.authenticate({ factorId: passkey.id, webauthn: relyingParty() })
      : await phonePasskeyCeremony(passkey.id).then(() => ({ error: null }), (reason: Error) => ({ error: reason }));
    if (!error) {
      if (pendingNewPassword !== undefined) {
        const password = pendingNewPassword;
        pendingNewPassword = undefined;
        const { error: updateError } = await supabase.auth.updateUser({ password });
        if (updateError) throw friendly(updateError, 'Signed in, but the new password couldn’t be saved. Set it again in Profile → Sign-in and security.');
      }
      return;
    }
    lastError = error;
    // Cancelling the prompt means "stop", not "try the next one".
    if (/NotAllowedError|cancel|abort/i.test(`${(error as Error).name} ${(error as Error).message}`)) break;
  }
  throw passkeyError(lastError as Error, 'Could not confirm with your passkey.');
}

/** The server has passkeys (WebAuthn MFA) switched off, so offering them would only fail. */
export class PasskeysSwitchedOff extends Error {
  constructor() { super('Passkeys aren’t switched on for Open Media yet. Try again later.'); }
}

function passkeyError(error: Error, fallback: string): Error {
  const detail = `${error?.name ?? ''} ${error?.message ?? ''} ${(error as { code?: string })?.code ?? ''}`;
  if (passkeysSwitchedOffError(detail)) return new PasskeysSwitchedOff();
  if (/NotAllowedError|cancel|abort|timed out/i.test(detail)) return new Error('The passkey prompt was closed or timed out. Try again.');
  if (/InvalidStateError|already registered/i.test(detail)) return new Error('This device already has a passkey for your account.');
  if (/SecurityError|rp ?id|origin/i.test(detail)) return new Error('Passkeys aren’t available at this web address.');
  return new Error(error?.message || fallback);
}

// Sign-in passkeys (ADR 0042) -------------------------------------------------------------------
//
// Supabase passkeys (/auth/v1/passkeys): sign in with one tap, no email or password. These are a
// way in, not a second step: the second-step passkeys above are separate (WebAuthn MFA factors).

export interface SignInPasskey { id: string; name: string; addedAt: string; lastUsedAt?: string }

/** Whether this browser can add or use sign-in passkeys (web only; the phone apps come later). */
export function signInPasskeysSupportedHere(): boolean {
  return Platform.OS === 'web' && typeof window !== 'undefined' && typeof window.PublicKeyCredential === 'function' && window.isSecureContext;
}

export async function listSignInPasskeys(): Promise<SignInPasskey[]> {
  const { data, error } = await client().auth.passkey.list();
  if (error) throw securityError(error, 'Could not load your passkeys.');
  return (data ?? []).map((item) => ({ id: item.id, name: item.friendly_name || 'Passkey', addedAt: item.created_at, lastUsedAt: item.last_used_at }));
}

/** Creates a sign-in passkey on this device and names it after the device. */
export async function addSignInPasskey(name: string): Promise<void> {
  if (!signInPasskeysSupportedHere()) throw new Error('Add a passkey from Open Media on the web, in a browser that supports passkeys.');
  const supabase = client();
  const { data, error } = await supabase.auth.registerPasskey();
  if (error || !data) throw securityError(error, 'Could not add the passkey.');
  const friendlyName = name.trim().slice(0, 120);
  if (friendlyName) await supabase.auth.passkey.update({ passkeyId: data.id, friendlyName }).catch(() => undefined);
}

export async function renameSignInPasskey(id: string, name: string): Promise<void> {
  const friendlyName = name.trim().slice(0, 120);
  if (!friendlyName) throw new Error('Give the passkey a name.');
  const { error } = await client().auth.passkey.update({ passkeyId: id, friendlyName });
  if (error) throw securityError(error, 'Could not rename the passkey.');
}

export async function removeSignInPasskey(id: string): Promise<void> {
  const { error } = await client().auth.passkey.delete({ passkeyId: id });
  if (error) throw securityError(error, 'Could not remove the passkey.');
}

// Authenticator app (TOTP) --------------------------------------------------------------------

export interface TotpEnrollment { factorId: string; secret: string; uri: string }

/** The verified authenticator app, if the person has one. */
export async function authenticatorApp(): Promise<{ id: string; name: string; addedAt: string } | undefined> {
  const { data, error } = await client().auth.mfa.listFactors();
  if (error) throw securityError(error, 'Could not load your authenticator app.');
  const factor = data.all.find((item) => item.factor_type === 'totp' && item.status === 'verified');
  return factor ? { id: factor.id, name: factor.friendly_name || 'Authenticator app', addedAt: factor.created_at } : undefined;
}

/** Starts adding an authenticator app: its secret and otpauth:// address for the QR code. */
export async function startAuthenticatorApp(): Promise<TotpEnrollment> {
  const supabase = client();
  // An earlier attempt that was never confirmed would block a new one with the same name.
  const { data: existing } = await supabase.auth.mfa.listFactors();
  for (const factor of existing?.all ?? []) if (factor.factor_type === 'totp' && factor.status === 'unverified') await supabase.auth.mfa.unenroll({ factorId: factor.id });
  const { data, error } = await supabase.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'Authenticator app', issuer: 'Open Media' });
  if (error || !data) throw securityError(error, 'Could not start adding the authenticator app.');
  return { factorId: data.id, secret: data.totp.secret, uri: data.totp.uri };
}

/** Confirms the app with its first code; from then on, signing in asks for a code. */
export async function confirmAuthenticatorApp(factorId: string, code: string): Promise<void> {
  const token = code.replace(/\s+/g, '');
  if (!/^\d{6}$/.test(token)) throw new Error('Enter the 6-digit code your authenticator app shows.');
  const { error } = await client().auth.mfa.challengeAndVerify({ factorId, code: token });
  if (error) throw securityError(error, 'That code isn’t right. Try the newest one.');
}

export async function cancelAuthenticatorApp(factorId: string): Promise<void> {
  await client().auth.mfa.unenroll({ factorId }).catch(() => undefined);
}

export async function removeAuthenticatorApp(factorId: string): Promise<void> {
  const supabase = client();
  const { error } = await supabase.auth.mfa.unenroll({ factorId });
  if (error) throw securityError(error, 'Could not remove the authenticator app.');
  await supabase.auth.refreshSession();
}

// Recovery codes ------------------------------------------------------------------------------

export async function recoveryCodesLeft(): Promise<number> {
  const { data, error } = await client().rpc('open_media_recovery_codes_left');
  if (error) throw securityError(error, 'Could not check your recovery codes.');
  return Number(data) || 0;
}

/** Ten new one-time codes, replacing the old ones. They are shown once; only hashes are kept. */
export async function newRecoveryCodes(): Promise<string[]> {
  const { data, error } = await client().rpc('open_media_new_recovery_codes');
  if (error) throw securityError(error, 'Could not make recovery codes.');
  return (data as string[]) ?? [];
}

// Apps signed in with Open Media --------------------------------------------------------------

export interface ConnectedApp { id: string; name: string; logoUri?: string; connectedAt: string }

async function accountAPI(path: string, method = 'GET') {
  const { data } = await client().auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error('Sign in first.');
  const response = await fetch(`${getAPIURL()}${path}`, { method, headers: { authorization: `Bearer ${token}` } });
  const body = await response.json().catch(() => undefined) as Record<string, unknown> | undefined;
  if (!response.ok) throw new Error(((body?.error as { message?: string } | undefined)?.message) ?? 'Open Media couldn’t answer. Try again shortly.');
  return body ?? {};
}

export async function listConnectedApps(): Promise<{ apps: ConnectedApp[]; available: boolean }> {
  const body = await accountAPI('/v1/me/apps') as { apps?: Array<{ id: string; name: string; logo_uri: string | null; connected_at: string }>; available?: boolean };
  return { apps: (body.apps ?? []).map((app) => ({ id: app.id, name: app.name, logoUri: app.logo_uri ?? undefined, connectedAt: app.connected_at })), available: body.available !== false };
}

/** Disconnects an app: its access stops at once. */
export async function disconnectApp(id: string): Promise<void> {
  await accountAPI(`/v1/me/apps/${encodeURIComponent(id)}`, 'DELETE');
}

/** True when Supabase wants this session's second step before a change (insufficient_aal). */
export function needsSecondStepFirst(error: unknown): boolean {
  return error instanceof Error && error.name === 'SecondStepFirst';
}

function securityError(error: { message?: string; code?: string; name?: string } | null | undefined, fallback: string): Error {
  const detail = `${error?.code ?? ''} ${error?.message ?? ''}`;
  if (/insufficient_aal|AAL2 (session|required)/i.test(detail)) return Object.assign(new Error('Confirm it’s you first, with your passkey or authenticator app, then try again.'), { name: 'SecondStepFirst' });
  if (/NotAllowedError|cancel|abort|timed out/i.test(`${error?.name ?? ''} ${detail}`)) return new Error('The passkey prompt was closed or timed out. Try again.');
  if (/InvalidStateError|already registered|excludeCredentials/i.test(`${error?.name ?? ''} ${detail}`)) return new Error('This device already has a passkey for your account.');
  if (/passkey.*(disabled|not enabled)|totp.*(disabled|not enabled)|mfa_totp_(enroll|verify)_not_enabled/i.test(detail)) return new Error('That isn’t switched on for Open Media yet. Try again later.');
  return friendly(error, fallback);
}
