import { useMemo, useState } from 'react';
import { dec } from '@sbm/domain';
import { ApiError } from '../api/client';
import { inventory as inventoryApi } from '../api/endpoints';
import { canViewCost, hasPermission } from '../api/permissions';
import { cachedList } from '../offline/cachedList';
import { useOnline } from '../offline/useSync';
import { AsyncState, Restricted } from '../components/States';
import { DataTable, type Column } from '../components/DataTable';
import { DateTimeText, MoneyText, QtyText } from '../components/MoneyText';
import { Badge, Button, Card, CheckboxInput, Notice, PageHeader, SelectInput, TextAreaInput, TextInput } from '../components/ui';
import { useApp, useT } from '../state/AppContext';
import { useResource, useSyncState } from '../offline/useSync';
import type { InventoryRow, MovementRow } from '../api/types';

/** Inventory: on-hand with valuation, adjustments and the movement ledger. */
export function InventoryScreen() {
  const { business, permissions, notify } = useApp();
  const { t } = useT();
  const online = useOnline();
  const { snapshot } = useSyncState();
  const currency = business?.currency ?? 'BDT';
  const showCost = canViewCost(permissions);
  const canAdjust = hasPermission(permissions, 'inventory.adjust');
  const canApproveNegative = hasPermission(permissions, 'inventory.adjust.approve');

  const stock = useResource(
    () => cachedList<InventoryRow>('inventory', () => inventoryApi.list(), { key: 'itemId' }),
    [snapshot.lastSyncedAt],
  );
  const movements = useResource(() => inventoryApi.movements(), [snapshot.lastSyncedAt]);

  const [itemId, setItemId] = useState('');
  const [direction, setDirection] = useState<'IN' | 'OUT'>('IN');
  const [quantity, setQuantity] = useState('');
  const [unit, setUnit] = useState('');
  const [reason, setReason] = useState('');
  const [allowNegative, setAllowNegative] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const columns: Column<InventoryRow>[] = useMemo(
    () => [
      { id: 'name', header: t('sales.product'), cell: (row) => row.name },
      { id: 'onHand', header: t('inv.onHand'), align: 'right', cell: (row) => <QtyText value={row.onHand} unit={row.unit} /> },
      { id: 'reorder', header: t('inv.reorderLevel'), align: 'right', cell: (row) => <QtyText value={row.reorderLevel} /> },
      { id: 'alert', header: t('common.status'), cell: (row) => <Badge tone={row.belowReorder ? 'error' : 'ok'}>{row.belowReorder ? t('inv.belowReorder') : 'OK'}</Badge> },
      { id: 'unitCost', header: t('inv.unitCost'), align: 'right', permission: 'purchase.cost.view', cell: (row) => <MoneyText value={row.unitCost} currency={currency} /> },
      { id: 'value', header: t('inv.value'), align: 'right', permission: 'purchase.cost.view', cell: (row) => <MoneyText value={row.value} currency={currency} /> },
    ],
    [t, currency],
  );

  const movementColumns: Column<MovementRow>[] = useMemo(
    () => [
      { id: 'when', header: t('inv.occurredAt'), cell: (row) => <DateTimeText value={row.occurredAt} /> },
      { id: 'item', header: t('sales.product'), cell: (row) => stock.data?.find((item) => item.itemId === row.itemId)?.name ?? row.itemId.slice(0, 8) },
      { id: 'direction', header: t('inv.direction'), cell: (row) => <Badge tone={row.direction === 'IN' ? 'ok' : 'warn'}>{row.direction}</Badge> },
      { id: 'quantity', header: t('common.quantity'), align: 'right', cell: (row) => <QtyText value={row.quantity} unit={row.unit} /> },
      { id: 'source', header: t('inv.source'), cell: (row) => `${row.sourceType}${row.sourceId ? ` · ${row.sourceId}` : ''}` },
      { id: 'reason', header: t('common.note'), cell: (row) => row.reason ?? '—' },
    ],
    [t, stock.data],
  );

  const submitAdjustment = () => {
    setError(null);
    if (!itemId || !dec(quantity || '0').isPositive() || reason.trim().length < 5) {
      setError(t('common.requiredFields'));
      return;
    }
    setBusy(true);
    void inventoryApi
      .adjust({
        itemId,
        direction,
        quantity,
        unit: unit || 'pcs',
        reason: reason.trim(),
        ...(allowNegative ? { allowNegative: true } : {}),
      })
      .then(() => {
        notify(t('inv.adjust'), 'success');
        setQuantity('');
        setReason('');
        setAllowNegative(false);
        stock.reload();
        movements.reload();
      })
      .catch((cause: unknown) => setError(cause instanceof ApiError ? cause.message : cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setBusy(false));
  };

  return (
    <>
      <PageHeader title={t('nav.inventory')} subtitle={business?.name} actions={<span className="pill pill--muted">{online ? t('common.online') : t('common.offline')}</span>} />

      {!showCost ? <Notice level="info">{t('inv.hideCost')}</Notice> : null}

      <Card title={t('nav.inventory')} subtitle={t('dash.lowStock')}>
        <AsyncState loading={stock.loading} error={stock.error} data={stock.data} onRetry={stock.reload}>
          {(rows) => (
            <DataTable
              columns={columns}
              rows={[...rows].sort((a, b) => Number(b.belowReorder) - Number(a.belowReorder))}
              getKey={(row) => row.itemId}
              permissions={permissions}
            />
          )}
        </AsyncState>
      </Card>

      {canAdjust ? (
        <Card
          title={t('inv.adjust')}
          subtitle={online ? undefined : t('common.offlineOnly')}
          actions={
            <Button variant="primary" onClick={submitAdjustment} disabled={busy || !online}>
              {t('common.save')}
            </Button>
          }
        >
          {error ? <Notice level="error">{error}</Notice> : null}
          {!online ? <Notice level="warn">{t('sync.unsupported')}</Notice> : null}
          <div className="grid grid--3">
            <SelectInput
              label={t('sales.product')}
              required
              value={itemId}
              onValueChange={(value) => {
                setItemId(value);
                setUnit(stock.data?.find((row) => row.itemId === value)?.unit ?? '');
              }}
              placeholder={t('sales.product')}
              options={(stock.data ?? []).map((row) => ({ value: row.itemId, label: `${row.name} (${row.onHand} ${row.unit})` }))}
            />
            <SelectInput
              label={t('inv.direction')}
              value={direction}
              onValueChange={(value) => setDirection(value === 'OUT' ? 'OUT' : 'IN')}
              options={[
                { value: 'IN', label: t('inv.in') },
                { value: 'OUT', label: t('inv.out') },
              ]}
            />
            <TextInput label={t('common.quantity')} inputMode="decimal" required value={quantity} onValueChange={setQuantity} />
            <TextInput label={t('common.unit')} value={unit} onValueChange={setUnit} />
          </div>
          <TextAreaInput label={t('inv.reason')} required value={reason} onValueChange={setReason} hint={t('inv.reason')} />
          {canApproveNegative ? (
            <CheckboxInput label={t('sales.allowNegative')} checked={allowNegative} onCheckedChange={setAllowNegative} hint={t('sales.stockConflict')} />
          ) : null}
        </Card>
      ) : (
        <Restricted permission="inventory.adjust" />
      )}

      <Card title={t('inv.movements')}>
        <AsyncState loading={movements.loading} error={movements.error} data={movements.data} onRetry={movements.reload}>
          {(rows) => <DataTable columns={movementColumns} rows={rows.slice(0, 100)} getKey={(row) => row.id} permissions={permissions} />}
        </AsyncState>
      </Card>
    </>
  );
}
