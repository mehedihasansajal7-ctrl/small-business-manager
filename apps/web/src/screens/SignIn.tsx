import { useState } from 'react';
import { ApiError } from '../api/client';
import { useApp, useT } from '../state/AppContext';
import { Button, Card, Notice, TextInput } from '../components/ui';

/** Sign in, register, or join an existing business with an invite code. */
export function SignInScreen() {
  const { signIn, register, acceptInvite, me, notify } = useApp();
  const { t } = useT();
  const [tab, setTab] = useState<'signIn' | 'register' | 'join'>('signIn');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [businessName, setBusinessName] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = (action: () => Promise<void>) => {
    setError(null);
    setBusy(true);
    action()
      .catch((cause: unknown) => {
        setError(cause instanceof ApiError ? cause.message : cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => setBusy(false));
  };

  return (
    <div className="auth">
      <div className="auth__panel">
        <header className="auth__head">
          <h1>{t('app.name')}</h1>
          <p>{t('app.tagline')}</p>
        </header>

        <div className="tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === 'signIn'} className={`tab${tab === 'signIn' ? ' tab--active' : ''}`} onClick={() => setTab('signIn')}>
            {t('auth.signIn')}
          </button>
          <button type="button" role="tab" aria-selected={tab === 'register'} className={`tab${tab === 'register' ? ' tab--active' : ''}`} onClick={() => setTab('register')}>
            {t('auth.register')}
          </button>
          <button type="button" role="tab" aria-selected={tab === 'join'} className={`tab${tab === 'join' ? ' tab--active' : ''}`} onClick={() => setTab('join')}>
            {t('team.joinByCode')}
          </button>
        </div>

        <Card>
          {error ? <Notice level="error">{error}</Notice> : null}

          {tab === 'signIn' ? (
            <form
              className="form"
              onSubmit={(event) => {
                event.preventDefault();
                run(() => signIn(email.trim(), password));
              }}
            >
              <TextInput label={t('common.email')} type="email" autoComplete="username" required value={email} onValueChange={setEmail} />
              <TextInput label={t('auth.password')} type="password" autoComplete="current-password" required value={password} onValueChange={setPassword} />
              <Button type="submit" variant="primary" block disabled={busy}>
                {t('auth.signIn')}
              </Button>
            </form>
          ) : null}

          {tab === 'register' ? (
            <form
              className="form"
              onSubmit={(event) => {
                event.preventDefault();
                run(() =>
                  register({
                    email: email.trim(),
                    password,
                    displayName: displayName.trim(),
                    ...(businessName.trim() ? { businessName: businessName.trim() } : {}),
                  }),
                );
              }}
            >
              <TextInput label={t('auth.displayName')} required value={displayName} onValueChange={setDisplayName} autoComplete="name" />
              <TextInput label={t('common.email')} type="email" required value={email} onValueChange={setEmail} autoComplete="username" />
              <TextInput label={t('auth.password')} type="password" required value={password} onValueChange={setPassword} autoComplete="new-password" hint="8+ characters" minLength={8} />
              <TextInput label={t('auth.businessName')} value={businessName} onValueChange={setBusinessName} hint={t('auth.businessNameHint')} />
              <Button type="submit" variant="primary" block disabled={busy}>
                {t('auth.register')}
              </Button>
            </form>
          ) : null}

          {tab === 'join' ? (
            <form
              className="form"
              onSubmit={(event) => {
                event.preventDefault();
                if (!me) {
                  setError(t('auth.noAccount'));
                  return;
                }
                run(async () => {
                  await acceptInvite(code.trim().toUpperCase());
                  notify(t('auth.joined'), 'success');
                });
              }}
            >
              <TextInput label={t('auth.inviteCode')} required value={code} onValueChange={setCode} hint={t('team.emailNotRequired')} />
              <p className="muted">{t('auth.haveAccount')} → {t('auth.signIn')}</p>
              <Button type="submit" variant="primary" block disabled={busy || !me}>
                {t('team.joinByCode')}
              </Button>
            </form>
          ) : null}
        </Card>
      </div>
    </div>
  );
}
