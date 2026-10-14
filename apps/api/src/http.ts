import type { IncomingMessage, ServerResponse } from 'node:http';

/** Tiny dependency-free HTTP layer: error type, router, cookies, rate limiting. */

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  static badRequest(code: string, message: string, details?: unknown): HttpError {
    return new HttpError(400, code, message, details);
  }
  static unauthorized(message = 'Sign in required'): HttpError {
    return new HttpError(401, 'UNAUTHORIZED', message);
  }
  static forbidden(message = 'You do not have access to this action'): HttpError {
    return new HttpError(403, 'FORBIDDEN', message);
  }
  static notFound(message = 'Not found'): HttpError {
    return new HttpError(404, 'NOT_FOUND', message);
  }
  static conflict(code: string, message: string, details?: unknown): HttpError {
    return new HttpError(409, code, message, details);
  }
  static tooMany(message = 'Too many requests. Please slow down.'): HttpError {
    return new HttpError(429, 'RATE_LIMITED', message);
  }
  static server(message = 'Unexpected server error'): HttpError {
    return new HttpError(500, 'INTERNAL', message);
  }
}

export interface RequestContext {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly method: string;
  readonly url: URL;
  readonly params: Record<string, string>;
  readonly query: URLSearchParams;
  /** Set by the json body reader when a body was present. */
  body?: unknown;
  /** Set by the auth middleware. */
  session?: unknown;
}

export type Handler = (ctx: RequestContext) => Promise<unknown> | unknown;

interface Route {
  readonly method: string;
  readonly segments: string[];
  readonly handler: Handler;
  readonly raw?: boolean;
}

/** Path router with `:param` support. */
export class Router {
  private readonly routes: Route[] = [];

  add(method: string, path: string, handler: Handler, options: { raw?: boolean } = {}): this {
    this.routes.push({ method: method.toUpperCase(), segments: path.split('/').filter(Boolean), handler, ...(options.raw ? { raw: true } : {}) });
    return this;
  }

  get(path: string, handler: Handler): this {
    return this.add('GET', path, handler);
  }
  post(path: string, handler: Handler): this {
    return this.add('POST', path, handler);
  }
  put(path: string, handler: Handler): this {
    return this.add('PUT', path, handler);
  }
  patch(path: string, handler: Handler): this {
    return this.add('PATCH', path, handler);
  }
  delete(path: string, handler: Handler): this {
    return this.add('DELETE', path, handler);
  }

  match(method: string, pathname: string): { handler: Handler; params: Record<string, string> } | null {
    const parts = pathname.split('/').filter(Boolean);
    let pathMatched = false;
    for (const route of this.routes) {
      if (route.segments.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < route.segments.length; i += 1) {
        const segment = route.segments[i] as string;
        const value = parts[i] as string;
        if (segment.startsWith(':')) params[segment.slice(1)] = decodeURIComponent(value);
        else if (segment !== value) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      pathMatched = true;
      if (route.method === method.toUpperCase()) return { handler: route.handler, params };
    }
    if (pathMatched) throw new HttpError(405, 'METHOD_NOT_ALLOWED', `${method} is not allowed on this path`);
    return null;
  }

  /** Route list for the diagnostics endpoint. */
  describe(): string[] {
    return this.routes.map((r) => `${r.method} /${r.segments.join('/')}`);
  }
}

const MAX_BODY_BYTES = 1_000_000; // matches the self-hosted edge limit

/** Read and parse a JSON body with a hard size limit. */
export async function readJsonBody(req: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > maxBytes) {
      throw new HttpError(413, 'PAYLOAD_TOO_LARGE', `Request body exceeds ${maxBytes} bytes`);
    }
    chunks.push(buf);
  }
  if (size === 0) return undefined;
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    throw HttpError.badRequest('INVALID_JSON', 'Request body is not valid JSON');
  }
}

