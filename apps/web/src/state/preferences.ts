/**
 * Tiny typed wrapper around `localStorage` for *preferences only*.
 *
 * Durable business data never lives here: it goes to IndexedDB (see
 * `src/offline/`). Storage can throw (private mode, quota, disabled cookies), so
 * every access is guarded and falls back to an in-memory map.
 */
const memory = new Map<string, string>();

function storage(): Storage | null {
  try {
    const candidate = globalThis.localStorage;
    if (!candidate) return null;
    // A write probe catches Safari private mode, which throws on setItem.
    candidate.setItem('__sbm_probe', '1');
    candidate.removeItem('__sbm_probe');
    return candidate;
  } catch {
    return null;
  }
}

export function readPreference(key: string): string | null {
  const store = storage();
  if (!store) return memory.get(key) ?? null;
  try {
    return store.getItem(key);
  } catch {
    return memory.get(key) ?? null;
  }
}

export function writePreference(key: string, value: string): void {
  memory.set(key, value);
  const store = storage();
  if (!store) return;
  try {
    store.setItem(key, value);
  } catch {
    /* keep the in-memory copy */
  }
}

export function readBool(key: string, fallback: boolean): boolean {
  const value = readPreference(key);
  if (value === null) return fallback;
  return value === 'true';
}

export const PREF_KEYS = {
  // v2: the previous key held the old Bangla default, not a real user choice,
  // so it is deliberately ignored once - the product now starts in English.
  locale: 'sbm.locale.v2',
  theme: 'sbm.theme',
  deviceId: 'sbm.deviceId',
  installDismissed: 'sbm.installDismissed',
  businessId: 'sbm.activeBusinessId',
} as const;
