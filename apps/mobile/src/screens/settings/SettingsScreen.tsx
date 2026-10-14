import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useCallback, useState } from 'react';
import { Text, View } from 'react-native';

import { CURRENCIES } from '@sbm/domain';

import * as api from '../../api/endpoints';
import { describeError } from '../../api/client';
import { useAuth } from '../../auth/AuthProvider';
import { Button, Card, Divider, Field, ListRow, Notice, Screen, SectionTitle, Segmented, Select, Toggle } from '../../components';
import { APP_INFO, API_BASE_URL } from '../../config/env';
import { resetDatabase } from '../../offline/db';
import { localUnits } from '../../offline/repository';
import { useI18n, LOCALES, type AppLocale } from '../../i18n';
import { useNetwork } from '../../lib/network';
import { useSync } from '../../lib/useSync';
import { useTheme, type ThemeMode } from '../../theme';
import type { MoreStackParamList } from '../../navigation/types';

type Props = NativeStackScreenProps<MoreStackParamList, 'Settings'>;

/**
 * Settings.
 *
 * Split by what each control actually needs:
 *  - **local** preferences (language, theme) — always available;
 *  - **server** settings (profile, partner visibility, unit conversions) — need the
 *    connection, because they are recorded in the audit log and change what other
 *    partners may see;
 *  - **data** actions (backup, CSV export, wiping the mirror) — always available,
 *    with the destructive one clearly labelled.
 */
