import { createHmac, randomUUID, scryptSync, timingSafeEqual, randomBytes } from 'node:crypto';
import { HttpError } from './http.js';
import type { Database } from './db.js';
import { normalizeEmail } from '@sbm/domain';

/**
 * Authentication: scrypt password hashing + HMAC-signed session cookies.
 *
 * Passwords are never stored or logged in plain text, and the session cookie is
 * HttpOnly + Secure + SameSite by default (see `serializeCookie`).
 */

const SCRYPT_KEYLEN = 64;
const SESSION_COOKIE = 'sbm_session';

export interface UserRow {
  id: string;
  email: string;
  display_name: string;
  password_hash: string;
  password_salt: string;
  locale: string;
  is_active: number;
  created_at: string;
  last_login_at: string | null;
}

export interface SessionRow {
  id: string;
  user_id: string;
  business_id: string | null;
  created_at: string;
  expires_at: string;
  last_seen_at: string;
  user_agent: string | null;
}

export function hashPassword(password: string, salt = randomBytes(16).toString('hex')): { hash: string; salt: string } {
  if (password.length < 8) throw HttpError.badRequest('WEAK_PASSWORD', 'Password must be at least 8 characters');
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex');
  return { hash, salt };
}

export function verifyPassword(password: string, hash: string, salt: string): boolean {
  const candidate = scryptSync(password, salt, SCRYPT_KEYLEN);
  const expected = Buffer.from(hash, 'hex');
  if (candidate.length !== expected.length) return false;
  return timingSafeEqual(candidate, expected);
}

export function signValue(value: string, secret: string): string {
  const mac = createHmac('sha256', secret).update(value).digest('base64url');
  return `${value}.${mac}`;
}

export function unsignValue(signed: string | undefined, secret: string): string | null {
  if (!signed) return null;
  const index = signed.lastIndexOf('.');
  if (index <= 0) return null;
  const value = signed.slice(0, index);
  const mac = signed.slice(index + 1);
  const expected = createHmac('sha256', secret).update(value).digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return value;
}

export const SESSION_COOKIE_NAME = SESSION_COOKIE;

export class AuthService {
  constructor(private readonly db: Database, private readonly secret: string, private readonly ttlHours: number) {}

  createUser(input: { email: string; displayName: string; password: string; locale?: string }): UserRow {
    const email = normalizeEmail(input.email);
    if (!email.includes('@')) throw HttpError.badRequest('VALIDATION', 'A valid email address is required');
    const existing = this.db.get<{ id: string }>('SELECT id FROM users WHERE email = ?', [email]);
    if (existing) throw HttpError.conflict('EMAIL_TAKEN', 'An account with this email already exists');
    const { hash, salt } = hashPassword(input.password);
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.run(
      'INSERT INTO users (id, email, display_name, password_hash, password_salt, locale, is_active, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)',
      [id, email, input.displayName, hash, salt, input.locale ?? 'en', now],
    );
    const user = this.db.get<UserRow>('SELECT * FROM users WHERE id = ?', [id]);
    if (!user) throw HttpError.server('Failed to create the account');
    return user;
  }

  /** Returns null when the credentials are wrong, so we never leak which part failed. */
  authenticate(email: string, password: string): UserRow | null {
    const user = this.db.get<UserRow>('SELECT * FROM users WHERE email = ?', [normalizeEmail(email)]);
    if (!user || user.is_active !== 1) {
      // Still run a hash so response time does not reveal whether the email exists.
      hashPassword('timing-equalisation-placeholder', '00000000000000000000000000000000');
      return null;
    }
    if (!verifyPassword(password, user.password_hash, user.password_salt)) return null;
    this.db.run('UPDATE users SET last_login_at = ? WHERE id = ?', [new Date().toISOString(), user.id]);
    return user;
  }

  createSession(userId: string, businessId: string | null, userAgent: string | null): { sessionId: string; cookieValue: string; expiresAt: string } {
    const sessionId = randomUUID();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.ttlHours * 3_600_000).toISOString();
    this.db.run('INSERT INTO sessions (id, user_id, business_id, created_at, expires_at, last_seen_at, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?)', [
      sessionId,
      userId,
      businessId,
      now.toISOString(),
      expiresAt,
      now.toISOString(),
      userAgent,
    ]);
    return { sessionId, cookieValue: signValue(sessionId, this.secret), expiresAt };
  }

  /** Resolve a signed cookie into a live session (or null when invalid/expired). */
  resolveSession(cookieValue: string | undefined): { session: SessionRow; user: UserRow } | null {
    const sessionId = unsignValue(cookieValue, this.secret);
    if (!sessionId) return null;
    const session = this.db.get<SessionRow>('SELECT * FROM sessions WHERE id = ?', [sessionId]);
    if (!session) return null;
    if (session.expires_at <= new Date().toISOString()) {
      this.db.run('DELETE FROM sessions WHERE id = ?', [session.id]);
      return null;
    }
    const user = this.db.get<UserRow>('SELECT * FROM users WHERE id = ?', [session.user_id]);
    if (!user || user.is_active !== 1) return null;
    this.db.run('UPDATE sessions SET last_seen_at = ? WHERE id = ?', [new Date().toISOString(), session.id]);
    return { session, user };
  }

  switchBusiness(sessionId: string, businessId: string | null): void {
    this.db.run('UPDATE sessions SET business_id = ? WHERE id = ?', [businessId, sessionId]);
  }

  destroySession(sessionId: string): void {
    this.db.run('DELETE FROM sessions WHERE id = ?', [sessionId]);
  }

  /** Drop expired sessions (called by the background job). */
  pruneExpiredSessions(): number {
    return this.db.run('DELETE FROM sessions WHERE expires_at <= ?', [new Date().toISOString()]).changes;
  }
}
