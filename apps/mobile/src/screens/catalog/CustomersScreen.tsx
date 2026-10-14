import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useCallback, useState } from 'react';
import { Text } from 'react-native';

import { isValidBdMobile, normalizeBdMobile } from '@sbm/domain';

import { useActor } from '../../auth/useActor';
import { useAuth } from '../../auth/AuthProvider';
import { Button, Card, EmptyState, Field, ListRow, MoneyText, Notice, Screen, SectionTitle } from '../../components';
import { localCustomers, upsertCustomer } from '../../offline/repository';
import { useI18n } from '../../i18n';
import { useAsyncData, useReloadOnFocus } from '../../lib/useAsyncData';
import { useNetwork } from '../../lib/network';
import { useSync } from '../../lib/useSync';
import { useTheme } from '../../theme';
import type { MoreStackParamList } from '../../navigation/types';

type Props = NativeStackScreenProps<MoreStackParamList, 'Customers'>;

/**
 * Customers.
 *
 * New customers are queued through the outbox with `baseRevision: null` — the
 * server's `customer.upsert` treats that as a create, and because `customers` is a
 * revision-checked table locally-created rows can never clobber a partner's edit.
 */
export function CustomersScreen(_props: Props) {
  const { colors, typography, spacing } = useTheme();
  const { t } = useI18n();
  const { business, can } = useAuth();
  const actor = useActor();
  const { online } = useNetwork();
  const { syncNow } = useSync();

  const [search, setSearch] = useState('');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const currency = business?.currency ?? 'BDT';
  const loader = useCallback(() => localCustomers(search), [search]);
  const { data, loading, reload } = useAsyncData(loader, [loader]);
  useReloadOnFocus(reload);

  const submit = async () => {
    setError(null);
    if (!actor) return;
    if (name.trim().length < 2) {
      setError(t('common.required'));
      return;
    }
    // Bangladeshi mobile numbers are the common identifier; validate with the
    // shared helper so the phone and the server agree on what "valid" means.
    if (phone.trim() !== '' && !isValidBdMobile(phone)) {
      setError('01XXXXXXXXX');
      return;
    }
    setBusy(true);
    try {
      await upsertCustomer(actor, { name: name.trim(), ...(phone.trim() ? { phone: normalizeBdMobile(phone) } : {}) });
      setName('');
      setPhone('');
      reload();
      if (online) void syncNow();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('common.error'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen title={t('customers.title')} onRefresh={reload} refreshing={loading}>
      <Field label={t('common.search')} value={search} onChangeText={setSearch} autoCapitalize="none" />

      <Card>
        {data && data.length > 0 ? (
          data.map((customer) => (
            <ListRow
              key={customer.id}
              title={customer.name}
              subtitle={customer.phone ?? customer.email ?? t('inventory.balanceAsOf')}
              right={<MoneyText value={customer.receivable ?? '0'} currency={currency} />}
            />
          ))
        ) : (
          <EmptyState title={t('common.none')} body={t('offline.coreWorksOffline')} />
        )}
      </Card>

      <SectionTitle title={t('customers.new')} />
      {error ? <Notice tone="danger" body={error} /> : null}
      <Card>
        <Field label={t('common.name')} value={name} onChangeText={setName} required />
        <Field label={t('common.phone')} value={phone} onChangeText={setPhone} keyboardType="phone-pad" note="01XXXXXXXXX" />
        <Button label={t('common.add')} onPress={() => void submit()} loading={busy} disabled={!can('customer.manage')} fullWidth />
        {!can('customer.manage') ? <Text style={[typography.caption, { color: colors.textMuted, marginTop: spacing.sm }]}>{t('common.restrictedBody')}</Text> : null}
      </Card>
    </Screen>
  );
}
