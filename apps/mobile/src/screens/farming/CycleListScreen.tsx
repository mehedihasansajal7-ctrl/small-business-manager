import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useCallback, useState } from 'react';
import { Text, View } from 'react-native';

import { useAuth } from '../../auth/AuthProvider';
import { Button, Card, EmptyState, ListRow, MoneyText, Notice, QuantityText, Screen, Segmented, StatusBadge, Tag } from '../../components';
import { proposals } from '../../offline/outbox';
import { localCycles, localFarms } from '../../offline/repository';
import { useI18n } from '../../i18n';
import { useAsyncData, useReloadOnFocus } from '../../lib/useAsyncData';
import { useNetwork } from '../../lib/network';
import { useSync } from '../../lib/useSync';
import { useTheme } from '../../theme';
import type { FarmingStackParamList } from '../../navigation/types';

type Props = NativeStackScreenProps<FarmingStackParamList, 'CycleList'>;

type Filter = 'ACTIVE' | 'ALL' | 'CLOSED';

/**
 * Production cycles.
 *
 * Pending `cycle.create` proposals are shown above the confirmed cycles, badged
 * with their sync status, so a cycle created in a field with no signal is visible
 * immediately but never mistaken for something the partners can already see.
 */
export function CycleListScreen({ navigation, route }: Props) {
  const { colors, typography, spacing } = useTheme();
  const { t } = useI18n();
  const { business, businessId, can } = useAuth();
  const { online } = useNetwork();
  const { summary, syncing, syncNow } = useSync();
  const [filter, setFilter] = useState<Filter>('ACTIVE');

  const currency = business?.currency ?? 'BDT';
  const farmId = route.params?.farmId;

  const loader = useCallback(async () => {
    const [cycles, farms, pending] = await Promise.all([
      filter === 'ALL' ? localCycles() : filter === 'CLOSED' ? localCycles('CLOSED') : localCycles('ACTIVE'),
      localFarms(),
      businessId ? proposals(businessId, 'production_cycle') : Promise.resolve([]),
    ]);
    const farmNames = new Map(farms.map((farm) => [farm.id, farm.name]));
    return {
      cycles: farmId ? cycles.filter((cycle) => cycle.farmId === farmId) : cycles,
      farmNames,
      pending,
    };
  }, [filter, farmId, businessId]);

  const { data, loading, reload } = useAsyncData(loader, [loader]);
  useReloadOnFocus(reload);

  const showCost = can('farming.cost.view');

  return (
    <Screen title={t('farming.cycles')} onRefresh={() => void syncNow()} refreshing={syncing}>
      <Segmented
        options={[
          { value: 'ACTIVE' as Filter, label: t('dashboard.activeCycles') },
          { value: 'CLOSED' as Filter, label: t('common.none') + ' / ' + t('sync.openConflict') },
          { value: 'ALL' as Filter, label: t('common.all') },
        ]}
        value={filter}
        onChange={setFilter}
      />

      {data?.pending && data.pending.length > 0 ? (
        <Card>
          {data.pending.map((row) => (
            <ListRow
              key={row.id}
              title={row.title}
              subtitle={`${row.document_date ?? row.occurred_at.slice(0, 10)} • ${t('offline.proposal')}`}
              badge={<StatusBadge status={row.status} risk="HIGH" />}
            />
          ))}
        </Card>
      ) : null}

      <Card>
        {data && data.cycles.length > 0 ? (
          data.cycles.map((cycle) => (
            <ListRow
              key={cycle.id}
              title={`${cycle.title} (${cycle.reference})`}
              subtitle={`${data.farmNames.get(cycle.farmId) ?? ''} • ${cycle.farmingType} • ${cycle.startDate}`}
              badge={<Tag text={cycle.status} tone={cycle.status === 'CLOSED' ? 'neutral' : 'primary'} />}
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

      <View style={{ marginTop: spacing.lg }}>
        <Button label={t('farming.newCycle')} onPress={() => navigation.navigate('NewCycle', farmId ? { farmId } : {})} fullWidth />
      </View>
      {!online ? <Notice tone="info" body={t('offline.banner')} /> : null}
      {loading && !data ? <Text style={[typography.caption, { color: colors.textMuted }]}>{t('common.loading')}</Text> : null}
    </Screen>
  );
}
