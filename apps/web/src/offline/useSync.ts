import { useEffect, useMemo, useState } from 'react';
import { getSyncCoordinator, type SyncSnapshot } from './sync';

/** Subscribe to the app-wide sync coordinator. */
export function useSyncState(): { snapshot: SyncSnapshot; syncNow: () => Promise<SyncSnapshot>; retryEvent: (id: string) => Promise<void> } {
  const coordinator = getSyncCoordinator();
  const [snapshot, setSnapshot] = useState<SyncSnapshot>(() => coordinator.getState());
  useEffect(() => coordinator.subscribe(setSnapshot), [coordinator]);
  return useMemo(
    () => ({
      snapshot,
      syncNow: () => coordinator.syncNow(),
      retryEvent: (id: string) => coordinator.retryEvent(id),
    }),
    [coordinator, snapshot],
  );
}

/**
 * A tiny data-fetching hook for screens: loading / error / data, plus a
 * `reload` the user can press. `deps` behave like an effect dependency list.
 */
export interface Resource<T> {
  readonly data: T | null;
  readonly error: Error | null;
  readonly loading: boolean;
  readonly reload: () => void;
}

export function useResource<T>(loader: () => Promise<T>, deps: readonly unknown[]): Resource<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    loader()
      .then((value) => {
        if (!cancelled) setData(value);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause : new Error(String(cause)));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  return { data, error, loading, reload: () => setNonce((value) => value + 1) };
}

const ONLINE_EVENT = 'online';
const OFFLINE_EVENT = 'offline';

/** Browser connectivity, kept in sync with the `online`/`offline` events. */
export function useOnline(): boolean {
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine !== false));
  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    globalThis.addEventListener(ONLINE_EVENT, up);
    globalThis.addEventListener(OFFLINE_EVENT, down);
    return () => {
      globalThis.removeEventListener(ONLINE_EVENT, up);
      globalThis.removeEventListener(OFFLINE_EVENT, down);
    };
  }, []);
  return online;
}
