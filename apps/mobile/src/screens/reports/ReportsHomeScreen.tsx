import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useCallback, useMemo, useState } from 'react';
import { Text, View } from 'react-native';

import { localDateString, monthStart } from '@sbm/domain';

import { useAuth } from '../../auth/AuthProvider';
import { Card, EmptyState, ListRow, MoneyText, Notice, OfflineBanner, RestrictedBlock, Row, Screen, SectionTitle, Segmented } from '../../components';
import { localBalanceSheet, localCashFlow, localCustomers, localProfitAndLoss, localSuppliers } from '../../offline/repository';
import { useI18n } from '../../i18n';
import { useAsyncData, useReloadOnFocus } from '../../lib/useAsyncData';
import { useNetwork } from '../../lib/network';
import { useSync } from '../../lib/useSync';
import { useTheme } from '../../theme';
import type { ReportsStackParamList } from '../../navigation/types';

type Props = NativeStackScreenProps<ReportsStackParamList, 'ReportsHome'>;

type Report = 'PL' | 'BS' | 'CF' | 'AR' | 'AP';

/**
 * Reports.
 *
 * All five reports are computed **on the device** from the mirrored journal and
 * ledger with `@sbm/domain`'s `profitAndLoss`, `balanceSheet` and `cashFlow` —
 * the same pure functions the server calls, which is why the numbers match. That
 * makes the whole reporting module work offline, which matters in a shop with no
 * reliable connection.
 *
 * Permission handling mirrors the server exactly: `financial_reports.view` for
 * P&L and the balance sheet (widenable by the owner's visibility setting),
 * `finance.view` for cash flow, `report.view` for receivables/payables. When a
 * role may not see a report, the screen explains that instead of showing zeros —
 * a zero balance and a hidden balance must never look the same.
 */
