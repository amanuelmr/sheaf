import React from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { radius, spacing, TOUCH_TARGET, type Palette } from '../theme';

/**
 * The small set of primitives every screen is built from. Kept deliberately plain:
 * one accent, restrained borders, no gradients or decorative shadows.
 */

export function Button({
  label,
  onPress,
  palette,
  variant = 'primary',
  disabled = false,
  style,
}: {
  label: string;
  onPress: () => void;
  palette: Palette;
  variant?: 'primary' | 'secondary' | 'quiet';
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const background =
    variant === 'primary'
      ? palette.accent
      : variant === 'secondary'
        ? palette.surface
        : 'transparent';
  const color = variant === 'primary' ? palette.accentText : palette.text;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        {
          backgroundColor: background,
          borderColor: variant === 'secondary' ? palette.border : 'transparent',
          opacity: disabled ? 0.45 : pressed ? 0.85 : 1,
        },
        style,
      ]}
    >
      <Text style={[styles.buttonLabel, { color }]}>{label}</Text>
    </Pressable>
  );
}

export function Field({
  label,
  hint,
  palette,
  children,
}: {
  label: string;
  hint?: string;
  palette: Palette;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.field}>
      <Text style={[styles.fieldLabel, { color: palette.textMuted }]}>{label}</Text>
      {children}
      {hint === undefined ? null : (
        <Text style={[styles.hint, { color: palette.textMuted }]}>{hint}</Text>
      )}
    </View>
  );
}

/**
 * Status is always a symbol *and* a sentence. Colour is the third channel, never
 * the only one (§41), so this reads the same to a screen reader and in greyscale.
 */
export function StatusBadge({
  symbol,
  label,
  tone,
  palette,
}: {
  symbol: string;
  label: string;
  tone: 'ok' | 'waiting' | 'danger' | 'neutral';
  palette: Palette;
}) {
  const color =
    tone === 'ok'
      ? palette.ok
      : tone === 'waiting'
        ? palette.waiting
        : tone === 'danger'
          ? palette.danger
          : palette.textMuted;
  return (
    <View style={styles.badge} accessible accessibilityLabel={label}>
      <Text style={[styles.badgeSymbol, { color }]}>{symbol}</Text>
      <Text style={[styles.badgeLabel, { color }]}>{label}</Text>
    </View>
  );
}

export function Divider({ palette }: { palette: Palette }) {
  return <View style={[styles.divider, { backgroundColor: palette.border }]} />;
}

export function EmptyState({
  title,
  body,
  palette,
  action,
  style,
}: {
  title: string;
  body: string;
  palette: Palette;
  action?: React.ReactNode;
  style?: StyleProp<TextStyle>;
}) {
  return (
    <View style={styles.empty}>
      <Text style={[styles.emptyTitle, { color: palette.text }, style]}>{title}</Text>
      <Text style={[styles.emptyBody, { color: palette.textMuted }]}>{body}</Text>
      {action}
    </View>
  );
}

const styles = StyleSheet.create({
  button: {
    minHeight: TOUCH_TARGET + 8,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
  },
  buttonLabel: { fontSize: 17, fontWeight: '600' },
  field: { gap: spacing.xs, marginBottom: spacing.lg },
  fieldLabel: { fontSize: 13, fontWeight: '500', textTransform: 'uppercase', letterSpacing: 0.6 },
  hint: { fontSize: 13, lineHeight: 18 },
  badge: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  badgeSymbol: { fontSize: 14, fontWeight: '600' },
  badgeLabel: { fontSize: 14, fontWeight: '500' },
  divider: { height: StyleSheet.hairlineWidth, width: '100%' },
  empty: { alignItems: 'center', gap: spacing.sm, paddingVertical: spacing.xxl },
  emptyTitle: { fontSize: 18, fontWeight: '600', textAlign: 'center' },
  emptyBody: { fontSize: 15, lineHeight: 22, textAlign: 'center', maxWidth: 300 },
});
