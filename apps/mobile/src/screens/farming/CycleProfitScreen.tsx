import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useCallback, useState } from 'react';
import { Text, View } from 'react-native';

import { dec } from '@sbm/domain';

import * as api from '../../api/endpoints';
import { describeError } from '../../api/client';
import { useAuth } from '../../auth/AuthProvider';
import { Button, Card, MoneyText, Notice, OfflineBanner, RestrictedBlock, Row, Screen, SectionTitle, StatTile, TileGrid } from '../../components';
import { localCycleProfit, type LocalCycleProfit } from '../../offline/repository';
import { useI18n } from '../../i18n';
import { useAsyncData, useReloadOnFocus } from '../../lib/useAsyncData';
import { useNetwork } from '../../lib/network';
import { useSync } from '../../lib/useSync';
import { useTheme } from '../../theme';
import type { FarmingStackParamList } from '../../navigation/types';

type Props = NativeStackScreenProps<FarmingStackParamList, 'CycleProfitScreen'>;

/**
 * Cycle profit.
 *
 * Prefers the server's report (it is the authority and recomputes from the full
 * ledger), and falls back to the **identical local calculation** when offline —
 * `localCycleProfit` mirrors `Repository.cycleProfitReport`, including the
 * "profit only on sold output" rule. The screen always says which source produced
 * the numbers, so a partner is never misled about freshness.
 */
export function CycleProfitScreen({ route }: Props) {
  const { colors, typography, spacing } = useTheme();
  const { t, money } = useI18n();
  const { business, can } = useAuth();
  const { online } = useNetwork();
  const { syncing, syncNow } = useSync();
  const [source, setSource] = useState<'local' | 'server'>('local');
  const [error, setError] = useState<string | null>(null);

  const { cycleId } = route.params;
  const currency = business?.currency ?? 'BDT';
  const showCost = can('farming.cost.view');

  const loader = useCallback(async (): Promise<LocalCycleProfit | null> => localCycleProfit(cycleId, currency), [cycleId, currency]);
  const { data, loading, reload } = useAsyncData(loader, [loader]);
  useReloadOnFocus(reload);

  const fetchFromServer = async () => {
    setError(null);
    if (!online) {
      setError(t('auth.needInternet'));
      return;
    }
    try {
      await api.cycleProfit(cycleId);
      setSource('server');
      void syncNow({ pullOnly: true });
    } catch (caught) {
      setError(describeError(caught).message);
    }
  };

  if (!showCost) {
    return (
      <Screen title={t('farming.cycleProfit')} subtitle={data?.reference}>
        <RestrictedBlock title={t('farming.costVisibility')} body={t('common.restrictedBody')} />
      </Screen>
    );
  }

  const remaining = data ? dec(data.costToDate).sub(dec(data.assignedToFinishedStock)) : dec('0');

  return (
    <Screen title={t('farming.cycleProfit')} subtitle={data ? `${data.title} (${data.reference})` : undefined} onRefresh={() => void syncNow().then(reload)} refreshing={syncing}>
      <OfflineBanner online={online} pending={0} conflicts={0} lastSyncedAt={null} syncing={syncing} />
      {error ? <Notice tone="danger" body={error} /> : null}
      <Text style={[typography.caption, { color: colors.textMuted, marginBottom: spacing.sm }]}>
        {source === 'server' ? t('common.refresh') : t('reports.offlineNote')} • {data?.farmingType ?? ''}
      </Text>

      <TileGrid>
        <StatTile label={t('farming.costToDate')} value={data ? money(data.costToDate, currency) : '…'} />
        <StatTile label={t('farming.harvestedQty')} value={data ? `${data.harvestedQuantity} ${data.outputUnit}` : '…'} />
        <StatTile label={t('farming.assignedToStock')} value={data ? money(data.assignedToFinishedStock, currency) : '…'} />
        <StatTile label={t('farming.unallocated')} value={money(remaining.toString(), currency)} />
      </TileGrid>

      <SectionTitle title={t('reports.profitLoss')} />
      <Card>
        {data ? (
          <>
            <Row label={t('dashboard.sales')} value={money(data.revenue, currency)} />
            <Row label={t('sales.cogs')} value={money(data.cogs, currency)} />
            <Row label={t('farming.cycleProfit')} value={money(data.grossProfit, currency)} emphasis />
            <Row label={t('farming.unsoldCost')} value={money(data.costInUnsoldOutput, currency)} muted />
            <Notice tone="info" body={HARVEST_NOTE_TEXT} />
          </>
        ) : (
          <Text style={[typography.body, { color: colors.textMuted }]}>{loading ? t('common.loading') : t('common.none')}</Text>
        )}
      </Card>

      <SectionTitle title={t('farming.costToDate')} />
      <Card>
        {(data?.costBreakdown ?? []).map((row) => (
          <View key={row.kind} style={{ flexDirection: 'row', justifyContent: 'space-between', gap: spacing.md, paddingVertical: 3 }}>
            <Text style={[typography.body, { color: colors.textMuted, flex: 1 }]}>{row.kind.replace(/_/g, ' ')}</Text>
            <MoneyText value={row.amount} currency={currency} />
          </View>
        ))}
        {(data?.costBreakdown.length ?? 0) === 0 ? <Text style={[typography.caption, { color: colors.textMuted }]}>{t('common.none')}</Text> : null}
      </Card>

      <Button label={t('sync.pullOnly')} variant="secondary" onPress={() => void fetchFromServer()} disabled={!online} fullWidth />
    </Screen>
  );
}

const HARVEST_NOTE_TEXT = 'Accrual basis. Profit counts only sold output; unsold harvest remains inventory.';
