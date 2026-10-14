import { StyleSheet, Text, View } from 'react-native';

import { SYNC_STATUS_LABEL, type SyncStatus } from '@sbm/domain';

import { useI18n } from '../i18n';
import { statusColors, useTheme } from '../theme';

/**
 * Sync-status badge.
 *
 * Labels come from `@sbm/domain`'s `SYNC_STATUS_LABEL`, so the phone, the web
 * client and the server describe the same state with the same words. A HIGH-risk
 * event is rendered differently from a LOW-risk one, because a locally recorded
 * sale is a *proposal* until the server confirms it.
 */

export function StatusBadge({ status, risk }: { status: SyncStatus; risk?: 'LOW' | 'HIGH' }) {
  const { scheme, radius, spacing, typography } = useTheme();
  const { language } = useI18n();
  const colors = statusColors(scheme, status);
  const label = SYNC_STATUS_LABEL[status][language];

  return (
    <View
      style={{
        backgroundColor: colors.background,
        borderRadius: radius.pill,
        paddingHorizontal: spacing.sm,
        paddingVertical: 2,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: colors.text,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
      }}
    >
      <Text style={[typography.caption, { color: colors.text, fontWeight: '600' }]}>
        {label}
        {risk === 'HIGH' && (status === 'PENDING' || status === 'SYNCING') ? ' •' : ''}
      </Text>
    </View>
  );
}

export function Tag({ text, tone = 'neutral' }: { text: string; tone?: 'neutral' | 'primary' | 'warning' | 'danger' | 'success' }) {
  const { colors, scheme, radius, spacing, typography } = useTheme();
  const map = {
    neutral: { background: colors.surfaceAlt, text: colors.textMuted },
    primary: { background: colors.primaryMuted, text: colors.primary },
    warning: statusColors(scheme, 'PENDING'),
    danger: statusColors(scheme, 'REJECTED'),
    success: statusColors(scheme, 'SYNCED'),
  } as const;
  const pair = map[tone];

  return (
    <View style={{ backgroundColor: pair.background, borderRadius: radius.pill, paddingHorizontal: spacing.sm, paddingVertical: 2 }}>
      <Text style={[typography.caption, { color: pair.text, fontWeight: '600' }]}>{text}</Text>
    </View>
  );
}
