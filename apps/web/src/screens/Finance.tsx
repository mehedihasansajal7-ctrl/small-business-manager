import { useMemo, useState } from 'react';
import { accountsByType, CASH_ACCOUNTS, finance, reports } from '../api/endpointsFinance';
import { catalog, members as membersApi } from '../api/endpoints';
import { canViewPartnerCapital, hasPermission } from '../api/permissions';
import { cachedList } from '../offline/cachedList';
import { AsyncState, Restricted } from '../components/States';
import { MoneyText } from '../components/MoneyText';
import { DataTable, type Column } from '../components/DataTable';
import { Card, Notice, PageHeader, Tabs } from '../components/ui';
import { VoucherForm, type VoucherSpec, type VoucherValues } from '../components/VoucherForm';
import { useApp, useT } from '../state/AppContext';
import { useResource, useSyncState } from '../offline/useSync';
import type { AccountRow, CustomerRow, MemberRow, PayableRow, ReceivableRow, SupplierRow } from '../api/types';

/** Voucher specs are static: only the option lists come from the screen. */
const SPECS: readonly VoucherSpec[] = [
  {
    id: 'receipt',
    titleKey: 'fin.receipt',
    submitLabelKey: 'common.save',
    fields: [
      { name: 'documentDate', labelKey: 'common.date', kind: 'date', required: true },
      { name: 'customerId', labelKey: 'sales.customer', kind: 'select', optionKey: 'customers' },
      { name: 'amount', labelKey: 'common.amount', kind: 'money', required: true },
      { name: 'accountCode', labelKey: 'fin.account', kind: 'select', optionKey: 'cash', defaultValue: '1000' },
      { name: 'reference', labelKey: 'common.reference', kind: 'text' },
      { name: 'note', labelKey: 'common.note', kind: 'textarea' },
    ],
    submit: (values) =>
      finance.receipt({
        documentDate: str(values.documentDate),
        amount: str(values.amount),
        ...(str(values.customerId) ? { customerId: str(values.customerId) } : {}),
        ...(str(values.accountCode) ? { accountCode: str(values.accountCode) } : {}),
        ...(str(values.reference) ? { reference: str(values.reference) } : {}),
        ...(str(values.note) ? { note: str(values.note) } : {}),
      }),
    offline: {
      eventType: 'receipt.post',
      store: 'sales',
      toPayload: (values) => ({
        documentDate: str(values.documentDate),
        amount: str(values.amount),
        ...(str(values.customerId) ? { customerId: str(values.customerId) } : {}),
        ...(str(values.accountCode) ? { accountCode: str(values.accountCode) } : {}),
      }),
      toRecord: (values, localId) => ({
        id: localId,
        reference: str(values.reference) || `${localId.slice(0, 10)}…`,
        customerId: str(values.customerId) || null,
        documentDate: str(values.documentDate),
        currency: '',
        gross: '0',
        discount: '0',
        net: '0',
        cashReceived: str(values.amount),
        receivable: '0',
        lines: [],
      }),
    },
  },
  {
    id: 'payment',
    titleKey: 'fin.payment',
    fields: [
      { name: 'documentDate', labelKey: 'common.date', kind: 'date', required: true },
      { name: 'supplierId', labelKey: 'purchases.supplier', kind: 'select', optionKey: 'suppliers' },
      { name: 'amount', labelKey: 'common.amount', kind: 'money', required: true },
      { name: 'accountCode', labelKey: 'fin.account', kind: 'select', optionKey: 'cash', defaultValue: '1000' },
      { name: 'reference', labelKey: 'common.reference', kind: 'text' },
      { name: 'note', labelKey: 'common.note', kind: 'textarea' },
    ],
    submit: (values) =>
      finance.payment({
        documentDate: str(values.documentDate),
        amount: str(values.amount),
        ...(str(values.supplierId) ? { supplierId: str(values.supplierId) } : {}),
        ...(str(values.accountCode) ? { accountCode: str(values.accountCode) } : {}),
        ...(str(values.reference) ? { reference: str(values.reference) } : {}),
        ...(str(values.note) ? { note: str(values.note) } : {}),
      }),
    offline: {
      eventType: 'payment.post',
      store: 'purchases',
      toPayload: (values) => ({
        documentDate: str(values.documentDate),
        amount: str(values.amount),
        ...(str(values.supplierId) ? { supplierId: str(values.supplierId) } : {}),
        ...(str(values.accountCode) ? { accountCode: str(values.accountCode) } : {}),
      }),
      toRecord: (values, localId) => ({
        id: localId,
        reference: str(values.reference) || `${localId.slice(0, 10)}…`,
        supplierId: str(values.supplierId) || null,
        documentDate: str(values.documentDate),
        currency: '',
        subtotal: undefined,
        tax: undefined,
        total: str(values.amount),
        paid: str(values.amount),
        payable: '0',
        lines: [],
      }),
    },
  },
  {
    id: 'transfer',
    titleKey: 'fin.transfer',
    fields: [
      { name: 'documentDate', labelKey: 'common.date', kind: 'date', required: true },
      { name: 'fromAccount', labelKey: 'fin.fromAccount', kind: 'select', optionKey: 'cash', required: true, defaultValue: '1000' },
      { name: 'toAccount', labelKey: 'fin.toAccount', kind: 'select', optionKey: 'cash', required: true, defaultValue: '1010' },
      { name: 'amount', labelKey: 'common.amount', kind: 'money', required: true },
      { name: 'note', labelKey: 'common.note', kind: 'textarea' },
    ],
    submit: (values) =>
      finance.transfer({
        documentDate: str(values.documentDate),
        fromAccount: str(values.fromAccount),
        toAccount: str(values.toAccount),
        amount: str(values.amount),
        ...(str(values.note) ? { note: str(values.note) } : {}),
      }),
    offline: {
      eventType: 'transfer.post',
      store: 'journalEntries',
      toPayload: (values) => ({
        documentDate: str(values.documentDate),
        fromAccount: str(values.fromAccount),
        toAccount: str(values.toAccount),
        amount: str(values.amount),
      }),
      toRecord: (values, localId) => ({ id: localId, reference: localId.slice(0, 10), documentDate: str(values.documentDate), amount: str(values.amount), lines: [] }),
    },
  },
  {
    id: 'income',
    titleKey: 'fin.income',
    fields: [
      { name: 'documentDate', labelKey: 'common.date', kind: 'date', required: true },
      { name: 'categoryAccount', labelKey: 'fin.category', kind: 'select', optionKey: 'income', required: true },
      { name: 'amount', labelKey: 'common.amount', kind: 'money', required: true },
      { name: 'accountCode', labelKey: 'fin.account', kind: 'select', optionKey: 'cash', defaultValue: '1000' },
      { name: 'paid', labelKey: 'fin.paidNow', kind: 'checkbox', defaultChecked: true },
      { name: 'note', labelKey: 'common.note', kind: 'textarea' },
    ],
    submit: (values) =>
      finance.incomeExpense({
        kind: 'INCOME',
        documentDate: str(values.documentDate),
        categoryAccount: str(values.categoryAccount),
        amount: str(values.amount),
        paid: values.paid !== false,
        ...(str(values.accountCode) ? { accountCode: str(values.accountCode) } : {}),
        ...(str(values.note) ? { note: str(values.note) } : {}),
      }),
    offline: {
      eventType: 'income.post',
      store: 'journalEntries',
      toPayload: (values) => ({
        documentDate: str(values.documentDate),
        categoryAccount: str(values.categoryAccount),
        amount: str(values.amount),
        paid: values.paid !== false,
        ...(str(values.accountCode) ? { accountCode: str(values.accountCode) } : {}),
      }),
      toRecord: (values, localId) => ({ id: localId, reference: localId.slice(0, 10), documentDate: str(values.documentDate), amount: str(values.amount), lines: [] }),
    },
  },
  {
    id: 'expense',
    titleKey: 'fin.expense',
    fields: [
      { name: 'documentDate', labelKey: 'common.date', kind: 'date', required: true },
      { name: 'categoryAccount', labelKey: 'fin.category', kind: 'select', optionKey: 'expense', required: true },
      { name: 'amount', labelKey: 'common.amount', kind: 'money', required: true },
      { name: 'accountCode', labelKey: 'fin.account', kind: 'select', optionKey: 'cash', defaultValue: '1000' },
      { name: 'paid', labelKey: 'fin.paidNow', kind: 'checkbox', defaultChecked: true },
      { name: 'note', labelKey: 'common.note', kind: 'textarea' },
    ],
    submit: (values) =>
      finance.incomeExpense({
        kind: 'EXPENSE',
        documentDate: str(values.documentDate),
        categoryAccount: str(values.categoryAccount),
        amount: str(values.amount),
        paid: values.paid !== false,
        ...(str(values.accountCode) ? { accountCode: str(values.accountCode) } : {}),
        ...(str(values.note) ? { note: str(values.note) } : {}),
      }),
    offline: {
      eventType: 'expense.post',
      store: 'journalEntries',
      toPayload: (values) => ({
        documentDate: str(values.documentDate),
        categoryAccount: str(values.categoryAccount),
        amount: str(values.amount),
        paid: values.paid !== false,
        ...(str(values.accountCode) ? { accountCode: str(values.accountCode) } : {}),
      }),
      toRecord: (values, localId) => ({ id: localId, reference: localId.slice(0, 10), documentDate: str(values.documentDate), amount: str(values.amount), lines: [] }),
    },
  },
];

