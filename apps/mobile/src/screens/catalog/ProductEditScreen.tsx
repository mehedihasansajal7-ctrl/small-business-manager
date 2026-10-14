import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useEffect, useState } from 'react';
import { Text } from 'react-native';

import { useActor } from '../../auth/useActor';
import { useAuth } from '../../auth/AuthProvider';
import { Button, Card, Field, Notice, NumberInput, OfflineCapabilityNote, Screen, SectionTitle, Select, Toggle } from '../../components';
import { localProducts, localUnits, upsertProduct } from '../../offline/repository';
import { useI18n } from '../../i18n';
import { useNetwork } from '../../lib/network';
import { useSync } from '../../lib/useSync';
import { useTheme } from '../../theme';
import type { MoreStackParamList } from '../../navigation/types';

type Props = NativeStackScreenProps<MoreStackParamList, 'ProductEdit'>;

const KINDS = ['PRODUCT', 'SERVICE', 'INPUT', 'OUTPUT', 'LIVESTOCK'] as const;

/**
 * Create or edit a product.
 *
 * `products` is a revision-checked aggregate on the server, so an edit carries the
 * `revision` we loaded as `baseRevision`. If a partner changed the row first the
 * server answers `CONFLICT` and the change lands in the Sync screen for a human
 * decision — never a silent overwrite.
 */
export function ProductEditScreen({ navigation, route }: Props) {
  const { t } = useI18n();
  const { business, can } = useAuth();
  const actor = useActor();
  const { online } = useNetwork();
  const { syncNow } = useSync();
  const { colors, typography, spacing } = useTheme();

  const productId = route.params?.productId;
  const currency = business?.currency ?? 'BDT';

  const [name, setName] = useState('');
  const [nameBn, setNameBn] = useState('');
  const [kind, setKind] = useState<string>('PRODUCT');
  const [unit, setUnit] = useState('kg');
  const [salePrice, setSalePrice] = useState('0');
  const [purchasePrice, setPurchasePrice] = useState('0');
  const [reorderLevel, setReorderLevel] = useState('0');
  const [trackLots, setTrackLots] = useState(false);
  const [baseRevision, setBaseRevision] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const unitOptions = localUnits().map((entry) => ({ value: entry.code, label: `${entry.name} (${entry.code})`, note: entry.nameBn }));

  // Load the existing row from the mirror so the form is pre-filled offline.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!productId) return;
      const products = await localProducts({});
      const existing = products.find((entry) => entry.id === productId);
      if (!existing || cancelled) return;
      setName(existing.name);
      setNameBn(existing.nameBn ?? '');
      setKind(existing.kind);
      setUnit(existing.unit);
      setSalePrice(existing.salePrice ?? '0');
      setPurchasePrice(existing.purchasePrice ?? '0');
      setReorderLevel(existing.reorderLevel ?? '0');
      setTrackLots(existing.trackLots);
      setBaseRevision(existing.revision);
    })();
    return () => {
      cancelled = true;
    };
  }, [productId]);

  const submit = async () => {
    setError(null);
    if (!actor) return;
    if (name.trim().length < 2 || unit === '') {
      setError(t('common.required'));
      return;
    }
    setBusy(true);
    try {
      await upsertProduct(actor, {
        ...(productId ? { id: productId, baseRevision } : {}),
        name: name.trim(),
        unit,
        kind,
        ...(nameBn.trim() ? { nameBn: nameBn.trim() } : {}),
        salePrice,
        purchasePrice,
        reorderLevel,
        trackLots,
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
    <Screen title={productId ? t('common.edit') : t('products.new')} subtitle={business?.name}>
      {!online ? <OfflineCapabilityNote /> : null}
      {error ? <Notice tone="danger" body={error} /> : null}

      <Card>
        <Field label={t('common.name')} value={name} onChangeText={setName} required />
        <Field label={t('products.nameBn')} value={nameBn} onChangeText={setNameBn} />
        <Select label={t('products.kind')} value={kind} options={KINDS.map((value) => ({ value, label: value }))} onChange={setKind} />
        <Select label={t('common.unit')} value={unit} options={unitOptions} onChange={setUnit} required />
        {unitOptions.length === 0 ? <Text style={[typography.caption, { color: colors.textMuted }]}>{t('common.loading')}</Text> : null}
      </Card>

      <SectionTitle title={t('common.price')} />
      <Card>
        <NumberInput label={t('products.salePrice')} value={salePrice} onChange={(value) => setSalePrice(value ?? '0')} mode="money" currency={currency} />
        <NumberInput
          label={t('products.purchasePrice')}
          value={purchasePrice}
          onChange={(value) => setPurchasePrice(value ?? '0')}
          mode="money"
          currency={currency}
          disabled={!can('purchase.cost.view')}
          note={can('purchase.cost.view') ? undefined : t('common.restrictedBody')}
        />
        <NumberInput label={t('inventory.reorderLevel')} value={reorderLevel} onChange={(value) => setReorderLevel(value ?? '0')} mode="quantity" />
        <Toggle label={t('products.trackLots')} value={trackLots} onChange={setTrackLots} />
      </Card>

      <Button label={t('common.save')} onPress={() => void submit()} loading={busy} disabled={!can('product.manage')} fullWidth />
      {!can('product.manage') ? <Text style={[typography.caption, { color: colors.textMuted, marginTop: spacing.md }]}>{t('common.restrictedBody')}</Text> : null}
    </Screen>
  );
}
