import Ionicons from './Icon';
import { useThemedStyles } from './useThemedStyles';
import type { Session, SupabaseClient } from '@supabase/supabase-js';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Image, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { confirmWithPasskey, confirmWithTotp, exchangeLinkCode, passkeyAutofill, passkeyAutofillAvailable, passkeysAvailableHere, secondStepFor, SecondStep, sendEmailSignIn, signInWithPasskey, signInWithPassword, useRecoveryCode as redeemRecoveryCode, verifyEmailCode, verifyLinkToken } from '../auth/gatewayAuth';
import { addSignInPasskey } from '../auth/accountSecurity';
import { createGatewayClient, getSupabaseClient, localAutoSignInAvailable, waitForLocalSignIn } from '../auth/supabase';
import { getAPIURL } from '../connectors/mailApiConnector';
import { getCurrentProfile, saveCurrentProfile } from '../data/openMediaService';
import { appLinkRedirect, cleanGatewaySearch, consentList, gatewayPath, GatewayParams, isEmail, nextGatewayStep, normalizeRecoveryCode, readGatewayParams, sessionEndpoint } from '../domain/signInGateway';
import { ThemeColors } from '../theme';
import { useOpenMediaTheme } from '../themeContext';
import { BrandMark } from './BrandMark';
import { Loader } from './Loader';
import { Text, TextInput } from './Text';

/**
 * openmedia.site/signin: one sign-in for Open Media and every app that signs in with it (ADR 0042).
 *
 * Passkey first, then email (a one-tap link and a code), then a password behind a quiet link. New
 * accounts choose a name and handle here; accounts with a second step confirm it here. In app mode
 * (`?request=` from the Worker's /authorize) it shows the app, signs in with its own in-memory
 * session and hands that session to the Worker with a top-level form post. In own mode it is the
 * web app's sign-in and goes to the app afterwards.
 */
