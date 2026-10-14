import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useCallback, useState } from 'react';
import { Text, View } from 'react-native';

import { dec, type Permission } from '@sbm/domain';

import * as api from '../../api/endpoints';
import { describeError } from '../../api/client';
import { useAuth } from '../../auth/AuthProvider';
import { useActor } from '../../auth/useActor';
import { Button, Card, EmptyState, Field, ListRow, MoneyText, Notice, OfflineBanner, Row, Screen, SectionTitle, StatTile, Tag, TileGrid } from '../../components';
import { closeCycleOffline, localCostAllocations, localCycles, localFarmingEvents, localHarvests } from '../../offline/repository';
import { useI18n } from '../../i18n';
import { useAsyncData, useReloadOnFocus } from '../../lib/useAsyncData';
import { useNetwork } from '../../lib/network';
import { useSync } from '../../lib/useSync';
import { useTheme } from '../../theme';
import type { FarmingStackParamList } from '../../navigation/types';

type Props = NativeStackScreenProps<FarmingStackParamList, 'CycleDetail'>;

/**
 * One production cycle: its events, harvests, allocated shared cost, and the
 * actions available on it.
 *
 * The four "record something" actions are all offline-capable outbox events
 * (`farming.input_issue`, `farming.cost`, `farming.observe`, `farming.mortality`,
 * `harvest.post`, `cycle.close`). Closing a cycle is queued too, and the server
 * re-derives the closing harvest — so a manager can close a batch in the field.
 */
