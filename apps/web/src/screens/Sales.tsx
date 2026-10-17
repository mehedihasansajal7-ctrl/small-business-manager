import { useMemo, useState } from 'react';
import { catalog } from '../api/endpoints';
import { sales as salesApi } from '../api/endpointsFinance';
import { canViewCost, hasPermission } from '../api/permissions';
import { cachedList } from '../offline/cachedList';
import { AsyncState, Restricted } from '../components/States';
import { DataTable, type Column } from '../components/DataTable';
import { DateText, MoneyText, QtyText } from '../components/MoneyText';
import { Badge, Button, Card, Modal, PageHeader, TextAreaInput, TextInput } from '../components/ui';
import { useApp, useT } from '../state/AppContext';
import { useResource, useSyncState } from '../offline/useSync';
import { SaleEditor } from './SaleEditor';
import type { CustomerRow, LocationRow, ProductRow, SaleRow } from '../api/types';

/** Sales page: POS editor (when permitted) + the posted sales list. */
export function SalesScreen() {
  const { business, permissions, notify } = useApp();
  const { t } = useT();
  const { snapshot, syncNow } = useSyncState();
  const currency = business?.currency ?? 'BDT';
  const canCreate = hasPermission(permissions, 'sale.create') && hasPermission(permissions, 'sale.view');
  /** Correcting a posted sale needs an explicit right - it moves stock and money. */
  const canVoid = hasPermission(permissions, 'sale.void');

  const products = useResource(() => cachedList<ProductRow>('products', () => catalog.products()), []);
  const customers = useResource(() => cachedList<CustomerRow>('customers', () => catalog.customers()), []);
  const locations = useResource(() => cachedList<LocationRow>('locations', () => catalog.locations(), { key: 'id' }), []);
  const sales = useResource(() => cachedList<SaleRow>('sales', () => salesApi.list()), [snapshot.lastSyncedAt]);

  // ---- void (reversal) dialog -------------------------------------------------
  const [voidTarget, setVoidTarget] = useState<SaleRow | null>(null);
  const [voidReason, setVoidReason] = useState('');
  const [voidDate, setVoidDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [voidBusy, setVoidBusy] = useState(false);

  const closeVoidDialog = () => {
    setVoidTarget(null);
    setVoidReason('');
  };

  const submitVoid = async () => {
    if (!voidTarget) return;
    setVoidBusy(true);
    try {
      await salesApi.voidSale(voidTarget.id, { date: voidDate, reason: voidReason.trim() });
      notify(t('sales.voidDone'), 'success');
      closeVoidDialog();
      sales.reload();
      products.reload();
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : String(cause), 'error');
    } finally {
      setVoidBusy(false);
    }
  };

  const columns: Column<SaleRow>[] = useMemo(() => {
    const base: Column<SaleRow>[] = [
      { id: 'reference', header: t('common.reference'), cell: (row) => <span className="mono">{row.reference}</span> },
      { id: 'date', header: t('common.date'), cell: (row) => <DateText value={row.documentDate} /> },
      { id: 'customer', header: t('sales.customer'), cell: (row) => customers.data?.find((c) => c.id === row.customerId)?.name ?? t('sales.walkIn') },
      { id: 'net', header: t('sales.net'), align: 'right', cell: (row) => <MoneyText value={row.net} currency={row.currency || currency} /> },
      { id: 'received', header: t('sales.cashReceived'), align: 'right', cell: (row) => <MoneyText value={row.cashReceived} currency={row.currency || currency} /> },
      { id: 'receivable', header: t('sales.receivable'), align: 'right', cell: (row) => <MoneyText value={row.receivable} currency={row.currency || currency} /> },
      { id: 'cogs', header: t('sales.cogs'), align: 'right', permission: 'purchase.cost.view', cell: (row) => <MoneyText value={row.cogs} currency={row.currency || currency} /> },
      { id: 'lines', header: t('sales.line'), cell: (row) => <QtyText value={row.lines?.length ?? 0} /> },
    ];
    if (canVoid) {
      base.push({
        id: 'actions',
        header: '',
        cell: (row) =>
          row.status === 'VOID' ? (
            <Badge tone="warn">{t('sales.voided')}</Badge>
          ) : (
            <button type="button" className="link" onClick={() => setVoidTarget(row)}>
              {t('sales.void')}
            </button>
          ),
      });
    }
    return base;
  }, [t, currency, customers.data, canVoid]);

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

      <Modal
        open={voidTarget !== null}
        title={t('sales.voidTitle')}
        onClose={closeVoidDialog}
        footer={
          <>
            <Button variant="secondary" onClick={closeVoidDialog} disabled={voidBusy}>
              {t('common.cancel')}
            </Button>
            <Button variant="danger" onClick={() => void submitVoid()} disabled={voidBusy || voidReason.trim().length < 5}>
              {t('sales.voidConfirm')}
            </Button>
          </>
        }
      >
        <p className="muted">{t('sales.voidHint')}</p>
        {voidTarget ? <p className="mono">{voidTarget.reference}</p> : null}
        <TextInput label={t('common.date')} type="date" value={voidDate} onValueChange={setVoidDate} required />
        <TextAreaInput
          label={t('sales.voidReason')}
          value={voidReason}
          onValueChange={setVoidReason}
          hint={t('sales.voidReasonHint')}
          required
        />
      </Modal>
    </>
  );
}
