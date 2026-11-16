import Ionicons from './Icon';
import { useThemedStyles } from './useThemedStyles';
import { memo, useCallback, useEffect, useState } from 'react';
import { Image, Platform, Pressable, StyleSheet, View } from 'react-native';

import {
  addSignInPasskey, authenticatorApp, cancelAuthenticatorApp, completePasskeyStep, ConnectedApp, confirmAuthenticatorApp, disconnectApp, listConnectedApps, listSignInPasskeys, needsSecondStepFirst,
  newRecoveryCodes, recoveryCodesLeft, removeAuthenticatorApp, removeSignInPasskey, renameSignInPasskey, SignInPasskey, signInPasskeysSupportedHere, startAuthenticatorApp, TotpEnrollment,
} from '../auth/accountSecurity';
import { recoveryCodesFile } from '../domain/signInGateway';
import { ThemeColors } from '../theme';
import { useOpenMediaTheme } from '../themeContext';
import { lazyComponent } from './lazyComponent';
import { Loader } from './Loader';
import { Text, TextInput } from './Text';

// The QR code library loads only when someone adds an authenticator app.
const QrGrid = lazyComponent(() => import('./QrGrid').then((module) => module.QrGrid), 'none');

type Run = (label: string, action: () => Promise<void>, done?: string) => Promise<void>;

/** Busy state, messages, and "confirm it's you first" when Supabase wants the second step (aal2) before a change. */
function useActions() {
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [stepUp, setStepUp] = useState<() => Promise<void>>();
  const run: Run = useCallback(async (label, action, done) => {
    setBusy(label); setError(''); setMessage(''); setStepUp(undefined);
    try { await action(); if (done) setMessage(done); }
    catch (reason) {
      setError(reason instanceof Error ? reason.message : 'That didn’t work. Try again.');
      if (needsSecondStepFirst(reason)) setStepUp(() => async () => { await completePasskeyStep(); await action(); if (done) setMessage(done); });
    }
    finally { setBusy(''); }
  }, []);
  const retry = stepUp ? () => run('step-up', stepUp) : undefined;
  return { busy, message, error, run, retry, setMessage };
}

function Feedback({ message, error, retry, busy }: { message: string; error: string; retry?: () => void; busy: string }) {
  const { colors } = useOpenMediaTheme(); const styles = useThemedStyles(createStyles);
  return <>
    {message ? <Text accessibilityLiveRegion="polite" style={styles.success}>{message}</Text> : null}
    {error ? <Text accessibilityLiveRegion="assertive" style={styles.error}>{error}</Text> : null}
    {retry ? <Pressable accessibilityRole="button" disabled={Boolean(busy)} onPress={retry} style={[styles.small, styles.inlineAction]}>{busy === 'step-up' ? <Loader color={colors.text} /> : <Text style={styles.smallText}>Confirm with my passkey and try again</Text>}</Pressable> : null}
  </>;
}