export function SettingsScreen(_props: Props) {
  const { colors, typography, spacing, mode: themeMode, setMode } = useTheme();
  const { t, locale, setLocale, language } = useI18n();
  const { business, can, signOut, refresh } = useAuth();
  const { online } = useNetwork();
  const { syncNow, syncing, attachmentsPending } = useSync();

  const [name, setName] = useState(business?.name ?? '');
  const [currency, setCurrency] = useState(business?.currency ?? 'BDT');
  const [timezone, setTimezone] = useState(business?.timezone ?? 'Asia/Dhaka');
  const [visibility, setVisibility] = useState({
    partnerCanSeeFinancialReports: Boolean(business?.settings.partnerCanSeeFinancialReports),
    partnerCanSeeCosts: Boolean(business?.settings.partnerCanSeeCosts),
    partnerCanSeeCapital: Boolean(business?.settings.partnerCanSeeCapital),
    lowStockAlerts: Boolean(business?.settings.lowStockAlerts ?? true),
  });

  const [fromUnit, setFromUnit] = useState('bag');
  const [toUnit, setToUnit] = useState('kg');
  const [factor, setFactor] = useState('50');
  const [conversionNote, setConversionNote] = useState('');

  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const saveProfile = async () => {
    setError(null);
    setBusy('profile');
    try {
      await api.updateBusiness({ name: name.trim(), currency, timezone });
      await refresh();
      setStatus(t('common.save'));
    } catch (caught) {
      setError(describeError(caught).message);
    } finally {
      setBusy(null);
    }
  };

  const saveVisibility = async () => {
    setError(null);
    setBusy('visibility');
    try {
      await api.saveBusinessSettings(visibility);
      await refresh();
      setStatus(t('common.save'));
    } catch (caught) {
      setError(describeError(caught).message);
    } finally {
      setBusy(null);
    }
  };

  const addConversion = async () => {
    setError(null);
    if (conversionNote.trim().length < 5) {
      setError(t('settings.conversionNote'));
      return;
    }
    setBusy('conversion');
    try {
      await api.createUnitConversion({ from: fromUnit, to: toUnit, factor, note: conversionNote.trim() });
      setConversionNote('');
      setStatus(t('common.save'));
    } catch (caught) {
      setError(describeError(caught).message);
    } finally {
      setBusy(null);
    }
  };

  const exportBackup = async () => {
    setError(null);
    setBusy('backup');
    try {
      const dump = await api.backupDump();
      const path = `${FileSystem.documentDirectory ?? ''}sbm-backup-${new Date().toISOString().slice(0, 10)}.json`;
      await FileSystem.writeAsStringAsync(path, JSON.stringify(dump, null, 2));
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(path, { mimeType: 'application/json', dialogTitle: t('settings.exportBackup') });
      }
      setStatus(path);
    } catch (caught) {
      setError(describeError(caught).message);
    } finally {
      setBusy(null);
    }
  };

  const exportCsv = async (table: string) => {
    setError(null);
    setBusy(`csv-${table}`);
    try {
      const csv = await api.exportTableCsv(table);
      const path = `${FileSystem.documentDirectory ?? ''}${table}-${new Date().toISOString().slice(0, 10)}.csv`;
      await FileSystem.writeAsStringAsync(path, csv);
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(path, { mimeType: 'text/csv', dialogTitle: table });
      }
      setStatus(path);
    } catch (caught) {
      setError(describeError(caught).message);
    } finally {
      setBusy(null);
    }
  };

  const wipeLocal = async () => {
    setError(null);
    setBusy('wipe');
    try {
      await resetDatabase();
      setStatus(t('settings.resetLocal'));
    } catch (caught) {
      setError(describeError(caught).message);
    } finally {
      setBusy(null);
    }
  };

  const units = localUnits();

  const onReset = useCallback(() => {
    void wipeLocal();
  }, []);

  return (
    <Screen title={t('nav.settings')} subtitle={business?.name}>
      {!online ? <Notice tone="warning" body={t('auth.needInternet')} /> : null}
      {error ? <Notice tone="danger" body={error} /> : null}
      {status ? <Notice tone="success" body={status} /> : null}

      <SectionTitle title={t('settings.business')} />
      <Card>
        <Field label={t('auth.businessName')} value={name} onChangeText={setName} />
        <Select
          label={t('common.currency')}
          value={currency}
          options={Object.values(CURRENCIES).map((definition) => ({ value: definition.code, label: `${definition.symbol} ${definition.code} — ${definition.name}` }))}
          onChange={setCurrency}
        />
        <Field label="Timezone" value={timezone} onChangeText={setTimezone} note="e.g. Asia/Dhaka — all dates are local to the business" />
        <Button label={t('common.save')} onPress={() => void saveProfile()} loading={busy === 'profile'} disabled={!online || !can('business.settings')} fullWidth />
      </Card>

      <SectionTitle title={t('settings.visibility')} />
      <Card>
        <Toggle
          label={t('settings.financialReports')}
          value={visibility.partnerCanSeeFinancialReports}
          onChange={(value) => setVisibility((current) => ({ ...current, partnerCanSeeFinancialReports: value }))}
        />
        <Toggle label={t('settings.costs')} value={visibility.partnerCanSeeCosts} onChange={(value) => setVisibility((current) => ({ ...current, partnerCanSeeCosts: value }))} />
        <Toggle label={t('settings.capital')} value={visibility.partnerCanSeeCapital} onChange={(value) => setVisibility((current) => ({ ...current, partnerCanSeeCapital: value }))} />
        <Divider />
        <Toggle label={t('settings.lowStockAlerts')} value={visibility.lowStockAlerts} onChange={(value) => setVisibility((current) => ({ ...current, lowStockAlerts: value }))} />
        <Button label={t('common.save')} onPress={() => void saveVisibility()} loading={busy === 'visibility'} disabled={!online || !can('business.settings')} fullWidth />
        <Text style={[typography.caption, { color: colors.textMuted, marginTop: spacing.sm }]}>{t('common.restrictedBody')}</Text>
      </Card>

      <SectionTitle title={t('settings.units')} />
      <Card>
        {units.slice(0, 8).map((unit) => (
          <ListRow key={unit.code} title={`${unit.name} (${unit.code})`} subtitle={`${unit.dimension} • ${unit.nameBn}`} right={<Text style={[typography.caption, { color: colors.textMuted }]}>×{unit.factor}</Text>} />
        ))}
        <Divider />
        <Select label={t('finance.fromAccount')} value={fromUnit} options={units.map((unit) => ({ value: unit.code, label: unit.code }))} onChange={setFromUnit} />
        <Select label={t('finance.toAccount')} value={toUnit} options={units.map((unit) => ({ value: unit.code, label: unit.code }))} onChange={setToUnit} />
        <Field label="Factor" value={factor} onChangeText={setFactor} keyboardType="decimal-pad" />
        <Field label={t('common.notes')} value={conversionNote} onChangeText={setConversionNote} multiline required note={t('settings.conversionNote')} />
        <Button label={t('common.add')} variant="secondary" onPress={() => void addConversion()} loading={busy === 'conversion'} disabled={!online || !can('product.manage')} fullWidth />
      </Card>

      <SectionTitle title={t('settings.language')} />
      <Segmented
        options={[
          { value: 'bn-BD' as AppLocale, label: 'বাংলা' },
          { value: 'en' as AppLocale, label: 'English' },
        ]}
        value={locale}
        onChange={(value) => void setLocale(value)}
      />

      <SectionTitle title={t('settings.theme')} />
      <Segmented
        options={[
          { value: 'system' as ThemeMode, label: t('settings.themeSystem') },
          { value: 'light' as ThemeMode, label: t('settings.themeLight') },
          { value: 'dark' as ThemeMode, label: t('settings.themeDark') },
        ]}
        value={themeMode}
        onChange={(value) => void setMode(value)}
      />

      <SectionTitle title={t('settings.data')} />
      <Card>
        <Button label={t('settings.exportBackup')} variant="secondary" onPress={() => void exportBackup()} loading={busy === 'backup'} disabled={!online || !can('backup.manage')} fullWidth />
        <View style={{ height: spacing.sm }} />
        {api.EXPORTABLE_TABLES.slice(0, 4).map((table) => (
          <View key={table} style={{ marginBottom: spacing.sm }}>
            <Button label={`${t('settings.exportCsv')} — ${table}`} variant="ghost" compact onPress={() => void exportCsv(table)} loading={busy === `csv-${table}`} disabled={!online || !can('report.export')} />
          </View>
        ))}
        <Divider />
        <Button label={t('settings.resetLocal')} variant="danger" onPress={onReset} loading={busy === 'wipe'} fullWidth />
        <Text style={[typography.caption, { color: colors.danger, marginTop: spacing.sm }]}>{t('settings.resetWarning')}</Text>
      </Card>

      <SectionTitle title={t('nav.sync')} />
      <Card>
        <ListRow title={t('offline.syncNow')} subtitle={t('common.loading')} right={<Text style={[typography.caption, { color: colors.primary }]}>{syncing ? '…' : '→'}</Text>} onPress={() => void syncNow()} />
        <ListRow title={t('sync.attachmentsPending')} right={<Text style={[typography.caption, { color: colors.textMuted }]}>{attachmentsPending}</Text>} />
      </Card>

      <SectionTitle title={t('settings.server')} />
      <Card>
        <ListRow title={t('settings.server')} subtitle={API_BASE_URL} />
        <ListRow title={t('settings.version')} subtitle={`${APP_INFO.name} ${APP_INFO.version} • ${APP_INFO.androidPackage}`} />
        <ListRow title={language === 'bn' ? 'সাইন আউট' : 'Sign out'} onPress={() => void signOut()} right={<Text style={[typography.caption, { color: colors.danger }]}>→</Text>} />
      </Card>

      <Text style={[typography.caption, { color: colors.textMuted, marginTop: spacing.lg }]}>{t('offline.coreWorksOffline')}</Text>
    </Screen>
  );
}
