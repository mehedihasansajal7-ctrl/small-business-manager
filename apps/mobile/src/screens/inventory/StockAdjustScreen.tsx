import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useCallback, useMemo, useState } from 'react';
import { Text } from 'react-native';

import { useAuth } from '../../auth/AuthProvider';
import { useActor } from '../../auth/useActor';
import { Button, Card, Field, Notice, NumberInput, OfflineCapabilityNote, Screen, SectionTitle, Segmented, Select, Toggle } from '../../components';
import { adjustStock, localMovements, localProducts } from '../../offline/repository';
import { useI18n } from '../../i18n';
import { useAsyncData } from '../../lib/useAsyncData';
import { useNetwork } from '../../lib/network';
import { useSync } from '../../lib/useSync';
import { useTheme } from '../../theme';
import type { InventoryStackParamList } from '../../navigation/types';

type Props = NativeStackScreenProps<InventoryStackParamList, 'StockAdjust'>;

/**
 * Stock adjustment.
 *
 * The server requires a reason of at least 5 characters and refuses negative
 * stock unless the caller holds `inventory.adjust.approve` **and** supplies one;
 * this screen mirrors that contract instead of letting the user discover it over
 * a round trip. Adjustments are queued in the outbox like every other write.
 */
export function StockAdjustScreen({ navigation, route }: Props) {
  const { t } = useI18n();
  const { business, businessId, can } = useAuth();
  const actor = useActor();
  const { online } = useNetwork();
  const { syncNow } = useSync();
  const { colors, typography, spacing } = useTheme();

  const currency = business?.currency ?? 'BDT';
  const preselected = route.params?.itemId ?? '';

  const [itemId, setItemId] = useState(preselected);
  const [direction, setDirection] = useState<'IN' | 'OUT'>('IN');
  const [quantity, setQuantity] = useState('1');
  const [unit, setUnit] = useState('pcs');
  const [unitCost, setUnitCost] = useState('0');
  const [reason, setReason] = useState('');
  const [allowNegative, setAllowNegative] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const productsLoader = useCallback(() => localProducts({}), []);
  const movementsLoader = useCallback(async () => (itemId ? localMovements(itemId).then((rows) => rows.slice(0, 8)) : []), [itemId]);
  const { data: products } = useAsyncData(productsLoader, [productsLoader]);
  const { data: recent } = useAsyncData(movementsLoader, [movementsLoader]);

  const productOptions = useMemo(
    () => [{ value: '', label: t('common.noneSelected') }, ...(products ?? []).map((product) => ({ value: product.id, label: `${product.name} (${product.unit})` }))],
    [products, t],
  );

  const submit = async () => {
    setError(null);
    if (!actor) return;
    if (!itemId) {
      setError(t('common.product'));
      return;
    }
    if (reason.trim().length < 5) {
      setError(t('inventory.reasonHint'));
      return;
    }
    setBusy(true);
    try {
      await adjustStock(actor, {
        itemId,
        direction,
        quantity,
        unit,
        unitCost,
        reason: reason.trim(),
        currency,
        ...(allowNegative ? { allowNegative: true } : {}),
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
    <Screen title={t('inventory.adjust')} subtitle={business?.name}>
      {!online ? <OfflineCapabilityNote /> : null}
      {error ? <Notice tone="danger" body={error} /> : null}
      {!can('inventory.adjust') ? <Notice tone="warning" body={t('common.restrictedBody')} /> : null}

      <Card>
        <Select
          label={t('common.product')}
          value={itemId}
          options={productOptions}
          onChange={(value) => {
            setItemId(value);
            const product = (products ?? []).find((entry) => entry.id === value);
            if (product) setUnit(product.unit);
          }}
          required
        />
        <Segmented
          options={[
            { value: 'IN', label: t('inventory.in') },
            { value: 'OUT', label: t('inventory.out') },
          ]}
          value={direction}
          onChange={(value) => setDirection(value)}
        />
        <NumberInput label={t('common.quantity')} value={quantity} onChange={(value) => setQuantity(value ?? '0')} mode="quantity" required />
        <NumberInput label={t('common.cost')} value={unitCost} onChange={(value) => setUnitCost(value ?? '0')} mode="money" currency={currency} note={t('common.optional')} />
        <Text style={[typography.caption, { color: colors.textMuted }]}>{t('common.unit')}: {unit}</Text>
      </Card>

      <Card>
        <Field label={t('inventory.reason')} value={reason} onChangeText={setReason} multiline required note={t('inventory.reasonHint')} />
        <Toggle label={t('sales.negativeStock')} value={allowNegative} onChange={setAllowNegative} note={t('sales.negativeHint')} disabled={!can('inventory.adjust.approve')} />
      </Card>

      {recent && recent.length > 0 ? (
        <>
          <SectionTitle title={t('inventory.movements')} />
          {recent.map((movement) => (
            <Text key={movement.id} style={[typography.caption, { color: colors.textMuted, marginBottom: spacing.xs }]}>
              {movement.occurredAt} • {movement.direction} {movement.quantity} {movement.unit} • {movement.sourceType}
              {movement.reason ? ` • ${movement.reason}` : ''}
            </Text>
          ))}
        </>
      ) : null}

      <Button label={t('common.save')} onPress={() => void submit()} loading={busy} fullWidth />
      <Text style={[typography.caption, { color: colors.textMuted, marginTop: spacing.md }]}>{businessId ? t('inventory.balanceAsOf') : ''}</Text>
    </Screen>
  );
}