export function SignInGateway() {
  const params = useMemo<GatewayParams>(() => readGatewayParams(typeof window !== 'undefined' ? window.location.search : ''), []);
  const appMode = Boolean(params.request);
  const client = useMemo(() => (appMode ? appModeClient() : getSupabaseClient()), [appMode]);
  const [app, setApp] = useState<AppInfo>();
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [session, setSession] = useState<Session>();
  const [notice, setNotice] = useState('');

  // One-time values (token hash, link code) never stay in the address bar.
  useEffect(() => {
    if (typeof window !== 'undefined') window.history.replaceState(null, '', `${gatewayPath}${cleanGatewaySearch(params)}`);
    if (typeof document !== 'undefined') document.title = 'Sign in · Open Media';
  }, [params]);

  /** Signed in (or already was): the second step, a new profile, the app's consent, or the app. */
  const advance = useCallback(async (next: Session, options: { newProfile?: boolean } = {}) => {
    if (!client) return;
    setSession(next);
    setPhase({ kind: 'loading' });
    try {
      const step = await secondStepFor(client);
      const profile = step.needed ? undefined : await getCurrentProfile(next, client);
      const where = nextGatewayStep({ signedIn: true, secondStepNeeded: step.needed, hasProfile: Boolean(profile), appMode });
      if (where === 'second-step') return setPhase({ kind: 'second-step', step: step as Extract<SecondStep, { needed: true }> });
      if (where === 'profile') return setPhase({ kind: 'profile' });
      // A new account gets one chance to add a passkey, so next time is one tap.
      if (options.newProfile && !appMode && passkeysAvailableHere()) return setPhase({ kind: 'offer-passkey' });
      if (where === 'consent') return setPhase({ kind: 'consent' });
      setPhase({ kind: 'leaving' });
      window.location.replace(params.next);
    } catch (reason) {
      setPhase({ kind: 'sign-in', error: messageFor(reason) });
    }
  }, [appMode, client, params.next]);

  useEffect(() => {
    if (!client) return;
    let active = true;
    (async () => {
      if (appMode) {
        const info = await loadApp(params.request!);
        if (!active) return;
        if (!info) return setPhase({ kind: 'expired' });
        setApp(info);
        if (params.tokenHash) return setPhase({ kind: 'link', tokenHash: params.tokenHash, type: params.linkType });
        return setPhase({ kind: 'sign-in', email: info.loginHint ?? params.loginHint });
      }
      if (params.code) {
        try { const next = await exchangeLinkCode(client, params.code); if (active) await advance(next); }
        catch (reason) { if (active) setPhase({ kind: 'sign-in', error: messageFor(reason) }); }
        return;
      }
      const { data } = await client.auth.getSession();
      if (!active) return;
      if (data.session) return advance(data.session);
      setPhase({ kind: 'sign-in', email: params.loginHint, error: params.linkError ? 'That sign-in link didn’t work or has expired. Ask for a new one.' : undefined });
    })().catch((reason) => { if (active) setPhase({ kind: 'sign-in', error: messageFor(reason) }); });
    return () => { active = false; };
  }, [advance, appMode, client, params]);

  const signOut = useCallback(async () => {
    await client?.auth.signOut({ scope: 'local' }).catch(() => undefined);
    setSession(undefined); setNotice('');
    setPhase({ kind: 'sign-in', email: app?.loginHint });
  }, [app?.loginHint, client]);

  if (!client) return <Shell><Card><BrandMark /><Title>Sign-in isn’t set up</Title><Lead>This build has no Supabase configuration.</Lead></Card></Shell>;
  const header = <GatewayHeader app={app} />;
  switch (phase.kind) {
    case 'loading': return <Shell><Card>{header}<View style={localStyles.centered}><Loader /></View></Card></Shell>;
    case 'leaving': return <Shell><Card>{header}<Title>{appMode ? `Returning to ${app?.name ?? 'the app'}…` : 'Opening Open Media…'}</Title><View style={localStyles.centered}><Loader /></View></Card></Shell>;
    case 'expired': return <Shell><Card><BrandMark /><Title>This sign-in has expired</Title><Lead>Go back to the app and choose “Continue with Open Media” again. Use the same browser from start to finish.</Lead></Card></Shell>;
    case 'link': return <LinkStep header={header} app={app} client={client} tokenHash={phase.tokenHash} type={phase.type} onSession={advance} onCancel={() => setPhase({ kind: 'sign-in', email: app?.loginHint })} />;
    case 'sign-in': return <SignInStep header={header} app={app} client={client} appMode={appMode} challenge={params.request} initialEmail={phase.email ?? ''} initialError={phase.error} onSession={advance} />;
    case 'second-step': return <SecondStepView header={header} client={client} step={phase.step} onDone={(recovered) => { if (recovered) setPhase({ kind: 'recovered' }); else if (session) advance(session); }} onSignOut={signOut} />;
    case 'recovered': return <Recovered header={header} onContinue={() => { setNotice('Your second step is off for now. Set up a passkey or authenticator app again in Profile → Sign-in and security.'); if (session) advance(session); }} />;
    case 'profile': return session ? <ProfileStep header={header} client={client} session={session} onDone={() => advance(session, { newProfile: true })} onSignOut={signOut} /> : null;
    case 'offer-passkey': return <OfferPasskey header={header} onDone={() => { setPhase({ kind: 'leaving' }); window.location.replace(params.next); }} />;
    case 'consent': return session ? <ConsentStep header={header} app={app!} client={client} challenge={params.request!} session={session} notice={notice} onSignOut={signOut} onLeaving={() => setPhase({ kind: 'leaving' })} /> : null;
  }
}

// One in-memory client per page load (renders that suspend would otherwise each make a new one).
let gatewayClient: SupabaseClient | undefined;
function appModeClient() { return (gatewayClient ??= createGatewayClient()); }

type Phase =
  | { kind: 'loading' } | { kind: 'leaving' } | { kind: 'expired' } | { kind: 'profile' } | { kind: 'offer-passkey' } | { kind: 'consent' } | { kind: 'recovered' }
  | { kind: 'link'; tokenHash: string; type: 'magiclink' | 'signup' }
  | { kind: 'sign-in'; email?: string; error?: string }
  | { kind: 'second-step'; step: Extract<SecondStep, { needed: true }> };

interface AppInfo { name: string; logoUri?: string; redirectHost: string; loginHint?: string }

async function loadApp(challenge: string): Promise<AppInfo | undefined> {
  try {
    const response = await fetch(`${getAPIURL()}/authorize/account/request?challenge=${challenge}`);
    if (!response.ok) return undefined;
    const body = await response.json() as { client_name?: string; logo_uri?: string | null; redirect_host?: string; login_hint?: string | null };
    return { name: String(body.client_name ?? 'An app').slice(0, 120), logoUri: body.logo_uri ?? undefined, redirectHost: String(body.redirect_host ?? ''), loginHint: body.login_hint ?? undefined };
  } catch { return undefined; }
}

// ─── Steps ───────────────────────────────────────────────────────────────────