/** Passkeys to sign in with one tap, no email or password (Supabase passkeys, ADR 0042). */
export function SignInPasskeySettings() {
  const { colors } = useOpenMediaTheme(); const styles = useThemedStyles(createStyles);
  const supported = signInPasskeysSupportedHere();
  const [passkeys, setPasskeys] = useState<SignInPasskey[]>();
  const [renaming, setRenaming] = useState<{ id: string; name: string }>();
  const [confirmRemove, setConfirmRemove] = useState<string>();
  const { busy, message, error, run, retry } = useActions();
  const refresh = useCallback(async () => setPasskeys(await listSignInPasskeys()), []);
  useEffect(() => { if (supported) refresh().catch(() => setPasskeys([])); }, [refresh, supported]);
  return <>
    <View style={styles.card}>
      <View style={styles.row}>
        <Ionicons name="finger-print-outline" size={20} color={colors.text} />
        <View style={styles.grow}>
          <Text style={styles.rowTitle}>Passkeys</Text>
          <Text style={styles.hint}>{supported ? 'Sign in with one tap: Touch ID, Face ID, Windows Hello, your phone or a security key. No email or password.' : 'Add passkeys to sign in with one tap from Open Media on the web.'}</Text>
        </View>
        {supported ? <Pressable accessibilityRole="button" disabled={Boolean(busy)} onPress={() => run('add', async () => { await addSignInPasskey(deviceName()); await refresh(); }, 'Passkey added. Next time, choose “Continue with passkey”.')} style={styles.small}>{busy === 'add' ? <Loader color={colors.text} /> : <Text style={styles.smallText}>Add passkey</Text>}</Pressable> : null}
      </View>
      {supported && passkeys === undefined ? <Loader style={styles.loading} color={colors.text} /> : null}
      {passkeys?.map((passkey) => <View key={passkey.id} style={[styles.row, styles.divider]}>
        {renaming?.id === passkey.id ? <>
          <TextInput accessibilityLabel="Passkey name" autoFocus maxLength={120} value={renaming.name} onChangeText={(name) => setRenaming({ id: passkey.id, name })} onSubmitEditing={() => run(`rename-${passkey.id}`, async () => { await renameSignInPasskey(passkey.id, renaming.name); setRenaming(undefined); await refresh(); })} style={[styles.input, styles.grow]} />
          <Pressable accessibilityRole="button" disabled={Boolean(busy) || !renaming.name.trim()} onPress={() => run(`rename-${passkey.id}`, async () => { await renameSignInPasskey(passkey.id, renaming.name); setRenaming(undefined); await refresh(); })} style={[styles.small, styles.smallOn]}>{busy === `rename-${passkey.id}` ? <Loader color={colors.surface} /> : <Text style={styles.smallTextOn}>Save</Text>}</Pressable>
          <Pressable accessibilityRole="button" disabled={Boolean(busy)} onPress={() => setRenaming(undefined)} style={styles.small}><Text style={styles.smallText}>Cancel</Text></Pressable>
        </> : <>
          <View style={styles.grow}>
            <Text style={styles.rowTitle}>{passkey.name}</Text>
            <Text style={styles.hint}>{`Added ${new Date(passkey.addedAt).toLocaleDateString()}${passkey.lastUsedAt ? ` · last used ${new Date(passkey.lastUsedAt).toLocaleDateString()}` : ''}`}</Text>
          </View>
          {confirmRemove === passkey.id ? <>
            <Pressable accessibilityRole="button" accessibilityLabel={`Confirm removing ${passkey.name}`} disabled={Boolean(busy)} onPress={() => run(`remove-${passkey.id}`, async () => { await removeSignInPasskey(passkey.id); setConfirmRemove(undefined); await refresh(); }, `Removed “${passkey.name}”.`)} style={[styles.small, styles.danger]}>{busy === `remove-${passkey.id}` ? <Loader color={colors.surface} /> : <Text style={styles.smallTextOn}>Remove</Text>}</Pressable>
            <Pressable accessibilityRole="button" disabled={Boolean(busy)} onPress={() => setConfirmRemove(undefined)} style={styles.small}><Text style={styles.smallText}>Keep</Text></Pressable>
          </> : <>
            <Pressable accessibilityRole="button" accessibilityLabel={`Rename ${passkey.name}`} disabled={Boolean(busy)} onPress={() => setRenaming({ id: passkey.id, name: passkey.name })} style={styles.iconButton}><Ionicons name="create-outline" size={18} color={colors.text} /></Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel={`Remove ${passkey.name}`} disabled={Boolean(busy)} onPress={() => setConfirmRemove(passkey.id)} style={styles.iconButton}><Ionicons name="trash-outline" size={18} color={colors.text} /></Pressable>
          </>}
        </>}
      </View>)}
    </View>
    <Feedback message={message} error={error} retry={retry} busy={busy} />
  </>;
}

