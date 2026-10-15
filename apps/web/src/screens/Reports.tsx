import { useState } from 'react';
import { reports } from '../api/endpointsFinance';
import { hasPermission } from '../api/permissions';
import { AsyncState, Restricted } from '../components/States';
import { DataTable, type Column } from '../components/DataTable';
import { MoneyText } from '../components/MoneyText';
import { Badge, Card, Notice, PageHeader, Tabs, TextInput, TotalRow, Totals } from '../components/ui';
import { useApp, useT } from '../state/AppContext';
import { useResource, useSyncState } from '../offline/useSync';
import type { AccountAmount, PayableRow, ReceivableRow } from '../api/types';

function monthStart(): string {
  return `${new Date().toISOString().slice(0, 7)}-01`;
}

/** Financial reports. Each statement is gated by the same permission the API uses. */
export function ReportsScreen() {
  const { business, permissions } = useApp();
  const { t } = useT();
  const { snapshot } = useSyncState();
  const currency = business?.currency ?? 'BDT';
  const [tab, setTab] = useState('pnl');
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(new Date().toISOString().slice(0, 10));
  const [asOf, setAsOf] = useState(new Date().toISOString().slice(0, 10));

  const canFinancials = hasPermission(permissions, 'financial_reports.view');
  const canFinance = hasPermission(permissions, 'finance.view');
  const canReport = hasPermission(permissions, 'report.view');

  const pnl = useResource(() => (canFinancials && tab === 'pnl' ? reports.profitAndLoss({ from, to }) : Promise.resolve(null)), [tab, from, to, canFinancials, business?.id]);
  const sheet = useResource(() => (canFinancials && tab === 'balance' ? reports.balanceSheet(asOf) : Promise.resolve(null)), [tab, asOf, canFinancials, business?.id]);
  const trial = useResource(() => (canFinancials && tab === 'trial' ? reports.trialBalance({ from, to }) : Promise.resolve(null)), [tab, from, to, canFinancials, business?.id]);
  const flow = useResource(() => (canFinance && tab === 'cash' ? reports.cashFlow({ from, to }) : Promise.resolve(null)), [tab, from, to, canFinance, business?.id]);
  const receivables = useResource(() => (canReport && tab === 'receivables' ? reports.receivables() : Promise.resolve(null)), [tab, canReport, snapshot.lastSyncedAt, business?.id]);
  const payables = useResource(() => (canReport && tab === 'payables' ? reports.payables() : Promise.resolve(null)), [tab, canReport, snapshot.lastSyncedAt, business?.id]);

  const tabs = [
    { id: 'pnl', label: t('rep.pnl') },
    { id: 'balance', label: t('rep.balanceSheet') },
    { id: 'trial', label: t('rep.trial') },
    { id: 'cash', label: t('rep.cashFlow') },
    { id: 'receivables', label: t('rep.receivables') },
    { id: 'payables', label: t('rep.payables') },
  ];

  const outstandingColumns = (nameLabel: string): Column<ReceivableRow | PayableRow>[] => [
    { id: 'name', header: nameLabel, cell: (row) => row.name },
    { id: 'phone', header: t('common.phone'), cell: (row) => row.phone ?? '—' },
    { id: 'outstanding', header: t('rep.outstanding'), align: 'right', cell: (row) => <MoneyText value={row.outstanding} currency={currency} /> },
  ];

  return (
    <>
      <PageHeader title={t('nav.reports')} subtitle={business?.name} />
      <Tabs tabs={tabs} active={tab} onChange={setTab} />

      {tab !== 'receivables' && tab !== 'payables' ? (
        <Card>
          <div className="grid grid--2">
            {tab === 'balance' ? (
              <TextInput label={t('rep.asOf')} type="date" value={asOf} onValueChange={setAsOf} />
            ) : (
              <>
                <TextInput label={t('rep.from')} type="date" value={from} onValueChange={setFrom} />
                <TextInput label={t('rep.to')} type="date" value={to} onValueChange={setTo} />
              </>
            )}
          </div>
        </Card>
      ) : null}

      {tab === 'pnl' ? (
        canFinancials ? (
          <AsyncState loading={pnl.loading} error={pnl.error} data={pnl.data} onRetry={pnl.reload}>
            {(data) =>
              data === null ? null : (
                <Card title={t('rep.pnl')} subtitle={`${data.from} → ${data.to} · ${t('rep.accrual')}`}>
                  <Totals>
                    <TotalRow label={t('dash.revenue')} value={<MoneyText value={data.revenue} currency={currency} />} />
                    <TotalRow label={t('sales.discount')} value={<MoneyText value={data.contraRevenue} currency={currency} />} />
                    <TotalRow label={t('rep.pnl')} value={<MoneyText value={data.netRevenue} currency={currency} />} strong />
                    <TotalRow label={t('sales.cogs')} value={<MoneyText value={data.costOfGoodsSold} currency={currency} />} />
                    <TotalRow label={t('dash.grossProfit')} value={<MoneyText value={data.grossProfit} currency={currency} />} strong />
                    <TotalRow label={t('dash.operatingExpenses')} value={<MoneyText value={data.operatingExpenses} currency={currency} />} />
                    <TotalRow label={t('fin.income')} value={<MoneyText value={data.otherIncome} currency={currency} />} />
                    <TotalRow label={t('dash.netProfit')} value={<MoneyText value={data.netProfit} currency={currency} signed />} strong />
                    <TotalRow label={t('dash.cashBasis')} value={<MoneyText value={data.cashBasisResult} currency={currency} />} />
                  </Totals>
                  {Number(data.revenue) === 0 && Number(data.costOfGoodsSold) === 0 && Number(data.operatingExpenses) === 0 && Number(data.otherIncome) === 0 ? (
                    <Notice level="info">{t('rep.noTransactions')}</Notice>
                  ) : null}
                  <Notice level="info">{data.note}</Notice>
                  <DataTable
                    columns={[
                      { id: 'account', header: t('rep.account'), cell: (row: { account: string; amount: string }) => <span className="mono">{row.account}</span> },
                      { id: 'name', header: t('common.name'), cell: (row: { name: string }) => row.name },
                      { id: 'amount', header: t('common.amount'), align: 'right', cell: (row: { amount: string }) => <MoneyText value={row.amount} currency={currency} /> },
                    ]}
                    rows={[...data.expensesByAccount]}
                    getKey={(row) => row.account}
                    permissions={permissions}
                  />
                </Card>
              )
            }
          </AsyncState>
        ) : (
          <Restricted permission="financial_reports.view" />
        )
      ) : null}

      {tab === 'balance' ? (
        canFinancials ? (
          <AsyncState loading={sheet.loading} error={sheet.error} data={sheet.data} onRetry={sheet.reload}>
            {(data) =>
              data === null ? null : (
                <Card
                  title={t('rep.balanceSheet')}
                  subtitle={data.asOf}
                  actions={<Badge tone={data.balanced ? 'ok' : 'error'}>{data.balanced ? t('rep.balanced') : t('rep.notBalanced')}</Badge>}
                >
                  <SheetSection title={t('rep.assets')} rows={data.assets} total={data.totalAssets} currency={currency} permissions={permissions} />
                  <SheetSection title={t('rep.liabilities')} rows={data.liabilities} total={data.totalLiabilities} currency={currency} permissions={permissions} />
                  <SheetSection title={t('rep.equity')} rows={data.equity} total={data.totalEquityIncludingResult} currency={currency} permissions={permissions} />
                </Card>
              )
            }
          </AsyncState>
        ) : (
          <Restricted permission="financial_reports.view" />
        )
      ) : null}

      {tab === 'trial' ? (
        canFinancials ? (
          <AsyncState loading={trial.loading} error={trial.error} data={trial.data} onRetry={trial.reload}>
            {(data) =>
              data === null ? null : (
                <Card title={t('rep.trial')} actions={<Badge tone={data.balanced ? 'ok' : 'error'}>{data.balanced ? t('rep.balanced') : t('rep.notBalanced')}</Badge>}>
                  <DataTable
                    columns={[
                      { id: 'account', header: t('rep.account'), cell: (row) => <span className="mono">{row.account}</span> },
                      { id: 'name', header: t('common.name'), cell: (row) => row.name },
                      { id: 'debit', header: t('rep.debit'), align: 'right', cell: (row) => <MoneyText value={row.debit} currency={currency} /> },
                      { id: 'credit', header: t('rep.credit'), align: 'right', cell: (row) => <MoneyText value={row.credit} currency={currency} /> },
                    ]}
                    rows={[...data.rows]}
                    getKey={(row) => row.account}
                    permissions={permissions}
                  />
                  <Totals>
                    <TotalRow label={t('rep.debit')} value={<MoneyText value={data.totalDebit} currency={currency} />} />
                    <TotalRow label={t('rep.credit')} value={<MoneyText value={data.totalCredit} currency={currency} />} />
                  </Totals>
                </Card>
              )
            }
          </AsyncState>
        ) : (
          <Restricted permission="financial_reports.view" />
        )
      ) : null}

      {tab === 'cash' ? (
        canFinance ? (
          <AsyncState loading={flow.loading} error={flow.error} data={flow.data} onRetry={flow.reload}>
            {(data) =>
              data === null ? null : (
                <Card title={t('rep.cashFlow')} subtitle={`${data.from} → ${data.to}`}>
                  <Totals>
                    <TotalRow label={t('rep.opening')} value={<MoneyText value={data.opening} currency={currency} />} />
                    <TotalRow label={t('rep.inflows')} value={<MoneyText value={data.inflows} currency={currency} />} />
                    <TotalRow label={t('rep.outflows')} value={<MoneyText value={data.outflows} currency={currency} />} />
                    <TotalRow label={t('rep.netChange')} value={<MoneyText value={data.netChange} currency={currency} signed />} />
                    <TotalRow label={t('rep.closing')} value={<MoneyText value={data.closing} currency={currency} />} strong />
                  </Totals>
                </Card>
              )
            }
          </AsyncState>
        ) : (
          <Restricted permission="finance.view" />
        )
      ) : null}

      {tab === 'receivables' ? (
        canReport ? (
          <Card title={t('rep.receivables')}>
            <AsyncState loading={receivables.loading} error={receivables.error} data={receivables.data} onRetry={receivables.reload}>
              {(rows) =>
                rows === null ? null : <DataTable columns={outstandingColumns(t('rep.customer'))} rows={rows} getKey={(row) => row.customerId} permissions={permissions} />
              }
            </AsyncState>
          </Card>
        ) : (
          <Restricted permission="report.view" />
        )
      ) : null}

      {tab === 'payables' ? (
        canReport ? (
          <Card title={t('rep.payables')}>
            <AsyncState loading={payables.loading} error={payables.error} data={payables.data} onRetry={payables.reload}>
              {(rows) => (rows === null ? null : <DataTable columns={outstandingColumns(t('rep.supplier'))} rows={rows} getKey={(row) => row.supplierId} permissions={permissions} />)}
            </AsyncState>
          </Card>
        ) : (
          <Restricted permission="report.view" />
        )
      ) : null}
    </>
  );
}

function SheetSection({
  title,
  rows,
  total,
  currency,
  permissions,
}: {
  readonly title: string;
  readonly rows: readonly AccountAmount[];
  readonly total: string;
  readonly currency: string;
  readonly permissions: readonly string[];
}) {
  const { t } = useT();
  return (
    <div className="sheetsec">
      <h3 className="sheet__title">{title}</h3>
      <DataTable
        columns={[
          { id: 'account', header: t('rep.account'), cell: (row: AccountAmount) => <span className="mono">{row.account}</span> },
          { id: 'name', header: t('common.name'), cell: (row: AccountAmount) => row.name },
          { id: 'amount', header: t('common.amount'), align: 'right', cell: (row: AccountAmount) => <MoneyText value={row.amount} currency={currency} accountingNegative /> },
        ]}
        rows={[...rows]}
        getKey={(row) => row.account}
        permissions={permissions}
      />
      <Totals>
        <TotalRow label={`${title} · ${t('common.total')}`} value={<MoneyText value={total} currency={currency} accountingNegative />} strong />
      </Totals>
    </div>
  );
}
