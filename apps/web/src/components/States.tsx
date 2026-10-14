import type { ReactNode } from 'react';
import { useT } from '../state/AppContext';

/** Loading / empty / error / restricted placeholders, used by every screen. */

export function Loading({ label }: { readonly label?: string }) {
  const { t } = useT();
  return (
    <div className="state state--loading" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      <span>{label ?? t('common.loading')}</span>
    </div>
  );
}

export function EmptyState({ title, hint, action }: { readonly title?: string; readonly hint?: string; readonly action?: ReactNode }) {
  const { t } = useT();
  return (
    <div className="state state--empty">
      <p className="state__title">{title ?? t('common.empty')}</p>
      <p className="state__hint">{hint ?? t('common.emptyHint')}</p>
      {action}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { readonly error: Error; readonly onRetry?: () => void }) {
  const { t } = useT();
  return (
    <div className="state state--error" role="alert">
      <p className="state__title">{t('common.error')}</p>
      <p className="state__hint">{error.message}</p>
      {onRetry ? (
        <button type="button" className="btn" onClick={onRetry}>
          {t('common.retry')}
        </button>
      ) : null}
    </div>
  );
}

/**
 * Shown when a role lacks a permission. The server enforces the same rule, so
 * this is a courtesy, not a security control.
 */
export function Restricted({ permission, hint }: { readonly permission?: string; readonly hint?: string }) {
  const { t } = useT();
  return (
    <div className="state state--restricted" role="status">
      <p className="state__title">{t('common.restricted')}</p>
      <p className="state__hint">{hint ?? t('common.restrictedHint')}</p>
      {permission ? <code className="pill pill--muted">{permission}</code> : null}
    </div>
  );
}

/** Wrap a resource in the right placeholder while it loads / fails. */
export function AsyncState<T>({
  loading,
  error,
  data,
  onRetry,
  empty,
  children,
}: {
  readonly loading: boolean;
  readonly error: Error | null;
  readonly data: T | null;
  readonly onRetry?: () => void;
  readonly empty?: (data: T) => boolean;
  readonly children: (data: T) => ReactNode;
}) {
  if (loading) return <Loading />;
  if (error) return <ErrorState error={error} {...(onRetry ? { onRetry } : {})} />;
  if (data === null) return <Loading />;
  if (empty?.(data)) return <EmptyState />;
  return <>{children(data)}</>;
}
