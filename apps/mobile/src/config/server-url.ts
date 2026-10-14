import { readPref, writePref } from '../prefs/storage';
import { DEFAULT_API_URL } from './env';

/**
 * Runtime-configurable API base URL.
 *
 * Why this exists: a sideloaded APK is shared as a single file, but the API it
 * talks to can live anywhere (a colleague's PC on the office LAN, a self-hosted
 * box, or a cloud host). Baking one address into the build would make the APK
 * useless to anybody but the person who built it, so instead:
 *
 *  - the build supplies a sensible default (`EXPO_PUBLIC_API_URL`, see env.ts),
 *  - the person using the app can override it once on the sign-in screen,
 *  - the choice is persisted and used by every request afterwards.
 *
 * The value is kept in the ordinary preference store, NOT secure-store: it is a
 * server address, not a credential.
 */

const PREF_KEY = 'sbm.apiBaseUrl';

/** Last resolved value, so the HTTP client can stay synchronous (`buildUrl`). */
let current: string = DEFAULT_API_URL;
let loaded = false;

/**
 * Accepts `host`, `host:port` or a full URL and returns a clean `http(s)://host[:port]`
 * with the trailing slash removed. An empty value falls back to the default.
 */
export function normalizeServerUrl(value: string): string {
  const trimmed = value.trim();
  if (trimmed === '') return DEFAULT_API_URL;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  return withScheme.replace(/\/+$/, '');
}

/** True when the string looks like something we could actually call. */
export function isValidServerUrl(value: string): boolean {
  const normalized = normalizeServerUrl(value);
  try {
    const parsed = new URL(normalized);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.hostname.length > 0;
  } catch {
    return false;
  }
}

/** Synchronous read used on every request. Defaults to the build-time value. */
export function getApiBaseUrl(): string {
  return current;
}

/** The address compiled into this build, shown so a user can reset to it. */
export const BUILD_TIME_API_URL = DEFAULT_API_URL;

/** Load the persisted override once at start-up. Safe to call repeatedly. */
export async function loadApiBaseUrl(): Promise<string> {
  if (loaded) return current;
  const stored = await readPref(PREF_KEY);
  current = stored && isValidServerUrl(stored) ? normalizeServerUrl(stored) : DEFAULT_API_URL;
  loaded = true;
  return current;
}

/** Persist a new server address. Returns the normalised value that was stored. */
export async function setApiBaseUrl(value: string): Promise<string> {
  const next = normalizeServerUrl(value);
  current = next;
  loaded = true;
  await writePref(PREF_KEY, next);
  return next;
}

/** Forget the override and go back to the build-time address. */
export async function resetApiBaseUrl(): Promise<string> {
  current = DEFAULT_API_URL;
  loaded = true;
  await writePref(PREF_KEY, DEFAULT_API_URL);
  return current;
}

/**
 * Ask the server whether it is really there (`GET /api/health`).
 * Used by the "test connection" action so a wrong address is caught before the
 * user blames their password.
 */
export async function probeServer(value: string, timeoutMs = 8000): Promise<{ ok: boolean; detail: string }> {
  const base = normalizeServerUrl(value);
  if (!isValidServerUrl(base)) return { ok: false, detail: 'That does not look like a valid http(s) address.' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${base}/api/health`, { signal: controller.signal });
    if (!response.ok) return { ok: false, detail: `The server answered with HTTP ${response.status}.` };
    const body = (await response.json()) as { service?: string; schemaVersion?: number };
    if (body?.service !== 'small-business-manager-api') {
      return { ok: false, detail: 'Something answered, but it is not the Small Business Manager API.' };
    }
    return { ok: true, detail: `Reachable (schema ${body.schemaVersion ?? '?'}).` };
  } catch (error) {
    return { ok: false, detail: error instanceof Error && error.name === 'AbortError' ? 'The server did not answer in time.' : 'The server could not be reached.' };
  } finally {
    clearTimeout(timer);
  }
}