export function ReportsHomeScreen(_props: Props) {
  const { colors, typography, spacing } = useTheme();
  const { t, money } = useI18n();
  const { business, can } = useAuth();
  const { online } = useNetwork();
  const { summary, syncing, syncNow } = useSync();

  const [report, setReport] = useState<Report>('PL');
  const currency = business?.currency ?? 'BDT';
  const timezone = business?.timezone ?? 'Asia/Dhaka';

  // Memoised so the loader's dependency list stays stable (an object literal per
  // render would re-create the callback and re-run the loader in a loop).
  const range = useMemo(() => ({ from: monthStart(new Date(), timezone), to: localDateString(new Date(), timezone) }), [timezone]);

  const loader = useCallback(async () => {
    const [pnl, sheet, flow, customers, suppliers] = await Promise.all([
      can('financial_reports.view') ? localProfitAndLoss(range, currency) : Promise.resolve(null),
      can('financial_reports.view') ? localBalanceSheet(range.to, currency) : Promise.resolve(null),
      can('finance.view') ? localCashFlow(range, currency) : Promise.resolve(null),
      can('report.view') ? localCustomers() : Promise.resolve([]),
      can('report.view') ? localSuppliers() : Promise.resolve([]),
    ]);
    return { pnl, sheet, flow, customers, suppliers };
  }, [can, range, currency]);

  const { data, loading, reload } = useAsyncData(loader, [loader]);
  useReloadOnFocus(reload);

  const options = [
    { value: 'PL' as Report, label: t('reports.profitLoss') },
    { value: 'BS' as Report, label: t('reports.balanceSheet') },
    { value: 'CF' as Report, label: t('reports.cashFlow') },
    { value: 'AR' as Report, label: t('reports.receivables') },
    { value: 'AP' as Report, label: t('reports.payables') },
  ];

  const restricted = (report === 'PL' || report === 'BS') && !can('financial_reports.view');

  return (
    <Screen title={t('nav.reports')} subtitle={`${range.from} → ${range.to}`} onRefresh={() => void syncNow()} refreshing={syncing}>
      <OfflineBanner online={online} pending={summary?.pending ?? 0} conflicts={summary?.conflictsOpen ?? 0} lastSyncedAt={summary?.lastSyncedAt ?? null} syncing={syncing} onSyncNow={() => void syncNow()} />
      <Text style={[typography.caption, { color: colors.textMuted, marginBottom: spacing.sm }]}>{t('reports.offlineNote')}</Text>

      <Segmented options={options} value={report} onChange={setReport} />

      {restricted ? (
        <RestrictedBlock title={t('reports.restrictedTitle')} body={t('reports.restrictedBody')} />
      ) : report === 'PL' ? (
        <Card>
          {data?.pnl ? (
            <>
              <Row label={t('reports.netRevenue')} value={money(data.pnl.netRevenue, currency)} />
              <Row label={t('sales.cogs')} value={money(data.pnl.costOfGoodsSold, currency)} />
              <Row label={t('dashboard.grossProfit')} value={money(data.pnl.grossProfit, currency)} emphasis />
              <Row label={t('reports.operatingExpenses')} value={money(data.pnl.operatingExpenses, currency)} />
              <Row label={t('dashboard.netProfit')} value={money(data.pnl.netProfit, currency)} emphasis />
              <SectionTitle title={t('reports.operatingExpenses')} />
              {data.pnl.expensesByAccount.map((row) => (
                <Row key={row.account} label={`${row.account} • ${row.name}`} value={money(row.amount, currency)} muted />
              ))}
              <Notice tone="info" body={data.pnl.currency + ' — ' + t('reports.accrualNote')} />
            </>
          ) : (
            <Text style={[typography.body, { color: colors.textMuted }]}>{t('common.loading')}</Text>
          )}
        </Card>
      ) : report === 'BS' ? (
        <View>
          <SectionTitle title={t('reports.balanceSheet')} />
          <Card>
            {data?.sheet ? (
              <>
                {data.sheet.assets.map((row) => (
                  <Row key={`a-${row.account}`} label={`${row.account} • ${row.name}`} value={money(row.amount, currency)} />
                ))}
                <Row label={t('common.total')} value={money(data.sheet.totalAssets, currency)} emphasis />
                {data.sheet.liabilities.map((row) => (
                  <Row key={`l-${row.account}`} label={`${row.account} • ${row.name}`} value={money(row.amount, currency)} />
                ))}
                {data.sheet.equity.map((row) => (
                  <Row key={`e-${row.account}`} label={`${row.account} • ${row.name}`} value={money(row.amount, currency)} />
                ))}
                <Notice tone={data.sheet.balanced ? 'success' : 'danger'} body={data.sheet.balanced ? t('reports.balanced') : t('reports.notBalanced')} />
              </>
            ) : (
              <Text style={[typography.body, { color: colors.textMuted }]}>{t('common.loading')}</Text>
            )}
          </Card>
        </View>
      ) : report === 'CF' ? (
        <Card>
          {data?.flow ? (
            <>
              <Row label={`${t('common.from')} — ${t('dashboard.cashBalance')}`} value={money(data.flow.opening ?? '0', currency)} />
              <Row label={t('reports.cashFlow') + ' (+)'} value={money(data.flow.inflows ?? '0', currency)} />
              <Row label={t('reports.cashFlow') + ' (−)'} value={money(data.flow.outflows ?? '0', currency)} />
              <Row label={t('common.total')} value={money(data.flow.closing ?? '0', currency)} emphasis />
            </>
          ) : (
            <Text style={[typography.body, { color: colors.textMuted }]}>{t('common.loading')}</Text>
          )}
        </Card>
      ) : report === 'AR' ? (
        <Card>
          {data?.customers && data.customers.length > 0 ? (
            data.customers
              .filter((customer) => (customer.receivable ?? '0') !== '0.00')
              .map((customer) => (
                <ListRow key={customer.id} title={customer.name} subtitle={customer.phone ?? undefined} right={<MoneyText value={customer.receivable ?? '0'} currency={currency} />} />
              ))
          ) : (
            <EmptyState title={t('common.none')} body={t('inventory.balanceAsOf')} />
          )}
        </Card>
      ) : (
        <Card>
          {data?.suppliers && data.suppliers.length > 0 ? (
            data.suppliers
              .filter((supplier) => (supplier.payable ?? '0') !== '0.00')
              .map((supplier) => (
                <ListRow key={supplier.id} title={supplier.name} subtitle={supplier.phone ?? undefined} right={<MoneyText value={supplier.payable ?? '0'} currency={currency} />} />
              ))
          ) : (
            <EmptyState title={t('common.none')} body={t('inventory.balanceAsOf')} />
          )}
        </Card>
      )}

      {loading && !data ? <Text style={[typography.caption, { color: colors.textMuted, marginTop: spacing.md }]}>{t('common.loading')}</Text> : null}
    </Screen>
  );
}
