import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useCallback } from 'react';
import { Text, View } from 'react-native';

import { STANDARD_ACCOUNTS, dec } from '@sbm/domain';

import { useAuth } from '../../auth/AuthProvider';
import { Button, Card, MoneyText, Notice, OfflineBanner, PermissionGate, Screen, SectionTitle, Tag } from '../../components';
import { localAccountBalances } from '../../offline/repository';
import { useI18n } from '../../i18n';
import { useAsyncData, useReloadOnFocus } from '../../lib/useAsyncData';
import { useNetwork } from '../../lib/network';
import { useSync } from '../../lib/useSync';
import { useTheme } from '../../theme';
import type { FinanceStackParamList } from '../../navigation/types';
import type { Permission } from '@sbm/domain';

type Props = NativeStackScreenProps<FinanceStackParamList, 'FinanceHome'>;

/**
 * Finance home: the chart of accounts with balances computed from the mirrored
 * journal, plus the day-to-day money actions.
 *
 * Balances are derived with `Decimal` (debit − credit), exactly like
 * `Repository`/`GET /api/accounts` does server-side. Accounts whose balance a
 * partner may not see still appear (they are part of the chart of accounts), but
 * their figure is described as available after the next sync rather than guessed.
 */
export function FinanceHomeScreen({ navigation }: Props) {
  const { colors, typography, spacing } = useTheme();
  const { t } = useI18n();
  const { business, can } = useAuth();
  const { online } = useNetwork();
  const { summary, syncing, syncNow } = useSync();

  const currency = business?.currency ?? 'BDT';

  const loader = useCallback(async () => {
    const balances = await localAccountBalances(currency);
    return STANDARD_ACCOUNTS.map((account) => ({
      code: account.code,
      name: account.name,
      nameBn: account.nameBn ?? account.name,
      type: account.type,
      isCash: ['1000', '1010', '1020'].includes(account.code),
      balance: (balances.get(account.code) ?? dec('0')).toString(),
    }));
  }, [currency]);

  const { data, loading, reload } = useAsyncData(loader, [loader]);
  useReloadOnFocus(reload);

  const actions: readonly { key: keyof FinanceStackParamList; label: string; permission: Permission; params?: object }[] = [
    { key: 'IncomeExpense', label: t('finance.income'), permission: 'finance.manage', params: { kind: 'INCOME' } },
    { key: 'IncomeExpense', label: t('finance.expense'), permission: 'finance.manage', params: { kind: 'EXPENSE' } },
    { key: 'Receipt', label: t('finance.receipt'), permission: 'finance.manage' },
    { key: 'Payment', label: t('finance.payment'), permission: 'finance.manage' },
    { key: 'Transfer', label: t('finance.transfer'), permission: 'finance.manage' },
    { key: 'PartnerCapital', label: t('finance.capital'), permission: 'partner_capital.view' },
  ];

  return (
    <Screen title={t('nav.finance')} subtitle={business?.name} onRefresh={() => void syncNow()} refreshing={syncing}>
      <OfflineBanner online={online} pending={summary?.pending ?? 0} conflicts={summary?.conflictsOpen ?? 0} lastSyncedAt={summary?.lastSyncedAt ?? null} syncing={syncing} onSyncNow={() => void syncNow()} />

      <SectionTitle title={t('finance.accounts')} />
      <Text style={[typography.caption, { color: colors.textMuted, marginBottom: spacing.sm }]}>{t('reports.offlineNote')}</Text>
      <Card>
        {(data ?? []).map((account) => (
          <View key={account.code} style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: spacing.sm, gap: spacing.md }}>
            <View style={{ flex: 1 }}>
              <Text style={[typography.body, { color: colors.text }]} numberOfLines={1}>
                {account.code} • {account.name}
              </Text>
              <Text style={[typography.caption, { color: colors.textMuted }]}>
                {account.nameBn} • {account.type}
              </Text>
            </View>
            {account.isCash ? <Tag text={t('finance.cash')} tone="primary" /> : null}
            <MoneyText value={account.balance} currency={currency} />
          </View>
        ))}
        {loading && !data ? <Text style={[typography.caption, { color: colors.textMuted }]}>{t('common.loading')}</Text> : null}
      </Card>

      <SectionTitle title={t('finance.title')} />
      <View style={{ gap: spacing.sm }}>
        {actions.map((action, index) => (
          <PermissionGate key={`${action.key}-${index}`} permission={action.permission} mode="hide">
            <Button
              label={action.label}
              variant="secondary"
              onPress={() => navigation.navigate(action.key as never, action.params as never)}
              fullWidth
            />
          </PermissionGate>
        ))}
      </View>

      {!can('finance.manage') ? <Notice tone="warning" body={t('common.restrictedBody')} /> : null}
      <Text style={[typography.caption, { color: colors.textMuted, marginTop: spacing.md }]}>{t('offline.coreWorksOffline')}</Text>
    </Screen>
  );
}