function str(value: string | boolean | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

const CAPITAL_SPEC: VoucherSpec = {
  id: 'capital',
  titleKey: 'fin.capital',
  fields: [
    { name: 'memberId', labelKey: 'fin.partner', kind: 'select', optionKey: 'members', required: true },
    { name: 'kind', labelKey: 'fin.kind', kind: 'select', required: true, defaultValue: 'CONTRIBUTION', optionKey: 'capitalKind' },
    { name: 'documentDate', labelKey: 'common.date', kind: 'date', required: true },
    { name: 'amount', labelKey: 'common.amount', kind: 'money', required: true },
    { name: 'accountCode', labelKey: 'fin.account', kind: 'select', optionKey: 'cash', defaultValue: '1000' },
    { name: 'note', labelKey: 'common.note', kind: 'textarea' },
  ],
  submit: (values) =>
    finance.partnerCapital({
      memberId: str(values.memberId),
      kind: str(values.kind) === 'WITHDRAWAL' ? 'WITHDRAWAL' : 'CONTRIBUTION',
      documentDate: str(values.documentDate),
      amount: str(values.amount),
      ...(str(values.accountCode) ? { accountCode: str(values.accountCode) } : {}),
      ...(str(values.note) ? { note: str(values.note) } : {}),
    }),
  offline: {
    eventType: 'capital.contribution',
    store: 'journalEntries',
    toPayload: (values) => ({
      memberId: str(values.memberId),
      documentDate: str(values.documentDate),
      amount: str(values.amount),
      ...(str(values.accountCode) ? { accountCode: str(values.accountCode) } : {}),
    }),
    toRecord: (values, localId) => ({ id: localId, reference: localId.slice(0, 10), documentDate: str(values.documentDate), amount: str(values.amount), lines: [] }),
  },
};

/** Finance: receipts, payments, transfers, income/expense, partner capital. */
export function FinanceScreen() {
  const { business, permissions } = useApp();
  const { t, locale } = useT();
  const { snapshot } = useSyncState();
  const currency = business?.currency ?? 'BDT';
  const [tab, setTab] = useState('receipt');

  const customers = useResource(() => cachedList<CustomerRow>('customers', () => catalog.customers()), []);
  const suppliers = useResource(() => cachedList<SupplierRow>('suppliers', () => catalog.suppliers()), []);
  const members = useResource(() => membersApi.list(), []);
  const accounts = useResource(() => finance.accounts(), [snapshot.lastSyncedAt]);
  const receivables = useResource(() => reports.receivables(), [snapshot.lastSyncedAt]);
  const payables = useResource(() => reports.payables(), [snapshot.lastSyncedAt]);

  const options = useMemo(
    () => ({
      customers: (customers.data ?? []).map((row) => ({ value: row.id, label: `${row.name}${row.phone ? ` · ${row.phone}` : ''}` })),
      suppliers: (suppliers.data ?? []).map((row) => ({ value: row.id, label: `${row.name}${row.phone ? ` · ${row.phone}` : ''}` })),
      members: (members.data ?? []).map((row: MemberRow) => ({ value: row.id, label: `${row.displayName} (${row.role})` })),
      cash: CASH_ACCOUNTS.map((row) => ({ value: row.code, label: locale === 'en' ? row.name : row.nameBn ?? row.name })),
      income: accountsByType('REVENUE').map((row) => ({ value: row.code, label: `${row.code} · ${locale === 'en' ? row.name : row.nameBn}` })),
      expense: accountsByType('EXPENSE').map((row) => ({ value: row.code, label: `${row.code} · ${locale === 'en' ? row.name : row.nameBn}` })),
      capitalKind: [
        { value: 'CONTRIBUTION', label: t('fin.contribution') },
        { value: 'WITHDRAWAL', label: t('fin.withdrawal') },
      ],
    }),
    [customers.data, suppliers.data, members.data, locale, t],
  );

  const tabs = [
    { id: 'receipt', label: t('fin.receipt') },
    { id: 'payment', label: t('fin.payment') },
    { id: 'transfer', label: t('fin.transfer') },
    { id: 'income', label: t('fin.income') },
    { id: 'expense', label: t('fin.expense') },
    { id: 'receivables', label: t('rep.receivables') },
    { id: 'payables', label: t('rep.payables') },
    { id: 'capital', label: t('fin.capital') },
  ];

  const activeSpec = SPECS.find((spec) => spec.id === tab);

  return (
    <>
      <PageHeader title={t('nav.finance')} subtitle={business?.name} />
      <Tabs tabs={tabs} active={tab} onChange={setTab} />

      {activeSpec ? <VoucherForm spec={activeSpec} options={options} /> : null}

      {tab === 'receivables' ? (
        <Card title={t('rep.receivables')}>
          {hasPermission(permissions, 'report.view') ? (
            <AsyncState loading={receivables.loading} error={receivables.error} data={receivables.data} onRetry={receivables.reload}>
              {(rows) => (
                <DataTable
                  columns={[
                    { id: 'name', header: t('rep.customer'), cell: (row: ReceivableRow) => row.name },
                    { id: 'phone', header: t('common.phone'), cell: (row: ReceivableRow) => row.phone ?? '—' },
                    { id: 'outstanding', header: t('rep.outstanding'), align: 'right', cell: (row: ReceivableRow) => <MoneyText value={row.outstanding} currency={currency} /> },
                  ]}
                  rows={rows}
                  getKey={(row) => row.customerId}
                  permissions={permissions}
                />
              )}
            </AsyncState>
          ) : (
            <Restricted permission="report.view" />
          )}
        </Card>
      ) : null}

      {tab === 'payables' ? (
        <Card title={t('rep.payables')}>
          {hasPermission(permissions, 'report.view') ? (
            <AsyncState loading={payables.loading} error={payables.error} data={payables.data} onRetry={payables.reload}>
              {(rows) => (
                <DataTable
                  columns={[
                    { id: 'name', header: t('rep.supplier'), cell: (row: PayableRow) => row.name },
                    { id: 'phone', header: t('common.phone'), cell: (row: PayableRow) => row.phone ?? '—' },
                    { id: 'outstanding', header: t('rep.outstanding'), align: 'right', cell: (row: PayableRow) => <MoneyText value={row.outstanding} currency={currency} /> },
                  ]}
                  rows={rows}
                  getKey={(row) => row.supplierId}
                  permissions={permissions}
                />
              )}
            </AsyncState>
          ) : (
            <Restricted permission="report.view" />
          )}
        </Card>
      ) : null}

      {tab === 'capital' ? (
        canViewPartnerCapital(permissions) ? (
          <VoucherForm spec={CAPITAL_SPEC} options={options} onPosted={() => accounts.reload()} />
        ) : (
          <Restricted permission="partner_capital.view" />
        )
      ) : null}

      {tab !== 'capital' ? (
        <Card title={t('fin.category')} subtitle={`${t('common.total')}: ${accounts.data?.length ?? 0}`}>
          <AsyncState loading={accounts.loading} error={accounts.error} data={accounts.data} onRetry={accounts.reload}>
            {(rows) => (
              <DataTable
                columns={[
                  { id: 'code', header: t('rep.account'), cell: (row: AccountRow) => <span className="mono">{row.code}</span> },
                  { id: 'name', header: t('common.name'), cell: (row: AccountRow) => (locale === 'en' ? row.name : row.nameBn) },
                  { id: 'type', header: t('fin.kind'), cell: (row: AccountRow) => row.type },
                  { id: 'balance', header: t('common.total'), align: 'right', cell: (row: AccountRow) => <MoneyText value={row.balance} currency={currency} accountingNegative /> },
                ]}
                rows={rows.filter((row) => row.isCash || row.type === 'REVENUE' || row.type === 'EXPENSE' || row.type === 'LIABILITY' || row.type === 'EQUITY')}
                getKey={(row) => row.code}
                permissions={permissions}
              />
            )}
          </AsyncState>
        </Card>
      ) : null}

    </>
  );
}
