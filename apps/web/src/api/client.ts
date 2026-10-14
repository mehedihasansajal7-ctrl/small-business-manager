/**
 * Small typed `fetch` wrapper.
 *
 *  - always sends `credentials: 'same-origin'` so the `sbm_session` cookie is used
 *  - understands the server's `{ error: { code, message } }` envelope
 *  - a 401 raises `UnauthorizedError` and notifies listeners, so the shell can
 *    send the user back to the sign-in screen from anywhere
 */

export interface ApiErrorBody {
  readonly error: { readonly code: string; readonly message: string; readonly details?: unknown };
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  /** Field/validation problems the user can fix. */
  get isValidation(): boolean {
    return this.status === 400 || this.status === 422;
  }

  get isForbidden(): boolean {
    return this.status === 403;
  }

  get isConflict(): boolean {
    return this.status === 409;
  }

  get isNotFound(): boolean {
    return this.status === 404;
  }
}

export class UnauthorizedError extends ApiError {
  constructor(message = 'Your session has ended. Please sign in again.') {
    super(401, 'UNAUTHORIZED', message);
    this.name = 'UnauthorizedError';
  }
}

/** Network / offline failures (no HTTP response was received). */
export class NetworkError extends Error {
  override readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'NetworkError';
    this.cause = cause;
  }
}

export type QueryValue = string | number | boolean | null | undefined;

export interface RequestOptions {
  readonly method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  readonly body?: unknown;
  readonly query?: Readonly<Record<string, QueryValue>>;
  readonly signal?: AbortSignal;
  /** Do not raise `UnauthorizedError` for this call (used by the sign-in form). */
  readonly anonymous?: boolean;
}

/** Base URL: same-origin by default; `VITE_API_BASE` allows a split deployment. */
export function apiBase(): string {
  const base = import.meta.env?.VITE_API_BASE;
  return base ? base.replace(/\/$/, '') : '';
}

export function buildUrl(path: string, query?: Readonly<Record<string, QueryValue>>): string {
  const url = `${apiBase()}${path}`;
  if (!query) return url;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === null || value === undefined || value === '') continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${url}?${qs}` : url;
}

type UnauthorizedListener = () => void;
const unauthorizedListeners = new Set<UnauthorizedListener>();

/** Register a handler for session expiry; returns an unsubscribe function. */
export function onUnauthorized(listener: UnauthorizedListener): () => void {
  unauthorizedListeners.add(listener);
  return () => unauthorizedListeners.delete(listener);
}

function notifyUnauthorized(): void {
  for (const listener of unauthorizedListeners) {
    try {
      listener();
    } catch {
      /* a broken listener must not break the request flow */
    }
  }
}

/** Perform a JSON request against the API. */
export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, query, signal, anonymous } = options;
  let response: Response;
  try {
    response = await fetch(buildUrl(path, query), {
      method,
      credentials: 'same-origin',
      headers: {
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    throw new NetworkError('Could not reach the server. You may be offline.', error);
  }

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  let parsed: unknown = undefined;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      parsed = undefined;
    }
  }

  if (!response.ok) {
    const envelope = parsed as ApiErrorBody | undefined;
    const code = envelope?.error?.code ?? `HTTP_${response.status}`;
    const message = envelope?.error?.message ?? `Request failed (${response.status})`;
    if (response.status === 401) {
      if (!anonymous) notifyUnauthorized();
      throw new UnauthorizedError(message);
    }
    throw new ApiError(response.status, code, message, envelope?.error?.details);
  }

  return parsed as T;
}

/** Fetch a non-JSON body (CSV / backup downloads) as a Blob. */
export async function apiDownload(path: string, query?: Readonly<Record<string, QueryValue>>): Promise<Blob> {
  let response: Response;
  try {
    response = await fetch(buildUrl(path, query), { credentials: 'same-origin' });
  } catch (error) {
    throw new NetworkError('Could not reach the server. You may be offline.', error);
  }
  if (!response.ok) {
    if (response.status === 401) {
      notifyUnauthorized();
      throw new UnauthorizedError();
    }
    throw new ApiError(response.status, `HTTP_${response.status}`, `Download failed (${response.status})`);
  }
  return response.blob();
}

/** Trigger a browser download for a Blob (used by backup / CSV export). */
export function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Give the browser a tick to start the download before revoking.
  setTimeout(() => URL.revokeObjectURL(url), 5_000);
}