/** The second step: an authenticator app (TOTP) and one-time recovery codes (ADR 0042). */
export function SecondStepSettings({ email }: { email?: string }) {
  const { colors } = useOpenMediaTheme(); const styles = useThemedStyles(createStyles);
  const [app, setApp] = useState<{ id: string; name: string; addedAt: string } | null>();
  const [enrolling, setEnrolling] = useState<TotpEnrollment>();
  const [code, setCode] = useState('');
  const [left, setLeft] = useState<number>();
  const [codes, setCodes] = useState<string[]>();
  const [confirmRemove, setConfirmRemove] = useState(false);
  const { busy, message, error, run, retry } = useActions();
  const refresh = useCallback(async () => {
    const [factor, count] = await Promise.all([authenticatorApp(), recoveryCodesLeft().catch(() => 0)]);
    setApp(factor ?? null); setLeft(count);
  }, []);
  useEffect(() => { refresh().catch(() => setApp(null)); }, [refresh]);
  const download = () => {
    if (!codes || Platform.OS !== 'web' || typeof document === 'undefined') return;
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([recoveryCodesFile(codes, email)], { type: 'text/plain' }));
    link.download = 'Open Media recovery codes.txt';
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  };
  return <>
    <Text style={styles.subtitle}>Second step</Text>
    <View style={styles.card}>
      <View style={styles.row}>
        <Ionicons name="phone-portrait-outline" size={20} color={colors.text} />
        <View style={styles.grow}>
          <Text style={styles.rowTitle}>Authenticator app</Text>
          <Text style={styles.hint}>{app ? `On since ${new Date(app.addedAt).toLocaleDateString()}. Signing in asks for its 6-digit code.` : 'After signing in, enter a 6-digit code from an app such as 1Password, Google Authenticator or Authy.'}</Text>
        </View>
        {app === undefined ? <Loader color={colors.text} /> : app ? (confirmRemove
          ? <><Pressable accessibilityRole="button" accessibilityLabel="Confirm removing the authenticator app" disabled={Boolean(busy)} onPress={() => run('remove-totp', async () => { await removeAuthenticatorApp(app.id); setConfirmRemove(false); await refresh(); }, 'Authenticator app removed.')} style={[styles.small, styles.danger]}>{busy === 'remove-totp' ? <Loader color={colors.surface} /> : <Text style={styles.smallTextOn}>Remove</Text>}</Pressable><Pressable accessibilityRole="button" disabled={Boolean(busy)} onPress={() => setConfirmRemove(false)} style={styles.small}><Text style={styles.smallText}>Keep</Text></Pressable></>
          : <Pressable accessibilityRole="button" accessibilityLabel="Remove the authenticator app" disabled={Boolean(busy)} onPress={() => setConfirmRemove(true)} style={styles.small}><Text style={styles.smallText}>Remove</Text></Pressable>)
          : enrolling ? null : <Pressable accessibilityRole="button" disabled={Boolean(busy)} onPress={() => run('start-totp', async () => { setCode(''); setEnrolling(await startAuthenticatorApp()); })} style={styles.small}>{busy === 'start-totp' ? <Loader color={colors.text} /> : <Text style={styles.smallText}>Set up</Text>}</Pressable>}
      </View>
      {enrolling ? <View style={styles.block}>
        <Text style={styles.hint}>Scan this with your authenticator app, or type the key into it. Then enter the 6-digit code it shows.</Text>
        <QrGrid value={enrolling.uri} label="QR code for your authenticator app" />
        <Text selectable style={styles.secret} accessibilityLabel={`Setup key ${enrolling.secret.split('').join(' ')}`}>{enrolling.secret.replace(/(.{4})/g, '$1 ').trim()}</Text>
        <TextInput accessibilityLabel="Code from the authenticator app" autoComplete="one-time-code" textContentType="oneTimeCode" keyboardType="number-pad" inputMode="numeric" maxLength={6} value={code} onChangeText={(value) => setCode(value.replace(/[^\d]/g, ''))} placeholder="123456" placeholderTextColor={colors.textTertiary} style={[styles.input, styles.codeInput]} />
        <View style={styles.actions}>
          <Pressable accessibilityRole="button" disabled={Boolean(busy) || code.length !== 6} onPress={() => run('confirm-totp', async () => { await confirmAuthenticatorApp(enrolling.factorId, code); setEnrolling(undefined); await refresh(); }, 'Authenticator app on. Make recovery codes below, in case you lose your phone.')} style={[styles.small, styles.smallOn, (Boolean(busy) || code.length !== 6) && styles.disabled]}>{busy === 'confirm-totp' ? <Loader color={colors.surface} /> : <Text style={styles.smallTextOn}>Turn on</Text>}</Pressable>
          <Pressable accessibilityRole="button" disabled={Boolean(busy)} onPress={() => { cancelAuthenticatorApp(enrolling.factorId); setEnrolling(undefined); }} style={styles.small}><Text style={styles.smallText}>Cancel</Text></Pressable>
        </View>
      </View> : null}

      <View style={[styles.row, styles.divider]}>
        <Ionicons name="key-outline" size={20} color={colors.text} />
        <View style={styles.grow}>
          <Text style={styles.rowTitle}>Recovery codes</Text>
          <Text style={styles.hint}>{left ? `${left} of 10 left. Each works once if you lose your passkey or authenticator app.` : 'Ten one-time codes to get in if you lose your passkey or authenticator app.'}</Text>
        </View>
        <Pressable accessibilityRole="button" disabled={Boolean(busy)} onPress={() => run('codes', async () => { setCodes(await newRecoveryCodes()); await refresh(); })} style={styles.small}>{busy === 'codes' ? <Loader color={colors.text} /> : <Text style={styles.smallText}>{left ? 'Make new codes' : 'Make codes'}</Text>}</Pressable>
      </View>
      {codes ? <View style={styles.block}>
        <Text style={styles.hint}>Save these now: they are shown only once, and making new codes replaces them all.</Text>
        <View style={styles.codes}>{codes.map((item) => <Text key={item} selectable style={styles.codeItem}>{item}</Text>)}</View>
        <View style={styles.actions}>
          {Platform.OS === 'web' ? <Pressable accessibilityRole="button" onPress={download} style={[styles.small, styles.smallOn]}><View style={styles.inline}><Ionicons name="download-outline" size={16} color={colors.surface} /><Text style={styles.smallTextOn}>Download</Text></View></Pressable> : null}
          <Pressable accessibilityRole="button" onPress={() => setCodes(undefined)} style={styles.small}><Text style={styles.smallText}>I saved them</Text></Pressable>
        </View>
      </View> : null}
    </View>
    <Feedback message={message} error={error} retry={retry} busy={busy} />
  </>;
}