function SignInStep({ header, app, client, appMode, challenge, initialEmail, initialError, onSession }: { header: React.ReactNode; app?: AppInfo; client: SupabaseClient; appMode: boolean; challenge?: string; initialEmail: string; initialError?: string; onSession: (session: Session) => void }) {
  const { colors } = useOpenMediaTheme(); const styles = useThemedStyles(createStyles);
  const [mode, setMode] = useState<'email' | 'code' | 'password'>('email');
  const [email, setEmail] = useState(initialEmail);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState<'' | 'passkey' | 'email' | 'code' | 'password'>('');
  const [error, setError] = useState(initialError ?? '');
  const passkeys = passkeysAvailableHere();
  const autofill = useRef<AbortController | undefined>(undefined);
  const validEmail = isEmail(email);

  // Conditional UI: the browser offers saved passkeys in the email field's autofill.
  useEffect(() => {
    if (mode !== 'email' || !passkeys) return;
    let stopped = false;
    const controller = new AbortController();
    autofill.current = controller;
    passkeyAutofillAvailable().then((available) => {
      if (!available || stopped) return;
      passkeyAutofill(client, controller.signal).then((session) => { if (session && !stopped) onSession(session); }).catch((reason) => { if (!stopped) setError(messageFor(reason)); });
    });
    return () => { stopped = true; controller.abort(); };
  }, [client, mode, onSession, passkeys]);

  const run = async (label: typeof busy, action: () => Promise<void>) => {
    setBusy(label); setError('');
    try { await action(); } catch (reason) { setError(messageFor(reason)); } finally { setBusy(''); }
  };
  const withPasskey = () => run('passkey', async () => {
    autofill.current?.abort();
    onSession(await signInWithPasskey(client));
  });
  const sentAt = useRef<Date | undefined>(undefined);
  const sendEmail = () => run('email', async () => {
    autofill.current?.abort();
    const redirect = appMode && challenge ? appLinkRedirect(getAPIURL(), challenge) : `${window.location.origin}${gatewayPath}`;
    sentAt.current = new Date();
    await sendEmailSignIn(client, email, redirect);
    setCode(''); setMode('code');
  });
  const submitCode = (value = code) => run('code', async () => onSession(await verifyEmailCode(client, email, value)));
  const submitPassword = () => run('password', async () => onSession(await signInWithPassword(client, email, password)));

  // Local Mac setup only: the code lands in the local test inbox, so it is filled in by itself.
  useEffect(() => {
    if (mode !== 'code' || !sentAt.current || !localAutoSignInAvailable()) return;
    let stopped = false;
    waitForLocalSignIn(email, sentAt.current, { timeoutMs: 60_000, cancelled: () => stopped }).then((result) => {
      if (!stopped && result && 'code' in result) { setCode(result.code); submitCode(result.code); }
    });
    return () => { stopped = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, email]);

  const title = appMode ? `Continue to ${app?.name ?? 'the app'}` : 'Sign in to Open Media';
  const lead = appMode ? `Use your Open Media account. ${app?.name ?? 'The app'} never sees your password or passkey.` : 'One account for Open Media and the apps you use with it.';

  return <Shell><Card>
    {header}
    {mode === 'code' ? <>
      <Title>Check your email</Title>
      <Lead>{`We sent a sign-in link and a code to ${email.trim()}. Tap the button in the email in this browser, or type the code here.`}</Lead>
      <Label text="Code from the email" />
      <TextInput accessibilityLabel="Code from the email" autoFocus autoComplete="one-time-code" textContentType="oneTimeCode" keyboardType="number-pad" inputMode="numeric" maxLength={12} returnKeyType="go" value={code} onChangeText={(value) => setCode(value.replace(/[^\d\s]/g, ''))} onSubmitEditing={() => submitCode()} placeholder="123456" placeholderTextColor={colors.textTertiary} style={[styles.input, styles.codeInput]} />
      <Primary label="Sign in" busy={busy === 'code'} disabled={Boolean(busy) || !/^\d{6,10}$/.test(code.replace(/\s+/g, ''))} onPress={() => submitCode()} />
      <View style={styles.links}><Quiet label="Send a new code" disabled={Boolean(busy)} onPress={sendEmail} /><Quiet label="Use a different email" disabled={Boolean(busy)} onPress={() => { setMode('email'); setError(''); }} /></View>
    </> : <>
      <Title>{title}</Title>
      <Lead>{lead}</Lead>
      {passkeys && mode === 'email' ? <>
        <Primary icon="finger-print-outline" label="Continue with passkey" busy={busy === 'passkey'} disabled={Boolean(busy)} onPress={withPasskey} />
        <View style={styles.divider} accessibilityElementsHidden importantForAccessibility="no-hide-descendants"><View style={styles.rule} /><Text style={styles.dividerText}>or</Text><View style={styles.rule} /></View>
      </> : null}
      <Label text="Email" />
      <TextInput accessibilityLabel="Email" autoCapitalize="none" autoCorrect={false} autoComplete={(passkeys ? 'username webauthn' : 'email') as 'email'} keyboardType="email-address" inputMode="email" textContentType="username" returnKeyType={mode === 'password' ? 'next' : 'send'} value={email} onChangeText={setEmail} onSubmitEditing={mode === 'email' && validEmail ? sendEmail : undefined} placeholder="you@example.com" placeholderTextColor={colors.textTertiary} style={styles.input} />
      {mode === 'password' ? <>
        <Label text="Password" />
        <TextInput accessibilityLabel="Password" secureTextEntry autoCapitalize="none" autoComplete="current-password" textContentType="password" returnKeyType="go" value={password} onChangeText={setPassword} onSubmitEditing={validEmail && password ? submitPassword : undefined} style={styles.input} />
        <Primary label="Sign in" busy={busy === 'password'} disabled={Boolean(busy) || !validEmail || !password} onPress={submitPassword} variant={passkeys ? 'secondary' : 'primary'} />
        <View style={styles.links}><Quiet label="Email me a code instead" disabled={Boolean(busy)} onPress={() => { setMode('email'); setError(''); }} /></View>
      </> : <>
        <Primary label="Continue with email" busy={busy === 'email'} disabled={Boolean(busy) || !validEmail} onPress={sendEmail} variant={passkeys ? 'secondary' : 'primary'} />
        <View style={styles.links}><Quiet label="Use a password instead" disabled={Boolean(busy)} onPress={() => { setMode('password'); setError(''); }} /></View>
      </>}
    </>}
    <ErrorText text={error} />
    <Text style={styles.fine}>{appMode ? `New to Open Media? Continuing with email creates your account. You’ll return to ${app?.redirectHost || 'the app'}.` : 'New to Open Media? Continuing with email creates your account.'}</Text>
    {!appMode ? <View style={styles.links}><Quiet label="Keep browsing without an account" onPress={() => window.location.assign('/')} /></View> : null}
  </Card></Shell>;
}

/** The email's one-tap button (app mode): asks before using it, so link scanners can't. */
function LinkStep({ header, app, client, tokenHash, type, onSession, onCancel }: { header: React.ReactNode; app?: AppInfo; client: SupabaseClient; tokenHash: string; type: 'magiclink' | 'signup'; onSession: (session: Session) => void; onCancel: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const finish = async () => {
    setBusy(true); setError('');
    try { onSession(await verifyLinkToken(client, tokenHash, type)); } catch (reason) { setError(messageFor(reason)); } finally { setBusy(false); }
  };
  return <Shell><Card>{header}<Title>Finish signing in</Title><Lead>{`You opened the sign-in link from your email. Continue to sign in${app ? ` and connect ${app.name}` : ''}.`}</Lead>
    <Primary label="Finish signing in" busy={busy} disabled={busy} onPress={finish} />
    <ErrorText text={error} />
    <View style={useThemedStyles(createStyles).links}><Quiet label="Sign in another way" disabled={busy} onPress={onCancel} /></View>
  </Card></Shell>;
}

function SecondStepView({ header, client, step, onDone, onSignOut }: { header: React.ReactNode; client: SupabaseClient; step: Extract<SecondStep, { needed: true }>; onDone: (recovered: boolean) => void; onSignOut: () => void }) {
  const { colors } = useOpenMediaTheme(); const styles = useThemedStyles(createStyles);
  const [mode, setMode] = useState<'choose' | 'recovery'>('choose');
  const [code, setCode] = useState('');
  const [recovery, setRecovery] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const run = async (label: string, action: () => Promise<boolean>) => {
    setBusy(label); setError('');
    try { onDone(await action()); } catch (reason) { setError(messageFor(reason)); } finally { setBusy(''); }
  };
  const passkey = step.passkey && passkeysAvailableHere();
  return <Shell><Card>{header}
    <View style={styles.badge}><Ionicons name="shield-checkmark" size={22} color={colors.text} /></View>
    <Title>Confirm it’s you</Title>
    {mode === 'recovery' ? <>
      <Lead>Type one of the recovery codes you saved. It works once, and it turns off your current second step so you can set up a new one.</Lead>
      <Label text="Recovery code" />
      <TextInput accessibilityLabel="Recovery code" autoFocus autoCapitalize="none" autoCorrect={false} autoComplete="one-time-code" value={recovery} onChangeText={(value) => setRecovery(normalizeRecoveryCode(value))} onSubmitEditing={() => run('recovery', async () => { await redeemRecoveryCode(client, recovery); return true; })} placeholder="abcd-efgh-jkmn-pqrs" placeholderTextColor={colors.textTertiary} style={[styles.input, styles.recoveryInput]} />
      <Primary label="Use recovery code" busy={busy === 'recovery'} disabled={Boolean(busy) || recovery.length < 19} onPress={() => run('recovery', async () => { await redeemRecoveryCode(client, recovery); return true; })} />
      <View style={styles.links}><Quiet label="Back" disabled={Boolean(busy)} onPress={() => { setMode('choose'); setError(''); }} /></View>
    </> : <>
      <Lead>{step.totpFactorId && passkey ? 'Your account has a second step. Use your passkey or the code from your authenticator app.' : step.totpFactorId ? 'Your account has a second step. Enter the 6-digit code from your authenticator app.' : 'Your account has a second step. Use your passkey: Touch ID, Face ID, Windows Hello, your phone or a security key.'}</Lead>
      {passkey ? <Primary icon="finger-print-outline" label="Use my passkey" busy={busy === 'passkey'} disabled={Boolean(busy)} onPress={() => run('passkey', async () => { await confirmWithPasskey(client); return false; })} /> : null}
      {step.passkey && !passkeysAvailableHere() ? <Text style={styles.hint}>This browser can’t use passkeys. Use a recovery code instead.</Text> : null}
      {step.totpFactorId ? <>
        <Label text="Authenticator code" />
        <TextInput accessibilityLabel="Authenticator code" autoFocus={!passkey} autoComplete="one-time-code" textContentType="oneTimeCode" keyboardType="number-pad" inputMode="numeric" maxLength={7} value={code} onChangeText={(value) => setCode(value.replace(/[^\d]/g, ''))} onSubmitEditing={() => run('totp', async () => { await confirmWithTotp(client, step.totpFactorId!, code); return false; })} placeholder="123456" placeholderTextColor={colors.textTertiary} style={[styles.input, styles.codeInput]} />
        <Primary label="Confirm" busy={busy === 'totp'} disabled={Boolean(busy) || code.length !== 6} onPress={() => run('totp', async () => { await confirmWithTotp(client, step.totpFactorId!, code); return false; })} variant={passkey ? 'secondary' : 'primary'} />
      </> : null}
      <View style={styles.links}><Quiet label="Use a recovery code" disabled={Boolean(busy)} onPress={() => { setMode('recovery'); setError(''); }} /><Quiet label="Use another account" disabled={Boolean(busy)} onPress={onSignOut} /></View>
    </>}
    <ErrorText text={error} />
  </Card></Shell>;
}

/** After a recovery code: they're in, and their old second step is gone, so ask them to set one up again. */
function Recovered({ header, onContinue }: { header: React.ReactNode; onContinue: () => void }) {
  const { colors } = useOpenMediaTheme(); const styles = useThemedStyles(createStyles);
  return <Shell><Card>{header}
    <View style={styles.badge}><Ionicons name="checkmark-circle" size={22} color={colors.text} /></View>
    <Title>You’re back in</Title>
    <Lead>Your recovery code worked, and it turned off your old passkey second step and authenticator app. Set up a new one soon in Profile → Sign-in and security, and make new recovery codes there too.</Lead>
    <Primary label="Continue" onPress={onContinue} />
  </Card></Shell>;
}

function ProfileStep({ header, client, session, onDone, onSignOut }: { header: React.ReactNode; client: SupabaseClient; session: Session; onDone: () => void; onSignOut: () => void }) {
  const { colors } = useOpenMediaTheme(); const styles = useThemedStyles(createStyles);
  const suggested = String(session.user.user_metadata?.full_name ?? session.user.email?.split('@')[0] ?? '');
  const [displayName, setDisplayName] = useState(suggested);
  const [handle, setHandle] = useState(suggested.toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 24));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const ready = Boolean(displayName.trim()) && /^[a-z0-9_]{3,24}$/.test(handle);
  const submit = async () => {
    setBusy(true); setError('');
    try { await saveCurrentProfile(session, { displayName, handle }, client); onDone(); } catch (reason) { setError(messageFor(reason)); } finally { setBusy(false); }
  };
  return <Shell><Card>{header}<Title>Create your profile</Title><Lead>{`Welcome to Open Media. This is how people find and message you. ${session.user.email ? `${session.user.email} stays private.` : 'Your email stays private.'}`}</Lead>
    <Label text="Name" />
    <TextInput accessibilityLabel="Name" autoFocus autoComplete="name" textContentType="name" maxLength={80} value={displayName} onChangeText={setDisplayName} placeholder="Your name" placeholderTextColor={colors.textTertiary} style={styles.input} />
    <Label text="Handle" />
    <View style={styles.handleRow}><Text style={styles.at}>@</Text><TextInput accessibilityLabel="Handle" autoCapitalize="none" autoCorrect={false} maxLength={24} value={handle} onChangeText={(value) => setHandle(value.toLowerCase().replace(/[^a-z0-9_]/g, ''))} onSubmitEditing={ready ? submit : undefined} placeholder="yourhandle" placeholderTextColor={colors.textTertiary} style={styles.handleInput} /></View>
    <Text style={styles.hint}>3–24 lowercase letters, numbers or underscores.</Text>
    <Primary label="Continue" busy={busy} disabled={busy || !ready} onPress={submit} />
    <ErrorText text={error} />
    <View style={styles.links}><Quiet label="Use a different email" disabled={busy} onPress={onSignOut} /></View>
  </Card></Shell>;
}

/** New accounts: one optional step to add a passkey, so next time is one tap. */
function OfferPasskey({ header, onDone }: { header: React.ReactNode; onDone: () => void }) {
  const { colors } = useOpenMediaTheme(); const styles = useThemedStyles(createStyles);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // Own mode only: adding a passkey uses the web app's saved session.
  const add = async () => {
    setBusy(true); setError('');
    try { await addSignInPasskey(passkeyDeviceName()); onDone(); } catch (reason) { setError(messageFor(reason)); } finally { setBusy(false); }
  };
  return <Shell><Card>{header}
    <View style={styles.badge}><Ionicons name="finger-print-outline" size={22} color={colors.text} /></View>
    <Title>Sign in faster next time</Title>
    <Lead>Add a passkey and sign in with Touch ID, Face ID, Windows Hello or your phone. No email, no password.</Lead>
    <Primary icon="finger-print-outline" label="Add a passkey" busy={busy} disabled={busy} onPress={add} />
    <ErrorText text={error} />
    <View style={styles.links}><Quiet label="Not now" disabled={busy} onPress={onDone} /></View>
  </Card></Shell>;
}

function ConsentStep({ header, app, client, challenge, session, notice, onSignOut, onLeaving }: { header: React.ReactNode; app: AppInfo; client: SupabaseClient; challenge: string; session: Session; notice: string; onSignOut: () => void; onLeaving: () => void }) {
  const { colors } = useOpenMediaTheme(); const styles = useThemedStyles(createStyles);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const go = async () => {
    setBusy(true); setError('');
    try {
      // The newest tokens (the second step may have refreshed them), posted as a top-level form so
      // this browser's challenge cookie goes with it. The page then leaves for the app.
      const { data } = await client.auth.getSession();
      const current = data.session ?? session;
      postForm(sessionEndpoint(getAPIURL()), { challenge, access_token: current.access_token, refresh_token: current.refresh_token });
      onLeaving();
    } catch (reason) { setError(messageFor(reason)); setBusy(false); }
  };
  return <Shell><Card>{header}
    <Title>{`Continue to ${app.name}`}</Title>
    <Lead>{`Signed in as ${session.user.email ?? 'you'}.`}</Lead>
    {notice ? <View style={styles.notice} accessibilityLiveRegion="polite"><Text style={styles.noticeText}>{notice}</Text></View> : null}
    <View style={styles.consent}>
      <Text style={styles.consentTitle}>{`${app.name} will be able to:`}</Text>
      {consentList.map((item) => <View key={item} style={styles.consentRow}><Ionicons name="checkmark" size={16} color={colors.text} /><Text style={styles.consentItem}>{item}</Text></View>)}
      <View style={styles.consentRow}><Ionicons name="lock-closed-outline" size={16} color={colors.textSecondary} /><Text style={[styles.consentItem, styles.muted]}>It never sees your password, passkey or Open Media session.</Text></View>
    </View>
    <Primary label={`Continue to ${app.name}`} busy={busy} disabled={busy} onPress={go} />
    <ErrorText text={error} />
    <Text style={styles.fine}>{`You’ll return to ${app.redirectHost}. Disconnect it any time in Profile → Sign-in and security.`}</Text>
    <View style={styles.links}><Quiet label="Use another account" disabled={busy} onPress={onSignOut} /></View>
  </Card></Shell>;
}

function postForm(action: string, fields: Record<string, string>) {
  const form = document.createElement('form');
  form.method = 'post';
  form.action = action;
  form.style.display = 'none';
  for (const [name, value] of Object.entries(fields)) {
    const input = document.createElement('input');
    input.type = 'hidden'; input.name = name; input.value = value;
    form.appendChild(input);
  }
  document.body.appendChild(form);
  form.submit();
}

function passkeyDeviceName(): string {
  if (typeof navigator === 'undefined') return 'Passkey';
  const agent = navigator.userAgent;
  const device = /iPhone/.test(agent) ? 'iPhone' : /iPad/.test(agent) ? 'iPad' : /Android/.test(agent) ? 'Android' : /Mac/.test(agent) ? 'Mac' : /Windows/.test(agent) ? 'Windows' : 'This device';
  const browser = /Edg\//.test(agent) ? 'Edge' : /Firefox\//.test(agent) ? 'Firefox' : /Chrome\//.test(agent) ? 'Chrome' : /Safari\//.test(agent) ? 'Safari' : '';
  return browser ? `${device} · ${browser}` : device;
}

// ─── Pieces ──────────────────────────────────────────────────────────────────

/** Open Media's mark, and in app mode the app's icon beside it. */
function GatewayHeader({ app }: { app?: AppInfo }) {
  const { colors } = useOpenMediaTheme(); const styles = useThemedStyles(createStyles);
  const [logoFailed, setLogoFailed] = useState(false);
  if (!app) return <BrandMark />;
  return <View style={styles.pair} accessibilityLabel={`Open Media and ${app.name}`}>
    <BrandMark compact />
    <Ionicons name="swap-horizontal" size={16} color={colors.textTertiary} />
    {app.logoUri && !logoFailed
      ? <Image source={{ uri: app.logoUri }} onError={() => setLogoFailed(true)} accessibilityIgnoresInvertColors style={styles.appLogo} />
      : <View style={[styles.appLogo, styles.appInitial]}><Text style={styles.appInitialText}>{app.name.slice(0, 1).toUpperCase()}</Text></View>}
  </View>;
}

function Shell({ children }: React.PropsWithChildren) {
  const styles = useThemedStyles(createStyles);
  return <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined}><ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.shell}>{children}</ScrollView></KeyboardAvoidingView>;
}

