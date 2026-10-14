import { Pressable, StyleSheet, Text, View } from 'react-native';

import { syncBanner } from '@sbm/domain';

import { useI18n } from '../i18n';
import { statusColors, useTheme } from '../theme';

export interface OfflineBannerProps {
  readonly online: boolean;
  readonly pending: number;
  readonly conflicts: number;
  readonly lastSyncedAt?: string | null;
  readonly syncing?: boolean;
  readonly onSyncNow?: () => void;
  /** The rich wording ("N changes saved on this device") can be too long for a header. */
  readonly compact?: boolean;
}

/**
 * The offline / pending banner.
 *
 * The text is produced by `@sbm/domain`'s `syncBanner`, which is the same
 * function the web client uses — so "Offline. 3 changes saved on this device and
 * waiting to sync." cannot drift between the two clients or lose the fact that
 * nothing has been shared yet.
 */
export function OfflineBanner({ online, pending, conflicts, lastSyncedAt, syncing, onSyncNow, compact }: OfflineBannerProps) {
  const { colors, radius, spacing, typography, scheme } = useTheme();
  const { language, t } = useI18n();

  const state = syncBanner({ online, pending, conflicts, lastSyncedAt });
  const pair = state.level === 'ok' ? statusColors(scheme, 'SYNCED') : statusColors(scheme, state.level === 'error' ? 'CONFLICT' : 'PENDING');

  if (state.level === 'ok' && !syncing) return null;

  const text = compact
    ? syncing
      ? `${t('common.loading')}`
      : conflicts > 0
        ? state[language]
        : !online
          ? `${t('offline.banner')} • ${pending}`
          : state[language]
    : state[language];

  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
        backgroundColor: pair.background,
        borderRadius: radius.md,
        paddingHorizontal: spacing.md,
        paddingVertical: spacing.sm,
        marginBottom: spacing.md,
      }}
    >
      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: pair.text }} />
      <Text style={[typography.caption, { color: pair.text, flex: 1 }]} numberOfLines={compact ? 1 : 3}>
        {text}
      </Text>
      {onSyncNow ? (
        <Pressable accessibilityRole="button" onPress={onSyncNow} disabled={syncing} style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}>
          <Text style={[typography.caption, { color: pair.text, fontWeight: '700', textDecorationLine: 'underline' }]}>
            {syncing ? '…' : t('offline.syncNow')}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/** A one-line reminder that the whole core flow works without a connection. */
export function OfflineCapabilityNote() {
  const { colors, radius, spacing, typography } = useTheme();
  const { t } = useI18n();
  return (
    <View style={{ borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, borderRadius: radius.md, padding: spacing.md, marginBottom: spacing.md }}>
      <Text style={[typography.caption, { color: colors.textMuted }]}>{t('offline.coreWorksOffline')}</Text>
    </View>
  );
}
