import { ActivityIndicator, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { useTheme } from '../theme';

/**
 * Buttons. Three visual levels plus disabled/loading states, so no screen has to
 * invent its own pressable style.
 */

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';

export interface ButtonProps {
  readonly label: string;
  readonly onPress: () => void;
  readonly variant?: ButtonVariant;
  readonly disabled?: boolean;
  readonly loading?: boolean;
  readonly fullWidth?: boolean;
  readonly compact?: boolean;
  readonly style?: StyleProp<ViewStyle>;
  readonly accessibilityHint?: string;
}

export function Button({ label, onPress, variant = 'primary', disabled, loading, fullWidth, compact, style, accessibilityHint }: ButtonProps) {
  const { colors, radius, spacing, typography } = useTheme();
  const isDisabled = Boolean(disabled) || Boolean(loading);

  const background = isDisabled
    ? colors.surfaceAlt
    : variant === 'primary'
      ? colors.primary
      : variant === 'danger'
        ? colors.danger
        : variant === 'secondary'
          ? colors.surfaceAlt
          : 'transparent';

  const textColor = isDisabled
    ? colors.textMuted
    : variant === 'primary'
      ? colors.primaryText
      : variant === 'danger'
        ? '#ffffff'
        : variant === 'secondary'
          ? colors.text
          : colors.primary;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: isDisabled, busy: Boolean(loading) }}
      accessibilityHint={accessibilityHint}
      onPress={isDisabled ? undefined : onPress}
      style={({ pressed }) => [
        styles.base,
        {
          backgroundColor: background,
          borderColor: variant === 'ghost' || variant === 'primary' || variant === 'danger' ? 'transparent' : colors.border,
          borderWidth: variant === 'secondary' ? StyleSheet.hairlineWidth : 0,
          borderRadius: radius.md,
          paddingVertical: compact ? spacing.sm : spacing.md,
          paddingHorizontal: compact ? spacing.md : spacing.lg,
          opacity: pressed && !isDisabled ? 0.85 : 1,
        },
        fullWidth ? styles.fullWidth : null,
        style,
      ]}
    >
      <View style={styles.content}>
        {loading ? <ActivityIndicator size="small" color={textColor} /> : null}
        <Text style={[typography.subheading, { color: textColor }]} numberOfLines={1}>
          {label}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: { alignItems: 'center', justifyContent: 'center' },
  fullWidth: { alignSelf: 'stretch' },
  content: { flexDirection: 'row', alignItems: 'center', gap: 8 },
});
