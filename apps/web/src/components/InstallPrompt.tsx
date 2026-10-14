import { useEffect, useState } from 'react';
import { PREF_KEYS, readPreference, writePreference } from '../state/preferences';
import { useT } from '../state/AppContext';
import { Button } from './ui';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

/**
 * "Add to Home Screen" panel.
 *
 * Chrome/Edge fire `beforeinstallprompt`, which we can trigger. iOS Safari has no
 * such event, so the panel shows the Share → Add to Home Screen instructions.
 */
export function InstallPrompt() {
  const { t } = useT();
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [dismissed, setDismissed] = useState(() => readPreference(PREF_KEYS.installDismissed) === 'true');
  const [installed, setInstalled] = useState(false);

  useEffect(() => {
    const onPrompt = (event: Event) => {
      event.preventDefault();
      setDeferred(event as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      setInstalled(true);
      setDeferred(null);
    };
    globalThis.addEventListener('beforeinstallprompt', onPrompt);
    globalThis.addEventListener('appinstalled', onInstalled);
    return () => {
      globalThis.removeEventListener('beforeinstallprompt', onPrompt);
      globalThis.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  if (installed || dismissed) return null;

  const close = () => {
    writePreference(PREF_KEYS.installDismissed, 'true');
    setDismissed(true);
  };

  const isIos = /iPad|iPhone|iPod/.test(navigator.userAgent);

  return (
    <aside className="notice notice--info install" aria-label={t('install.title')}>
      <div>
        <strong>{t('install.title')}</strong>
        <p>{t('install.body')}</p>
        <p className="install__steps">{isIos ? t('install.ios') : t('install.android')}</p>
      </div>
      <div className="install__actions">
        {deferred ? (
          <Button
            variant="primary"
            onClick={() => {
              void deferred
                .prompt()
                .then(() => deferred.userChoice)
                .then((choice) => {
                  if (choice.outcome === 'accepted') setInstalled(true);
                  else close();
                });
            }}
          >
            {t('install.button')}
          </Button>
        ) : null}
        <Button variant="ghost" onClick={close}>
          {t('install.later')}
        </Button>
      </div>
    </aside>
  );
}
