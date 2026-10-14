import { API_BASE_URL, API_TIMEOUT_MS } from '../config/env';
import {
  clearSession,
  extractSessionCookie,
  getSessionSync,
  loadSession,
  saveSessionCookie,
} from './session-store';

/**
 * The typed HTTP client.
 *
 * Why a hand-written client instead of axios/react-query:
 *  - the API is plain `fetch`-shaped, and the offline outbox already owns
 *    retry/backoff, so a second retry layer would create duplicate writes;
 *  - we must read `Set-Cookie` manually because React Native's fetch does not
 *    maintain a cookie jar, and the server has **no bearer-token fallback**.
 *
 * Every non-2xx response is normalised into an `ApiError` carrying the server's
 * `{ error: { code, message } }` body, so screens can show the real reason
 * instead of "something went wrong".
 */

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly body: unknown;
  /** True when the request never reached the server (offline / DNS / timeout). */
  readonly offline: boolean;

  constructor(input: { status: number; code: string; message: string; body?: unknown; offline?: boolean }) {
    super(input.message);
    this.name = 'ApiError';
    this.status = input.status;
    this.code = input.code;
    this.body = input.body;
    this.offline = input.offline ?? false;
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

export function isOfflineError(error: unknown): boolean {
  return isApiError(error) && error.offline;
}

export interface RequestOptions {
  readonly body?: unknown;
  readonly query?: Record<string, string | number | boolean | undefined | null>;
  readonly timeoutMs?: number;
  /** Set for `/api/auth/*` and `/api/health`, which must not trigger a 401 logout. */
  readonly skipAuthRedirect?: boolean;
  readonly signal?: AbortSignal;
}

type UnauthorizedListener = () => void;
const unauthorizedListeners = new Set<UnauthorizedListener>();

/** The auth provider subscribes here to drop the user back to the sign-in screen. */
export function onUnauthorized(listener: UnauthorizedListener): () => void {
  unauthorizedListeners.add(listener);
  return () => unauthorizedListeners.delete(listener);
}

function notifyUnauthorized(): void {
  for (const listener of unauthorizedListeners) {
    try {
      listener();
    } catch {
      // ignore
    }
  }
}

function buildUrl(path: string, query?: RequestOptions['query']): string {
  const url = `${API_BASE_URL}${path.startsWith('/') ? path : `/${path}`}`;
  if (!query) return url;
  const parts: string[] = [];
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  return parts.length === 0 ? url : `${url}?${parts.join('&')}`;
}

function withTimeout(timeoutMs: number, external?: AbortSignal): { signal: AbortSignal | undefined; done: () => void } {
  const globalAbort = (globalThis as { AbortController?: typeof AbortController }).AbortController;
  if (!globalAbort) return { signal: external, done: () => undefined };
  const controller = new globalAbort();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onExternalAbort = () => controller.abort();
  external?.addEventListener?.('abort', onExternalAbort);
  return {
    signal: controller.signal,
    done: () => {
      clearTimeout(timer);
      external?.removeEventListener?.('abort', onExternalAbort);
    },
  };
}

/** Low-level JSON request. Prefer the typed helpers in `endpoints.ts`. */
export async function request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
  await loadSession();
  const headers: Record<string, string> = { accept: 'application/json' };
  const session = getSessionSync();
  if (session?.cookie) {
    // The server authenticates with an HttpOnly cookie and has no bearer-token
    // fallback, so the captured `Set-Cookie` value is replayed verbatim.
    headers.cookie = session.cookie;
  }
  let bodyInit: string | undefined;
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
    bodyInit = JSON.stringify(options.body);
  }

  const { signal, done } = withTimeout(options.timeoutMs ?? API_TIMEOUT_MS, options.signal);

  let response: Response;
  try {
    response = await fetch(buildUrl(path, options.query), { method, headers, ...(bodyInit ? { body: bodyInit } : {}), ...(signal ? { signal } : {}) });
  } catch (error) {
    done();
    const aborted = (error as { name?: string })?.name === 'AbortError';
    throw new ApiError({
      status: 0,
      code: aborted ? 'TIMEOUT' : 'NETWORK',
      offline: true,
      message: aborted ? 'The server took too long to answer.' : 'No connection to the server. Changes are saved on this device.',
      body: error,
    });
  }

  const setCookie = response.headers?.get?.('set-cookie') ?? null;
  const cookie = extractSessionCookie(setCookie);
  if (cookie) await saveSessionCookie(cookie);

  const text = await response.text();
  done();

  let parsed: unknown = undefined;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }

  if (response.status === 401) {
    // Session expired or revoked on the server: forget it locally. Callers that
    // are themselves auth routes opt out so they can render the 401 inline.
    if (!options.skipAuthRedirect) {
      await clearSession();
      notifyUnauthorized();
    }
    throw new ApiError({
      status: 401,
      code: errorCode(parsed) ?? 'UNAUTHORIZED',
      message: errorMessage(parsed) ?? 'Your session has ended. Please sign in again.',
      body: parsed,
    });
  }

  if (!response.ok) {
    throw new ApiError({
      status: response.status,
      code: errorCode(parsed) ?? `HTTP_${response.status}`,
      message: errorMessage(parsed) ?? `Request failed (HTTP ${response.status}).`,
      body: parsed,
    });
  }

  return parsed as T;
}

