import { useMemo, useState, type ReactNode } from 'react';
import { dec } from '@sbm/domain';
import { ApiError } from '../api/client';
import { sales as salesApi } from '../api/endpointsFinance';
import { computeSaleTotals, salePayload } from '../api/documentMath';
import { hasPermission } from '../api/permissions';
import { Button, Card, CheckboxInput, Notice, SelectInput, TextAreaInput, TextInput, TotalRow, Totals } from '../components/ui';
import { MoneyText } from '../components/MoneyText';
import { useApp, useT } from '../state/AppContext';
import { useOnline } from '../offline/useSync';
import { deviceId, isLocalId, newLocalId, saveLocally } from '../offline/localStorage';
import type { CustomerRow, LocationRow, ProductRow } from '../api/types';

interface DraftLine {
  readonly key: string;
  productId: string;
  quantity: string;
  unit: string;
  unitPrice: string;
  discount: string;
  tax: string;
}

const emptyLine = (): DraftLine => ({ key: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, productId: '', quantity: '1', unit: '', unitPrice: '', discount: '', tax: '' });

/**
 * POS-style sale editor. Totals are computed with exact decimals locally (a
 * preview only — the server recomputes and posts the real numbers), and the
 * whole sale can be queued on the device when the server is unreachable.
 */
