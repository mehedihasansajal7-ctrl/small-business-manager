import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useCallback, useMemo, useState } from 'react';
import { Text, View } from 'react-native';

import { dec, localDateString, monthStart } from '@sbm/domain';

import { useAuth } from '../../auth/AuthProvider';
import { Card, EmptyState, MoneyText, Notice, OfflineBanner, Screen, SectionTitle, Segmented, StatTile, TileGrid } from '../../components';
import { ATTACHMENT_NOTICE } from '../../offline/attachments';
import {
  localCashFlow,
  localCustomers,
  localFarms,
  localMortalityAlerts,
  localProfitAndLoss,
  localPurchases,
  localSales,
  localStock,
  localSuppliers,
} from '../../offline/repository';
import { useI18n } from '../../i18n';
import { useAsyncData, useReloadOnFocus } from '../../lib/useAsyncData';
import { useNetwork } from '../../lib/network';
import { useSync } from '../../lib/useSync';
import { useTheme } from '../../theme';
import type { DashboardStackParamList } from '../../navigation/types';

type Props = NativeStackScreenProps<DashboardStackParamList, 'Dashboard'>;

type Period = 'month' | 'today' | 'all';

interface DashboardData {
  readonly salesTotal: string;
  readonly purchasesTotal: string;
  readonly receivablesTotal: string;
  readonly payablesTotal: string;
  readonly lowStockItems: number;
  readonly lowStockNames: readonly string[];
  readonly cashClosing: string;
  readonly profit: { netProfit: string; grossProfit: string; netRevenue: string; operatingExpenses: string } | null;
  readonly mortality: readonly { cycleReference: string; abnormal: boolean; totalQuantity: string }[];
  readonly farms: number;
}

/**
 * Dashboard.
 *
 * Every figure is computed from the **local mirror**, so the screen is useful
 * with no connection — and it says "as of the last sync" instead of pretending to
 * be live. Money and quantities are summed with `@sbm/domain`'s `Decimal`, never
 * with `Number()`.
 */
