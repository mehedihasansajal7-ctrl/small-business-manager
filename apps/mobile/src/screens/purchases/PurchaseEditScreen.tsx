import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useCallback, useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { STANDARD_ACCOUNTS, dec, localDateString } from '@sbm/domain';

import { useAuth } from '../../auth/AuthProvider';
import { useActor } from '../../auth/useActor';
import { Button, Card, Field, MoneyText, Notice, NumberInput, OfflineCapabilityNote, PhotoPicker, Screen, SectionTitle, Select } from '../../components';
import { localProducts, localSuppliers, recordPurchase } from '../../offline/repository';
import { useI18n } from '../../i18n';
import { useAsyncData } from '../../lib/useAsyncData';
import { useNetwork } from '../../lib/network';
import { useSync } from '../../lib/useSync';
import { useTheme } from '../../theme';
import type { PurchasesStackParamList } from '../../navigation/types';

type Props = NativeStackScreenProps<PurchasesStackParamList, 'PurchaseEdit'>;

interface DraftLine {
  readonly key: string;
  productId: string;
  unit: string;
  quantity: string;
  unitCost: string;
}

const MONEY_ACCOUNTS = STANDARD_ACCOUNTS.filter((account) => ['1000', '1010', '1020'].includes(account.code));

/**
 * Receive a purchase.
 *
 * Queued locally like every other core action. The payload matches
 * `Repository.createPurchase`, and every cost is normalised through
 * `@sbm/domain`'s `money()` first, so the server stores an exact decimal.
 */
export function PurchaseEditScreen({ navigation }: Props) {
  const { colors, typography, spacing } = useTheme();
  const { t } = useI18n();
  const { business } = useAuth();
  const actor = useActor();
  const { online } = useNetwork();
  const { syncNow } = useSync();

  const currency = business?.currency ?? 'BDT';
  const timezone = business?.timezone ?? 'Asia/Dhaka';

  const [entityId] = useState(() => globalThis.crypto.randomUUID());
  const [documentDate, setDocumentDate] = useState(localDateString(new Date(), timezone));
  const [supplierId, setSupplierId] = useState<string | null>(null);
  const [accountCode, setAccountCode] = useState('1000');
  const [paid, setPaid] = useState('0');
  const [note, setNote] = useState('');
  const [lines, setLines] = useState<DraftLine[]>([{ key: globalThis.crypto.randomUUID(), productId: '', unit: 'pcs', quantity: '1', unitCost: '0' }]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const productsLoader = useCallback(() => localProducts({}), []);
  const suppliersLoader = useCallback(() => localSuppliers(), []);
  const { data: products } = useAsyncData(productsLoader, [productsLoader]);
  const { data: suppliers } = useAsyncData(suppliersLoader, [suppliersLoader]);

  const productOptions = useMemo(
    () => [{ value: '', label: t('common.noneSelected') }, ...(products ?? []).map((product) => ({ value: product.id, label: `${product.name} (${product.unit})` }))],
    [products, t],
  );
  const supplierOptions = useMemo(
    () => [{ value: '', label: t('common.noneSelected') }, ...(suppliers ?? []).map((supplier) => ({ value: supplier.id, label: supplier.name, note: supplier.phone ?? undefined }))],
    [suppliers, t],
  );

  const total = useMemo(
    () => lines.reduce((acc, line) => acc.add(dec(line.quantity === '' ? '0' : line.quantity).mul(dec(line.unitCost === '' ? '0' : line.unitCost))), dec('0')).round(2, 'HALF_UP').toString(),
    [lines],
  );

  const updateLine = (key: string, patch: Partial<DraftLine>) => setLines((current) => current.map((line) => (line.key === key ? { ...line, ...patch } : line)));

  const submit = async () => {
    setError(null);
    if (!actor) return;
    const usable = lines.filter((line) => line.productId !== '');
    if (usable.length === 0) {
      setError(t('common.product'));
      return;
    }
    if (usable.some((line) => !dec(line.quantity).isPositive())) {
      setError(t('common.quantity'));
      return;
    }
    setBusy(true);
    try {
      await recordPurchase(actor, {
        aggregateId: entityId,
        documentDate,
        currency,
        accountCode,
        paid,
        ...(supplierId ? { supplierId } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
        lines: usable.map((line) => ({ productId: line.productId, quantity: line.quantity, unit: line.unit, unitCost: line.unitCost })),
      });
      if (online) void syncNow();
      navigation.goBack();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('common.error'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen title={t('purchases.new')} subtitle={business?.name}>
      {!online ? <OfflineCapabilityNote /> : null}
      {error ? <Notice tone="danger" body={error} /> : null}

      <Card>
        <Field label={t('common.date')} value={documentDate} onChangeText={setDocumentDate} note="YYYY-MM-DD" required />
        <Select label={t('common.supplier')} value={supplierId ?? ''} options={supplierOptions} onChange={(value) => setSupplierId(value === '' ? null : value)} />
        <Select label={t('common.account')} value={accountCode} options={MONEY_ACCOUNTS.map((account) => ({ value: account.code, label: `${account.code} — ${account.name}` }))} onChange={setAccountCode} />

        <SectionTitle title={t('products.title')} />
        {lines.map((line, index) => (
          <View key={line.key} style={{ borderTopWidth: index === 0 ? 0 : 1, borderTopColor: colors.border, paddingTop: spacing.sm, marginBottom: spacing.sm }}>
            <Select
              label={`${t('common.product')} ${index + 1}`}
              value={line.productId}
              options={productOptions}
              onChange={(value) => {
                const product = (products ?? []).find((entry) => entry.id === value);
                updateLine(line.key, { productId: value, unit: product?.unit ?? line.unit, unitCost: product?.purchasePrice ?? line.unitCost });
              }}
            />
            <NumberInput label={t('common.quantity')} value={line.quantity} onChange={(value) => updateLine(line.key, { quantity: value ?? '0' })} mode="quantity" />
            <NumberInput label={t('products.purchasePrice')} value={line.unitCost} onChange={(value) => updateLine(line.key, { unitCost: value ?? '0' })} mode="money" currency={currency} />
            {lines.length > 1 ? (
              <Pressable accessibilityRole="button" onPress={() => setLines((current) => current.filter((entry) => entry.key !== line.key))}>
                <Text style={[typography.caption, { color: colors.danger }]}>{t('common.delete')}</Text>
              </Pressable>
            ) : null}
          </View>
        ))}
        <Button label={t('sales.addLine')} variant="secondary" compact onPress={() => setLines((current) => [...current, { key: globalThis.crypto.randomUUID(), productId: '', unit: current[0]?.unit ?? 'pcs', quantity: '1', unitCost: '0' }])} />
      </Card>

      <Card>
        <NumberInput label={t('purchases.paid')} value={paid} onChange={(value) => setPaid(value ?? '0')} mode="money" currency={currency} />
        <Field label={t('common.notes')} value={note} onChangeText={setNote} multiline />
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: spacing.sm }}>
          <Text style={[typography.body, { color: colors.textMuted }]}>{t('common.total')}</Text>
          <MoneyText value={total} currency={currency} />
        </View>
      </Card>

      <SectionTitle title={t('photo.add')} />
      <PhotoPicker entityType="purchase" entityId={entityId} />

      <Button label={t('common.save')} onPress={() => void submit()} loading={busy} fullWidth />
    </Screen>
  );
}
