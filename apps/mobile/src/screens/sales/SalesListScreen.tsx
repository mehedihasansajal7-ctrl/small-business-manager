import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useCallback, useState } from 'react';
import { Text, View } from 'react-native';

import { dec, localDateString, monthStart } from '@sbm/domain';

import { useAuth } from '../../auth/AuthProvider';
import { Button, Card, EmptyState, ListRow, MoneyText, Notice, OfflineBanner, Screen, Segmented, StatusBadge, Tag } from '../../components';
import { localCustomers, localSales } from '../../offline/repository';
import { proposals } from '../../offline/outbox';
import { useI18n } from '../../i18n';
import { useAsyncData, useReloadOnFocus } from '../../lib/useAsyncData';
import { useNetwork } from '../../lib/network';
import { useSync } from '../../lib/useSync';
import { useTheme } from '../../theme';
import type { SalesStackParamList } from '../../navigation/types';

type Props = NativeStackScreenProps<SalesStackParamList, 'SalesList'>;

type Period = 'month' | 'today' | 'all';

interface Row {
  readonly id: string;
  readonly reference: string;
  readonly date: string;
  readonly net: string;
  readonly receivable: string;
  readonly customer: string;
  readonly proposalStatus?: 'PENDING' | 'SYNCING' | 'NEEDS_ATTENTION' | 'CONFLICT' | 'REJECTED';
}

/**
 * Sales list.
 *
 * Two sources, deliberately kept visually distinct:
 *  - **confirmed** rows from the local mirror (`sales`, filled by `sync/pull`), and
 *  - **local proposals** from the outbox, badged with their sync status.
 *
 * A partner must never see an offline sale presented as shared, which is the
 * whole reason the outbox exists as a separate table.
 */
export function SalesListScreen({ navigation }: Props) {
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

    const [sales, customers, pending] = await Promise.all([
      localSales(range.from, range.to),
      localCustomers(),
      businessId ? proposals(businessId, 'sale') : Promise.resolve([]),
    ]);
    const byId = new Map(customers.map((customer) => [customer.id, customer.name]));

    const confirmed: Row[] = sales.map((sale) => ({
      id: sale.id,
      reference: sale.reference,
      date: sale.documentDate,
      net: sale.net,
      receivable: sale.receivable,
      customer: sale.customerId ? (byId.get(sale.customerId) ?? '—') : t('common.walkIn'),
    }));

    const proposed: Row[] = pending.map((row) => ({
      id: row.id,
      reference: row.title,
      date: row.document_date ?? row.occurred_at.slice(0, 10),
      net: row.preview_amount ?? '0',
      receivable: '0',
      customer: row.subtitle ?? '',
      proposalStatus: row.status as Row['proposalStatus'],
    }));

    return [...proposed, ...confirmed];
  }, [period, timezone, businessId, t]);

  const { data, loading, reload } = useAsyncData(loader, [loader]);
  useReloadOnFocus(reload);

  const periodOptions = [
    { value: 'today' as Period, label: t('common.today') },
    { value: 'month' as Period, label: t('common.thisMonth') },
    { value: 'all' as Period, label: t('common.all') },
  ];

  return (
    <Screen
      title={t('nav.sales')}
      onRefresh={() => void syncNow()}
      refreshing={syncing}
      footer={
        can('sale.create') ? (
          <View style={{ marginTop: spacing.lg }}>
            <Button label={t('sales.new')} onPress={() => navigation.navigate('SaleEdit', {})} fullWidth />
          </View>
        ) : null
      }
    >
      <OfflineBanner online={online} pending={summary?.pending ?? 0} conflicts={summary?.conflictsOpen ?? 0} lastSyncedAt={summary?.lastSyncedAt ?? null} syncing={syncing} onSyncNow={() => void syncNow()} />
      <Segmented options={periodOptions} value={period} onChange={setPeriod} />

      {!can('sale.create') ? <Notice tone="info" body={t('common.restrictedBody')} /> : null}

      <Card>
        {data && data.length > 0 ? (
          data.map((row) => (
            <ListRow
              key={row.id}
              title={row.reference || row.customer}
              subtitle={`${row.date}${row.customer ? ` • ${row.customer}` : ''}`}
              badge={row.proposalStatus ? <StatusBadge status={row.proposalStatus} risk="HIGH" /> : <Tag text={t('common.save')} tone="success" />}
              right={
                <View style={{ alignItems: 'flex-end', gap: 2 }}>
                  <MoneyText value={row.net} currency={currency} />
                  {dec(row.receivable).isPositive() ? (
                    <Text style={[typography.caption, { color: colors.warning }]}>
                      {t('sales.receivable')} {row.receivable}
                    </Text>
                  ) : null}
                </View>
              }
              onPress={row.proposalStatus ? undefined : () => navigation.navigate('SaleEdit', { saleId: row.id })}
            />
          ))
        ) : loading ? (
          <Text style={[typography.body, { color: colors.textMuted }]}>{t('common.loading')}</Text>
        ) : (
          <EmptyState title={t('sales.empty')} body={t('offline.coreWorksOffline')} />
        )}
      </Card>
    </Screen>
  );
}