function Card({ children }: React.PropsWithChildren) {
  const styles = useThemedStyles(createStyles);
  return <View style={styles.card} role="main">{children}</View>;
}

function Title({ children }: React.PropsWithChildren) {
  const styles = useThemedStyles(createStyles);
  return <Text accessibilityRole="header" style={styles.title}>{children}</Text>;
}

function Lead({ children }: React.PropsWithChildren) {
  const styles = useThemedStyles(createStyles);
  return <Text style={styles.lead}>{children}</Text>;
}

function Label({ text }: { text: string }) {
  const styles = useThemedStyles(createStyles);
  return <Text style={styles.label}>{text}</Text>;
}

function ErrorText({ text }: { text: string }) {
  const styles = useThemedStyles(createStyles);
  return text ? <Text accessibilityLiveRegion="assertive" role="alert" style={styles.error}>{text}</Text> : null;
}

function Primary({ label, onPress, busy, disabled, icon, variant = 'primary' }: { label: string; onPress: () => void; busy?: boolean; disabled?: boolean; icon?: 'finger-print-outline'; variant?: 'primary' | 'secondary' }) {
  const { colors } = useOpenMediaTheme(); const styles = useThemedStyles(createStyles);
  const primary = variant === 'primary';
  const ink = primary ? colors.surface : colors.text;
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled: Boolean(disabled), busy: Boolean(busy) }} disabled={disabled} onPress={onPress} style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => [styles.button, primary ? styles.buttonPrimary : styles.buttonSecondary, (pressed || hovered) && !disabled && styles.buttonPressed, disabled && !busy && styles.disabled]}>
    {busy ? <Loader color={ink} /> : <View style={styles.buttonInner}>{icon ? <Ionicons name={icon} size={18} color={ink} /> : null}<Text style={[styles.buttonText, { color: ink }]}>{label}</Text></View>}
  </Pressable>;
}