// Rows shown at a time: the list sits inside the profile's scroll view, so it is paged, not all mounted.
const appPage = 20;

/** Apps signed in with Open Media (OAuth grants), and disconnecting them. */
export function ConnectedAppsSettings() {
  const { colors } = useOpenMediaTheme(); const styles = useThemedStyles(createStyles);
  const [apps, setApps] = useState<ConnectedApp[]>();
  const [available, setAvailable] = useState(true);
  const [confirm, setConfirm] = useState<string>();
  const { busy, message, error, run, retry } = useActions();
  const [shown, setShown] = useState(appPage);
  const refresh = useCallback(async () => { const result = await listConnectedApps(); setApps(result.apps); setAvailable(result.available); }, []);
  useEffect(() => { refresh().catch(() => { setApps([]); setAvailable(false); }); }, [refresh]);
  const disconnect = useCallback((item: ConnectedApp) => run(`revoke-${item.id}`, async () => { await disconnectApp(item.id); setConfirm(undefined); await refresh(); }, `${item.name} was disconnected.`), [run, refresh]);
  return <>
    <Text style={styles.subtitle}>Apps signed in with Open Media</Text>
    <View style={styles.card}>
      {apps === undefined ? <Loader style={styles.loading} color={colors.text} /> : !apps.length ? <View style={styles.row}><Ionicons name="lock-open-outline" size={20} color={colors.text} /><Text style={[styles.hint, styles.grow]}>{available ? 'No apps yet. When you choose “Continue with Open Media” in an app or AI assistant, it shows up here.' : 'Connected apps can’t be listed on this server.'}</Text></View>
        : <>
          {apps.slice(0, shown).map((item, index) => <ConnectedAppRow key={item.id} item={item} first={index === 0} confirming={confirm === item.id} busy={busy} onAsk={setConfirm} onDisconnect={disconnect} />)}
          {apps.length > shown ? <Pressable accessibilityRole="button" onPress={() => setShown((count) => count + appPage)} style={[styles.row, styles.divider]}><Text style={[styles.rowTitle, styles.grow]}>{`Show ${Math.min(appPage, apps.length - shown)} more of ${apps.length - shown}`}</Text></Pressable> : null}
        </>}
    </View>
    <Feedback message={message} error={error} retry={retry} busy={busy} />
  </>;
}

const ConnectedAppRow = memo(function ConnectedAppRow({ item, first, confirming, busy, onAsk, onDisconnect }: { item: ConnectedApp; first: boolean; confirming: boolean; busy?: string; onAsk: (id: string | undefined) => void; onDisconnect: (item: ConnectedApp) => void }) {
  const { colors } = useOpenMediaTheme(); const styles = useThemedStyles(createStyles);
  return <View style={[styles.row, !first && styles.divider]}>
    {item.logoUri ? <Image source={{ uri: item.logoUri }} style={styles.logo} accessibilityIgnoresInvertColors /> : <View style={[styles.logo, styles.logoInitial]}><Text style={styles.rowTitle}>{item.name.slice(0, 1).toUpperCase()}</Text></View>}
    <View style={styles.grow}><Text style={styles.rowTitle}>{item.name}</Text><Text style={styles.hint}>{`Connected ${new Date(item.connectedAt).toLocaleDateString()}`}</Text></View>
    {confirming
      ? <><Pressable accessibilityRole="button" accessibilityLabel={`Confirm disconnecting ${item.name}`} disabled={Boolean(busy)} onPress={() => onDisconnect(item)} style={[styles.small, styles.danger]}>{busy === `revoke-${item.id}` ? <Loader color={colors.surface} /> : <Text style={styles.smallTextOn}>Disconnect</Text>}</Pressable><Pressable accessibilityRole="button" disabled={Boolean(busy)} onPress={() => onAsk(undefined)} style={styles.small}><Text style={styles.smallText}>Keep</Text></Pressable></>
      : <Pressable accessibilityRole="button" accessibilityLabel={`Disconnect ${item.name}`} disabled={Boolean(busy)} onPress={() => onAsk(item.id)} style={styles.small}><Text style={styles.smallText}>Disconnect</Text></Pressable>}
  </View>;
});

