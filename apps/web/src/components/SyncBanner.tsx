import { useSyncState } from '../offline/useSync';
import { useApp, useT } from '../state/AppContext';
import { navigate } from '../state/router';
import { SYNC_STATUS_LABEL } from '@sbm/domain';

/**
 * The persistent sync strip. It is the single place the user learns that a
 * change is only local, so it is rendered on every screen and announced with
 * `aria-live`.
 */
export function SyncBanner({ compact }: { readonly compact?: boolean }) {
  const { snapshot, syncNow } = useSyncState();
  const { t, locale } = useT();
  const { me } = useApp();
  const banner = snapshot.banner;
  const tone = banner.level === 'ok' ? 'ok' : banner.level === 'warn' ? 'warn' : 'error';
  const text = locale === 'en' ? banner.en : banner.bn;

  return (
    <div className={`syncbar syncbar--${tone}${compact ? ' syncbar--compact' : ''}`} role="status" aria-live="polite">
      <span className={`dot dot--${snapshot.online ? 'ok' : 'warn'}`} aria-hidden="true" />
      <span className="syncbar__text">{text}</span>
      <span className="syncbar__meta">
        {snapshot.pending > 0 ? (
          <span className="pill pill--warn">
            {t('sync.pending')}: {snapshot.pending}
          </span>
        ) : null}
        {snapshot.conflicts > 0 ? (
          <button type="button" className="pill pill--error" onClick={() => navigate('/sync')}>
            {SYNC_STATUS_LABEL.CONFLICT[locale === 'en' ? 'en' : 'bn']}: {snapshot.conflicts}
          </button>
        ) : null}
      </span>
      {me ? (
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={() => {
            void syncNow();
          }}
          disabled={snapshot.flushing || snapshot.pulling}
        >
          {snapshot.flushing || snapshot.pulling ? t('sync.syncing') : t('sync.now')}
        </button>
      ) : null}
    </div>
  );
}
