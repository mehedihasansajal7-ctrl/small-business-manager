import { useState } from 'react';
import { FARMING_TYPES } from '@sbm/domain';
import { businesses as businessApi, catalog } from '../api/endpoints';
import { ApiError } from '../api/client';
import { useApp, useT } from '../state/AppContext';
import { Button, Card, CheckboxInput, CopyButton, Notice, SelectInput, TextInput } from '../components/ui';
import { navigate } from '../state/router';

const CURRENCIES = ['BDT', 'USD', 'INR', 'EUR', 'GBP', 'JPY'];
const TIMEZONES = ['Asia/Dhaka', 'Asia/Kolkata', 'Asia/Dubai', 'Asia/Singapore', 'Europe/London', 'America/New_York', 'UTC'];

/**
 * First-run guided setup: business profile → currency/timezone → farming types →
 * first stock location. Everything it writes goes through the real API.
 */
export function SetupScreen() {
  const { me, refresh, notify, switchBusiness } = useApp();
  const { t, locale } = useT();
  const [step, setStep] = useState(0);
  const [name, setName] = useState('');
  const [currency, setCurrency] = useState('BDT');
  const [timezone, setTimezone] = useState('Asia/Dhaka');
  const [types, setTypes] = useState<readonly string[]>([]);
  const [locationName, setLocationName] = useState('Main store');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{ id: string; name: string } | null>(null);

  const toggleType = (type: string) => setTypes((current) => (current.includes(type) ? current.filter((row) => row !== type) : [...current, type]));

  const finish = () => {
    setError(null);
    setBusy(true);
    void (async () => {
      try {
        const business = await businessApi.create({ name: name.trim(), currency, timezone, locale });
        if (types.length > 0) {
          await businessApi.patch({ farmingTypes: types });
        }
        if (locationName.trim()) {
          await catalog.createLocation({ name: locationName.trim(), kind: 'STORE' });
        }
        await refresh();
        await switchBusiness(business.id);
        setCreated({ id: business.id, name: business.name });
        notify(t('setup.done'), 'success');
      } catch (cause) {
        setError(cause instanceof ApiError ? cause.message : cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(false);
      }
    })();
  };

  if (created) {
    return (
      <div className="auth">
        <div className="auth__panel">
          <Card title={t('setup.done')}>
            <p>{created.name}</p>
            <div className="row">
              <Button variant="primary" onClick={() => navigate('/')}>
                {t('nav.dashboard')}
              </Button>
              <CopyButton text={created.id} label="Copy business id" />
            </div>
          </Card>
        </div>
      </div>
    );
  }

  const steps = [t('auth.businessName'), t('setup.currency'), t('setup.farmingTypes'), t('setup.locationName')];

  return (
    <div className="auth">
      <div className="auth__panel">
        <header className="auth__head">
          <h1>{t('setup.title')}</h1>
          <p>
            {t('setup.step')} {step + 1}/4 · {me?.user.displayName}
          </p>
        </header>

        <div className="steps" aria-hidden="true">
          {steps.map((label, index) => (
            <span key={label} className={`steps__dot${index <= step ? ' is-done' : ''}`} />
          ))}
        </div>

        <Card>
          {error ? <Notice level="error">{error}</Notice> : null}

          {step === 0 ? <TextInput label={t('auth.businessName')} required value={name} onValueChange={setName} /> : null}

          {step === 1 ? (
            <>
              <SelectInput label={t('setup.currency')} value={currency} onValueChange={setCurrency} options={CURRENCIES.map((row) => ({ value: row, label: row }))} />
              <SelectInput label={t('setup.timezone')} value={timezone} onValueChange={setTimezone} options={TIMEZONES.map((row) => ({ value: row, label: row }))} />
            </>
          ) : null}

          {step === 2 ? (
            <>
              <p className="muted">{t('setup.farmingTypes')}</p>
              {FARMING_TYPES.map((row) => (
                <CheckboxInput key={row.type} label={locale === 'en' ? row.name : row.nameBn} checked={types.includes(row.type)} onCheckedChange={() => toggleType(row.type)} />
              ))}
            </>
          ) : null}

          {step === 3 ? <TextInput label={t('setup.locationName')} value={locationName} onValueChange={setLocationName} hint={t('setup.locationHint')} /> : null}

          <div className="row row--end">
            {step > 0 ? (
              <Button variant="ghost" onClick={() => setStep((value) => value - 1)}>
                {t('common.back')}
              </Button>
            ) : null}
            {step < 3 ? (
              <Button variant="primary" disabled={step === 0 && name.trim().length === 0} onClick={() => setStep((value) => value + 1)}>
                {t('setup.next')}
              </Button>
            ) : (
              <Button variant="primary" disabled={busy || name.trim().length === 0} onClick={finish}>
                {t('setup.finish')}
              </Button>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}