function errorCode(parsed: unknown): string | undefined {
  const envelope = parsed as { error?: { code?: unknown } } | undefined;
  return typeof envelope?.error?.code === 'string' ? envelope.error.code : undefined;
}

function errorMessage(parsed: unknown): string | undefined {
  const envelope = parsed as { error?: { message?: unknown } } | undefined;
  if (typeof envelope?.error?.message === 'string') return envelope.error.message;
  return typeof parsed === 'string' && parsed.length > 0 ? parsed : undefined;
}

export const get = <T>(path: string, options?: RequestOptions): Promise<T> => request<T>('GET', path, options);
export const post = <T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> =>
  request<T>('POST', path, { ...options, body });
export const patch = <T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> =>
  request<T>('PATCH', path, { ...options, body });
export const put = <T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> =>
  request<T>('PUT', path, { ...options, body });
export const del = <T>(path: string, options?: RequestOptions): Promise<T> => request<T>('DELETE', path, options);

/**
 * Upload raw bytes (`POST /api/attachments/:entityType/:entityId`).
 *
 * The route reads the *raw body* (max 5 MB) and derives the MIME itself, so we
 * must not wrap the photo in multipart/form-data or base64 JSON — a base64
 * JSON body would inflate by ~33% and can trip an edge body-size limit.
 */
export async function uploadBytes(
  path: string,
  bytes: Uint8Array,
  options: { fileName: string; contentType: string; timeoutMs?: number } = { fileName: 'attachment.bin', contentType: 'application/octet-stream' },
): Promise<unknown> {
  await loadSession();
  const headers: Record<string, string> = {
    accept: 'application/json',
    'content-type': options.contentType,
  };
  const session = getSessionSync();
  if (session?.cookie) headers.cookie = session.cookie;

  const { signal, done } = withTimeout(options.timeoutMs ?? API_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(buildUrl(path, { fileName: options.fileName }), {
      method: 'POST',
      headers,
      body: bytes as unknown as BodyInit,
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    done();
    throw new ApiError({
      status: 0,
      code: 'NETWORK',
      offline: true,
      message: 'The photo could not be uploaded. The record itself is unaffected.',
      body: error,
    });
  }

  const text = await response.text();
  done();
  const parsed = text.length > 0 ? safeJson(text) : undefined;
  if (response.status === 401) {
    if (session?.cookie) {
      await clearSession();
      notifyUnauthorized();
    }
    throw new ApiError({ status: 401, code: 'UNAUTHORIZED', message: 'Your session has ended.', body: parsed });
  }
  if (!response.ok) {
    throw new ApiError({
      status: response.status,
      code: errorCode(parsed) ?? `HTTP_${response.status}`,
      message: errorMessage(parsed) ?? 'The attachment was rejected.',
      body: parsed,
    });
  }
  return parsed;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Human-readable message for a snackbar / error card. */
export function describeError(error: unknown): { message: string; code: string; offline: boolean } {
  if (isApiError(error)) {
    return { message: error.message, code: error.code, offline: error.offline };
  }
  if (error instanceof Error) return { message: error.message, code: 'UNKNOWN', offline: false };
  return { message: String(error), code: 'UNKNOWN', offline: false };
}
