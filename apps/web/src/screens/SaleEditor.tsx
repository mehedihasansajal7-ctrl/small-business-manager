import { useMemo, useState, type ReactNode } from 'react';
import { dec } from '@sbm/domain';
import { ApiError } from '../api/client';
import { catalog } from '../api/endpoints';
import { sales as salesApi } from '../api/endpointsFinance';
import { computeSaleTotals, salePayload } from '../api/documentMath';
import { hasPermission } from '../api/permissions';
import { Button, Card, CheckboxInput, Modal, Notice, SelectInput, TextAreaInput, TextInput, TotalRow, Totals } from '../components/ui';
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
  // A product created on this device has no server id yet, so the server cannot
  // resolve `productId` for it. Those rows stay out of the picker until they sync.
  const selectable = products.filter((row) => !isLocalId(row.id));
  const pendingCount = products.length - selectable.length;

  // A product created from this screen is added to the picker immediately (the
  // parent list is reloaded in the background), so a first sale can be recorded
  // without a detour through Catalog.
  const [newProductFor, setNewProductFor] = useState<DraftLine | null>(null);
  const [npName, setNpName] = useState('');
  const [npUnit, setNpUnit] = useState('kg');
  const [npPrice, setNpPrice] = useState('');
  const [npBusy, setNpBusy] = useState(false);
  const [extraProducts, setExtraProducts] = useState<readonly ProductRow[]>([]);
  const pickable = [...selectable, ...extraProducts.filter((extra) => !selectable.some((row) => row.id === extra.id))];

  const openNewProduct = (line: DraftLine) => {
    setNewProductFor(line);
    setNpName('');
    setNpUnit(line.unit || 'kg');
    setNpPrice(line.unitPrice || '');
    setError(null);
  };

  const createProductForLine = async () => {
    if (!newProductFor) return;
    const name = npName.trim();
    const unit = npUnit.trim();
    if (!name || !unit) {
      setError(t('common.requiredFields'));
      return;
    }
    if (!online) {
      setError(t('purchases.productNeedsInternet'));
      return;
    }
    setNpBusy(true);
    setError(null);
    try {
      const created = await catalog.createProduct({
        name,
        unit,
        kind: 'PRODUCT',
        ...(npPrice.trim() ? { salePrice: npPrice.trim() } : {}),
      });
      setExtraProducts((current) => [...current, created]);
      updateLine(newProductFor.key, { productId: created.id, unit: created.unit, unitPrice: created.salePrice ?? npPrice });
      setNewProductFor(null);
      setNpName('');
      notify(t('purchases.productAdded'), 'success');
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : cause instanceof Error ? cause.message : String(cause));
    } finally {
      setNpBusy(false);
    }
  };

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
    const product = pickable.find((row) => row.id === productId) ?? products.find((row) => row.id === productId);
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
      {pendingCount > 0 ? (
        <Notice level="warn">
          {pendingCount} {t('sync.localProposal')}
        </Notice>
      ) : null}

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

      {pickable.length === 0 ? <Notice level="info">{t('purchases.noProducts')}</Notice> : null}
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
                options={pickable.map((row) => ({ value: row.id, label: `${row.name} (${row.onHand ?? '0'} ${row.unit})` }))}
              />
              <button type="button" className="link" onClick={() => openNewProduct(line)}>
                ＋ {t('purchases.newProduct')}
              </button>
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
      <Modal
        open={newProductFor !== null}
        title={t('purchases.newProductTitle')}
        onClose={() => setNewProductFor(null)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setNewProductFor(null)} disabled={npBusy}>
              {t('common.cancel')}
            </Button>
            <Button variant="primary" onClick={() => void createProductForLine()} disabled={npBusy || !npName.trim() || !npUnit.trim()}>
              {t('purchases.addProduct')}
            </Button>
          </>
        }
      >
        <p className="muted">{t('purchases.newProductHint')}</p>
        <TextInput label={t('common.name')} required value={npName} onValueChange={setNpName} />
        <div className="grid grid--2">
          <TextInput label={t('common.unit')} required value={npUnit} onValueChange={setNpUnit} />
          <TextInput label={t('sales.unitPrice')} inputMode="decimal" value={npPrice} onValueChange={setNpPrice} />
        </div>
      </Modal>
    </Card>
  );
}

