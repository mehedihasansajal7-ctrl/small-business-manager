import { useState } from 'react';
import { FARMING_TYPES } from '@sbm/domain';
import { businesses as businessApi, catalog, reports as reportApi } from '../api/endpoints';
import { EXPORT_TABLES } from '../api/endpointsFinance';
import { ApiError, saveBlob } from '../api/client';
import { hasPermission } from '../api/permissions';
import { CACHE_STORES, countStore, type CacheStore } from '../offline/db';
import { clearCache } from '../offline/localStorage';
import { AsyncState, Restricted } from '../components/States';
import { DataTable, type Column } from '../components/DataTable';
import { Badge, Button, Card, CheckboxInput, Notice, PageHeader, SelectInput, Tabs, TextInput } from '../components/ui';
import { useApp, useT } from '../state/AppContext';
import { useResource } from '../offline/useSync';
import type { UnitRow } from '../api/types';

const TIMEZONES = ['Asia/Dhaka', 'Asia/Kolkata', 'Asia/Dubai', 'Asia/Singapore', 'Europe/London', 'America/New_York', 'UTC'];
const CURRENCIES = ['BDT', 'USD', 'INR', 'EUR', 'GBP', 'JPY'];

/** Settings: profile, partner visibility, units/conversions, backup & data. */
export function SettingsScreen() {
  const { business, permissions, refresh, notify } = useApp();
  const { t, locale } = useT();
  const [tab, setTab] = useState('profile');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const canSettings = hasPermission(permissions, 'business.settings');
  const canUnits = hasPermission(permissions, 'product.manage');
  const canExport = hasPermission(permissions, 'report.export');
  const canBackup = hasPermission(permissions, 'backup.manage');

  const [name, setName] = useState(business?.name ?? '');
  const [currency, setCurrency] = useState(business?.currency ?? 'BDT');
  const [timezone, setTimezone] = useState(business?.timezone ?? 'Asia/Dhaka');
  const [farmingTypes, setFarmingTypes] = useState<readonly string[]>(business?.farmingTypes ?? []);
  const [settings, setSettings] = useState({
    partnerCanSeeFinancialReports: business?.settings.partnerCanSeeFinancialReports ?? false,
    partnerCanSeeCosts: business?.settings.partnerCanSeeCosts ?? false,
    partnerCanSeeCapital: business?.settings.partnerCanSeeCapital ?? false,
    lowStockAlerts: business?.settings.lowStockAlerts ?? true,
    mortalityWarningPercent: String(business?.settings.mortalityWarningPercent ?? 5),
  });
  const [conversionFrom, setConversionFrom] = useState('');
  const [conversionTo, setConversionTo] = useState('');
  const [conversionFactor, setConversionFactor] = useState('');
  const [conversionNote, setConversionNote] = useState('');
  const [cacheCounts, setCacheCounts] = useState<readonly { store: CacheStore; count: number }[]>([]);

  const units = useResource(() => catalog.units(), []);

  const run = (action: () => Promise<void>) => {
    setError(null);
    setBusy(true);
    action()
      .catch((cause: unknown) => setError(cause instanceof ApiError ? cause.message : cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setBusy(false));
  };

  const loadCounts = () => {
    void Promise.all(
      CACHE_STORES.map(async (store) => ({ store, count: await countStore(store) })),
    ).then(setCacheCounts);
  };

  const unitColumns: Column<UnitRow>[] = [
    { id: 'code', header: t('common.unit'), cell: (row) => <span className="mono">{row.code}</span> },
    { id: 'name', header: t('common.name'), cell: (row) => (locale === 'en' ? row.name : row.nameBn) },
    { id: 'dimension', header: t('farm.unitKind'), cell: (row) => <Badge tone="muted">{row.dimension}</Badge> },
    { id: 'factor', header: t('set.conversionFactor'), align: 'right', cell: (row) => row.factor },
  ];

  return (
    <>
      <PageHeader title={t('nav.settings')} subtitle={business?.name} />
      <Tabs
        tabs={[
          { id: 'profile', label: t('set.profile') },
          { id: 'visibility', label: t('set.visibility') },
          { id: 'units', label: t('set.units') },
          { id: 'data', label: t('set.backup') },
        ]}
        active={tab}
        onChange={setTab}
      />

      {error ? <Notice level="error">{error}</Notice> : null}

      {tab === 'profile' ? (
        canSettings ? (
          <Card
            title={t('set.profile')}
            actions={
              <Button
                variant="primary"
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    await businessApi.patch({ name: name.trim(), currency, timezone, locale: business?.locale ?? 'bn-BD', farmingTypes });
                    await refresh();
                    notify(t('common.saved'), 'success');
                  })
                }
              >
                {t('common.save')}
              </Button>
            }
          >
            <div className="grid grid--2">
              <TextInput label={t('auth.businessName')} required value={name} onValueChange={setName} />
              <SelectInput label={t('setup.currency')} value={currency} onValueChange={setCurrency} options={CURRENCIES.map((row) => ({ value: row, label: row }))} />
              <SelectInput label={t('setup.timezone')} value={timezone} onValueChange={setTimezone} options={TIMEZONES.map((row) => ({ value: row, label: row }))} />
            </div>
            <p className="muted">{t('set.farmingTypes')}</p>
            <div className="grid grid--2">
              {FARMING_TYPES.map((row) => (
                <CheckboxInput
                  key={row.type}
                  label={locale === 'en' ? row.name : row.nameBn}
                  checked={farmingTypes.includes(row.type)}
                  onCheckedChange={(checked) =>
                    setFarmingTypes((current) => (checked ? [...current, row.type] : current.filter((value) => value !== row.type)))
                  }
                />
              ))}
            </div>
          </Card>
        ) : (
          <Restricted permission="business.settings" />
        )
      ) : null}

      {tab === 'visibility' ? (
        canSettings ? (
          <Card
            title={t('set.visibility')}
            subtitle={t('set.visibilityHint')}
            actions={
              <Button
                variant="primary"
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    await businessApi.updateSettings({
                      partnerCanSeeFinancialReports: settings.partnerCanSeeFinancialReports,
                      partnerCanSeeCosts: settings.partnerCanSeeCosts,
                      partnerCanSeeCapital: settings.partnerCanSeeCapital,
                      lowStockAlerts: settings.lowStockAlerts,
                      mortalityWarningPercent: Number(settings.mortalityWarningPercent) || 5,
                    });
                    notify(t('common.saved'), 'success');
                  })
                }
              >
                {t('common.save')}
              </Button>
            }
          >
            <CheckboxInput
              label={t('set.partnerFinancial')}
              checked={settings.partnerCanSeeFinancialReports}
              onCheckedChange={(checked) => setSettings((current) => ({ ...current, partnerCanSeeFinancialReports: checked }))}
            />
            <CheckboxInput
              label={t('set.partnerCosts')}
              checked={settings.partnerCanSeeCosts}
              onCheckedChange={(checked) => setSettings((current) => ({ ...current, partnerCanSeeCosts: checked }))}
            />
            <CheckboxInput
              label={t('set.partnerCapital')}
              checked={settings.partnerCanSeeCapital}
              onCheckedChange={(checked) => setSettings((current) => ({ ...current, partnerCanSeeCapital: checked }))}
            />
            <CheckboxInput
              label={t('set.lowStockAlerts')}
              checked={settings.lowStockAlerts}
              onCheckedChange={(checked) => setSettings((current) => ({ ...current, lowStockAlerts: checked }))}
            />
            <TextInput
              label={t('set.mortalityWarning')}
              inputMode="decimal"
              value={settings.mortalityWarningPercent}
              onValueChange={(value) => setSettings((current) => ({ ...current, mortalityWarningPercent: value }))}
            />
          </Card>
        ) : (
          <Restricted permission="business.settings" />
        )
      ) : null}

      {tab === 'units' ? (
        <>
          {canUnits ? (
            <Card
              title={t('set.units')}
              subtitle={t('set.unitsHint')}
              actions={
                <Button
                  variant="primary"
                  disabled={busy}
                  onClick={() =>
                    run(async () => {
                      await catalog.createConversion({ from: conversionFrom.trim(), to: conversionTo.trim(), factor: conversionFactor.trim(), note: conversionNote.trim() });
                      notify(t('common.saved'), 'success');
                      setConversionNote('');
                    })
                  }
                >
                  {t('common.create')}
                </Button>
              }
            >
              <div className="grid grid--2">
                <TextInput label="From" required value={conversionFrom} onValueChange={setConversionFrom} />
                <TextInput label="To" required value={conversionTo} onValueChange={setConversionTo} />
                <TextInput label={t('set.conversionFactor')} inputMode="decimal" required value={conversionFactor} onValueChange={setConversionFactor} />
                <TextInput label={t('set.conversionNote')} required value={conversionNote} onValueChange={setConversionNote} />
              </div>
            </Card>
          ) : (
            <Restricted permission="product.manage" />
          )}
          <Card title={t('set.units')}>
            <AsyncState loading={units.loading} error={units.error} data={units.data} onRetry={units.reload}>
              {(rows) => <DataTable columns={unitColumns} rows={rows} getKey={(row) => row.code} permissions={permissions} />}
            </AsyncState>
          </Card>
        </>
      ) : null}

      {tab === 'data' ? (
        <>
          <Card title={t('set.backup')} subtitle={t('set.backupHint')}>
            {canBackup ? (
              <Button
                variant="primary"
                onClick={() =>
                  run(async () => {
                    const blob = await reportApi.backup();
                    saveBlob(blob, `sbm-backup-${new Date().toISOString().slice(0, 10)}.json`);
                  })
                }
              >
                {t('common.download')} JSON
              </Button>
            ) : (
              <Restricted permission="backup.manage" />
            )}

            <p className="muted">{t('set.exportTable')}</p>
            {canExport ? (
              <div className="row row--wrap">
                {EXPORT_TABLES.map((table) => (
                  <Button
                    key={table}
                    variant="secondary"
                    onClick={() =>
                      run(async () => {
                        const blob = await reportApi.exportCsv(table);
                        saveBlob(blob, `${table}-${new Date().toISOString().slice(0, 10)}.csv`);
                      })
                    }
                  >
                    {table} ⇩
                  </Button>
                ))}
              </div>
            ) : (
              <Restricted permission="report.export" />
            )}
          </Card>

          <Card
            title={t('set.dataOnDevice')}
            subtitle={t('set.clearCacheHint')}
            actions={
              <>
                <Button variant="secondary" onClick={loadCounts}>
                  {t('common.reload')}
                </Button>
                <Button
                  variant="danger"
                  disabled={busy}
                  onClick={() =>
                    run(async () => {
                      await clearCache();
                      loadCounts();
                      notify(t('set.cacheCleared'), 'success');
                    })
                  }
                >
                  {t('set.clearCache')}
                </Button>
              </>
            }
          >
            {cacheCounts.length === 0 ? (
              <Button variant="ghost" onClick={loadCounts}>
                {t('set.dataOnDevice')}
              </Button>
            ) : (
              <ul className="list">
                {cacheCounts.map((row) => (
                  <li key={row.store} className="list__item">
                    <span className="mono">{row.store}</span>
                    <span>{row.count}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </>
      ) : null}
    </>
  );
}
