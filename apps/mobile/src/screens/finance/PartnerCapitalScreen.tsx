import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useCallback, useState } from 'react';
import { Text } from 'react-native';

import { STANDARD_ACCOUNTS, dec, localDateString } from '@sbm/domain';

import { useAuth } from '../../auth/AuthProvider';
import { useActor } from '../../auth/useActor';
import * as api from '../../api/endpoints';
import { describeError } from '../../api/client';
import { Button, Card, Field, ListRow, Notice, NumberInput, OfflineCapabilityNote, Screen, SectionTitle, Segmented, Select } from '../../components';
import { recordPartnerCapital } from '../../offline/repository';
import { useI18n } from '../../i18n';
import { useAsyncData } from '../../lib/useAsyncData';
import { useNetwork } from '../../lib/network';
import { useSync } from '../../lib/useSync';
import { useTheme } from '../../theme';
import type { FinanceStackParamList } from '../../navigation/types';

type Props = NativeStackScreenProps<FinanceStackParamList, 'PartnerCapital'>;

/**
 * Partner capital: contributions and withdrawals.
 *
 * The server treats capital as **equity, never revenue** — so this screen explains
 * that in the copy and never shows a "profit" hint.
 *
 * Offline behaviour follows the server's own rules exactly:
 *  - a member may always record **their own** contribution/withdrawal
 *    (`partner_capital.view` is enough), so self-recording works with no network;
 *  - recording for *another* partner needs the member list, which is not part of
 *    the offline mirror, so that path requires the internet and says so.
 */
export function PartnerCapitalScreen({ navigation }: Props) {
  const { t } = useI18n();
  const { business, can } = useAuth();
  const actor = useActor();
  const { online } = useNetwork();
  const { syncNow } = useSync();
  const { colors, typography, spacing } = useTheme();

  const currency = business?.currency ?? 'BDT';
  const timezone = business?.timezone ?? 'Asia/Dhaka';
  const selfMemberId = business?.member.id ?? null;

  const [kind, setKind] = useState<'CONTRIBUTION' | 'WITHDRAWAL'>('CONTRIBUTION');
  const [documentDate, setDocumentDate] = useState(localDateString(new Date(), timezone));
  const [amount, setAmount] = useState('0');
  const [memberId, setMemberId] = useState<string | null>(selfMemberId);
  const [accountCode, setAccountCode] = useState('1000');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Members are only available online; the mirror deliberately does not carry them
  // (membership changes are online-only on the server too).
  const membersLoader = useCallback(async () => {
    if (!online || !can('member.view')) return [];
    try {
      return await api.listMembers();
    } catch {
      return [];
    }
  }, [online, can]);
  const { data: members } = useAsyncData(membersLoader, [membersLoader]);

  const submit = async () => {
    setError(null);
    if (!actor || !memberId) {
      setError(t('finance.partner'));
      return;
    }
    if (!dec(amount).isPositive()) {
      setError(t('common.amount'));
      return;
    }
    setBusy(true);
    try {
      await recordPartnerCapital(actor, {
        memberId,
        kind,
        documentDate,
        currency,
        amount,
        accountCode,
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      if (online) void syncNow();
      navigation.goBack();
    } catch (caught) {
      setError(describeError(caught).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen title={t('finance.capital')} subtitle={business?.name}>
      {!online ? <OfflineCapabilityNote /> : null}
      {error ? <Notice tone="danger" body={error} /> : null}
      <Notice tone="info" body={t('finance.capital') + ': ' + t('reports.accrualNote')} />

      <Segmented
        options={[
          { value: 'CONTRIBUTION' as const, label: t('finance.contribution') },
          { value: 'WITHDRAWAL' as const, label: t('finance.withdrawal') },
        ]}
        value={kind}
        onChange={setKind}
      />

      <Card>
        <Field label={t('common.date')} value={documentDate} onChangeText={setDocumentDate} note="YYYY-MM-DD" required />
        <NumberInput label={t('common.amount')} value={amount} onChange={(value) => setAmount(value ?? '0')} mode="money" currency={currency} required />
        <Select
          label={t('finance.partner')}
          value={memberId ?? ''}
          options={
            members && members.length > 0
              ? members.map((member) => ({ value: member.id, label: member.displayName, note: `${member.role} • ${member.email}` }))
              : selfMemberId
                ? [{ value: selfMemberId, label: business?.member.displayName ?? t('finance.partner'), note: business?.member.role }]
                : []
          }
          onChange={(value) => setMemberId(value)}
          required
          note={online ? undefined : t('team.needsInternet')}
        />
        <Select
          label={t('common.account')}
          value={accountCode}
          options={STANDARD_ACCOUNTS.filter((account) => ['1000', '1010', '1020'].includes(account.code)).map((account) => ({ value: account.code, label: `${account.code} — ${account.name}` }))}
          onChange={setAccountCode}
        />
        <Field label={t('common.notes')} value={note} onChangeText={setNote} multiline />
      </Card>

      <SectionTitle title={t('finance.accounts')} />
      {members && members.length > 0 ? (
        <Card>
          {members.map((member) => (
            <ListRow key={member.id} title={member.displayName} subtitle={`${member.role} • ${member.email}`} />
          ))}
        </Card>
      ) : (
        <Text style={[typography.caption, { color: colors.textMuted, marginBottom: spacing.md }]}>{t('team.needsInternet')}</Text>
      )}

      <Button label={t('common.save')} onPress={() => void submit()} loading={busy} fullWidth />
    </Screen>
  );
}
