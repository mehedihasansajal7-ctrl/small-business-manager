import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useCallback, useState } from 'react';
import { Text, View } from 'react-native';

import { dec } from '@sbm/domain';

import { useAuth } from '../../auth/AuthProvider';
import { Button, Card, EmptyState, Field, ListRow, MoneyText, Notice, OfflineBanner, QuantityText, Screen, StatusBadge, Tag } from '../../components';
import { proposals } from '../../offline/outbox';
import { localStock } from '../../offline/repository';
import { useI18n } from '../../i18n';
import { useAsyncData, useReloadOnFocus } from '../../lib/useAsyncData';
import { useNetwork } from '../../lib/network';
import { useSync } from '../../lib/useSync';
import { useTheme } from '../../theme';
import type { InventoryStackParamList } from '../../navigation/types';

type Props = NativeStackScreenProps<InventoryStackParamList, 'InventoryList'>;

/**
 * Inventory: on-hand quantity per item, derived from the mirrored movement
 * ledger by `@sbm/domain`'s `stockBalance` / `weightedAverageValuation` — the
 * same functions the server uses, so a partner sees the same number offline and
 * online.
 *
 * Quantities and costs are exact decimals; nothing is recomputed with floats.
 */
export function InventoryListScreen({ navigation }: Props) {
  const { colors, typography, spacing } = useTheme();
  const { t } = useI18n();
  const { business, businessId, can } = useAuth();
  const { online } = useNetwork();
  const { summary, syncing, syncNow } = useSync();
  const [search, setSearch] = useState('');

  const currency = business?.currency ?? 'BDT';

  const loader = useCallback(async () => {
    const rows = await localStock();
    const pending = businessId ? await proposals(businessId, 'stock_movement') : [];
    const needle = search.trim().toLowerCase();
    return {
      rows: needle ? rows.filter((row) => row.name.toLowerCase().includes(needle)) : rows,
      pending,
    };
  }, [search, businessId]);

  const { data, loading, reload } = useAsyncData(loader, [loader]);
  useReloadOnFocus(reload);

  const showCost = can('purchase.cost.view');

  return (
    <Screen title={t('nav.inventory')} onRefresh={() => void syncNow()} refreshing={syncing}>
      <OfflineBanner online={online} pending={summary?.pending ?? 0} conflicts={summary?.conflictsOpen ?? 0} lastSyncedAt={summary?.lastSyncedAt ?? null} syncing={syncing} onSyncNow={() => void syncNow()} />

      <Field label={t('common.search')} value={search} onChangeText={setSearch} autoCapitalize="none" />
      <Text style={[typography.caption, { color: colors.textMuted, marginBottom: spacing.md }]}>{t('inventory.balanceAsOf')}</Text>

      {data?.pending && data.pending.length > 0 ? (
        <Card>
          {data.pending.map((row) => (
            <ListRow
              key={row.id}
              title={`${row.title} ${row.subtitle ?? ''}`}
              subtitle={`${row.document_date ?? ''} • ${t('offline.proposal')}`}
              badge={<StatusBadge status={row.status} risk="HIGH" />}
            />
          ))}
        </Card>
      ) : null}

      <Card>
        {data && data.rows.length > 0 ? (
          data.rows.map((row) => (
            <ListRow
              key={row.itemId}
              title={row.name}
              subtitle={
                row.reorderLevel
                  ? `${t('inventory.reorderLevel')}: ${row.reorderLevel} ${row.unit}`
                  : showCost && row.value
                    ? `${t('inventory.value')}: ${row.value}`
                    : undefined
              }
              badge={row.belowReorder ? <Tag text={t('inventory.belowReorder')} tone="warning" /> : undefined}
              right={
                <View style={{ alignItems: 'flex-end', gap: 2 }}>
                  <QuantityText value={row.onHand} unit={row.unit} />
                  {showCost && row.unitCost ? <MoneyText value={row.unitCost} currency={currency} style={{ fontSize: 12 }} /> : null}
                  {dec(row.onHand).isNegative() ? <Text style={[typography.caption, { color: colors.danger }]}>{t('inventory.out')}</Text> : null}
                </View>
              }
              onPress={() => navigation.navigate('MovementHistory', { itemId: row.itemId })}
            />
          ))
        ) : (
          <EmptyState title={t('common.none')} body={t('offline.coreWorksOffline')} />
        )}
      </Card>

      {can('inventory.adjust') ? (
        <View style={{ marginTop: spacing.lg }}>
          <Button label={t('inventory.adjust')} onPress={() => navigation.navigate('StockAdjust', {})} fullWidth />
        </View>
      ) : (
        <Notice tone="warning" body={t('common.restrictedBody')} />
      )}

      {can('inventory.adjust.approve') ? null : <Text style={[typography.caption, { color: colors.textMuted }]}>{t('sales.negativeHint')}</Text>}
      {loading && !data ? <Text style={[typography.caption, { color: colors.textMuted }]}>{t('common.loading')}</Text> : null}
    </Screen>
  );
}
