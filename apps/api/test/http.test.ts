import { describe, expect, it } from 'vitest';
import {
  HttpError,
  RateLimiter,
  Router,
  asRecord,
  optionalBoolean,
  optionalString,
  parseCookies,
  requireEnum,
  requireString,
  serializeCookie,
} from '../src/http.js';
import { toCsv } from '../src/routes.js';

/**
 * Unit tests for the dependency-free HTTP layer: routing, validation helpers,
 * cookie handling, the rate limiter and CSV escaping.
 */

describe('Router', () => {
  it('matches static and parameterised paths and extracts params', () => {
    const router = new Router();
    router.get('/api/things', () => 'list');
    router.get('/api/things/:id', (ctx) => ctx.params.id);
    router.post('/api/things/:id/void', () => 'voided');

    expect(router.match('GET', '/api/things')?.params).toEqual({});
    expect(router.match('GET', '/api/things/abc-123')?.params).toEqual({ id: 'abc-123' });
    expect(router.match('POST', '/api/things/a/void')?.params).toEqual({ id: 'a' });
    expect(router.match('GET', '/api/nope')).toBeNull();
  });

  it('returns 405 when the path exists with a different method', () => {
    const router = new Router();
    router.get('/api/only-get', () => 'x');
    expect(() => router.match('POST', '/api/only-get')).toThrow(HttpError);
    try {
      router.match('DELETE', '/api/only-get');
    } catch (error) {
      expect((error as HttpError).status).toBe(405);
      expect((error as HttpError).code).toBe('METHOD_NOT_ALLOWED');
    }
  });

  it('decodes URL-encoded path segments', () => {
    const router = new Router();
    router.get('/api/files/:name', (ctx) => ctx.params.name);
    expect(router.match('GET', '/api/files/receipt%20photo.png')?.params.name).toBe('receipt photo.png');
  });

  it('describes its routes for the diagnostics endpoint', () => {
    const router = new Router();
    router.get('/a/b', () => 1);
    router.post('/a/c', () => 2);
    expect(router.describe()).toEqual(['GET /a/b', 'POST /a/c']);
  });
});

describe('validation helpers', () => {
  it('requireString trims, enforces presence and length', () => {
    expect(requireString('  hi  ', 'f')).toBe('hi');
    expect(() => requireString('', 'f')).toThrow(/required/);
    expect(() => requireString(123, 'f')).toThrow(/must be a string/);
    expect(() => requireString('abcdef', 'f', { maxLength: 3 })).toThrow(/at most 3/);
  });

  it('optionalString returns null for empty input', () => {
    expect(optionalString(undefined, 'f')).toBeNull();
    expect(optionalString('', 'f')).toBeNull();
    expect(optionalString('  x ', 'f')).toBe('x');
    expect(() => optionalString('toolong', 'f', 3)).toThrow(/at most 3/);
  });

  it('requireEnum restricts to the allowed set', () => {
    expect(requireEnum('IN', 'direction', ['IN', 'OUT'] as const)).toBe('IN');
    expect(() => requireEnum('SIDEWAYS', 'direction', ['IN', 'OUT'] as const)).toThrow(/must be one of/);
  });

  it('optionalBoolean accepts only real booleans', () => {
    expect(optionalBoolean(true, 'f')).toBe(true);
    expect(optionalBoolean(undefined, 'f')).toBe(false);
    expect(optionalBoolean(undefined, 'f', true)).toBe(true);
    expect(() => optionalBoolean('yes', 'f')).toThrow(/true or false/);
  });

  it('asRecord rejects arrays and null', () => {
    expect(asRecord({ a: 1 }, 'f')).toEqual({ a: 1 });
    expect(() => asRecord([], 'f')).toThrow(/must be an object/);
    expect(() => asRecord(null, 'f')).toThrow(/must be an object/);
  });
});

describe('cookies', () => {
  it('parses a cookie header', () => {
    expect(parseCookies('a=1; sbm_session=xyz.abc; b=2')).toEqual({ a: '1', sbm_session: 'xyz.abc', b: '2' });
    expect(parseCookies(undefined)).toEqual({});
  });

  it('serialises secure cookies by default', () => {
    const value = serializeCookie('sbm_session', 'abc', { maxAgeSeconds: 60 });
    expect(value).toContain('sbm_session=abc');
    expect(value).toContain('Path=/');
    expect(value).toContain('Max-Age=60');
    expect(value).toContain('HttpOnly');
    expect(value).toContain('Secure');
    expect(value).toContain('SameSite=Lax');
  });

  it('omits Secure when explicitly disabled (local HTTP dev only)', () => {
    const value = serializeCookie('sbm_session', 'abc', { secure: false });
    expect(value).not.toContain('Secure');
    expect(value).toContain('HttpOnly');
  });

  it('encodes cookie values', () => {
    expect(serializeCookie('c', 'a b/c')).toContain('c=a%20b%2Fc');
  });
});

describe('RateLimiter', () => {
  it('allows up to the limit inside the window and then refuses', () => {
    const limiter = new RateLimiter(3, 1000);
    const now = 1_000_000;
    limiter.consume('ip', now);
    limiter.consume('ip', now + 1);
    limiter.consume('ip', now + 2);
    expect(limiter.remaining('ip', now + 3)).toBe(0);
    expect(() => limiter.consume('ip', now + 3)).toThrow(HttpError);
    try {
      limiter.consume('ip', now + 3);
    } catch (error) {
      expect((error as HttpError).status).toBe(429);
      expect((error as HttpError).code).toBe('RATE_LIMITED');
    }
  });

  it('keys independently per caller', () => {
    const limiter = new RateLimiter(1, 1000);
    limiter.consume('a', 0);
    expect(() => limiter.consume('a', 0)).toThrow();
    expect(() => limiter.consume('b', 0)).not.toThrow();
  });

  it('forgets attempts once the window has passed', () => {
    const limiter = new RateLimiter(1, 1000);
    limiter.consume('a', 0);
    expect(() => limiter.consume('a', 500)).toThrow();
    expect(() => limiter.consume('a', 1001)).not.toThrow();
    expect(limiter.remaining('a', 1001)).toBe(0);
  });
});

describe('toCsv', () => {
  it('writes a BOM + header row + escaped values', () => {
    const csv = toCsv([
      { reference: 'SAL-1', note: 'has, comma', empty: null },
      { reference: 'SAL-2', note: 'has "quotes"', empty: undefined },
    ]);
    expect(csv.startsWith('\uFEFF')).toBe(true);
    expect(csv).toContain('reference,note,empty');
    expect(csv).toContain('"has, comma"');
    expect(csv).toContain('"has ""quotes"""');
    expect(csv.endsWith('\r\n')).toBe(true);
  });

  it('returns an empty string for no rows', () => {
    expect(toCsv([])).toBe('');
  });

  it('serialises nested values as JSON', () => {
    expect(toCsv([{ meta: { a: 1 } }])).toContain('"{""a"":1}"');
  });
});

describe('HttpError', () => {
  it('exposes typed factory helpers with sensible codes', () => {
    expect(HttpError.badRequest('X', 'm').status).toBe(400);
    expect(HttpError.unauthorized().status).toBe(401);
    expect(HttpError.forbidden().status).toBe(403);
    expect(HttpError.notFound().status).toBe(404);
    expect(HttpError.conflict('C', 'm').status).toBe(409);
    expect(HttpError.tooMany().status).toBe(429);
    expect(HttpError.server().status).toBe(500);
    expect(HttpError.notFound().code).toBe('NOT_FOUND');
  });
});
