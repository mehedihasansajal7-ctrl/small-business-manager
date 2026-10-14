import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useCallback, useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { Decimal, STANDARD_ACCOUNTS, dec, localDateString } from '@sbm/domain';

import { useAuth } from '../../auth/AuthProvider';
import { useActor } from '../../auth/useActor';
import { Button, Card, Field, ListRow, MoneyText, Notice, NumberInput, OfflineCapabilityNote, PhotoPicker, Screen, SectionTitle, Select, Toggle } from '../../components';
import { recordSale } from '../../offline/repository';
import { localCustomers, localProducts, localSales } from '../../offline/repository';
import { useI18n } from '../../i18n';
import { useAsyncData } from '../../lib/useAsyncData';
import { useNetwork } from '../../lib/network';
import { useSync } from '../../lib/useSync';
import { useTheme } from '../../theme';
import type { SalesStackParamList } from '../../navigation/types';

type Props = NativeStackScreenProps<SalesStackParamList, 'SaleEdit'>;

interface DraftLine {
  readonly key: string;
  productId: string;
  unit: string;
  quantity: string;
  unitPrice: string;
  discount: string;
}

const CASH_ACCOUNTS = STANDARD_ACCOUNTS.filter((account) => ['1000', '1010', '1020'].includes(account.code));

function emptyLine(unit = 'pcs'): DraftLine {
  return { key: globalThis.crypto.randomUUID(), productId: '', unit, quantity: '1', unitPrice: '0', discount: '0' };
}

/**
 * Point of sale.
 *
 * Everything is queued locally through the outbox, so a partner can record a sale
 * with no connection; the payload is an exact-decimal mirror of what
 * `Repository.createSale` expects, and the server applies it idempotently.
 *
 * Two deliberate limitations, made visible in the UI rather than hidden:
 *  1. a **posted** sale is immutable in this API (there is no `PATCH /api/sales/:id`),
 *     so opening an existing sale shows a read-only document;
 *  2. selling more than the recorded stock needs an approver role *and* a written
 *     reason, exactly like the server demands.
 */
