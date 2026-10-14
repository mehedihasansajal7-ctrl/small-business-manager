import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useCallback, useMemo, useState } from 'react';
import { Text } from 'react-native';

import * as api from '../../api/endpoints';
import { describeError } from '../../api/client';
import { useAuth } from '../../auth/AuthProvider';
import { Button, Card, Field, Notice, NumberInput, Screen, SectionTitle, Segmented, Select, Toggle } from '../../components';
import { localMovements, localProducts } from '../../offline/repository';
import { useI18n } from '../../i18n';
import { useAsyncData } from '../../lib/useAsyncData';
import { useNetwork } from '../../lib/network';
import { useSync } from '../../lib/useSync';
import { useTheme } from '../../theme';
import type { InventoryStackParamList } from '../../navigation/types';

type Props = NativeStackScreenProps<InventoryStackParamList, 'StockAdjust'>;

/**
 * Stock adjustment — **online only, and labelled as such**.
 *
 * Why this screen is the exception in an otherwise offline-first app: the server's
 * `SyncService.applyEvent` has no `stock.adjust` case, so an adjustment queued in
 * the outbox would come back `REJECTED / UNKNOWN_EVENT`. `POST /api/inventory/adjust`
 * exists and does the job properly — it records a real movement in the ledger,
 * requires `inventory.adjust`, and requires both `inventory.adjust.approve` **and**
 * a written reason before it will let stock go negative.
 *
 * The form mirrors those rules locally so the user is never surprised by a round
 * trip: the reason must be at least 5 characters, and the negative-stock override
 * is disabled unless the role holds the approval permission.
 */
export function StockAdjustScreen({ navigation, route }: Props) {
  const { t } = useI18n();
  const { business, can } = useAuth();
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
    if (!online) {
      setError(t('auth.needInternet'));
      return;
    }
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
      await api.adjustStock({
        itemId,
        direction,
        quantity,
        unit,
        unitCost,
        reason: reason.trim(),
        currency,
        ...(allowNegative ? { allowNegative: true } : {}),
      });
      // The adjustment is applied server-side, so pull the new ledger rows.
      await syncNow({ pullOnly: true });
      navigation.goBack();
    } catch (caught) {
      setError(describeError(caught).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen title={t('inventory.adjust')} subtitle={business?.name}>
      {!online ? <Notice tone="warning" body={t('auth.needInternet')} /> : null}
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
        <Text style={[typography.caption, { color: colors.textMuted }]}>
          {t('common.unit')}: {unit}
        </Text>
      </Card>

      <Card>
        <Field label={t('inventory.reason')} value={reason} onChangeText={setReason} multiline required note={t('inventory.reasonHint')} />
        <Toggle
          label={t('sales.negativeStock')}
          value={allowNegative}
          onChange={setAllowNegative}
          note={t('sales.negativeHint')}
          disabled={!can('inventory.adjust.approve')}
        />
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

      <Button label={t('common.save')} onPress={() => void submit()} loading={busy} disabled={!online} fullWidth />
      <Text style={[typography.caption, { color: colors.textMuted, marginTop: spacing.md }]}>{t('auth.needInternet')}</Text>
    </Screen>
  );
}
