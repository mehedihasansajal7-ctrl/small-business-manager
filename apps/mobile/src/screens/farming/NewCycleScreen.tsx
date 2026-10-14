import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Text } from 'react-native';

import { FARMING_TYPES, localDateString } from '@sbm/domain';

import { useAuth } from '../../auth/AuthProvider';
import { useActor } from '../../auth/useActor';
import { Button, Card, Field, Notice, NumberInput, OfflineCapabilityNote, Screen, SectionTitle, Select } from '../../components';
import { createCycle, localFarms, localUnits } from '../../offline/repository';
import { useI18n } from '../../i18n';
import { useAsyncData } from '../../lib/useAsyncData';
import { useNetwork } from '../../lib/network';
import { useSync } from '../../lib/useSync';
import { useTheme } from '../../theme';
import type { FarmingStackParamList } from '../../navigation/types';

type Props = NativeStackScreenProps<FarmingStackParamList, 'NewCycle'>;

/**
 * Start a production cycle.
 *
 * Offline-capable: `cycle.create` is one of the event types `SyncService` applies,
 * so a cycle can be started the moment the seed goes in the ground, connection or
 * not.
 */
export function NewCycleScreen({ navigation, route }: Props) {
  const { t, language } = useI18n();
  const { business } = useAuth();
  const actor = useActor();
  const { online } = useNetwork();
  const { syncNow } = useSync();
  const { colors, typography, spacing } = useTheme();

  const currency = business?.currency ?? 'BDT';
  const timezone = business?.timezone ?? 'Asia/Dhaka';

  const [farmId, setFarmId] = useState(route.params?.farmId ?? '');
  const [unitId, setUnitId] = useState(route.params?.unitId ?? '');
  const [farmingType, setFarmingType] = useState('CROP');
  const [title, setTitle] = useState('');
  const [cropOrSpecies, setCropOrSpecies] = useState('');
  const [season, setSeason] = useState('');
  const [startDate, setStartDate] = useState(localDateString(new Date(), timezone));
  const [expectedEndDate, setExpectedEndDate] = useState('');
  const [plannedOutput, setPlannedOutput] = useState('0');
  const [plannedOutputUnit, setPlannedOutputUnit] = useState('kg');
  const [startingPopulation, setStartingPopulation] = useState('0');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const farmsLoader = useCallback(() => localFarms(), []);
  const { data: farms } = useAsyncData(farmsLoader, [farmsLoader]);

  const unitOptions = useMemo(() => {
    const farm = (farms ?? []).find((entry) => entry.id === farmId);
    return (farm?.units ?? []).map((unit) => ({ value: unit.id, label: `${unit.name} (${unit.kind})` }));
  }, [farms, farmId]);

  // Keep the unit selection valid when the farm changes.
  useEffect(() => {
    if (unitOptions.length > 0 && !unitOptions.some((option) => option.value === unitId)) setUnitId(unitOptions[0]?.value ?? '');
  }, [unitOptions, unitId]);

  const submit = async () => {
    setError(null);
    if (!actor) return;
    if (!farmId || !unitId || title.trim().length < 2) {
      setError(t('common.required'));
      return;
    }
    setBusy(true);
    try {
      await createCycle(actor, {
        farmId,
        unitId,
        farmingType,
        title: title.trim(),
        startDate,
        ...(cropOrSpecies.trim() ? { cropOrSpecies: cropOrSpecies.trim() } : {}),
        ...(season.trim() ? { season: season.trim() } : {}),
        ...(expectedEndDate.trim() ? { expectedEndDate: expectedEndDate.trim() } : {}),
        plannedOutput,
        plannedOutputUnit,
        startingPopulation,
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
    <Screen title={t('farming.newCycle')} subtitle={business?.name}>
      {!online ? <OfflineCapabilityNote /> : null}
      {error ? <Notice tone="danger" body={error} /> : null}

      <Card>
        <Select
          label={t('farming.farms')}
          value={farmId}
          options={(farms ?? []).map((farm) => ({ value: farm.id, label: farm.name }))}
          onChange={setFarmId}
          required
          note={(farms ?? []).length === 0 ? t('auth.needInternet') : undefined}
        />
        <Select label={t('farming.units')} value={unitId} options={unitOptions} onChange={setUnitId} required />
        <Select
          label={t('common.type')}
          value={farmingType}
          options={FARMING_TYPES.map((entry) => ({ value: entry.type, label: language === 'bn' ? `${entry.nameBn} (${entry.type})` : `${entry.name} (${entry.type})` }))}
          onChange={setFarmingType}
          required
        />
        <Field label={t('common.name')} value={title} onChangeText={setTitle} required />
        <Field label={t('common.description')} value={cropOrSpecies} onChangeText={setCropOrSpecies} note="Crop / species / breed" />
        <Field label={t('common.date')} value={startDate} onChangeText={setStartDate} note="YYYY-MM-DD" required />
        <Field label={t('common.to')} value={expectedEndDate} onChangeText={setExpectedEndDate} note="YYYY-MM-DD" />
        <Field label={t('common.reference')} value={season} onChangeText={setSeason} note="Season" />
      </Card>

      <SectionTitle title={t('farming.plannedOutput')} />
      <Card>
        <NumberInput label={t('farming.plannedOutput')} value={plannedOutput} onChange={(value) => setPlannedOutput(value ?? '0')} mode="quantity" />
        <Select label={t('common.unit')} value={plannedOutputUnit} options={localUnits().map((unit) => ({ value: unit.code, label: `${unit.name} (${unit.code})` }))} onChange={setPlannedOutputUnit} />
        <NumberInput label={t('farming.startingPopulation')} value={startingPopulation} onChange={(value) => setStartingPopulation(value ?? '0')} mode="quantity" />
        <Text style={[typography.caption, { color: colors.textMuted }]}>{currency} • {timezone}</Text>
      </Card>

      <Button label={t('common.save')} onPress={() => void submit()} loading={busy} fullWidth />
      <Text style={[typography.caption, { color: colors.textMuted, marginTop: spacing.md }]}>{t('offline.coreWorksOffline')}</Text>
    </Screen>
  );
}
