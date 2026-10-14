import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useCallback, useState } from 'react';
import { Text } from 'react-native';

import { dec, localDateString } from '@sbm/domain';

import { useAuth } from '../../auth/AuthProvider';
import { useActor } from '../../auth/useActor';
import { Button, Card, Field, Notice, NumberInput, OfflineCapabilityNote, PhotoPicker, Screen, SectionTitle, Select } from '../../components';
import { localCycles, localProducts, recordHarvest } from '../../offline/repository';
import { useI18n } from '../../i18n';
import { useAsyncData } from '../../lib/useAsyncData';
import { useNetwork } from '../../lib/network';
import { useSync } from '../../lib/useSync';
import { useTheme } from '../../theme';
import type { FarmingStackParamList } from '../../navigation/types';

type Props = NativeStackScreenProps<FarmingStackParamList, 'HarvestForm'>;

/**
 * Record a harvest.
 *
 * The costing is **not** computed here: the server assigns the batch's cost to the
 * harvested quantity with `assignHarvestCost` (planned-yield pro-rata by default),
 * posts the journal and turns the output into sellable stock. The phone only
 * collects the facts, which is the right split — a client must never invent a cost
 * per unit.
 *
 * The copy repeats the server's own accounting note: unsold harvest stays
 * inventory; profit is recognised only when the output is sold.
 */
export function HarvestFormScreen({ navigation, route }: Props) {
  const { t } = useI18n();
  const { business } = useAuth();
  const actor = useActor();
  const { online } = useNetwork();
  const { syncNow } = useSync();
  const { colors, typography, spacing } = useTheme();

  const { cycleId } = route.params;
  const timezone = business?.timezone ?? 'Asia/Dhaka';

  const [entityId] = useState(() => globalThis.crypto.randomUUID());
  const [occurredOn, setOccurredOn] = useState(localDateString(new Date(), timezone));
  const [quantity, setQuantity] = useState('0');
  const [unit, setUnit] = useState('kg');
  const [method, setMethod] = useState<'PLANNED_YIELD_PRORATA' | 'CLOSING_REMAINDER'>('PLANNED_YIELD_PRORATA');
  const [productId, setProductId] = useState<string | null>(null);
  const [grade, setGrade] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loader = useCallback(async () => {
    const [cycles, products] = await Promise.all([localCycles(), localProducts({})]);
    return {
      cycle: cycles.find((entry) => entry.id === cycleId) ?? null,
      outputs: products.filter((product) => product.kind === 'OUTPUT' || product.kind === 'PRODUCT'),
    };
  }, [cycleId]);

  const { data } = useAsyncData(loader, [loader]);

  const submit = async () => {
    setError(null);
    if (!actor) return;
    if (!dec(quantity).isPositive() || unit.trim() === '') {
      setError(t('common.quantity'));
      return;
    }
    setBusy(true);
    try {
      await recordHarvest(actor, {
        aggregateId: entityId,
        cycleId,
        occurredOn,
        quantity,
        unit,
        method,
        ...(productId ? { productId } : {}),
        ...(grade.trim() ? { grade: grade.trim() } : {}),
        ...(notes.trim() ? { notes: notes.trim() } : {}),
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
    <Screen title={t('farming.harvest')} subtitle={data?.cycle?.title ?? business?.name}>
      {!online ? <OfflineCapabilityNote /> : null}
      {error ? <Notice tone="danger" body={error} /> : null}
      <Notice tone="info" body="Unsold harvest stays in finished-goods inventory; profit is recognised only when sold." />

      <Card>
        <Field label={t('common.date')} value={occurredOn} onChangeText={setOccurredOn} note="YYYY-MM-DD" required />
        <NumberInput label={t('common.quantity')} value={quantity} onChange={(value) => setQuantity(value ?? '0')} mode="quantity" required />
        <Field label={t('common.unit')} value={unit} onChangeText={setUnit} required />
        <Select
          label={t('common.type')}
          value={method}
          options={[
            { value: 'PLANNED_YIELD_PRORATA', label: 'Planned yield pro-rata', note: 'Default: assigns cost in proportion to the planned output' },
            { value: 'CLOSING_REMAINDER', label: 'Closing remainder', note: 'Assigns everything left in the batch' },
          ]}
          onChange={(value) => setMethod(value as typeof method)}
        />
        <Select
          label={t('common.product')}
          value={productId ?? ''}
          options={[
            { value: '', label: t('common.noneSelected') },
            ...(data?.outputs ?? []).map((product) => ({ value: product.id, label: `${product.name} (${product.unit})` })),
          ]}
          onChange={(value) => setProductId(value === '' ? null : value)}
          note="The output product receives the harvested stock at the assigned cost per unit"
        />
        <Field label={t('common.category')} value={grade} onChangeText={setGrade} note="Grade" />
        <Field label={t('common.notes')} value={notes} onChangeText={setNotes} multiline />
      </Card>

      <SectionTitle title={t('photo.add')} />
      <PhotoPicker entityType="harvest" entityId={entityId} />

      <Button label={t('common.save')} onPress={() => void submit()} loading={busy} fullWidth />
      <Text style={[typography.caption, { color: colors.textMuted, marginTop: spacing.md }]}>{t('offline.coreWorksOffline')}</Text>
    </Screen>
  );
}
