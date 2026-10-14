import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import type { ReactNode } from 'react';

import { useTheme } from '../theme';

/**
 * Presentational building blocks: card, section title, stat tile, list row,
 * empty state. Keeping them together avoids five near-identical files while
 * still giving every screen the same rhythm and the same dark-mode behaviour.
 */

export function Card({ children, style, onPress }: { children: ReactNode; style?: StyleProp<ViewStyle>; onPress?: () => void }) {
  const { colors, radius, spacing } = useTheme();
  const base: StyleProp<ViewStyle> = [
    {
      backgroundColor: colors.surface,
      borderRadius: radius.lg,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      padding: spacing.lg,
    },
    style,
  ];

  if (!onPress) {
    return (
      <View style={base}>
        {children}
      </View>
    );
  }
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [base, pressed ? { opacity: 0.9 } : null]}>
      {children}
    </Pressable>
  );
}

export function SectionTitle({ title, action }: { title: string; action?: ReactNode }) {
  const { colors, typography, spacing } = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: spacing.lg, marginBottom: spacing.sm }}>
      <Text style={[typography.label, { color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 0.6 }]}>{title}</Text>
      {action}
    </View>
  );
}

export function StatTile({ label, value, tone = 'default', hint }: { label: string; value: string; tone?: 'default' | 'positive' | 'negative' | 'warning'; hint?: string }) {
  const { colors, radius, spacing, typography } = useTheme();
  const valueColor =
    tone === 'positive' ? colors.success : tone === 'negative' ? colors.danger : tone === 'warning' ? colors.warning : colors.text;

  return (
    <View
      style={{
        flexGrow: 1,
        flexBasis: '47%',
        backgroundColor: colors.surface,
        borderRadius: radius.md,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: colors.border,
        padding: spacing.md,
        gap: 2,
      }}
    >
      <Text style={[typography.caption, { color: colors.textMuted }]} numberOfLines={1}>
        {label}
      </Text>
      <Text style={[typography.subheading, { color: valueColor }]} numberOfLines={1} adjustsFontSizeToFit>
        {value}
      </Text>
      {hint ? (
        <Text style={[typography.caption, { color: colors.textMuted }]} numberOfLines={2}>
          {hint}
        </Text>
      ) : null}
    </View>
  );
}

export function ListRow({
  title,
  subtitle,
  right,
  onPress,
  badge,
}: {
  title: string;
  subtitle?: string | null;
  right?: ReactNode;
  onPress?: () => void;
  badge?: ReactNode;
}) {
  const { colors, spacing, typography } = useTheme();
  const content = (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md }}>
      <View style={{ flex: 1, gap: 2 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
          <Text style={[typography.body, { color: colors.text, fontWeight: '600', flexShrink: 1 }]} numberOfLines={1}>
            {title}
          </Text>
          {badge}
        </View>
        {subtitle ? (
          <Text style={[typography.caption, { color: colors.textMuted }]} numberOfLines={2}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {right}
    </View>
  );

  const style: StyleProp<ViewStyle> = {
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  };

  return onPress ? (
    <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [style, pressed ? { backgroundColor: colors.surfaceAlt } : null]}>
      {content}
    </Pressable>
  ) : (
    <View style={style}>{content}</View>
  );
}

export function EmptyState({ title, body, action }: { title: string; body?: string; action?: ReactNode }) {
  const { colors, spacing, typography } = useTheme();
  return (
    <View style={{ padding: spacing.xl, alignItems: 'center', gap: spacing.sm }}>
      <Text style={[typography.subheading, { color: colors.text, textAlign: 'center' }]}>{title}</Text>
      {body ? (
        <Text style={[typography.body, { color: colors.textMuted, textAlign: 'center' }]}>{body}</Text>
      ) : null}
      {action}
    </View>
  );
}

export function Divider({ spacing: gap = 'md' }: { spacing?: 'sm' | 'md' | 'lg' }) {
  const { colors, spacing } = useTheme();
  return (
    <View
      style={{
        height: StyleSheet.hairlineWidth,
        backgroundColor: colors.border,
        marginVertical: spacing[gap],
      }}
    />
  );
}
