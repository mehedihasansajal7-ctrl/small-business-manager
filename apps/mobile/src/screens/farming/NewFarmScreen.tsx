import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useState } from 'react';
import { Text } from 'react-native';

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

type Props = NativeStackScreenProps<FarmingStackParamList, 'NewFarm'>;

/**
 * Create a farm.
 *
 * **Online only**, by design and by contract: `SyncService.applyEvent` handles
 * `cycle.create` and the operational events, but there is no `farm.create` event
 * type, so queueing one offline would produce an `UNKNOWN_EVENT` rejection. The
 * screen disables the button and explains why.
 */
export function NewFarmScreen({ navigation }: Props) {
  const { t } = useI18n();
  const { business } = useAuth();
  const { online } = useNetwork();
  const { syncNow } = useSync();
  const { colors, typography, spacing } = useTheme();

  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [area, setArea] = useState('0');
  const [areaUnit, setAreaUnit] = useState('decimal');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const areaUnits = localUnits('AREA').map((unit) => ({ value: unit.code, label: `${unit.name} (${unit.code})` }));

  const submit = async () => {
    setError(null);
    if (name.trim().length < 2) {
      setError(t('common.required'));
      return;
    }
    setBusy(true);
    try {
      await api.createFarm({ name: name.trim(), area, areaUnit, ...(address.trim() ? { address: address.trim() } : {}) });
      void syncNow({ pullOnly: true });
      navigation.goBack();
    } catch (caught) {
      setError(describeError(caught).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen title={t('farming.newFarm')} subtitle={business?.name}>
      {!online ? <Notice tone="warning" body={t('auth.needInternet')} /> : null}
      {error ? <Notice tone="danger" body={error} /> : null}

      <Card>
        <Field label={t('common.name')} value={name} onChangeText={setName} required />
        <Field label={t('common.address')} value={address} onChangeText={setAddress} multiline />
        <NumberInput label={t('common.quantity')} value={area} onChange={(value) => setArea(value ?? '0')} mode="quantity" note="Area" />
        <Select label={t('common.unit')} value={areaUnit} options={areaUnits} onChange={setAreaUnit} />
      </Card>

      <Button label={t('common.save')} onPress={() => void submit()} loading={busy} disabled={!online} fullWidth />
      <Text style={[typography.caption, { color: colors.textMuted, marginTop: spacing.md }]}>{t('auth.needInternet')}</Text>
    </Screen>
  );
}
