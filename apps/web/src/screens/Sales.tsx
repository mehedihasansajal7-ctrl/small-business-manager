import { useMemo } from 'react';
import { catalog } from '../api/endpoints';
import { sales as salesApi } from '../api/endpointsFinance';
import { canViewCost, hasPermission } from '../api/permissions';
import { cachedList } from '../offline/cachedList';
import { AsyncState, Restricted } from '../components/States';
import { DataTable, type Column } from '../components/DataTable';
import { DateText, MoneyText, QtyText } from '../components/MoneyText';
import { Badge, Card, PageHeader } from '../components/ui';
import { useApp, useT } from '../state/AppContext';
import { useResource, useSyncState } from '../offline/useSync';
import { SaleEditor } from './SaleEditor';
import type { CustomerRow, LocationRow, ProductRow, SaleRow } from '../api/types';

/** Sales page: POS editor (when permitted) + the posted sales list. */
export function SalesScreen() {
  const { business, permissions } = useApp();
  const { t } = useT();
  const { snapshot, syncNow } = useSyncState();
  const currency = business?.currency ?? 'BDT';
  const canCreate = hasPermission(permissions, 'sale.create') && hasPermission(permissions, 'sale.view');

  const products = useResource(() => cachedList<ProductRow>('products', () => catalog.products()), []);
  const customers = useResource(() => cachedList<CustomerRow>('customers', () => catalog.customers()), []);
  const locations = useResource(() => cachedList<LocationRow>('locations', () => catalog.locations(), { key: 'id' }), []);
  const sales = useResource(() => cachedList<SaleRow>('sales', () => salesApi.list()), [snapshot.lastSyncedAt]);

  const columns: Column<SaleRow>[] = useMemo(
    () => [
      { id: 'reference', header: t('common.reference'), cell: (row) => <span className="mono">{row.reference}</span> },
      { id: 'date', header: t('common.date'), cell: (row) => <DateText value={row.documentDate} /> },
      { id: 'customer', header: t('sales.customer'), cell: (row) => customers.data?.find((c) => c.id === row.customerId)?.name ?? t('sales.walkIn') },
      { id: 'net', header: t('sales.net'), align: 'right', cell: (row) => <MoneyText value={row.net} currency={row.currency || currency} /> },
      { id: 'received', header: t('sales.cashReceived'), align: 'right', cell: (row) => <MoneyText value={row.cashReceived} currency={row.currency || currency} /> },
      { id: 'receivable', header: t('sales.receivable'), align: 'right', cell: (row) => <MoneyText value={row.receivable} currency={row.currency || currency} /> },
      { id: 'cogs', header: t('sales.cogs'), align: 'right', permission: 'purchase.cost.view', cell: (row) => <MoneyText value={row.cogs} currency={row.currency || currency} /> },
      { id: 'lines', header: t('sales.line'), cell: (row) => <QtyText value={row.lines?.length ?? 0} /> },
    ],
    [t, currency, customers.data],
  );

  const visibleSales = (sales.data ?? []).slice(0, 100);

  return (
    <>
      <PageHeader
        title={t('nav.sales')}
        subtitle={`${business?.name ?? ''} · ${canViewCost(permissions) ? t('sales.cogs') : ''}`}
        actions={
          <button type="button" className="link" onClick={() => void syncNow()} disabled={snapshot.flushing}>
            {t('sync.now')}
          </button>
        }
      />

      {canCreate ? (
        <AsyncState
          loading={products.loading || customers.loading || locations.loading}
          error={products.error ?? customers.error ?? locations.error}
          data={products.data ? { products: products.data, customers: customers.data ?? [], locations: locations.data ?? [] } : null}
          onRetry={() => {
            products.reload();
            customers.reload();
            locations.reload();
          }}
          empty={() => (products.data ?? []).length === 0}
        >
          {({ products: productRows, customers: customerRows, locations: locationRows }) => (
            <SaleEditor
              products={productRows}
              customers={customerRows}
              locations={locationRows}
              currency={currency}
              onPosted={() => {
                sales.reload();
                products.reload();
              }}
            />
          )}
        </AsyncState>
      ) : (
        <Restricted permission="sale.create" />
      )}

      <Card title={t('sales.list')} subtitle={`${visibleSales.length}`}>
        <AsyncState loading={sales.loading} error={sales.error} data={sales.data} onRetry={sales.reload}>
          {(rows) => (
            <DataTable
              columns={columns}
              rows={rows.slice(0, 100)}
              getKey={(row) => row.id}
              permissions={permissions}
              caption={t('sales.list')}
            />
          )}
        </AsyncState>
        {visibleSales.some((row) => (row as { __pending?: boolean }).__pending) ? <Badge tone="warn">{t('sync.localProposal')}</Badge> : null}
      </Card>
    </>
  );
}
