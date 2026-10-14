import { useMemo, useState } from 'react';
import { dec } from '@sbm/domain';
import { ApiError } from '../api/client';
import { catalog } from '../api/endpoints';
import { purchases as purchaseApi } from '../api/endpointsFinance';
import { computePurchaseTotals, purchasePayload } from '../api/documentMath';
import { canViewCost, hasPermission } from '../api/permissions';
import { cachedList } from '../offline/cachedList';
import { deviceId, newLocalId, saveLocally } from '../offline/localStorage';
import { useOnline } from '../offline/useSync';
import { AsyncState, Restricted } from '../components/States';
import { DataTable, type Column } from '../components/DataTable';
import { DateText, MoneyText } from '../components/MoneyText';
import { Button, Card, Notice, PageHeader, SelectInput, TextAreaInput, TextInput, TotalRow, Totals } from '../components/ui';
import { useApp, useT } from '../state/AppContext';
import { useResource, useSyncState } from '../offline/useSync';
import type { ProductRow, PurchaseRow, SupplierRow } from '../api/types';

interface DraftLine {
  readonly key: string;
  productId: string;
  quantity: string;
  unit: string;
  unitCost: string;
  tax: string;
}

const emptyLine = (): DraftLine => ({ key: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, productId: '', quantity: '1', unit: '', unitCost: '', tax: '' });

