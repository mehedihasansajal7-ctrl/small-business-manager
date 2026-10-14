import { useCallback, useEffect, useRef, useState } from 'react';
import { useFocusEffect } from '@react-navigation/native';

import { describeError } from '../api/client';

/**
 * Minimal data-loading hook for offline-first screens.
 *
 * Why not react-query: every read here already hits the local SQLite mirror,
 * which is instant and never fails for network reasons, so a cache/dedupe layer
 * would add a dependency without adding behaviour. What screens actually need
 * from a hook is: run the loader, keep the last successful value while a refresh
 * is in flight, and expose a retry.
 */

export interface AsyncState<T> {
  readonly data: T | null;
  readonly error: { message: string; code: string; offline: boolean } | null;
  readonly loading: boolean;
  readonly reload: () => void;
}

export function useAsyncData<T>(loader: () => Promise<T>, deps: readonly unknown[] = []): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<AsyncState<T>['error']>(null);
  const [loading, setLoading] = useState(true);
  const generation = useRef(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const run = useCallback(async () => {
    const current = ++generation.current;
    setLoading(true);
    try {
      const result = await loader();
      // Ignore a stale response that resolved after a newer one started.
      if (!mounted.current || current !== generation.current) return;
      setData(result);
      setError(null);
    } catch (caught) {
      if (!mounted.current || current !== generation.current) return;
      setError(describeError(caught));
    } finally {
      if (mounted.current && current === generation.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    void run();
  }, [run]);

  const reload = useCallback(() => {
    void run();
  }, [run]);

  return { data, error, loading, reload };
}

/** Re-run a loader every time the screen regains focus (list → detail → back). */
export function useReloadOnFocus(reload: () => void): void {
  useFocusEffect(
    useCallback(() => {
      reload();
      // The loader is stable (useCallback in the caller); re-running only on focus
      // is intentional, so the dependency list is empty for the effect itself.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [reload]),
  );
}
