import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useCallback, useState } from 'react';
import { Text } from 'react-native';

import { STANDARD_ACCOUNTS, dec, localDateString } from '@sbm/domain';

import { useAuth } from '../../auth/AuthProvider';
import { useActor } from '../../auth/useActor';
import { Button, Card, Field, Notice, NumberInput, OfflineCapabilityNote, Screen, Select } from '../../components';
import { localSuppliers, recordSupplierPayment } from '../../offline/repository';
import { useI18n } from '../../i18n';
import { useAsyncData } from '../../lib/useAsyncData';
import { useNetwork } from '../../lib/network';
import { useSync } from '../../lib/useSync';
import { useTheme } from '../../theme';
import type { FinanceStackParamList } from '../../navigation/types';

type Props = NativeStackScreenProps<FinanceStackParamList, 'Payment'>;

/** Money paid to a supplier against what we owe them. */
export function PaymentScreen({ navigation }: Props) {
  const { t } = useI18n();
  const { business } = useAuth();
  const actor = useActor();
  const { online } = useNetwork();
  const { syncNow } = useSync();
  const { colors, typography, spacing } = useTheme();

  const currency = business?.currency ?? 'BDT';
  const timezone = business?.timezone ?? 'Asia/Dhaka';

  const [documentDate, setDocumentDate] = useState(localDateString(new Date(), timezone));
  const [amount, setAmount] = useState('0');
  const [supplierId, setSupplierId] = useState<string | null>(null);
  const [accountCode, setAccountCode] = useState('1000');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const suppliersLoader = useCallback(() => localSuppliers(), []);
  const { data: suppliers } = useAsyncData(suppliersLoader, [suppliersLoader]);

  const submit = async () => {
    setError(null);
    if (!actor) return;
    if (!dec(amount).isPositive()) {
      setError(t('common.amount'));
      return;
    }
    setBusy(true);
    try {
      await recordSupplierPayment(actor, {
        documentDate,
        currency,
        amount,
        accountCode,
        ...(supplierId ? { supplierId } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
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
    <Screen title={t('finance.payment')} subtitle={business?.name}>
      {!online ? <OfflineCapabilityNote /> : null}
      {error ? <Notice tone="danger" body={error} /> : null}

      <Card>
        <Field label={t('common.date')} value={documentDate} onChangeText={setDocumentDate} note="YYYY-MM-DD" required />
        <NumberInput label={t('common.amount')} value={amount} onChange={(value) => setAmount(value ?? '0')} mode="money" currency={currency} required />
        <Select
          label={t('common.supplier')}
          value={supplierId ?? ''}
          options={[{ value: '', label: t('common.noneSelected') }, ...(suppliers ?? []).map((supplier) => ({ value: supplier.id, label: supplier.name, note: supplier.payable ? `${t('suppliers.outstanding')}: ${supplier.payable}` : undefined }))]}
          onChange={(value) => setSupplierId(value === '' ? null : value)}
          note={t('inventory.balanceAsOf')}
        />
        <Select
          label={t('common.account')}
          value={accountCode}
          options={STANDARD_ACCOUNTS.filter((account) => ['1000', '1010', '1020'].includes(account.code)).map((account) => ({ value: account.code, label: `${account.code} — ${account.name}` }))}
          onChange={setAccountCode}
        />
        <Field label={t('common.notes')} value={note} onChangeText={setNote} multiline />
      </Card>

      <Button label={t('common.save')} onPress={() => void submit()} loading={busy} fullWidth />
      <Text style={[typography.caption, { color: colors.textMuted, marginTop: spacing.md }]}>{t('inventory.balanceAsOf')}</Text>
    </Screen>
  );
}
