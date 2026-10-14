import { useMemo, useState } from 'react';
import { catalog } from '../api/endpoints';
import { hasPermission } from '../api/permissions';
import { cachedList } from '../offline/cachedList';
import { AsyncState, Restricted } from '../components/States';
import { DataTable, type Column } from '../components/DataTable';
import { MoneyText, QtyText } from '../components/MoneyText';
import { Badge, Card, PageHeader, Tabs } from '../components/ui';
import { VoucherForm, type VoucherSpec } from '../components/VoucherForm';
import { useApp, useT } from '../state/AppContext';
import { useResource, useSyncState } from '../offline/useSync';
import type { CustomerRow, LocationRow, ProductRow, SupplierRow, UnitRow } from '../api/types';

/**
 * Catalog: products & services, customers, suppliers and stock locations.
 *
 * Master data can be created offline (it is queued as `product.upsert`,
 * `customer.upsert` or `supplier.upsert`). Stock locations are online-only
 * because the sync API has no location event — the form says so instead of
 * silently losing the record.
 */

const PRODUCT_SPEC: VoucherSpec = {
  id: 'product',
  titleKey: 'cat.products',
  submitLabelKey: 'common.create',
  fields: [
    { name: 'name', labelKey: 'common.name', kind: 'text', required: true },
    { name: 'nameBn', labelKey: 'cat.nameBn', kind: 'text' },
    { name: 'sku', labelKey: 'cat.sku', kind: 'text' },
    { name: 'kind', labelKey: 'cat.kind', kind: 'select', required: true, defaultValue: 'PRODUCT', optionKey: 'kinds' },
    { name: 'unit', labelKey: 'common.unit', kind: 'select', required: true, optionKey: 'units' },
    { name: 'salePrice', labelKey: 'cat.salePrice', kind: 'money' },
    { name: 'purchasePrice', labelKey: 'cat.purchasePrice', kind: 'money', hintKey: 'inv.hideCost' },
    { name: 'reorderLevel', labelKey: 'inv.reorderLevel', kind: 'money' },
    { name: 'trackLots', labelKey: 'cat.trackLots', kind: 'checkbox' },
  ],
  submit: async (values) => catalog.createProduct(toProductBody(values)),
  offline: {
    eventType: 'product.upsert',
    store: 'products',
    toPayload: (values) => toProductBody(values),
    toRecord: (values, localId) => ({
      id: localId,
      name: text(values.name),
      nameBn: text(values.nameBn) || null,
      sku: text(values.sku) || null,
      kind: text(values.kind) || 'PRODUCT',
      unit: text(values.unit) || 'pcs',
      salePrice: text(values.salePrice) || null,
      purchasePrice: text(values.purchasePrice) || null,
      reorderLevel: text(values.reorderLevel) || null,
      trackLots: values.trackLots === true,
      isActive: true,
      revision: 1,
      onHand: '0',
      onHandUnit: text(values.unit) || 'pcs',
    }),
  },
};

const CUSTOMER_SPEC: VoucherSpec = {
  id: 'customer',
  titleKey: 'cat.customers',
  submitLabelKey: 'common.create',
  fields: [
    { name: 'name', labelKey: 'common.name', kind: 'text', required: true },
    { name: 'phone', labelKey: 'common.phone', kind: 'text' },
    { name: 'email', labelKey: 'common.email', kind: 'text' },
    { name: 'address', labelKey: 'common.address', kind: 'textarea' },
    { name: 'openingBalance', labelKey: 'cat.openingBalance', kind: 'money', hintKey: 'rep.receivables' },
  ],
  submit: async (values) =>
    catalog.createCustomer({
      name: text(values.name),
      ...(text(values.phone) ? { phone: text(values.phone) } : {}),
      ...(text(values.email) ? { email: text(values.email) } : {}),
      ...(text(values.address) ? { address: text(values.address) } : {}),
      ...(text(values.openingBalance) ? { openingBalance: text(values.openingBalance) } : {}),
    }),
  offline: {
    eventType: 'customer.upsert',
    store: 'customers',
    toPayload: (values) => ({
      name: text(values.name),
      ...(text(values.phone) ? { phone: text(values.phone) } : {}),
      ...(text(values.address) ? { address: text(values.address) } : {}),
    }),
    toRecord: (values, localId) => ({ id: localId, name: text(values.name), phone: text(values.phone) || null, email: text(values.email) || null, receivable: text(values.openingBalance) || '0' }),
  },
};

