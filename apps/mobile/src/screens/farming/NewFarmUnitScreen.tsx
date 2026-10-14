import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useState } from 'react';
import { Text } from 'react-native';

import { FARM_UNIT_KINDS } from '@sbm/domain';

import * as api from '../../api/endpoints';
import { describeError } from '../../api/client';
import { useAuth } from '../../auth/AuthProvider';
import { Button, Card, Field, Notice, NumberInput, Screen, Select } from '../../components';
import { localUnits } from '../../offline/repository';
import { useI18n } from '../../i18n';
import { useNetwork } from '../../lib/network';
import { useSync } from '../../lib/useSync';
import { useTheme } from '../../theme';
import type { FarmingStackParamList } from '../../navigation/types';

type Props = NativeStackScreenProps<FarmingStackParamList, 'NewFarmUnit'>;

/** Create a farm unit. Online only (no `farm_unit.create` outbox event exists). */
export function NewFarmUnitScreen({ navigation, route }: Props) {
  const { t, language } = useI18n();
  const { business } = useAuth();
  const { online } = useNetwork();
  const { syncNow } = useSync();
  const { colors, typography, spacing } = useTheme();

  const { farmId } = route.params;
  const [kind, setKind] = useState('PLOT');
  const [name, setName] = useState('');
  const [capacity, setCapacity] = useState('0');
  const [capacityUnit, setCapacityUnit] = useState('pcs');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const kindOptions = FARM_UNIT_KINDS.map((entry) => ({ value: entry.kind, label: language === 'bn' ? entry.nameBn : entry.name }));
  const unitOptions = localUnits().map((unit) => ({ value: unit.code, label: `${unit.name} (${unit.code})` }));

  const submit = async () => {
    setError(null);
    if (name.trim().length < 2) {
      setError(t('common.required'));
      return;
    }
    setBusy(true);
    try {
      await api.createFarmUnit({ farmId, kind, name: name.trim(), capacity, capacityUnit });
      void syncNow({ pullOnly: true });
      navigation.goBack();
    } catch (caught) {
      setError(describeError(caught).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen title={t('farming.newUnit')} subtitle={business?.name}>
      {!online ? <Notice tone="warning" body={t('auth.needInternet')} /> : null}
      {error ? <Notice tone="danger" body={error} /> : null}

      <Card>
        <Select label={t('common.type')} value={kind} options={kindOptions} onChange={setKind} required />
        <Field label={t('common.name')} value={name} onChangeText={setName} required />
        <NumberInput label={t('common.quantity')} value={capacity} onChange={(value) => setCapacity(value ?? '0')} mode="quantity" note="Capacity" />
        <Select label={t('common.unit')} value={capacityUnit} options={unitOptions} onChange={setCapacityUnit} />
      </Card>

      <Button label={t('common.save')} onPress={() => void submit()} loading={busy} disabled={!online} fullWidth />
      <Text style={[typography.caption, { color: colors.textMuted, marginTop: spacing.md }]}>{t('auth.needInternet')}</Text>
    </Screen>
  );
}
