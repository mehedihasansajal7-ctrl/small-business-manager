import { RefreshControl, ScrollView, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { ReactNode } from 'react';

import { useTheme } from '../theme';

/**
 * Screen shell: safe-area padding, an optional heading block and consistent
 * scroll/refresh behaviour. Using `useSafeAreaInsets` directly (rather than
 * `SafeAreaView`) lets a screen opt out of the bottom inset when it has its own
 * bottom bar.
 */
export function Screen({
  title,
  subtitle,
  actions,
  children,
  scroll = true,
  refreshing,
  onRefresh,
  footer,
  contentStyle,
  bottomInset = true,
}: {
  title?: string;
  subtitle?: string | null;
  actions?: ReactNode;
  children: ReactNode;
  scroll?: boolean;
  refreshing?: boolean;
  onRefresh?: () => void;
  footer?: ReactNode;
  contentStyle?: StyleProp<ViewStyle>;
  bottomInset?: boolean;
}) {
  const { colors, spacing, typography } = useTheme();
  const insets = useSafeAreaInsets();

  const header = title ? (
    <View style={{ flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: spacing.md, marginBottom: spacing.md }}>
      <View style={{ flex: 1 }}>
        <Text style={[typography.title, { color: colors.text }]}>{title}</Text>
        {subtitle ? <Text style={[typography.caption, { color: colors.textMuted, marginTop: 2 }]}>{subtitle}</Text> : null}
      </View>
      {actions}
    </View>
  ) : null;

  const padding: ViewStyle = {
    padding: spacing.lg,
    paddingBottom: bottomInset ? insets.bottom + spacing.xl : spacing.lg,
    gap: 0,
  };

  if (!scroll) {
    return (
      <View style={[{ flex: 1, backgroundColor: colors.background }, padding, contentStyle]}>
        {header}
        {children}
        {footer}
      </View>
    );
  }

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.background }}
      contentContainerStyle={[padding, contentStyle]}
      keyboardShouldPersistTaps="handled"
      refreshControl={
        onRefresh
          ? <RefreshControl refreshing={Boolean(refreshing)} onRefresh={onRefresh} colors={[colors.primary]} tintColor={colors.primary} />
          : undefined
      }
    >
      {header}
      {children}
      {footer}
    </ScrollView>
  );
}

/** A two-column stat grid; used by dashboard and report screens. */
export function TileGrid({ children }: { children: ReactNode }) {
  const { spacing } = useTheme();
  return <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginBottom: spacing.md }}>{children}</View>;
}

/** Label/value table row for reports. */
export function Row({ label, value, emphasis, muted }: { label: string; value: string; emphasis?: boolean; muted?: boolean }) {
  const { colors, spacing, typography } = useTheme();
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: spacing.md, paddingVertical: spacing.xs }}>
      <Text style={[emphasis ? typography.subheading : typography.body, { color: muted ? colors.textMuted : colors.text, flex: 1 }]} numberOfLines={2}>
        {label}
      </Text>
      <Text style={[emphasis ? typography.subheading : typography.mono, { color: muted ? colors.textMuted : colors.text }]} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

export const screenStyles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  spaceBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  grow: { flex: 1 },
});
