import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useCallback } from 'react';
import { Text, View } from 'react-native';

import { dec } from '@sbm/domain';

import { useAuth } from '../../auth/AuthProvider';
import { Button, Card, EmptyState, ListRow, MoneyText, Notice, OfflineBanner, QuantityText, Screen, SectionTitle, StatTile, Tag, TileGrid } from '../../components';
import { localCostAllocations, localCycles, localFarms, localMortalityAlerts } from '../../offline/repository';
import { useI18n } from '../../i18n';
import { useAsyncData, useReloadOnFocus } from '../../lib/useAsyncData';
import { useNetwork } from '../../lib/network';
import { useSync } from '../../lib/useSync';
import { useTheme } from '../../theme';
import type { FarmingStackParamList } from '../../navigation/types';

type Props = NativeStackScreenProps<FarmingStackParamList, 'FarmingHome'>;

/**
 * Farming home.
 *
 * Cost, revenue and the mortality warning are all computed from the mirror, so a
 * farm manager standing in a shed with no signal still sees the picture — and,
 * importantly, still sees a large-mortality warning. Disease does not wait for
 * connectivity.
 */
export function FarmingHomeScreen({ navigation }: Props) {
  const { colors, typography, spacing } = useTheme();
  const { t, money } = useI18n();
  const { business, can } = useAuth();
  const { online } = useNetwork();
  const { summary, syncing, syncNow } = useSync();

  const currency = business?.currency ?? 'BDT';

  const loader = useCallback(async () => {
    const [cycles, farms, mortality, allocations] = await Promise.all([localCycles(), localFarms(), localMortalityAlerts(), localCostAllocations()]);
    const active = cycles.filter((cycle) => cycle.status === 'ACTIVE' || cycle.status === 'HARVESTING');
    const totalCost = active.reduce((acc, cycle) => acc.add(dec(cycle.costToDate ?? '0')), dec('0'));
    const revenue = active.reduce((acc, cycle) => acc.add(dec(cycle.revenue ?? '0')), dec('0'));
    return {
      cycles,
      active,
      farms,
      mortality,
      allocations: allocations.length,
      totalCost: totalCost.toString(),
      revenue: revenue.toString(),
      grossProfit: revenue.sub(totalCost).toString(),
    };
  }, []);

  const { data, loading, reload } = useAsyncData(loader, [loader]);
  useReloadOnFocus(reload);

  const abnormal = data?.mortality.filter((row) => row.abnormal) ?? [];
  const showCost = can('farming.cost.view');

  return (
    <Screen title={t('nav.farming')} subtitle={business?.name} onRefresh={() => void syncNow()} refreshing={syncing}>
      <OfflineBanner online={online} pending={summary?.pending ?? 0} conflicts={summary?.conflictsOpen ?? 0} lastSyncedAt={summary?.lastSyncedAt ?? null} syncing={syncing} onSyncNow={() => void syncNow()} />

      {abnormal.length > 0 ? (
        <Notice
          tone="danger"
          title={t('farming.mortalityWarning')}
          body={`${abnormal.map((row) => `${row.cycleReference}: ${row.totalQuantity}`).join(' • ')} — ${t('farming.mortalityEscalation')}`}
        />
      ) : null}

      <TileGrid>
        <StatTile label={t('dashboard.activeCycles')} value={String(data?.active.length ?? 0)} />
        <StatTile label={t('farming.costToDate')} value={data ? money(data.totalCost, currency) : '…'} tone={showCost ? 'default' : 'warning'} hint={showCost ? t('inventory.balanceAsOf') : t('farming.costVisibility')} />
        <StatTile label={t('farming.cycleProfit')} value={data ? money(data.grossProfit, currency) : '…'} tone={data && dec(data.grossProfit).isNegative() ? 'negative' : 'positive'} hint={showCost ? undefined : t('farming.costVisibility')} />
        <StatTile label={t('farming.farms')} value={String(data?.farms.length ?? 0)} />
      </TileGrid>

      <SectionTitle title={t('farming.cycles')} action={<Text style={[typography.caption, { color: colors.primary }]} onPress={() => navigation.navigate('CycleList', {})}>{t('common.all')}</Text>} />
      <Card>
        {data && data.active.length > 0 ? (
          data.active.map((cycle) => (
            <ListRow
              key={cycle.id}
              title={`${cycle.title} (${cycle.reference})`}
              subtitle={`${cycle.farmingType} • ${cycle.startDate}${cycle.expectedEndDate ? ` → ${cycle.expectedEndDate}` : ''}`}
              badge={<Tag text={cycle.status} tone="primary" />}
              right={
                <View style={{ alignItems: 'flex-end', gap: 2 }}>
                  <QuantityText value={cycle.harvestedQuantity} />
                  {showCost && cycle.costToDate ? <MoneyText value={cycle.costToDate} currency={currency} style={{ fontSize: 12 }} /> : null}
                </View>
              }
              onPress={() => navigation.navigate('CycleDetail', { cycleId: cycle.id, title: cycle.title })}
            />
          ))
        ) : (
          <EmptyState title={t('common.none')} body={t('offline.coreWorksOffline')} />
        )}
      </Card>

      <SectionTitle title={t('farming.title')} />
      <View style={{ gap: spacing.sm }}>
        <Button label={t('farming.farms')} variant="secondary" onPress={() => navigation.navigate('FarmList')} fullWidth />
        <Button label={t('farming.newCycle')} variant="secondary" onPress={() => navigation.navigate('NewCycle', {})} fullWidth />
        <Button label={t('farming.allocation')} variant="secondary" onPress={() => navigation.navigate('AllocationForm')} fullWidth />
      </View>

      {loading && !data ? <Text style={[typography.caption, { color: colors.textMuted, marginTop: spacing.md }]}>{t('common.loading')}</Text> : null}
      {!showCost ? <Text style={[typography.caption, { color: colors.textMuted, marginTop: spacing.md }]}>{t('farming.costVisibility')}</Text> : null}
    </Screen>
  );
}
