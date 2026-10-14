import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useCallback, useState } from 'react';
import { Text, View } from 'react-native';

import { dec, localDateString, monthStart } from '@sbm/domain';

import { useAuth } from '../../auth/AuthProvider';
import { Button, Card, EmptyState, ListRow, MoneyText, Notice, OfflineBanner, Screen, Segmented, StatusBadge } from '../../components';
import { proposals } from '../../offline/outbox';
import { localPurchases, localSuppliers } from '../../offline/repository';
import { useI18n } from '../../i18n';
import { useAsyncData, useReloadOnFocus } from '../../lib/useAsyncData';
import { useNetwork } from '../../lib/network';
import { useSync } from '../../lib/useSync';
import { useTheme } from '../../theme';
import type { PurchasesStackParamList } from '../../navigation/types';

type Props = NativeStackScreenProps<PurchasesStackParamList, 'PurchaseList'>;

type Period = 'month' | 'today' | 'all';

interface Row {
  readonly id: string;
  readonly reference: string;
  readonly date: string;
  readonly total: string;
  readonly payable: string;
  readonly supplier: string;
  readonly proposalStatus?: 'PENDING' | 'SYNCING' | 'NEEDS_ATTENTION' | 'CONFLICT' | 'REJECTED';
}

/** Purchases received from suppliers: confirmed rows plus local proposals. */
export function PurchaseListScreen({ navigation }: Props) {
  const { colors, typography, spacing } = useTheme();
  const { t } = useI18n();
  const { business, businessId, can } = useAuth();
  const { online } = useNetwork();
  const { summary, syncing, syncNow } = useSync();
  const [period, setPeriod] = useState<Period>('month');

  const currency = business?.currency ?? 'BDT';
  const timezone = business?.timezone ?? 'Asia/Dhaka';

  const loader = useCallback(async (): Promise<Row[]> => {
    const today = localDateString(new Date(), timezone);
    const range =
      period === 'today' ? { from: today, to: today } : period === 'all' ? { from: '1970-01-01', to: '2999-12-31' } : { from: monthStart(new Date(), timezone), to: today };

    const [purchases, suppliers, pending] = await Promise.all([
      localPurchases(range.from, range.to),
      localSuppliers(),
      businessId ? proposals(businessId, 'purchase') : Promise.resolve([]),
    ]);
    const byId = new Map(suppliers.map((supplier) => [supplier.id, supplier.name]));

    return [
      ...pending.map<Row>((row) => ({
        id: row.id,
        reference: row.title,
        date: row.document_date ?? row.occurred_at.slice(0, 10),
        total: row.preview_amount ?? '0',
        payable: '0',
        supplier: row.subtitle ?? '',
        proposalStatus: row.status as Row['proposalStatus'],
      })),
      ...purchases.map<Row>((purchase) => ({
        id: purchase.id,
        reference: purchase.reference,
        date: purchase.documentDate,
        total: purchase.total,
        payable: purchase.payable,
        supplier: purchase.supplierId ? (byId.get(purchase.supplierId) ?? '—') : t('common.walkIn'),
      })),
    ];
  }, [period, timezone, businessId, t]);

  const { data, loading, reload } = useAsyncData(loader, [loader]);
  useReloadOnFocus(reload);

  return (
    <Screen
      title={t('nav.purchases')}
      onRefresh={() => void syncNow()}
      refreshing={syncing}
      footer={
        can('purchase.manage') ? (
          <View style={{ marginTop: spacing.lg }}>
            <Button label={t('purchases.new')} onPress={() => navigation.navigate('PurchaseEdit')} fullWidth />
          </View>
        ) : null
      }
    >
      <OfflineBanner online={online} pending={summary?.pending ?? 0} conflicts={summary?.conflictsOpen ?? 0} lastSyncedAt={summary?.lastSyncedAt ?? null} syncing={syncing} onSyncNow={() => void syncNow()} />
      <Segmented
        options={[
          { value: 'today' as Period, label: t('common.today') },
          { value: 'month' as Period, label: t('common.thisMonth') },
          { value: 'all' as Period, label: t('common.all') },
        ]}
        value={period}
        onChange={setPeriod}
      />

      {!can('purchase.cost.view') ? <Notice tone="warning" body={t('common.restrictedBody')} /> : null}

      <Card>
        {data && data.length > 0 ? (
          data.map((row) => (
            <ListRow
              key={row.id}
              title={row.reference || row.supplier}
              subtitle={`${row.date}${row.supplier ? ` • ${row.supplier}` : ''}`}
              badge={row.proposalStatus ? <StatusBadge status={row.proposalStatus} risk="HIGH" /> : undefined}
              right={
                <View style={{ alignItems: 'flex-end', gap: 2 }}>
                  <MoneyText value={row.total} currency={currency} />
                  {dec(row.payable).isPositive() ? (
                    <Text style={[typography.caption, { color: colors.warning }]}>
                      {t('purchases.payable')} {row.payable}
                    </Text>
                  ) : null}
                </View>
              }
            />
          ))
        ) : loading ? (
          <Text style={[typography.body, { color: colors.textMuted }]}>{t('common.loading')}</Text>
        ) : (
          <EmptyState title={t('purchases.empty')} body={t('offline.coreWorksOffline')} />
        )}
      </Card>
    </Screen>
  );
}
