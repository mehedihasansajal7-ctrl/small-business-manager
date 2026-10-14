import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useState } from 'react';
import { Text } from 'react-native';

import { STANDARD_ACCOUNTS, dec, localDateString } from '@sbm/domain';

import { useAuth } from '../../auth/AuthProvider';
import { useActor } from '../../auth/useActor';
import { Button, Card, Field, Notice, NumberInput, OfflineCapabilityNote, Screen, Select } from '../../components';
import { recordTransfer } from '../../offline/repository';
import { useI18n } from '../../i18n';
import { useNetwork } from '../../lib/network';
import { useSync } from '../../lib/useSync';
import { useTheme } from '../../theme';
import type { FinanceStackParamList } from '../../navigation/types';

type Props = NativeStackScreenProps<FinanceStackParamList, 'Transfer'>;

/** Move money between two cash/bank accounts. Queued offline like every write. */
export function TransferScreen({ navigation }: Props) {
  const { t } = useI18n();
  const { business } = useAuth();
  const actor = useActor();
  const { online } = useNetwork();
  const { syncNow } = useSync();
  const { colors, typography, spacing } = useTheme();

  const currency = business?.currency ?? 'BDT';
  const timezone = business?.timezone ?? 'Asia/Dhaka';
  const accountOptions = STANDARD_ACCOUNTS.filter((account) => ['1000', '1010', '1020'].includes(account.code)).map((account) => ({
    value: account.code,
    label: `${account.code} — ${account.name}`,
  }));

  const [documentDate, setDocumentDate] = useState(localDateString(new Date(), timezone));
  const [amount, setAmount] = useState('0');
  const [fromAccount, setFromAccount] = useState('1000');
  const [toAccount, setToAccount] = useState('1010');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setError(null);
    if (!actor) return;
    if (!dec(amount).isPositive()) {
      setError(t('common.amount'));
      return;
    }
    if (fromAccount === toAccount) {
      setError(t('finance.fromAccount') + ' ≠ ' + t('finance.toAccount'));
      return;
    }
    setBusy(true);
    try {
      await recordTransfer(actor, { documentDate, currency, amount, fromAccount, toAccount, note: note.trim() || undefined });
      if (online) void syncNow();
      navigation.goBack();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('common.error'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen title={t('finance.transfer')} subtitle={business?.name}>
      {!online ? <OfflineCapabilityNote /> : null}
      {error ? <Notice tone="danger" body={error} /> : null}

      <Card>
        <Field label={t('common.date')} value={documentDate} onChangeText={setDocumentDate} note="YYYY-MM-DD" required />
        <NumberInput label={t('common.amount')} value={amount} onChange={(value) => setAmount(value ?? '0')} mode="money" currency={currency} required />
        <Select label={t('finance.fromAccount')} value={fromAccount} options={accountOptions} onChange={setFromAccount} required />
        <Select label={t('finance.toAccount')} value={toAccount} options={accountOptions} onChange={setToAccount} required />
        <Field label={t('common.notes')} value={note} onChangeText={setNote} multiline />
      </Card>

      <Button label={t('common.save')} onPress={() => void submit()} loading={busy} fullWidth />
      <Text style={[typography.caption, { color: colors.textMuted, marginTop: spacing.md }]}>{t('offline.coreWorksOffline')}</Text>
    </Screen>
  );
}