function Quiet({ label, onPress, disabled }: { label: string; onPress: () => void; disabled?: boolean }) {
  const styles = useThemedStyles(createStyles);
  return <Pressable accessibilityRole="button" disabled={disabled} onPress={onPress} hitSlop={8} style={styles.quiet}><Text style={[styles.quietText, disabled && styles.disabled]}>{label}</Text></Pressable>;
}

function messageFor(reason: unknown) { return reason instanceof Error ? reason.message : 'Something went wrong. Try again.'; }

const localStyles = StyleSheet.create({ centered: { minHeight: 120, alignItems: 'center', justifyContent: 'center' } });

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: colors.chrome },
    shell: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16, paddingVertical: 32, backgroundColor: colors.chrome },
    card: { width: '100%', maxWidth: 420, paddingHorizontal: 28, paddingTop: 30, paddingBottom: 22, borderRadius: 24, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, boxShadow: '0 8px 24px rgba(0, 0, 0, 0.04)' },
    pair: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 30 },
    appLogo: { width: 28, height: 28, borderRadius: 8, backgroundColor: colors.accentSoft },
    appInitial: { alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.border },
    appInitialText: { color: colors.text, fontSize: 14, fontWeight: '800' },
    badge: { width: 44, height: 44, marginBottom: 14, alignItems: 'center', justifyContent: 'center', borderRadius: 22, backgroundColor: colors.accentSoft },
    title: { color: colors.text, fontSize: 28, lineHeight: 33, fontWeight: '800', letterSpacing: -0.9 },
    lead: { marginTop: 10, marginBottom: 22, color: colors.textSecondary, fontSize: 15, lineHeight: 22 },
    label: { marginTop: 14, marginBottom: 7, color: colors.textSecondary, fontSize: 13, fontWeight: '700' },
    input: { minHeight: 50, paddingHorizontal: 15, borderRadius: 14, borderWidth: 1, borderColor: colors.border, color: colors.text, backgroundColor: colors.surfaceAlt, fontSize: 16, outlineStyle: 'none' } as object,
    codeInput: { fontSize: 22, letterSpacing: 6, fontVariant: ['tabular-nums'] },
    recoveryInput: { fontSize: 17, letterSpacing: 1.5, fontFamily: Platform.OS === 'web' ? 'ui-monospace, SFMono-Regular, Menlo, monospace' : undefined },
    handleRow: { minHeight: 50, paddingHorizontal: 15, flexDirection: 'row', alignItems: 'center', borderRadius: 14, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surfaceAlt },
    at: { color: colors.textSecondary, fontSize: 16 },
    handleInput: { flex: 1, minHeight: 48, color: colors.text, fontSize: 16, outlineStyle: 'none' } as object,
    hint: { marginTop: 7, color: colors.textTertiary, fontSize: 13, lineHeight: 18 },
    button: { minHeight: 52, marginTop: 16, paddingHorizontal: 20, alignItems: 'center', justifyContent: 'center', borderRadius: 26, borderWidth: 1 },
    buttonPrimary: { backgroundColor: colors.text, borderColor: colors.text },
    buttonSecondary: { backgroundColor: colors.surface, borderColor: colors.border },
    buttonPressed: { opacity: 0.86 },
    buttonInner: { flexDirection: 'row', alignItems: 'center', gap: 9 },
    buttonText: { fontSize: 15, fontWeight: '700' },
    disabled: { opacity: 0.4 },
    divider: { marginTop: 22, marginBottom: 2, flexDirection: 'row', alignItems: 'center', gap: 12 },
    rule: { flex: 1, height: 1, backgroundColor: colors.border },
    dividerText: { color: colors.textTertiary, fontSize: 13 },
    links: { marginTop: 16, flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', columnGap: 22, rowGap: 6 },
    quiet: { minHeight: 32, justifyContent: 'center' },
    quietText: { color: colors.textSecondary, fontSize: 14, fontWeight: '600', textDecorationLine: 'underline' },
    error: { marginTop: 14, color: colors.danger, fontSize: 14, lineHeight: 20, fontWeight: '600' },
    fine: { marginTop: 20, color: colors.textTertiary, fontSize: 13, lineHeight: 19, textAlign: 'center' },
    notice: { marginBottom: 14, padding: 14, borderRadius: 14, backgroundColor: colors.accentSoft },
    noticeText: { color: colors.text, fontSize: 14, lineHeight: 20 },
    consent: { padding: 16, borderRadius: 16, gap: 10, backgroundColor: colors.surfaceAlt, borderWidth: 1, borderColor: colors.border },
    consentTitle: { color: colors.text, fontSize: 14, fontWeight: '700' },
    consentRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
    consentItem: { flex: 1, color: colors.text, fontSize: 14, lineHeight: 20 },
    muted: { color: colors.textSecondary },
  });
}