export function SaleEditScreen({ navigation, route }: Props) {
  const { colors, typography, spacing } = useTheme();
  const { t, money: formatMoneyI18n } = useI18n();
  const { business, can } = useAuth();
  const actor = useActor();
  const { online } = useNetwork();
  const { syncNow } = useSync();

  const currency = business?.currency ?? 'BDT';
  const timezone = business?.timezone ?? 'Asia/Dhaka';
  const saleId = route.params?.saleId;
  const readOnly = Boolean(saleId);

  const [entityId] = useState(() => globalThis.crypto.randomUUID());
  const [documentDate, setDocumentDate] = useState(localDateString(new Date(), timezone));
  const [customerId, setCustomerId] = useState<string | null>(null);
  const [accountCode, setAccountCode] = useState('1000');
  const [lines, setLines] = useState<DraftLine[]>([emptyLine()]);
  const [discount, setDiscount] = useState('0');
  const [cashReceived, setCashReceived] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [allowNegative, setAllowNegative] = useState(false);
  const [negativeReason, setNegativeReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const productsLoader = useCallback(() => localProducts({}), []);
  const customersLoader = useCallback(() => localCustomers(), []);
  const existingLoader = useCallback(async () => (saleId ? (await localSales()).find((sale) => sale.id === saleId) ?? null : null), [saleId]);

  const { data: products } = useAsyncData(productsLoader, [productsLoader]);
  const { data: customers } = useAsyncData(customersLoader, [customersLoader]);
  const { data: existing } = useAsyncData(existingLoader, [existingLoader]);

  const productOptions = useMemo(
    () => [
      { value: '', label: t('common.noneSelected') },
      ...(products ?? []).map((product) => ({ value: product.id, label: `${product.name} (${product.unit})`, note: product.sku ?? undefined })),
    ],
    [products, t],
  );

  const customerOptions = useMemo(
    () => [{ value: '', label: t('common.walkIn') }, ...(customers ?? []).map((customer) => ({ value: customer.id, label: customer.name, note: customer.phone ?? undefined }))],
    [customers, t],
  );

  const accountOptions = CASH_ACCOUNTS.map((account) => ({ value: account.code, label: `${account.code} — ${account.name}` }));

  /** All totals are computed with `Decimal`; `Number()` never touches money. */
  const totals = useMemo(() => {
    let revenue = Decimal.ZERO;
    let lineDiscount = Decimal.ZERO;
    for (const line of lines) {
      const quantity = dec(line.quantity === '' ? '0' : line.quantity);
      const unitPrice = dec(line.unitPrice === '' ? '0' : line.unitPrice);
      const lineTotal = quantity.mul(unitPrice);
      revenue = revenue.add(lineTotal);
      lineDiscount = lineDiscount.add(dec(line.discount === '' ? '0' : line.discount));
    }
    const headerDiscount = dec(discount === '' ? '0' : discount);
    const net = revenue.sub(lineDiscount).sub(headerDiscount);
    const received = cashReceived === null ? net : dec(cashReceived === '' ? '0' : cashReceived);
    return {
      revenue: revenue.round(2, 'HALF_UP').toString(),
      discount: lineDiscount.add(headerDiscount).round(2, 'HALF_UP').toString(),
      net: net.round(2, 'HALF_UP').toString(),
      received: received.round(2, 'HALF_UP').toString(),
      receivable: net.sub(received).round(2, 'HALF_UP').toString(),
    };
  }, [lines, discount, cashReceived]);

  const updateLine = (key: string, patch: Partial<DraftLine>) => {
    setLines((current) => current.map((line) => (line.key === key ? { ...line, ...patch } : line)));
  };

  const onPickProduct = (key: string, productId: string) => {
    const product = (products ?? []).find((entry) => entry.id === productId);
    updateLine(key, {
      productId,
      unit: product?.unit ?? 'pcs',
      unitPrice: product?.salePrice ?? '0',
    });
  };

  const submit = async () => {
    setError(null);
    if (!actor) {
      setError(t('common.error'));
      return;
    }
    const usable = lines.filter((line) => line.productId !== '' || dec(line.quantity).isPositive());
    if (usable.length === 0) {
      setError(t('sales.addLine'));
      return;
    }
    if (usable.some((line) => !dec(line.quantity).isPositive())) {
      setError(t('common.quantity'));
      return;
    }
    if (allowNegative && negativeReason.trim().length < 5) {
      setError(t('sales.negativeHint'));
      return;
    }

    setBusy(true);
    try {
      await recordSale(actor, {
        aggregateId: entityId,
        documentDate,
        currency,
        accountCode,
        discount: totals.discount,
        cashReceived: totals.received,
        ...(customerId ? { customerId } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
        ...(allowNegative ? { allowNegative: true, negativeReason: negativeReason.trim() } : {}),
        lines: usable.map((line) => ({
          productId: line.productId,
          quantity: line.quantity,
          unit: line.unit,
          unitPrice: line.unitPrice,
          discount: line.discount,
        })),
      });
      // Fire and forget: the record is already durable locally, and the sync
      // controller will retry until the server confirms it.
      if (online) void syncNow();
      navigation.goBack();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('common.error'));
    } finally {
      setBusy(false);
    }
  };

  if (readOnly) {
    return (
      <Screen title={t('sales.title')} subtitle={existing?.reference}>
        <Notice tone="info" body={`${t('reports.offlineNote')} — a posted sale cannot be edited; record a receipt or an adjustment instead.`} />
        {existing ? (
          <Card>
            <ListRow title={existing.reference} subtitle={existing.documentDate} right={<MoneyText value={existing.net} currency={existing.currency} />} />
            {existing.lines.map((line, index) => (
              <ListRow
                key={`${existing.id}-${index}`}
                title={line.description || line.productId || '—'}
                subtitle={`${line.quantity} ${line.unit} × ${line.unitPrice}`}
                right={<MoneyText value={line.lineTotal} currency={existing.currency} />}
              />
            ))}
            <View style={{ height: spacing.sm }} />
            <ListRow title={t('common.total')} subtitle={`${t('sales.cashReceived')} ${formatMoneyI18n(existing.cashReceived, existing.currency)}`} right={<MoneyText value={existing.net} currency={existing.currency} />} />
            {existing.cogs !== undefined ? (
              <ListRow title={t('sales.cogs')} right={<MoneyText value={existing.cogs} currency={existing.currency} />} />
            ) : (
              <Notice tone="warning" body={t('common.restrictedBody')} />
            )}
          </Card>
        ) : null}
      </Screen>
    );
  }

  return (
    <Screen title={t('sales.new')} subtitle={business?.name}>
      {!online ? <OfflineCapabilityNote /> : null}
      {error ? <Notice tone="danger" body={error} /> : null}

      <Card>
        <Field label={t('common.date')} value={documentDate} onChangeText={setDocumentDate} note="YYYY-MM-DD" required />
        <Select label={t('common.customer')} value={customerId ?? ''} options={customerOptions} onChange={(value) => setCustomerId(value === '' ? null : value)} />
        <Select label={t('common.account')} value={accountCode} options={accountOptions} onChange={setAccountCode} />

        <SectionTitle title={t('sales.line')} />
        {lines.map((line, index) => (
          <View key={line.key} style={{ borderTopWidth: index === 0 ? 0 : 1, borderTopColor: colors.border, paddingTop: spacing.sm, marginBottom: spacing.sm }}>
            <Select label={`${t('common.product')} ${index + 1}`} value={line.productId} options={productOptions} onChange={(value) => onPickProduct(line.key, value)} />
            <NumberInput
              label={t('common.quantity')}
              value={line.quantity}
              onChange={(value) => updateLine(line.key, { quantity: value ?? '0' })}
              mode="quantity"
            />
            <NumberInput
              label={t('sales.unitPrice')}
              value={line.unitPrice}
              onChange={(value) => updateLine(line.key, { unitPrice: value ?? '0' })}
              mode="money"
              currency={currency}
            />
            <NumberInput label={t('sales.discount')} value={line.discount} onChange={(value) => updateLine(line.key, { discount: value ?? '0' })} mode="money" currency={currency} />
            {lines.length > 1 ? (
              <Pressable accessibilityRole="button" onPress={() => setLines((current) => current.filter((entry) => entry.key !== line.key))}>
                <Text style={[typography.caption, { color: colors.danger }]}>{t('common.delete')}</Text>
              </Pressable>
            ) : null}
          </View>
        ))}
        <Button label={t('sales.addLine')} variant="secondary" compact onPress={() => setLines((current) => [...current, emptyLine(current[0]?.unit ?? 'pcs')])} />
      </Card>

      <Card>
        {can('sale.discount.apply') ? (
          <NumberInput label={`${t('sales.discount')} (${t('common.total')})`} value={discount} onChange={(value) => setDiscount(value ?? '0')} mode="money" currency={currency} />
        ) : (
          <Notice tone="warning" body={`${t('sales.discount')}: ${t('common.restrictedBody')}`} />
        )}
        <NumberInput
          label={t('sales.cashReceived')}
          value={cashReceived ?? totals.net}
          onChange={(value) => setCashReceived(value)}
          mode="money"
          currency={currency}
          note={t('common.optional')}
        />
        <Field label={t('common.notes')} value={note} onChangeText={setNote} multiline />

        <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: spacing.sm }}>
          <Text style={[typography.body, { color: colors.textMuted }]}>{t('common.total')}</Text>
          <MoneyText value={totals.net} currency={currency} />
        </View>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
          <Text style={[typography.body, { color: colors.textMuted }]}>{t('sales.receivable')}</Text>
          <MoneyText value={totals.receivable} currency={currency} />
        </View>
      </Card>

      {can('inventory.adjust.approve') ? (
        <Card>
          <Toggle label={t('sales.negativeStock')} value={allowNegative} onChange={setAllowNegative} note={t('sales.negativeHint')} />
          {allowNegative ? <Field label={t('sales.negativeReason')} value={negativeReason} onChangeText={setNegativeReason} multiline required /> : null}
        </Card>
      ) : null}

      <SectionTitle title={t('photo.add')} />
      <PhotoPicker entityType="sale" entityId={entityId} />

      <Button label={t('common.save')} onPress={() => void submit()} loading={busy} fullWidth />
    </Screen>
  );
}
