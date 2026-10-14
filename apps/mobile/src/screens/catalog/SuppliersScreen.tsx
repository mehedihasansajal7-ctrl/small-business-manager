import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useCallback, useState } from 'react';
import { Text } from 'react-native';

import { useAuth } from '../../auth/AuthProvider';
import { useActor } from '../../auth/useActor';
import { Button, Card, EmptyState, Field, ListRow, MoneyText, Notice, Screen, SectionTitle } from '../../components';
import { localSuppliers, upsertSupplier } from '../../offline/repository';
import { useI18n } from '../../i18n';
import { useAsyncData, useReloadOnFocus } from '../../lib/useAsyncData';
import { useNetwork } from '../../lib/network';
import { useSync } from '../../lib/useSync';
import { useTheme } from '../../theme';
import type { MoreStackParamList } from '../../navigation/types';

type Props = NativeStackScreenProps<MoreStackParamList, 'Suppliers'>;

/** Suppliers, with the payable the mirror can prove (labelled "as of last sync"). */
export function SuppliersScreen(_props: Props) {
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
  const loader = useCallback(() => localSuppliers(search), [search]);
  const { data, loading, reload } = useAsyncData(loader, [loader]);
  useReloadOnFocus(reload);

  const submit = async () => {
    setError(null);
    if (!actor) return;
    if (name.trim().length < 2) {
      setError(t('common.required'));
      return;
    }
    setBusy(true);
    try {
      await upsertSupplier(actor, { name: name.trim(), ...(phone.trim() ? { phone: phone.trim() } : {}) });
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
    <Screen title={t('suppliers.title')} onRefresh={reload} refreshing={loading}>
      <Field label={t('common.search')} value={search} onChangeText={setSearch} autoCapitalize="none" />

      <Card>
        {data && data.length > 0 ? (
          data.map((supplier) => (
            <ListRow
              key={supplier.id}
              title={supplier.name}
              subtitle={supplier.phone ?? t('inventory.balanceAsOf')}
              right={<MoneyText value={supplier.payable ?? '0'} currency={currency} />}
            />
          ))
        ) : (
          <EmptyState title={t('common.none')} body={t('offline.coreWorksOffline')} />
        )}
      </Card>

      <SectionTitle title={t('suppliers.new')} />
      {error ? <Notice tone="danger" body={error} /> : null}
      <Card>
        <Field label={t('common.name')} value={name} onChangeText={setName} required />
        <Field label={t('common.phone')} value={phone} onChangeText={setPhone} keyboardType="phone-pad" />
        <Button label={t('common.add')} onPress={() => void submit()} loading={busy} disabled={!can('supplier.manage')} fullWidth />
        {!can('supplier.manage') ? <Text style={[typography.caption, { color: colors.textMuted, marginTop: spacing.sm }]}>{t('common.restrictedBody')}</Text> : null}
      </Card>
    </Screen>
  );
}
