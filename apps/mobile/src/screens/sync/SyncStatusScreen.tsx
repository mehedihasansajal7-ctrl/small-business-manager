import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useCallback, useState } from 'react';
import { Text, View } from 'react-native';

import { SYNC_STATUS_LABEL, type SyncStatus } from '@sbm/domain';

import * as api from '../../api/endpoints';
import { describeError } from '../../api/client';
import { useAuth } from '../../auth/AuthProvider';
import { Button, Card, EmptyState, ListRow, Notice, OfflineBanner, Screen, SectionTitle, StatTile, StatusBadge, Tag, TileGrid } from '../../components';
import { listOutbox, discard, retryNow, type OutboxRow } from '../../offline/outbox';
import { allConflicts, applyConflictResolution } from '../../offline/sync';
import { useI18n } from '../../i18n';
import { useAsyncData, useReloadOnFocus } from '../../lib/useAsyncData';
import { useNetwork } from '../../lib/network';
import { useSync } from '../../lib/useSync';
import { useTheme } from '../../theme';
import type { ConflictRow } from '../../api/types';
import type { DashboardStackParamList, MoreStackParamList } from '../../navigation/types';

type Props = NativeStackScreenProps<DashboardStackParamList & MoreStackParamList, 'SyncStatus'>;

/**
 * Sync status — the screen that makes offline-first honest.
 *
 * It shows exactly three things a partner needs to trust the app:
 *  1. what is still waiting (per status, with the server's own rejection message),
 *  2. what needs a human decision (conflicts, with the two resolutions), and
 *  3. when the device last successfully synced.
 *
 * Resolution policy (see `applyConflictResolution`): `SERVER_WINS` drops our queued
 * change; `LOCAL_WINS` re-queues it against the server's *current* revision, so the
 * retry is a legitimate edit instead of the same stale clash.
 */
export function SyncStatusScreen(_props: Props) {
  const { colors, typography, spacing } = useTheme();
  const { t, language } = useI18n();
  const { businessId } = useAuth();
  const { online } = useNetwork();
  const { summary, syncing, syncNow, refresh, attachmentsPending } = useSync();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const loader = useCallback(async () => {
    if (!businessId) return { rows: [] as OutboxRow[], conflicts: [] as ConflictRow[] };
    const [rows, conflicts] = await Promise.all([listOutbox(businessId), allConflicts(businessId)]);
    return { rows, conflicts };
  }, [businessId]);

  const { data, reload } = useAsyncData(loader, [loader]);
  useReloadOnFocus(reload);

  const resolve = async (conflict: ConflictRow, resolution: 'LOCAL_WINS' | 'SERVER_WINS') => {
    setError(null);
    setBusy(conflict.id);
    try {
      if (online) await api.resolveConflict(conflict.id, resolution);
      await applyConflictResolution(conflict, resolution);
      reload();
      void refresh();
      if (resolution === 'LOCAL_WINS' && online) void syncNow();
    } catch (caught) {
      setError(describeError(caught).message);
    } finally {
      setBusy(null);
    }
  };

  const openRows = (data?.rows ?? []).filter((row) => row.status !== 'SYNCED');
  const openConflicts = (data?.conflicts ?? []).filter((conflict) => conflict.status === 'OPEN');
  const counts = openRows.reduce<Record<string, number>>((acc, row) => {
    acc[row.status] = (acc[row.status] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <Screen title={t('sync.title')} onRefresh={() => void syncNow().then(reload)} refreshing={syncing}>
      <OfflineBanner online={online} pending={summary?.pending ?? 0} conflicts={summary?.conflictsOpen ?? 0} lastSyncedAt={summary?.lastSyncedAt ?? null} syncing={syncing} onSyncNow={() => void syncNow()} />
      {error ? <Notice tone="danger" body={error} /> : null}

      <TileGrid>
        <StatTile label={t('sync.pending')} value={String(counts.PENDING ?? 0)} tone={(counts.PENDING ?? 0) > 0 ? 'warning' : 'default'} />
        <StatTile label={t('sync.conflicts')} value={String(openConflicts.length)} tone={openConflicts.length > 0 ? 'negative' : 'default'} />
        <StatTile label={t('sync.needsAttention')} value={String(counts.NEEDS_ATTENTION ?? 0)} />
        <StatTile label={t('sync.attachmentsPending')} value={String(attachmentsPending)} />
      </TileGrid>

      <Card>
        <ListRow
          title={t('sync.lastSync')}
          subtitle={summary?.lastSyncedAt ? summary.lastSyncedAt.slice(0, 19).replace('T', ' ') : t('sync.never')}
        />
        <View style={{ flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md }}>
          <Button label={t('sync.pushOnly')} compact variant="secondary" loading={syncing} disabled={!online} onPress={() => void syncNow({ pushOnly: true })} />
          <Button label={t('sync.pullOnly')} compact variant="secondary" loading={syncing} disabled={!online} onPress={() => void syncNow({ pullOnly: true })} />
        </View>
      </Card>

      {openConflicts.length > 0 ? (
        <>
          <SectionTitle title={t('sync.conflicts')} />
          <Notice tone="danger" body={t('sync.conflictExplainer')} />
          {openConflicts.map((conflict) => (
            <Card key={conflict.id} style={{ marginBottom: spacing.sm }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
                <Tag text={conflict.aggregate_type} />
                <Text style={[typography.caption, { color: colors.textMuted }]} numberOfLines={1}>
                  {conflict.aggregate_id}
                </Text>
              </View>
              <Text style={[typography.caption, { color: colors.textMuted, marginTop: 4 }]}>
                base {conflict.base_revision ?? '—'} → server {conflict.server_revision ?? '—'} • {conflict.differing_fields}
              </Text>
              <View style={{ flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md }}>
                <Button label={t('sync.resolveKeepLocal')} compact variant="secondary" loading={busy === conflict.id} onPress={() => void resolve(conflict, 'LOCAL_WINS')} />
                <Button label={t('sync.resolveKeepServer')} compact variant="ghost" loading={busy === conflict.id} onPress={() => void resolve(conflict, 'SERVER_WINS')} />
              </View>
            </Card>
          ))}
        </>
      ) : null}

      <SectionTitle title={t('sync.pending')} />
      <Card>
        {openRows.length > 0 ? (
          openRows.map((row) => (
            <View key={row.id} style={{ borderBottomWidth: 1, borderBottomColor: colors.border, paddingVertical: spacing.sm }}>
              <ListRow
                title={row.event_type}
                subtitle={`${row.created_at.slice(0, 19).replace('T', ' ')} • attempts ${row.attempts}${row.last_error ? ` • ${row.last_error}` : ''}`}
                badge={<StatusBadge status={row.status as SyncStatus} risk={row.risk} />}
              />
              <View style={{ flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm }}>
                {row.status === 'NEEDS_ATTENTION' || row.status === 'PENDING' ? (
                  <Button label={t('common.retry')} compact variant="ghost" onPress={() => void retryNow(row.id).then(reload)} />
                ) : null}
                {row.status === 'REJECTED' || row.status === 'NEEDS_ATTENTION' ? (
                  <Button label={t('common.delete')} compact variant="danger" onPress={() => void discard(row.id).then(reload)} />
                ) : null}
              </View>
            </View>
          ))
        ) : (
          <EmptyState title={t('common.none')} body={SYNC_STATUS_LABEL.SYNCED[language]} />
        )}
      </Card>

      <Text style={[typography.caption, { color: colors.textMuted, marginTop: spacing.md }]}>{t('sync.onlineOnly')}</Text>
    </Screen>
  );
}