export function SaleEditor({
  products,
  customers,
  locations,
  currency,
  onPosted,
}: {
  readonly products: readonly ProductRow[];
  readonly customers: readonly CustomerRow[];
  readonly locations: readonly LocationRow[];
  readonly currency: string;
  readonly onPosted: () => void;
}) {
  const { t } = useT();
  const { business, permissions, me, notify } = useApp();
  const online = useOnline();
  const [documentDate, setDocumentDate] = useState(new Date().toISOString().slice(0, 10));
  const [customerId, setCustomerId] = useState('');
  const [locationId, setLocationId] = useState('');
  const [lines, setLines] = useState<readonly DraftLine[]>([emptyLine()]);
  const [headerDiscount, setHeaderDiscount] = useState('');
  const [cashReceived, setCashReceived] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [stockConflict, setStockConflict] = useState(false);
  const [allowNegative, setAllowNegative] = useState(false);
  const [negativeReason, setNegativeReason] = useState('');
  const [busy, setBusy] = useState(false);

  const canDiscount = hasPermission(permissions, 'sale.discount.apply');
  const canOverrideStock = hasPermission(permissions, 'inventory.adjust.approve');

  const totals = useMemo(
    () =>
      computeSaleTotals({
        currency,
        lines: lines.map((line) => ({
          productId: line.productId,
          quantity: line.quantity,
          unit: line.unit,
          unitPrice: line.unitPrice,
          ...(line.discount ? { discount: line.discount } : {}),
          ...(line.tax ? { tax: line.tax } : {}),
        })),
        headerDiscount: canDiscount ? headerDiscount : '0',
        cashReceived,
      }),
    [currency, lines, headerDiscount, cashReceived, canDiscount],
  );

  const updateLine = (key: string, patch: Partial<DraftLine>) => {
    setLines((current) => current.map((line) => (line.key === key ? { ...line, ...patch } : line)));
  };

  const pickProduct = (key: string, productId: string) => {
    const product = products.find((row) => row.id === productId);
    updateLine(key, {
      productId,
      unit: product?.unit ?? '',
      unitPrice: product?.salePrice ?? '',
    });
  };

  const submit = () => {
    setError(null);
    setStockConflict(false);
    const usable = lines.filter((line) => line.productId && dec(line.quantity || '0').isPositive());
    if (usable.length === 0) {
      setError(t('sales.needLine'));
      return;
    }
    const payload = salePayload({
      documentDate,
      currency,
      ...(customerId ? { customerId } : {}),
      ...(locationId ? { locationId } : {}),
      lines: usable.map((line) => ({
        productId: line.productId,
        quantity: line.quantity,
        unit: line.unit,
        unitPrice: line.unitPrice,
        ...(line.discount ? { discount: line.discount } : {}),
        ...(line.tax ? { tax: line.tax } : {}),
      })),
      ...(canDiscount && headerDiscount ? { headerDiscount } : {}),
      ...(cashReceived ? { cashReceived } : {}),
      ...(note ? { note } : {}),
      ...(allowNegative ? { allowNegative: true } : {}),
      ...(allowNegative && negativeReason ? { negativeReason } : {}),
    });

    setBusy(true);
    void (async () => {
      try {
        if (online && business && me) {
          await salesApi.create(payload as never);
          notify(t('sales.posted'), 'success');
        } else if (business && me) {
          // Fully usable offline: the sale is stored locally and queued.
          const localId = newLocalId();
          await saveLocally(
            {
              eventType: 'sale.post',
              aggregateId: localId,
              payload,
              store: 'sales',
              record: {
                id: localId,
                reference: `${localId.slice(0, 12)}…`,
                customerId: customerId || null,
                documentDate,
                currency,
                gross: totals.gross.amount.toString(),
                discount: totals.discount.amount.toString(),
                net: totals.net.amount.toString(),
                cashReceived: totals.cashReceived.amount.toString(),
                receivable: totals.receivable.amount.toString(),
                lines: payload.lines,
              },
            },
            { businessId: business.id, actorId: me.user.id, deviceId: deviceId() },
          );
          notify(t('common.savedOffline'), 'warn');
        }
        setLines([emptyLine()]);
        setHeaderDiscount('');
        setCashReceived('');
        setNote('');
        setAllowNegative(false);
        setNegativeReason('');
        onPosted();
      } catch (cause) {
        if (cause instanceof ApiError && (cause.code === 'STOCK_CONFLICT' || cause.status === 409)) {
          setStockConflict(true);
          setError(t('sales.stockConflict'));
        } else {
          setError(cause instanceof ApiError ? cause.message : cause instanceof Error ? cause.message : String(cause));
        }
      } finally {
        setBusy(false);
      }
    })();
  };

  return (
    <Card
      title={t('sales.new')}
      subtitle={online ? undefined : t('common.offline')}
      actions={
        <Button variant="primary" onClick={submit} disabled={busy}>
          {t('sales.submit')}
        </Button>
      }
    >
      {error ? <Notice level="error">{error}</Notice> : null}

      <div className="grid grid--3">
        <TextInput label={t('common.date')} type="date" required value={documentDate} onValueChange={setDocumentDate} />
        <SelectInput
          label={t('sales.customer')}
          value={customerId}
          onValueChange={setCustomerId}
          placeholder={t('sales.walkIn')}
          options={customers.map((row) => ({ value: row.id, label: row.name }))}
        />
        <SelectInput
          label={t('sales.location')}
          value={locationId}
          onValueChange={setLocationId}
          placeholder={t('cat.locations')}
          options={locations.map((row) => ({ value: row.id, label: row.name }))}
        />
      </div>

      <div className="lines">
        {lines.map((line, index) => (
          <div className="line" key={line.key}>
            <span className="line__index">{index + 1}</span>
            <div className="line__product">
              <SelectInput
                label={t('sales.product')}
                value={line.productId}
                onValueChange={(value) => pickProduct(line.key, value)}
                placeholder={t('sales.product')}
                options={products.map((row) => ({
                  value: row.id,
                  label: isLocalId(row.id) ? `${row.name} — ${t('sync.localProposal')}` : `${row.name} (${row.onHand} ${row.unit})`,
                }))}
              />
            </div>
            <TextInput label={t('common.quantity')} inputMode="decimal" value={line.quantity} onValueChange={(value) => updateLine(line.key, { quantity: value })} />
            <TextInput label={t('common.unit')} value={line.unit} onValueChange={(value) => updateLine(line.key, { unit: value })} />
            <TextInput label={t('sales.unitPrice')} inputMode="decimal" value={line.unitPrice} onValueChange={(value) => updateLine(line.key, { unitPrice: value })} />
            {canDiscount ? (
              <TextInput label={t('sales.discount')} inputMode="decimal" value={line.discount} onValueChange={(value) => updateLine(line.key, { discount: value })} />
            ) : null}
            <Button
              variant="ghost"
              onClick={() => setLines((current) => (current.length === 1 ? [emptyLine()] : current.filter((row) => row.key !== line.key)))}
              aria-label={`${t('sales.removeLine')} ${index + 1}`}
            >
              ✕
            </Button>
          </div>
        ))}
      </div>

      <Button variant="secondary" onClick={() => setLines((current) => [...current, emptyLine()])}>
        + {t('sales.addLine')}
      </Button>

      <div className="grid grid--2">
        {canDiscount ? (
          <TextInput label={t('sales.discount')} inputMode="decimal" value={headerDiscount} onValueChange={setHeaderDiscount} />
        ) : (
          <Notice level="info">{t('sales.noDiscountPermission')}</Notice>
        )}
        <TextInput label={t('sales.cashReceived')} inputMode="decimal" value={cashReceived} onValueChange={setCashReceived} hint={totals.net.amount.toString()} />
      </div>

      <Totals>
        <TotalRow label={t('sales.gross')} value={<MoneyText value={totals.gross.amount.toString()} currency={currency} />} />
        <TotalRow label={t('sales.discount')} value={<MoneyText value={totals.discount.amount.toString()} currency={currency} />} />
        <TotalRow label={t('sales.tax')} value={<MoneyText value={totals.tax.amount.toString()} currency={currency} />} />
        <TotalRow label={t('sales.net')} value={<MoneyText value={totals.net.amount.toString()} currency={currency} />} strong />
        <TotalRow label={t('sales.receivable')} value={<MoneyText value={totals.receivable.amount.toString()} currency={currency} />} />
      </Totals>

      <TextAreaInput label={t('common.note')} value={note} onValueChange={setNote} rows={2} />

      {stockConflict ? (
        <>
          {canOverrideStock ? (
            <>
              <CheckboxInput label={t('sales.allowNegative')} checked={allowNegative} onCheckedChange={setAllowNegative} hint={t('sales.stockConflict')} />
              {allowNegative ? <TextAreaInput label={t('sales.negativeReason')} required value={negativeReason} onValueChange={setNegativeReason} rows={2} /> : null}
            </>
          ) : (
            <Notice level="warn">{t('common.restrictedHint')}</Notice>
          )}
        </>
      ) : null}
    </Card>
  );
}

