import { useEffect, useState } from 'react';

/**
 * A ~40-line hash router. A routing library would be an extra runtime
 * dependency, and every screen here is reachable from the nav.
 *
 * Routes look like `#/inventory`, `#/farming/cycle/<id>`, `#/sign-in`.
 */

export interface Route {
  /** Path without the leading `#`, e.g. `/inventory`. */
  readonly path: string;
  readonly parts: readonly string[];
}

function currentRoute(): Route {
  const raw = globalThis.location?.hash?.replace(/^#/, '') ?? '/';
  const path = raw.startsWith('/') ? raw : `/${raw}`;
  return { path, parts: path.split('/').filter(Boolean) };
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => currentRoute());
  useEffect(() => {
    const onChange = () => setRoute(currentRoute());
    globalThis.addEventListener('hashchange', onChange);
    return () => globalThis.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

export function navigate(path: string, options: { replace?: boolean } = {}): void {
  const target = `#${path.startsWith('/') ? path : `/${path}`}`;
  if (options.replace) {
    const url = `${globalThis.location.pathname}${globalThis.location.search}${target}`;
    globalThis.history.replaceState(null, '', url);
    globalThis.dispatchEvent(new HashChangeEvent('hashchange'));
    return;
  }
  if (globalThis.location.hash === target) {
    globalThis.dispatchEvent(new HashChangeEvent('hashchange'));
    return;
  }
  globalThis.location.hash = target;
}

/** Build a hash path for a cycle detail page. */
export function cyclePath(cycleId: string): string {
  return `/farming/cycle/${encodeURIComponent(cycleId)}`;
}

export function cycleIdFromRoute(route: Route): string | null {
  if (route.parts[0] !== 'farming' || route.parts[1] !== 'cycle') return null;
  const id = route.parts[2];
  return id ? decodeURIComponent(id) : null;
}
