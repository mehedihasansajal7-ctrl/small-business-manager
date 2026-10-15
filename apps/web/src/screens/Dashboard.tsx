import { useMemo, useState, type ReactNode } from 'react';
import { reports as reportApi } from '../api/endpointsFinance';
import { farming as farmingApi } from '../api/endpointsFarming';
import { canViewFarmingCost, canViewFinancialReports } from '../api/permissions';
import { AsyncState, Restricted } from '../components/States';
import { Card } from '../components/ui';
import { DataTable, type Column } from '../components/DataTable';
import { MoneyText, QtyText } from '../components/MoneyText';
import { Notice, PageHeader, SelectInput, TextInput, Badge } from '../components/ui';
import { useApp, useT } from '../state/AppContext';
import { useResource } from '../offline/useSync';
import { navigate } from '../state/router';
import type { CycleRow } from '../api/types';

function monthStart(date = new Date()): string {
  return `${date.toISOString().slice(0, 7)}-01`;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Dashboard: period KPIs, low stock, receivables/payables and farming summary. */
export function DashboardScreen() {
  const { business, permissions } = useApp();
  const { t, locale } = useT();
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(today());
  const [preset, setPreset] = useState('thisMonth');

  const report = useResource(() => reportApi.dashboard({ from, to }), [from, to, business?.id]);
  const hasFarming = permissions.includes('farming.view');
  const farming = useResource(() => (hasFarming ? farmingApi.dashboard() : Promise.resolve(null)), [hasFarming, business?.id]);

  const currency = business?.currency ?? 'BDT';
  const financialsVisible = canViewFinancialReports(permissions);
  const farmingCostVisible = canViewFarmingCost(permissions);

  const applyPreset = (value: string) => {
    setPreset(value);
    const now = new Date();
    if (value === 'thisMonth') {
      setFrom(monthStart(now));
      setTo(today());
    } else if (value === 'lastMonth') {
      const first = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const last = new Date(now.getFullYear(), now.getMonth(), 0);
      setFrom(first.toISOString().slice(0, 10));
      setTo(last.toISOString().slice(0, 10));
    } else if (value === 'thisYear') {
      setFrom(`${now.getFullYear()}-01-01`);
      setTo(today());
    }
  };

  const cycleColumns: Column<CycleRow>[] = useMemo(
    () => [
      { id: 'reference', header: t('common.reference'), cell: (row) => <button type="button" className="link" onClick={() => navigate(`/farming/cycle/${row.id}`)}>{row.reference}</button> },
      { id: 'title', header: t('farm.title'), cell: (row) => row.title },
      { id: 'status', header: t('common.status'), cell: (row) => <Badge tone={row.status === 'ACTIVE' ? 'ok' : 'muted'}>{row.status}</Badge> },
      { id: 'cost', header: t('farm.costToDate'), align: 'right', permission: 'farming.cost.view', cell: (row) => <MoneyText value={row.costToDate} currency={currency} /> },
      { id: 'harvest', header: t('farm.harvested'), align: 'right', cell: (row) => <QtyText value={row.harvestedQuantity} /> },
    ],
    [t, currency],
  );

  return (
    <>
      <PageHeader
        title={t('nav.dashboard')}
        subtitle={`${business?.name ?? ''} · ${from} → ${to}`}
        actions={
          <SelectInput
            label={t('dash.range')}
            value={preset}
            onValueChange={applyPreset}
            options={[
              { value: 'thisMonth', label: t('dash.thisMonth') },
              { value: 'lastMonth', label: t('dash.lastMonth') },
              { value: 'thisYear', label: t('dash.thisYear') },
              { value: 'custom', label: t('dash.custom') },
            ]}
          />
        }
      />

      {preset === 'custom' ? (
        <Card>
          <div className="grid grid--2">
            <TextInput label={t('rep.from')} type="date" value={from} onValueChange={setFrom} />
            <TextInput label={t('rep.to')} type="date" value={to} onValueChange={setTo} />
          </div>
        </Card>
      ) : null}

      <AsyncState loading={report.loading} error={report.error} data={report.data} onRetry={report.reload}>
        {(data) => (
          <>
            <div className="kpis">
              <Kpi label={t('dash.sales')} value={<MoneyText value={data.sales} currency={currency} />} onClick={() => navigate('/sales')} />
              <Kpi label={t('dash.purchases')} value={<MoneyText value={data.purchases} currency={currency} />} onClick={() => navigate('/purchases')} />
              <Kpi label={t('dash.cashBalance')} value={<MoneyText value={data.cashBalance} currency={currency} />} />
              <Kpi label={t('dash.cashIn')} value={<MoneyText value={data.cashReceived} currency={currency} />} />
              <Kpi label={t('dash.cashOut')} value={<MoneyText value={data.cashPaid} currency={currency} />} />
              <Kpi label={t('dash.receivables')} value={<MoneyText value={data.receivables} currency={currency} />} onClick={() => navigate('/reports')} />
              <Kpi label={t('dash.payables')} value={<MoneyText value={data.payables} currency={currency} />} onClick={() => navigate('/reports')} />
              <Kpi label={t('dash.lowStock')} value={locale === 'en' ? String(data.lowStockItems) : String(data.lowStockItems).replace(/\d/g, (d) => '০১২৩৪৫৬৭৮৯'[Number(d)] as string)} onClick={() => navigate('/inventory')} />
            </div>

            <Card title={t('rep.pnl')} subtitle={t('rep.accrual')}>
              {financialsVisible && data.netProfit !== undefined ? (
                <div className="grid grid--2">
                  <Stat label={t('dash.revenue')} value={<MoneyText value={data.revenue} currency={currency} />} />
                  <Stat label={t('dash.grossProfit')} value={<MoneyText value={data.grossProfit} currency={currency} />} />
                  <Stat label={t('dash.operatingExpenses')} value={<MoneyText value={data.operatingExpenses} currency={currency} />} />
                  <Stat label={t('dash.netProfit')} value={<MoneyText value={data.netProfit} currency={currency} signed />} />
                  <Stat label={t('dash.cashBasis')} value={<MoneyText value={data.cashBasisResult} currency={currency} />} />
                </div>
              ) : (
                <Restricted permission="financial_reports.view" />
              )}
            </Card>
          </>
        )}
      </AsyncState>

      {hasFarming ? (
        <AsyncState loading={farming.loading} error={farming.error} data={farming.data} onRetry={farming.reload}>
          {(data) =>
            data === null ? (
              <Restricted permission="farming.view" />
            ) : (
              <Card
                title={t('dash.farming')}
                subtitle={data.mortalityAlerts > 0 ? t('farm.mortalityEscalation') : undefined}
                actions={
                  <button type="button" className="link" onClick={() => navigate('/farming')}>
                    {t('nav.farming')}
                  </button>
                }
              >
                <div className="kpis kpis--compact">
                  <Kpi label={t('dash.activeCycles')} value={String(data.activeCycles)} />
                  <Kpi label={t('dash.closedCycles')} value={String(data.closedCycles)} />
                  <Kpi label={t('dash.mortalityAlerts')} value={String(data.mortalityAlerts)} />
                  {farmingCostVisible ? <Kpi label={t('dash.farmingCost')} value={<MoneyText value={data.totalCostToDate} currency={currency} />} /> : null}
                  {farmingCostVisible ? <Kpi label={t('dash.farmingRevenue')} value={<MoneyText value={data.revenue} currency={currency} />} /> : null}
                </div>
                {data.mortalityAlerts > 0 ? <Notice level="error">{t('farm.mortalityEscalation')}</Notice> : null}
                <DataTable columns={cycleColumns} rows={data.cycles.filter((row) => row.status !== 'CLOSED').slice(0, 5)} getKey={(row) => row.id} permissions={permissions} />
              </Card>
            )
          }
        </AsyncState>
      ) : null}
    </>
  );
}

function Kpi({ label, value, onClick }: { readonly label: string; readonly value: ReactNode; readonly onClick?: () => void }) {
  if (onClick) {
    return (
      <button type="button" className="kpi kpi--link" onClick={onClick}>
        <span className="kpi__label">{label}</span>
        <span className="kpi__value">{value}</span>
      </button>
    );
  }
  return (
    <div className="kpi">
      <span className="kpi__label">{label}</span>
      <span className="kpi__value">{value}</span>
    </div>
  );
}

function Stat({ label, value }: { readonly label: string; readonly value: ReactNode }) {
  return (
    <div className="stat">
      <span className="stat__label">{label}</span>
      <span className="stat__value">{value}</span>
    </div>
  );
}