export function DashboardScreen({ navigation }: Props) {
  const { colors, typography, spacing } = useTheme();
  const { t, money, language } = useI18n();
  const { business, can, useCachedData } = useAuth();
  const { online } = useNetwork();
  const { summary, syncing, syncNow, attachmentsPending } = useSync();
  const [period, setPeriod] = useState<Period>('month');

  const currency = business?.currency ?? 'BDT';
  const timezone = business?.timezone ?? 'Asia/Dhaka';
  const showProfit = can('financial_reports.view');

  const range = useMemo(() => {
    const today = localDateString(new Date(), timezone);
    if (period === 'today') return { from: today, to: today };
    if (period === 'all') return { from: '1970-01-01', to: '2999-12-31' };
    return { from: monthStart(new Date(), timezone), to: today };
  }, [period, timezone]);

  const loader = useCallback(async (): Promise<DashboardData> => {
    const [sales, purchases, customers, suppliers, stock, farms, mortality] = await Promise.all([
      localSales(range.from, range.to),
      localPurchases(range.from, range.to),
      localCustomers(),
      localSuppliers(),
      localStock(),
      localFarms(),
      localMortalityAlerts(),
    ]);

    const salesTotal = sales.reduce((acc, sale) => acc.add(dec(sale.net)), dec('0'));
    const purchasesTotal = purchases.reduce((acc, purchase) => acc.add(dec(purchase.total)), dec('0'));
    const receivablesTotal = customers.reduce((acc, customer) => acc.add(dec(customer.receivable ?? '0')), dec('0'));
    const payablesTotal = suppliers.reduce((acc, supplier) => acc.add(dec(supplier.payable ?? '0')), dec('0'));
    const cash = await localCashFlow(range, currency);
    const profit = showProfit ? await localProfitAndLoss(range, currency) : null;
    const lowStock = stock.filter((row) => row.belowReorder);

    return {
      salesTotal: salesTotal.toString(),
      purchasesTotal: purchasesTotal.toString(),
      receivablesTotal: receivablesTotal.toString(),
      payablesTotal: payablesTotal.toString(),
      lowStockItems: lowStock.length,
      lowStockNames: lowStock.slice(0, 3).map((row) => row.name),
      cashClosing: cash.closing ?? '0',
      profit: profit
        ? { netProfit: profit.netProfit, grossProfit: profit.grossProfit, netRevenue: profit.netRevenue, operatingExpenses: profit.operatingExpenses }
        : null,
      mortality: mortality.map((alert) => ({ cycleReference: alert.cycleReference, abnormal: alert.abnormal, totalQuantity: alert.totalQuantity })),
      farms: farms.length,
    };
  }, [range, currency, showProfit]);

  const { data, loading, reload } = useAsyncData(loader, [loader]);
  useReloadOnFocus(reload);

  const show = (value: string | undefined): string => (value === undefined ? t('common.loading') : money(value, currency));

  const periodOptions = [
    { value: 'today' as Period, label: t('common.today') },
    { value: 'month' as Period, label: t('common.thisMonth') },
    { value: 'all' as Period, label: t('common.all') },
  ];

  const abnormalAlerts = data?.mortality.filter((row) => row.abnormal) ?? [];

  return (
    <Screen
      title={t('nav.dashboard')}
      subtitle={business?.name}
      onRefresh={() => void syncNow()}
      refreshing={syncing}
      actions={
        <Text style={[typography.caption, { color: colors.primary }]} onPress={() => navigation.navigate('SyncStatus')}>
          {t('nav.sync')}
        </Text>
      }
    >
      <OfflineBanner
        online={online}
        pending={summary?.pending ?? 0}
        conflicts={summary?.conflictsOpen ?? 0}
        lastSyncedAt={summary?.lastSyncedAt ?? null}
        syncing={syncing}
        onSyncNow={() => void syncNow()}
      />

      {useCachedData ? <Notice tone="info" body={t('reports.offlineNote')} /> : null}
      {attachmentsPending > 0 ? <Notice tone="warning" body={`${t('sync.attachmentsPending')}: ${attachmentsPending}`} /> : null}

      {abnormalAlerts.length > 0 ? (
        <Notice
          tone="danger"
          title={t('farming.mortalityWarning')}
          body={`${abnormalAlerts.map((row) => row.cycleReference).join(', ')} — ${t('farming.mortalityEscalation')}`}
          action={
            <Text
              style={[typography.subheading, { color: colors.danger, marginTop: spacing.xs }]}
              onPress={() => navigation.getParent()?.navigate('FarmingTab' as never)}
            >
              {t('nav.farming')}
            </Text>
          }
        />
      ) : null}

      <Segmented options={periodOptions} value={period} onChange={setPeriod} />

      <TileGrid>
        <StatTile label={t('dashboard.sales')} value={show(data?.salesTotal)} />
        <StatTile label={t('dashboard.purchases')} value={show(data?.purchasesTotal)} />
        <StatTile label={t('dashboard.cashBalance')} value={show(data?.cashClosing)} hint={t('reports.offlineNote')} />
        <StatTile label={t('dashboard.receivables')} value={show(data?.receivablesTotal)} hint={t('inventory.balanceAsOf')} />
        <StatTile label={t('dashboard.payables')} value={show(data?.payablesTotal)} hint={t('inventory.balanceAsOf')} />
        <StatTile
          label={t('dashboard.netProfit')}
          value={data === null ? t('common.loading') : data.profit ? money(data.profit.netProfit, currency) : t('common.restricted')}
          tone={data?.profit && dec(data.profit.netProfit).isNegative() ? 'negative' : 'positive'}
        />
        <StatTile label={t('dashboard.lowStock')} value={String(data?.lowStockItems ?? 0)} tone={(data?.lowStockItems ?? 0) > 0 ? 'warning' : 'default'} hint={data?.lowStockNames.join(', ')} />
      </TileGrid>

      <SectionTitle
        title={t('reports.profitLoss')}
        action={
          <Text style={[typography.caption, { color: colors.primary }]} onPress={() => navigation.getParent()?.navigate('ReportsTab' as never)}>
            {t('nav.reports')}
          </Text>
        }
      />
      <Card>
        {data?.profit ? (
          <>
            <MoneyRow label={t('reports.netRevenue')} value={data.profit.netRevenue} currency={currency} />
            <MoneyRow label={t('dashboard.grossProfit')} value={data.profit.grossProfit} currency={currency} />
            <MoneyRow label={t('reports.operatingExpenses')} value={data.profit.operatingExpenses} currency={currency} />
            <MoneyRow label={t('dashboard.netProfit')} value={data.profit.netProfit} currency={currency} emphasis />
            <Text style={[typography.caption, { color: colors.textMuted, marginTop: spacing.sm }]}>{t('reports.accrualNote')}</Text>
          </>
        ) : (
          <EmptyState title={t('reports.restrictedTitle')} body={t('reports.restrictedBody')} />
        )}
      </Card>

      <SectionTitle title={t('farming.title')} />
      <Card>
        <Text style={[typography.body, { color: colors.text }]}>
          {t('farming.farms')}: {data?.farms ?? 0}
        </Text>
        <Text style={[typography.caption, { color: colors.textMuted, marginTop: spacing.xs }]}>{ATTACHMENT_NOTICE[language]}</Text>
      </Card>

      {loading && !data ? <Text style={[typography.caption, { color: colors.textMuted, marginTop: spacing.md }]}>{t('common.loading')}</Text> : null}
      <View style={{ height: spacing.xl }} />
    </Screen>
  );
}

function MoneyRow({ label, value, currency, emphasis }: { label: string; value: string; currency: string; emphasis?: boolean }) {
  const { colors, typography } = useTheme();
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 3, gap: 12 }}>
      <Text style={[emphasis ? typography.subheading : typography.body, { color: emphasis ? colors.text : colors.textMuted, flex: 1 }]}>{label}</Text>
      <MoneyText value={value} currency={currency} />
    </View>
  );
}