function deviceName(): string {
  if (typeof navigator === 'undefined') return 'Passkey';
  const agent = navigator.userAgent;
  const device = /iPhone/.test(agent) ? 'iPhone' : /iPad/.test(agent) ? 'iPad' : /Android/.test(agent) ? 'Android' : /Mac/.test(agent) ? 'Mac' : /Windows/.test(agent) ? 'Windows' : /Linux/.test(agent) ? 'Linux' : 'This device';
  const browser = /Edg\//.test(agent) ? 'Edge' : /Firefox\//.test(agent) ? 'Firefox' : /Chrome\//.test(agent) ? 'Chrome' : /Safari\//.test(agent) ? 'Safari' : '';
  return browser ? `${device} · ${browser}` : device;
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    subtitle: { marginTop: 22, marginBottom: 10, color: colors.textSecondary, fontSize: 13, fontWeight: '700' },
    card: { borderWidth: 1, borderColor: colors.border, borderRadius: 16, overflow: 'hidden', backgroundColor: colors.surface },
    loading: { padding: 16 },
    block: { paddingHorizontal: 16, paddingBottom: 16, gap: 10 },
    divider: { borderTopWidth: 1, borderTopColor: colors.border },
    row: { minHeight: 60, paddingHorizontal: 16, paddingVertical: 12, flexDirection: 'row', alignItems: 'center', gap: 10 },
    grow: { flex: 1, gap: 2 },
    rowTitle: { color: colors.text, fontSize: 15, fontWeight: '600' },
    hint: { color: colors.textSecondary, fontSize: 13, lineHeight: 18 },
    input: { minHeight: 42, paddingHorizontal: 12, color: colors.text, fontSize: 15, borderRadius: 12, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surfaceAlt, outlineStyle: 'none' } as object,
    codeInput: { fontSize: 20, letterSpacing: 5, fontVariant: ['tabular-nums'] },
    secret: { alignSelf: 'center', color: colors.text, fontSize: 14, letterSpacing: 1, fontFamily: Platform.OS === 'web' ? 'ui-monospace, SFMono-Regular, Menlo, monospace' : Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
    codes: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, padding: 12, borderRadius: 12, backgroundColor: colors.surfaceAlt, borderWidth: 1, borderColor: colors.border },
    codeItem: { width: '47%', color: colors.text, fontSize: 14, fontFamily: Platform.OS === 'web' ? 'ui-monospace, SFMono-Regular, Menlo, monospace' : Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
    actions: { flexDirection: 'row', gap: 8 },
    inline: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    inlineAction: { alignSelf: 'flex-start', marginTop: 8 },
    small: { minHeight: 34, paddingHorizontal: 12, justifyContent: 'center', alignItems: 'center', borderRadius: 17, borderWidth: 1, borderColor: colors.border },
    iconButton: { width: 34, height: 34, alignItems: 'center', justifyContent: 'center', borderRadius: 17, borderWidth: 1, borderColor: colors.border },
    smallOn: { backgroundColor: colors.text, borderColor: colors.text },
    danger: { backgroundColor: colors.danger, borderColor: colors.danger },
    disabled: { opacity: 0.4 },
    smallText: { color: colors.text, fontSize: 13, fontWeight: '600' },
    smallTextOn: { color: colors.surface, fontSize: 13, fontWeight: '600' },
    logo: { width: 32, height: 32, borderRadius: 8, backgroundColor: colors.accentSoft },
    logoInitial: { alignItems: 'center', justifyContent: 'center' },
    success: { marginTop: 8, color: colors.textSecondary, fontSize: 12, lineHeight: 18 },
    error: { marginTop: 8, color: colors.danger, fontSize: 12, lineHeight: 18 },
  });
}
