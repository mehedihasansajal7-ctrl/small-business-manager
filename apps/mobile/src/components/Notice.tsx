import { StyleSheet, Text, View } from 'react-native';
import type { ReactNode } from 'react';

import { useTheme } from '../theme';

/**
 * Inline notices. `Notice` is used for every explained state — an error from the
 * API, a restricted report, an online-only action — so the user is told *why*
 * something is unavailable instead of seeing a dead button.
 */

export type NoticeTone = 'info' | 'success' | 'warning' | 'danger';

export function Notice({ tone = 'info', title, body, action }: { tone?: NoticeTone; title?: string; body: string; action?: ReactNode }) {
  const { colors, radius, spacing, typography } = useTheme();
  const map: Record<NoticeTone, { background: string; text: string; border: string }> = {
    info: { background: colors.infoMuted, text: colors.info, border: colors.info },
    success: { background: colors.successMuted, text: colors.success, border: colors.success },
    warning: { background: colors.warningMuted, text: colors.warning, border: colors.warning },
    danger: { background: colors.dangerMuted, text: colors.danger, border: colors.danger },
  };
  const palette = map[tone];

  return (
    <View
      style={{
        backgroundColor: palette.background,
        borderRadius: radius.md,
        borderLeftWidth: 4,
        borderLeftColor: palette.border,
        padding: spacing.md,
        gap: spacing.xs,
        marginBottom: spacing.md,
      }}
    >
      {title ? <Text style={[typography.subheading, { color: palette.text }]}>{title}</Text> : null}
      <Text style={[typography.body, { color: palette.text }]}>{body}</Text>
      {action}
    </View>
  );
}

/** Standard "this failed, and here is the server's own message" card. */
export function ErrorNotice({ message, code, onRetry, retryLabel }: { message: string; code?: string; onRetry?: () => void; retryLabel?: string }) {
  const { colors, spacing, typography } = useTheme();
  return (
    <Notice
      tone="danger"
      title={code ? `Error: ${code}` : undefined}
      body={message}
      action={
        onRetry ? (
          <Text
            onPress={onRetry}
            style={[typography.subheading, { color: colors.danger, marginTop: spacing.xs, textDecorationLine: 'underline' }]}
          >
            {retryLabel ?? 'Try again'}
          </Text>
        ) : undefined
      }
    />
  );
}

/** Wrap any list/screen content while it is loading for the first time. */
export function LoadingBlock({ label }: { label: string }) {
  const { colors, spacing, typography } = useTheme();
  return (
    <View style={{ padding: spacing.xl, alignItems: 'center' }}>
      <Text style={[typography.body, { color: colors.textMuted }]}>{label}</Text>
    </View>
  );
}

/** A restriction state, used by reports and by permission-gated buttons. */
export function RestrictedBlock({ title, body }: { title: string; body: string }) {
  const { colors, spacing, typography } = useTheme();
  return (
    <View
      style={{
        borderWidth: StyleSheet.hairlineWidth,
        borderStyle: 'dashed',
        borderColor: colors.border,
        borderRadius: 10,
        padding: spacing.lg,
        gap: spacing.xs,
      }}
    >
      <Text style={[typography.subheading, { color: colors.text }]}>{title}</Text>
      <Text style={[typography.body, { color: colors.textMuted }]}>{body}</Text>
    </View>
  );
}