/** Purchases: receive stock into inventory and handle the payable. */
export function PurchasesScreen() {
  const { business, permissions, me, notify } = useApp();
  const { t } = useT();
  const online = useOnline();
  const { snapshot } = useSyncState();
  const currency = business?.currency ?? 'BDT';
  const canManage = hasPermission(permissions, 'purchase.manage');
  const showCost = canViewCost(permissions);

  const products = useResource(() => cachedList<ProductRow>('products', () => catalog.products()), []);
  const suppliers = useResource(() => cachedList<SupplierRow>('suppliers', () => catalog.suppliers()), []);
  const purchases = useResource(() => cachedList<PurchaseRow>('purchases', () => purchaseApi.list()), [snapshot.lastSyncedAt]);

  const [documentDate, setDocumentDate] = useState(new Date().toISOString().slice(0, 10));
  const [supplierId, setSupplierId] = useState('');
  const [paid, setPaid] = useState('');
  const [note, setNote] = useState('');
  const [lines, setLines] = useState<readonly DraftLine[]>([emptyLine()]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const totals = useMemo(
    () =>
      computePurchaseTotals({
        currency,
        lines: lines.map((line) => ({
          productId: line.productId,
          quantity: line.quantity,
          unit: line.unit,
          unitCost: line.unitCost,
          ...(line.tax ? { tax: line.tax } : {}),
        })),
        paid,
      }),
    [currency, lines, paid],
  );

  const updateLine = (key: string, patch: Partial<DraftLine>) => setLines((current) => current.map((line) => (line.key === key ? { ...line, ...patch } : line)));

  const submit = () => {
    setError(null);
    const usable = lines.filter((line) => line.productId && dec(line.quantity || '0').isPositive());
    if (usable.length === 0) {
      setError(t('sales.needLine'));
      return;
    }
    const payload = purchasePayload({
      documentDate,
      currency,
      ...(supplierId ? { supplierId } : {}),
      ...(paid ? { paid } : {}),
      ...(note ? { note } : {}),
      lines: usable.map((line) => ({
        productId: line.productId,
        quantity: line.quantity,
        unit: line.unit,
        unitCost: line.unitCost,
        ...(line.tax ? { tax: line.tax } : {}),
      })),
    });
    setBusy(true);
    void (async () => {
      try {
        if (online && business && me) {
          await purchaseApi.create(payload as never);
          notify(t('purchases.posted'), 'success');
        } else if (business && me) {
          const localId = newLocalId();
          await saveLocally(
            {
              eventType: 'purchase.receive',
              aggregateId: localId,
              payload,
              store: 'purchases',
              record: {
                id: localId,
                reference: `${localId.slice(0, 12)}…`,
                supplierId: supplierId || null,
                documentDate,
                currency,
                total: totals.total.amount.toString(),
                paid: totals.paid.amount.toString(),
                payable: totals.payable.amount.toString(),
                lines: payload.lines,
              },
            },
            { businessId: business.id, actorId: me.user.id, deviceId: deviceId() },
          );
          notify(t('common.savedOffline'), 'warn');
        }
        setLines([emptyLine()]);
        setPaid('');
        setNote('');
        purchases.reload();
        products.reload();
      } catch (cause) {
        setError(cause instanceof ApiError ? cause.message : cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(false);
      }
    })();
  };

  const columns: Column<PurchaseRow>[] = useMemo(
    () => [
      { id: 'reference', header: t('common.reference'), cell: (row) => <span className="mono">{row.reference}</span> },
      { id: 'date', header: t('common.date'), cell: (row) => <DateText value={row.documentDate} /> },
      { id: 'supplier', header: t('purchases.supplier'), cell: (row) => suppliers.data?.find((row2) => row2.id === row.supplierId)?.name ?? '—' },
      { id: 'total', header: t('common.total'), align: 'right', cell: (row) => <MoneyText value={row.total} currency={row.currency || currency} /> },
      { id: 'paid', header: t('purchases.paid'), align: 'right', cell: (row) => <MoneyText value={row.paid} currency={row.currency || currency} /> },
      { id: 'payable', header: t('purchases.payable'), align: 'right', cell: (row) => <MoneyText value={row.payable} currency={row.currency || currency} /> },
      { id: 'tax', header: t('sales.tax'), align: 'right', permission: 'purchase.cost.view', cell: (row) => <MoneyText value={row.tax} currency={row.currency || currency} /> },
    ],
    [t, currency, suppliers.data],
  );

  return (
    <>
      <PageHeader title={t('nav.purchases')} subtitle={business?.name} />

      {canManage ? (
        <Card
          title={t('purchases.new')}
          subtitle={online ? undefined : t('common.offline')}
          actions={
            <Button variant="primary" onClick={submit} disabled={busy}>
              {t('purchases.submit')}
            </Button>
          }
        >
          {error ? <Notice level="error">{error}</Notice> : null}
          <div className="grid grid--2">
            <TextInput label={t('common.date')} type="date" required value={documentDate} onValueChange={setDocumentDate} />
            <SelectInput
              label={t('purchases.supplier')}
              value={supplierId}
              onValueChange={setSupplierId}
              placeholder={t('purchases.supplier')}
              options={(suppliers.data ?? []).map((row) => ({ value: row.id, label: row.name }))}
            />
          </div>

          <AsyncState loading={products.loading} error={products.error} data={products.data} onRetry={products.reload}>
            {(productRows) => (
              <div className="lines">
                {lines.map((line, index) => (
                  <div className="line" key={line.key}>
                    <span className="line__index">{index + 1}</span>
                    <div className="line__product">
                      <SelectInput
                        label={t('sales.product')}
                        value={line.productId}
                        onValueChange={(value) => {
                          const product = productRows.find((row) => row.id === value);
                          updateLine(line.key, { productId: value, unit: product?.unit ?? '', unitCost: product?.purchasePrice ?? '' });
                        }}
                        placeholder={t('sales.product')}
                        options={productRows.map((row) => ({ value: row.id, label: `${row.name} (${row.unit})` }))}
                      />
                    </div>
                    <TextInput label={t('common.quantity')} inputMode="decimal" value={line.quantity} onValueChange={(value) => updateLine(line.key, { quantity: value })} />
                    <TextInput label={t('common.unit')} value={line.unit} onValueChange={(value) => updateLine(line.key, { unit: value })} />
                    <TextInput label={t('purchases.unitCost')} inputMode="decimal" value={line.unitCost} onValueChange={(value) => updateLine(line.key, { unitCost: value })} />
                    <Button variant="ghost" onClick={() => setLines((current) => current.filter((row) => row.key !== line.key))} aria-label={t('sales.removeLine')}>
                      ✕
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </AsyncState>

          <Button variant="secondary" onClick={() => setLines((current) => [...current, emptyLine()])}>
            + {t('sales.addLine')}
          </Button>

          <div className="grid grid--2">
            <TextInput label={t('purchases.paid')} inputMode="decimal" value={paid} onValueChange={setPaid} hint={totals.total.amount.toString()} />
            <TextAreaInput label={t('common.note')} value={note} onValueChange={setNote} rows={2} />
          </div>

          <Totals>
            <TotalRow label={t('common.total')} value={<MoneyText value={totals.total.amount.toString()} currency={currency} />} strong />
            <TotalRow label={t('purchases.paid')} value={<MoneyText value={totals.paid.amount.toString()} currency={currency} />} />
            <TotalRow label={t('purchases.payable')} value={<MoneyText value={totals.payable.amount.toString()} currency={currency} />} />
          </Totals>
        </Card>
      ) : (
        <Restricted permission="purchase.manage" />
      )}

      <Card title={t('purchases.list')}>
        <AsyncState loading={purchases.loading} error={purchases.error} data={purchases.data} onRetry={purchases.reload}>
          {(rows) => <DataTable columns={columns} rows={rows.slice(0, 100)} getKey={(row) => row.id} permissions={permissions} />}
        </AsyncState>
        {!showCost ? <Notice level="info">{t('inv.hideCost')}</Notice> : null}
      </Card>
    </>
  );
}