export function CycleDetailScreen({ navigation, route }: Props) {
  const { colors, typography, spacing } = useTheme();
  const { t, money } = useI18n();
  const { business, can } = useAuth();
  const actor = useActor();
  const { online } = useNetwork();
  const { summary, syncing, syncNow } = useSync();

  const { cycleId, title } = route.params;
  const currency = business?.currency ?? 'BDT';

  const [remainingQuantity, setRemainingQuantity] = useState('');
  const [closing, setClosing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loader = useCallback(async () => {
    const [cycles, events, harvests, allocations] = await Promise.all([
      localCycles(),
      localFarmingEvents(cycleId),
      localHarvests(cycleId),
      localCostAllocations(cycleId),
    ]);
    const cycle = cycles.find((entry) => entry.id === cycleId) ?? null;
    const directCost = events.reduce((acc, event) => (event.amount ? acc.add(dec(event.amount)) : acc), dec('0'));
    const allocated = allocations.reduce((acc, item) => acc.add(dec(item.amount)), dec('0'));
    const harvestedQty = harvests.reduce((acc, harvest) => acc.add(dec(harvest.quantity)), dec('0'));
    const assignedCost = harvests.reduce((acc, harvest) => acc.add(dec(harvest.costBasis)), dec('0'));
    return { cycle, events, harvests, allocations, directCost: directCost.toString(), allocated: allocated.toString(), harvestedQty: harvestedQty.toString(), assignedCost: assignedCost.toString() };
  }, [cycleId]);

  const { data, loading, reload } = useAsyncData(loader, [loader]);
  useReloadOnFocus(reload);

  const showCost = can('farming.cost.view');
  const closed = data?.cycle?.status === 'CLOSED';

  const onCloseCycle = async () => {
    setError(null);
    if (!actor) return;
    setClosing(true);
    try {
      await closeCycleOffline(actor, {
        cycleId,
        ...(remainingQuantity.trim() ? { remainingQuantity: remainingQuantity.trim() } : {}),
      });
      if (online) void syncNow();
      reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('common.error'));
    } finally {
      setClosing(false);
    }
  };

  const onRefreshProfitFromServer = async () => {
    if (!online) {
      setError(t('auth.needInternet'));
      return;
    }
    try {
      await api.cycleProfit(cycleId);
      setError(null);
    } catch (caught) {
      setError(describeError(caught).message);
    }
  };

  const actions: readonly { label: string; eventType: string; permission: Permission }[] = [
    { label: t('farming.inputIssue'), eventType: 'INPUT_ISSUE', permission: 'farming.input_issue' },
    { label: t('farming.cost'), eventType: 'DIRECT_LABOUR', permission: 'farming.operations' },
    { label: t('farming.observation'), eventType: 'OBSERVATION', permission: 'farming.observation' },
    { label: t('farming.mortality'), eventType: 'MORTALITY', permission: 'farming.operations' },
  ];

  return (
    <Screen title={title ?? data?.cycle?.title ?? t('farming.cycleDetail')} subtitle={data?.cycle?.reference} onRefresh={() => void syncNow().then(reload)} refreshing={syncing}>
      <OfflineBanner online={online} pending={summary?.pending ?? 0} conflicts={summary?.conflictsOpen ?? 0} lastSyncedAt={summary?.lastSyncedAt ?? null} syncing={syncing} onSyncNow={() => void syncNow()} />
      {error ? <Notice tone="danger" body={error} /> : null}

      {data?.cycle ? (
        <Card>
          <View style={{ flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.sm }}>
            <Tag text={data.cycle.status} tone={closed ? 'neutral' : 'primary'} />
            <Tag text={data.cycle.farmingType} />
          </View>
          <Row label={t('common.date')} value={`${data.cycle.startDate}${data.cycle.expectedEndDate ? ` → ${data.cycle.expectedEndDate}` : ''}`} />
          <Row label={t('farming.plannedOutput')} value={`${data.cycle.plannedOutput ?? '0'} ${data.cycle.plannedOutputUnit ?? ''}`} />
          <Row label={t('farming.startingPopulation')} value={data.cycle.startingPopulation ?? '0'} />
          <Row label={t('farming.harvestedQty')} value={`${data.harvestedQty} ${data.cycle.plannedOutputUnit ?? ''}`} />
        </Card>
      ) : null}

      {showCost ? (
        <TileGrid>
          <StatTile label={t('farming.costToDate')} value={data ? money(dec(data.directCost).add(dec(data.allocated)).toString(), currency) : '…'} />
          <StatTile label={t('farming.assignedToStock')} value={data ? money(data.assignedCost, currency) : '…'} />
          <StatTile label={t('farming.allocatedTotal')} value={data ? money(data.allocated, currency) : '…'} />
          <StatTile label={t('farming.cycleProfit')} value={data?.cycle?.revenue ? money(dec(data.cycle.revenue).sub(dec(data.assignedCost)).toString(), currency) : '…'} />
        </TileGrid>
      ) : (
        <Notice tone="info" body={t('farming.costVisibility')} />
      )}

      <SectionTitle title={t('farming.events')} />
      {actions.map((action) =>
        can(action.permission as never) ? (
          <View key={action.eventType} style={{ marginBottom: spacing.sm }}>
            <Button
              label={action.label}
              variant="secondary"
              onPress={() => navigation.navigate('FarmingEventForm', { cycleId, eventType: action.eventType, title: action.label })}
              fullWidth
            />
          </View>
        ) : null,
      )}
      <Button
        label={t('farming.harvest')}
        variant="secondary"
        onPress={() => navigation.navigate('HarvestForm', { cycleId })}
        fullWidth
        disabled={!can('farming.harvest')}
      />

      <Card>
        {data && data.events.length > 0 ? (
          data.events.map((event) => (
            <ListRow
              key={event.id}
              title={`${event.eventType}${event.quantity ? ` • ${event.quantity} ${event.unit ?? ''}` : ''}`}
              subtitle={`${event.occurredOn}${event.notes ? ` • ${event.notes}` : ''}`}
              right={event.amount ? <MoneyText value={event.amount} currency={event.currency ?? currency} /> : undefined}
            />
          ))
        ) : (
          <EmptyState title={t('common.none')} body={loading ? t('common.loading') : t('offline.coreWorksOffline')} />
        )}
      </Card>

      <SectionTitle title={t('farming.harvest')} />
      <Card>
        {data && data.harvests.length > 0 ? (
          data.harvests.map((harvest) => (
            <ListRow
              key={harvest.id}
              title={`${harvest.quantity} ${harvest.unit}`}
              subtitle={`${harvest.occurredOn}${harvest.grade ? ` • ${harvest.grade}` : ''}`}
              right={<MoneyText value={harvest.costBasis} currency={harvest.currency} />}
            />
          ))
        ) : (
          <Text style={[typography.caption, { color: colors.textMuted }]}>{t('common.none')}</Text>
        )}
      </Card>

      <SectionTitle title={t('farming.cycleProfit')} />
      <Card>
        <Button label={t('farming.cycleProfit')} variant="secondary" onPress={() => navigation.navigate('CycleProfitScreen', { cycleId })} fullWidth />
        <View style={{ height: spacing.sm }} />
        <Button label={t('sync.pullOnly')} variant="ghost" onPress={() => void onRefreshProfitFromServer()} fullWidth disabled={!online} />
        <Text style={[typography.caption, { color: colors.textMuted, marginTop: spacing.sm }]}>{t('reports.offlineNote')}</Text>
      </Card>

      {can('farming.close_cycle') && !closed ? (
        <>
          <SectionTitle title={t('farming.closeCycle')} />
          <Card>
            <Field label={t('common.quantity')} value={remainingQuantity} onChangeText={setRemainingQuantity} note={t('common.optional')} />
            <Button label={t('farming.closeCycle')} onPress={() => void onCloseCycle()} loading={closing} fullWidth />
            <Text style={[typography.caption, { color: colors.textMuted, marginTop: spacing.sm }]}>{t('offline.coreWorksOffline')}</Text>
          </Card>
        </>
      ) : null}

      <View style={{ height: spacing.xl }} />
    </Screen>
  );
}