export async function readRawBody(req: IncomingMessage, maxBytes = 20_000_000): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > maxBytes) throw new HttpError(413, 'PAYLOAD_TOO_LARGE', `Upload exceeds ${maxBytes} bytes`);
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body, jsonReplacer);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  res.end(text);
}

/** BigInt-safe JSON (decorated decimals never appear, but keep it safe). */
function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    if (key === '') continue;
    out[key] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

export function serializeCookie(
  name: string,
  value: string,
  options: { maxAgeSeconds?: number; secure?: boolean; httpOnly?: boolean; sameSite?: 'Lax' | 'Strict' | 'None'; path?: string } = {},
): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${options.path ?? '/'}`];
  if (options.maxAgeSeconds !== undefined) parts.push(`Max-Age=${Math.floor(options.maxAgeSeconds)}`);
  if (options.httpOnly !== false) parts.push('HttpOnly');
  if (options.secure !== false) parts.push('Secure');
  parts.push(`SameSite=${options.sameSite ?? 'Lax'}`);
  return parts.join('; ');
}

export function applySecurityHeaders(res: ServerResponse): void {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('cross-origin-opener-policy', 'same-origin');
}

/** In-memory sliding-window rate limiter (per process; enough for one instance). */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(private readonly limit: number, private readonly windowMs: number) {}

  /** Records an attempt; throws 429 when the window is full. */
  consume(key: string, now = Date.now()): void {
    const windowStart = now - this.windowMs;
    const timestamps = (this.hits.get(key) ?? []).filter((t) => t > windowStart);
    if (timestamps.length >= this.limit) {
      this.hits.set(key, timestamps);
      throw HttpError.tooMany();
    }
    timestamps.push(now);
    this.hits.set(key, timestamps);
    if (this.hits.size > 5_000) this.prune(now);
  }

  remaining(key: string, now = Date.now()): number {
    const windowStart = now - this.windowMs;
    const timestamps = (this.hits.get(key) ?? []).filter((t) => t > windowStart);
    return Math.max(0, this.limit - timestamps.length);
  }

  private prune(now: number): void {
    const windowStart = now - this.windowMs;
    for (const [key, timestamps] of this.hits) {
      const kept = timestamps.filter((t) => t > windowStart);
      if (kept.length === 0) this.hits.delete(key);
      else this.hits.set(key, kept);
    }
  }
}

export function clientIp(req: IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) return (forwarded.split(',')[0] as string).trim();
  return req.socket.remoteAddress ?? 'unknown';
}

/** Assert a value is a non-empty string. */
export function requireString(value: unknown, field: string, options: { maxLength?: number; minLength?: number } = {}): string {
  if (typeof value !== 'string') throw HttpError.badRequest('VALIDATION', `${field} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length < (options.minLength ?? 1)) throw HttpError.badRequest('VALIDATION', `${field} is required`);
  if (options.maxLength && trimmed.length > options.maxLength) throw HttpError.badRequest('VALIDATION', `${field} must be at most ${options.maxLength} characters`);
  return trimmed;
}

export function optionalString(value: unknown, field: string, maxLength = 2000): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw HttpError.badRequest('VALIDATION', `${field} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length > maxLength) throw HttpError.badRequest('VALIDATION', `${field} must be at most ${maxLength} characters`);
  return trimmed === '' ? null : trimmed;
}

export function requireEnum<T extends string>(value: unknown, field: string, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw HttpError.badRequest('VALIDATION', `${field} must be one of: ${allowed.join(', ')}`);
  }
  return value as T;
}

export function optionalBoolean(value: unknown, field: string, fallback = false): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  throw HttpError.badRequest('VALIDATION', `${field} must be true or false`);
}

export function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw HttpError.badRequest('VALIDATION', `${field} must be an object`);
  return value as Record<string, unknown>;
}

export function asArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) throw HttpError.badRequest('VALIDATION', `${field} must be an array`);
  return value;
}
