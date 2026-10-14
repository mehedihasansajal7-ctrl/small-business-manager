import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useMemo, useState } from 'react';
import { Text } from 'react-native';

import { STANDARD_ACCOUNTS, dec, localDateString } from '@sbm/domain';

import { useAuth } from '../../auth/AuthProvider';
import { useActor } from '../../auth/useActor';
import { Button, Card, Field, Notice, NumberInput, OfflineCapabilityNote, Screen, Select } from '../../components';
import { recordIncome, recordExpense } from '../../offline/repository';
import { useI18n } from '../../i18n';
import { useNetwork } from '../../lib/network';
import { useSync } from '../../lib/useSync';
import { useTheme } from '../../theme';
import type { FinanceStackParamList } from '../../navigation/types';

type Props = NativeStackScreenProps<FinanceStackParamList, 'IncomeExpense'>;

/**
 * Income and expense.
 *
 * The server validates that the chosen `categoryAccount` really is a REVENUE
 * account for income and an EXPENSE account for expense; the picker is therefore
 * filtered by type here as well, so an invalid pair cannot even be assembled.
 * If it somehow were, the server's `REJECTED` answer lands in the Sync screen.
 */
export function IncomeExpenseScreen({ navigation, route }: Props) {
  const { t } = useI18n();
  const { business } = useAuth();
  const actor = useActor();
  const { online } = useNetwork();
  const { syncNow } = useSync();
  const { colors, typography, spacing } = useTheme();

  const kind = route.params.kind;
  const currency = business?.currency ?? 'BDT';
  const timezone = business?.timezone ?? 'Asia/Dhaka';

  const [documentDate, setDocumentDate] = useState(localDateString(new Date(), timezone));
  const [amount, setAmount] = useState('0');
  const [categoryAccount, setCategoryAccount] = useState(kind === 'INCOME' ? '4100' : '5170');
  const [accountCode, setAccountCode] = useState('1000');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const categoryOptions = useMemo(
    () =>
      STANDARD_ACCOUNTS.filter((account) => account.type === (kind === 'INCOME' ? 'REVENUE' : 'EXPENSE'))
        .filter((account) => !account.contra)
        .map((account) => ({ value: account.code, label: `${account.code} — ${account.name}`, note: account.nameBn })),
    [kind],
  );

  const accountOptions = STANDARD_ACCOUNTS.filter((account) => ['1000', '1010', '1020'].includes(account.code)).map((account) => ({
    value: account.code,
    label: `${account.code} — ${account.name}`,
  }));

  const submit = async () => {
    setError(null);
    if (!actor) return;
    if (!dec(amount).isPositive()) {
      setError(t('common.amount'));
      return;
    }
    setBusy(true);
    try {
      const payload = { documentDate, currency, amount, categoryAccount, accountCode, note: note.trim() || undefined };
      if (kind === 'INCOME') await recordIncome(actor, payload);
      else await recordExpense(actor, payload);
      if (online) void syncNow();
      navigation.goBack();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('common.error'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen title={kind === 'INCOME' ? t('finance.income') : t('finance.expense')} subtitle={business?.name}>
      {!online ? <OfflineCapabilityNote /> : null}
      {error ? <Notice tone="danger" body={error} /> : null}

      <Card>
        <Field label={t('common.date')} value={documentDate} onChangeText={setDocumentDate} note="YYYY-MM-DD" required />
        <NumberInput label={t('common.amount')} value={amount} onChange={(value) => setAmount(value ?? '0')} mode="money" currency={currency} required />
        <Select label={t('common.category')} value={categoryAccount} options={categoryOptions} onChange={setCategoryAccount} required />
        <Select label={t('common.account')} value={accountCode} options={accountOptions} onChange={setAccountCode} note={t('finance.cash')} />
        <Field label={t('common.notes')} value={note} onChangeText={setNote} multiline />
      </Card>

      <Button label={t('common.save')} onPress={() => void submit()} loading={busy} fullWidth />
      <Text style={[typography.caption, { color: colors.textMuted, marginTop: spacing.md }]}>{t('reports.accrualNote')}</Text>
    </Screen>
  );
}