const SUPPLIER_SPEC: VoucherSpec = {
  id: 'supplier',
  titleKey: 'cat.suppliers',
  submitLabelKey: 'common.create',
  fields: [
    { name: 'name', labelKey: 'common.name', kind: 'text', required: true },
    { name: 'phone', labelKey: 'common.phone', kind: 'text' },
    { name: 'email', labelKey: 'common.email', kind: 'text' },
    { name: 'address', labelKey: 'common.address', kind: 'textarea' },
    { name: 'openingBalance', labelKey: 'cat.openingBalance', kind: 'money', hintKey: 'rep.payables' },
  ],
  submit: async (values) =>
    catalog.createSupplier({
      name: text(values.name),
      ...(text(values.phone) ? { phone: text(values.phone) } : {}),
      ...(text(values.email) ? { email: text(values.email) } : {}),
      ...(text(values.address) ? { address: text(values.address) } : {}),
      ...(text(values.openingBalance) ? { openingBalance: text(values.openingBalance) } : {}),
    }),
  offline: {
    eventType: 'supplier.upsert',
    store: 'suppliers',
    toPayload: (values) => ({
      name: text(values.name),
      ...(text(values.phone) ? { phone: text(values.phone) } : {}),
    }),
    toRecord: (values, localId) => ({ id: localId, name: text(values.name), phone: text(values.phone) || null, payable: text(values.openingBalance) || '0' }),
  },
};

/** Stock locations have no sync event type, so this spec is online-only. */
const LOCATION_SPEC: VoucherSpec = {
  id: 'location',
  titleKey: 'cat.locations',
  submitLabelKey: 'common.create',
  fields: [
    { name: 'name', labelKey: 'common.name', kind: 'text', required: true },
    { name: 'kind', labelKey: 'cat.locationKind', kind: 'select', defaultValue: 'STORE', optionKey: 'locationKinds' },
    { name: 'address', labelKey: 'common.address', kind: 'textarea' },
  ],
  submit: async (values) =>
    catalog.createLocation({
      name: text(values.name),
      ...(text(values.kind) ? { kind: text(values.kind) } : {}),
      ...(text(values.address) ? { address: text(values.address) } : {}),
    }),
};

