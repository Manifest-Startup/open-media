import Ionicons from './Icon';
import { useThemedStyles } from './useThemedStyles';
import { memo } from 'react';
import { Linking, Pressable, StyleSheet, View } from 'react-native';

import { appChip } from '../domain/appContext';
import { ThemeColors } from '../theme';
import { useOpenMediaTheme } from '../themeContext';
import { Text } from './Text';

/**
 * "From Manifest": a small chip on a post or conversation an integrated app created (ADR 0041).
 * With a link (always on the app's own site, which the server checks) it opens that page; inside a
 * pressable row (`linked={false}`) it is a plain label so the row stays one tap target.
 */
export const AppContextChip = memo(function AppContextChip({ context, linked = true }: { context: unknown; linked?: boolean }) {
  const { colors } = useOpenMediaTheme();
  const styles = useThemedStyles(createStyles);
  const chip = appChip(context);
  if (!chip) return null;
  if (!linked || !chip.url) {
    return <View accessible accessibilityLabel={chip.accessibilityLabel} style={styles.chip}><Text numberOfLines={1} style={styles.label}>{chip.label}</Text></View>;
  }
  const url = chip.url;
  return <Pressable
    accessibilityRole="link"
    accessibilityLabel={chip.accessibilityLabel}
    hitSlop={6}
    onPress={() => { Linking.openURL(url).catch(() => undefined); }}
    style={({ hovered, pressed }: { hovered?: boolean; pressed: boolean }) => [styles.chip, (hovered || pressed) && styles.chipActive]}
  >
    <Text numberOfLines={1} style={styles.label}>{chip.label}</Text>
    <Ionicons name="arrow-up-outline" size={11} color={colors.textSecondary} style={styles.arrow} />
  </Pressable>;
});

function createStyles(colors: ThemeColors) { return StyleSheet.create({
  chip: { alignSelf: 'flex-start', maxWidth: 200, minHeight: 22, flexDirection: 'row', alignItems: 'center', gap: 3, paddingHorizontal: 8, borderRadius: 11, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, backgroundColor: colors.chrome },
  chipActive: { backgroundColor: colors.accentSoft },
  label: { flexShrink: 1, color: colors.textSecondary, fontSize: 11, fontWeight: '600', letterSpacing: -0.05 },
  arrow: { transform: [{ rotate: '45deg' }] },
}); }
