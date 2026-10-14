import * as SecureStore from 'expo-secure-store';

/**
 * Session persistence.
 *
 * The API authenticates with an **HttpOnly signed cookie** (`sbm_session`).
 * React Native does not reliably expose `Set-Cookie` to JavaScript, so the
 * dependable path on a device is the `sessionToken` the server returns in the
 * login/register response body, sent back as `Authorization: Bearer`. The
 * `Cookie` header is kept as a second, equivalent path for browser clients.
 *
 * We keep exactly the `name=value` pair (attributes are meaningless to us) in
 * the device keystore via expo-secure-store:
 *   - it is not readable by other apps,
 *   - it is excluded from Android auto-backup, and
 *   - it survives app restarts, which is what makes offline-first usable.
 *
 * The cookie is a bearer credential in practice, so it is never logged, never
 * written to the SQLite mirror and never included in a sync payload.
 */

const SESSION_KEY = 'sbm.session';
const COOKIE_NAME = 'sbm_session';

export interface StoredSession {
  /** e.g. `sbm_session=eyJ…` — sent verbatim as the `Cookie` header. */
  readonly cookie: string;
  /**
   * The bare signed session value, sent as `Authorization: Bearer …`.
   *
   * This is the RELIABLE path on a device: React Native's `fetch` does not
   * consistently expose `Set-Cookie` to JavaScript, so a client that only keeps
   * the cookie silently loses the session and "sign-in does nothing". Both are
   * sent when available, so either mechanism on the server is enough.
   */
  readonly token?: string;
  /** When we captured it, for display only. */
  readonly capturedAt: string;
}

let cached: StoredSession | null = null;
let loaded = false;

type Listener = () => void;
const listeners = new Set<Listener>();

/** Subscribe to session changes (sign-in, sign-out, server 401). */
export function onSessionChanged(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // A listener must never be able to break the auth flow.
    }
  }
}

export async function loadSession(): Promise<StoredSession | null> {
  if (loaded) return cached;
  try {
    const raw = await SecureStore.getItemAsync(SESSION_KEY);
    cached = raw ? (JSON.parse(raw) as StoredSession) : null;
  } catch {
    cached = null;
  }
  loaded = true;
  return cached;
}

/** Synchronous read for the fetch layer, which cannot await per request. */
export function getSessionSync(): StoredSession | null {
  return cached;
}

export async function saveSessionCookie(cookie: string): Promise<StoredSession> {
  const next: StoredSession = { cookie, capturedAt: new Date().toISOString() };
  cached = next;
  loaded = true;
  await SecureStore.setItemAsync(SESSION_KEY, JSON.stringify(next));
  emit();
  return next;
}

/**
 * Store the session from whatever the server gave us.
 *
 * Prefers the `sessionToken` in the JSON body (always available, unlike the
 * header) and keeps the `Cookie` form too so either server mechanism works.
 */
export async function saveSessionFromResponse(body: unknown, setCookieHeader?: string | null): Promise<StoredSession | null> {
  const fromBody = (body as { sessionToken?: unknown } | null)?.sessionToken;
  const token = typeof fromBody === 'string' && fromBody !== '' ? fromBody : null;
  const cookie = extractSessionCookie(setCookieHeader ?? null) ?? (token ? `${COOKIE_NAME}=${token}` : null);
  if (!token && !cookie) return null;
  const next: StoredSession = {
    cookie: cookie ?? `${COOKIE_NAME}=${token}`,
    ...(token ? { token } : {}),
    capturedAt: new Date().toISOString(),
  };
  cached = next;
  loaded = true;
  await SecureStore.setItemAsync(SESSION_KEY, JSON.stringify(next));
  emit();
  return next;
}

export async function clearSession(): Promise<void> {
  cached = null;
  loaded = true;
  try {
    await SecureStore.deleteItemAsync(SESSION_KEY);
  } finally {
    emit();
  }
}

/**
 * Pull the signed session cookie out of a `Set-Cookie` header value.
 * Returns `null` when the header is absent or does not carry our cookie.
 */
export function extractSessionCookie(setCookieHeader: string | null | undefined): string | null {
  if (!setCookieHeader) return null;
  // A single Set-Cookie value; multiple headers arrive comma-joined, so scan
  // the first segment that mentions our cookie name.
  for (const part of setCookieHeader.split(',')) {
    const pair = part.trim().split(';')[0]?.trim() ?? '';
    if (pair.startsWith(`${COOKIE_NAME}=`)) return pair;
  }
  return null;
}

export const SESSION_COOKIE_NAME = COOKIE_NAME;