function text(value: string | boolean | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

function toProductBody(values: Record<string, string | boolean>): Record<string, unknown> {
  return {
    name: text(values.name),
    ...(text(values.nameBn) ? { nameBn: text(values.nameBn) } : {}),
    ...(text(values.sku) ? { sku: text(values.sku) } : {}),
    kind: text(values.kind) || 'PRODUCT',
    unit: text(values.unit),
    ...(text(values.salePrice) ? { salePrice: text(values.salePrice) } : {}),
    ...(text(values.purchasePrice) ? { purchasePrice: text(values.purchasePrice) } : {}),
    ...(text(values.reorderLevel) ? { reorderLevel: text(values.reorderLevel) } : {}),
    trackLots: values.trackLots === true,
  };
}

export function CatalogScreen() {
  const { business, permissions } = useApp();
  const { t } = useT();
  const { snapshot } = useSyncState();
  const currency = business?.currency ?? 'BDT';
  const [tab, setTab] = useState('products');

  const products = useResource(() => cachedList<ProductRow>('products', () => catalog.products()), [snapshot.lastSyncedAt]);
  const customers = useResource(() => cachedList<CustomerRow>('customers', () => catalog.customers()), [snapshot.lastSyncedAt]);
  const suppliers = useResource(() => cachedList<SupplierRow>('suppliers', () => catalog.suppliers()), [snapshot.lastSyncedAt]);
  const locations = useResource(() => catalog.locations(), [snapshot.lastSyncedAt]);
  const units = useResource(() => catalog.units(), []);

  const options = useMemo(
    () => ({
      units: (units.data ?? []).map((row: UnitRow) => ({ value: row.code, label: `${row.code} — ${row.dimension}` })),
      kinds: [
        { value: 'PRODUCT', label: 'PRODUCT' },
        { value: 'SERVICE', label: 'SERVICE' },
        { value: 'INPUT', label: 'INPUT' },
        { value: 'OUTPUT', label: 'OUTPUT' },
        { value: 'LIVESTOCK', label: 'LIVESTOCK' },
      ],
      locationKinds: ['STORE', 'WAREHOUSE', 'SHOP', 'FARM', 'OTHER'].map((kind) => ({ value: kind, label: kind })),
    }),
    [units.data],
  );

  const tabs = [
    { id: 'products', label: t('cat.products') },
    { id: 'customers', label: t('cat.customers') },
    { id: 'suppliers', label: t('cat.suppliers') },
    { id: 'locations', label: t('cat.locations') },
  ];

  const productColumns: Column<ProductRow>[] = [
    {
      id: 'name',
      header: t('common.name'),
      cell: (row) => (
        <span>
          {row.name} {(row as { __pending?: boolean }).__pending ? <Badge tone="warn">{t('sync.localProposal')}</Badge> : null}
        </span>
      ),
    },
    { id: 'kind', header: t('cat.kind'), cell: (row) => <Badge tone="muted">{row.kind}</Badge> },
    { id: 'unit', header: t('common.unit'), cell: (row) => row.unit },
    { id: 'salePrice', header: t('cat.salePrice'), align: 'right', cell: (row) => <MoneyText value={row.salePrice} currency={currency} /> },
    { id: 'purchasePrice', header: t('cat.purchasePrice'), align: 'right', permission: 'purchase.cost.view', cell: (row) => <MoneyText value={row.purchasePrice} currency={currency} /> },
    { id: 'onHand', header: t('inv.onHand'), align: 'right', cell: (row) => <QtyText value={row.onHand} unit={row.unit} /> },
    { id: 'reorder', header: t('inv.reorderLevel'), align: 'right', cell: (row) => <QtyText value={row.reorderLevel} /> },
  ];

  return (
    <>
      <PageHeader title={t('nav.catalog')} subtitle={business?.name} />
      <Tabs tabs={tabs} active={tab} onChange={setTab} />

      {tab === 'products' ? (
        <>
          {hasPermission(permissions, 'product.manage') ? (
            <VoucherForm spec={PRODUCT_SPEC} options={options} onPosted={products.reload} />
          ) : (
            <Restricted permission="product.manage" />
          )}
          <Card title={t('cat.products')}>
            <AsyncState loading={products.loading} error={products.error} data={products.data} onRetry={products.reload}>
              {(rows) => <DataTable columns={productColumns} rows={rows.slice(0, 200)} getKey={(row) => row.id} permissions={permissions} />}
            </AsyncState>
          </Card>
        </>
      ) : null}

      {tab === 'customers' ? (
        <>
          {hasPermission(permissions, 'customer.manage') ? (
            <VoucherForm spec={CUSTOMER_SPEC} options={options} onPosted={customers.reload} />
          ) : (
            <Restricted permission="customer.manage" />
          )}
          <Card title={t('cat.customers')}>
            <AsyncState loading={customers.loading} error={customers.error} data={customers.data} onRetry={customers.reload}>
              {(rows) => (
                <DataTable
                  columns={[
                    { id: 'name', header: t('common.name'), cell: (row: CustomerRow) => row.name },
                    { id: 'phone', header: t('common.phone'), cell: (row: CustomerRow) => row.phone ?? '—' },
                    { id: 'email', header: t('common.email'), cell: (row: CustomerRow) => row.email ?? '—' },
                    { id: 'receivable', header: t('cat.receivable'), align: 'right', cell: (row: CustomerRow) => <MoneyText value={row.receivable} currency={currency} /> },
                  ]}
                  rows={rows.slice(0, 200)}
                  getKey={(row) => row.id}
                  permissions={permissions}
                />
              )}
            </AsyncState>
          </Card>
        </>
      ) : null}

      {tab === 'suppliers' ? (
        <>
          {hasPermission(permissions, 'supplier.manage') ? (
            <VoucherForm spec={SUPPLIER_SPEC} options={options} onPosted={suppliers.reload} />
          ) : (
            <Restricted permission="supplier.manage" />
          )}
          <Card title={t('cat.suppliers')}>
            <AsyncState loading={suppliers.loading} error={suppliers.error} data={suppliers.data} onRetry={suppliers.reload}>
              {(rows) => (
                <DataTable
                  columns={[
                    { id: 'name', header: t('common.name'), cell: (row: SupplierRow) => row.name },
                    { id: 'phone', header: t('common.phone'), cell: (row: SupplierRow) => row.phone ?? '—' },
                    { id: 'payable', header: t('cat.payable'), align: 'right', cell: (row: SupplierRow) => <MoneyText value={row.payable} currency={currency} /> },
                  ]}
                  rows={rows.slice(0, 200)}
                  getKey={(row) => row.id}
                  permissions={permissions}
                />
              )}
            </AsyncState>
          </Card>
        </>
      ) : null}

      {tab === 'locations' ? (
        <>
          {hasPermission(permissions, 'location.manage') ? (
            <VoucherForm spec={LOCATION_SPEC} options={options} onPosted={locations.reload} />
          ) : (
            <Restricted permission="location.manage" />
          )}
          <Card title={t('cat.locations')}>
            <AsyncState loading={locations.loading} error={locations.error} data={locations.data} onRetry={locations.reload}>
              {(rows) => (
                <DataTable
                  columns={[
                    { id: 'name', header: t('common.name'), cell: (row: LocationRow) => row.name },
                    { id: 'kind', header: t('cat.locationKind'), cell: (row: LocationRow) => row.kind },
                    { id: 'address', header: t('common.address'), cell: (row: LocationRow) => row.address ?? '—' },
                    { id: 'default', header: t('cat.isDefault'), cell: (row: LocationRow) => (row.isDefault ? <Badge tone="ok">✓</Badge> : '—') },
                  ]}
                  rows={rows}
                  getKey={(row) => row.id}
                  permissions={permissions}
                />
              )}
            </AsyncState>
          </Card>
        </>
      ) : null}
    </>
  );
}
