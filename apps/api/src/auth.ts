import { createHash, createHmac, randomInt, randomUUID, scryptSync, timingSafeEqual, randomBytes } from 'node:crypto';
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

/**
 * Reset codes are high-entropy (12 chars from a 32-symbol alphabet), single-use
 * and short-lived, so a plain SHA-256 is the right storage here - unlike a user
 * password, which is low-entropy and needs scrypt.
 */
function hashResetCode(code: string): string {
  return createHash('sha256').update(code.replace(/[^A-Za-z0-9]/g, '').toUpperCase()).digest('hex');
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

  // ------------------------------------------------------------ password reset
  //
  // There is no email provider in this deployment (zero-cost, self-hosted), so a
  // reset cannot be emailed. Instead a partner who may manage members issues a
  // one-time code and reads it out; the person redeems it themselves, from any
  // device, including the phone. Only the SHA-256 of the code is stored.

  /** Issue a one-time code. The plain code is returned ONCE and never stored. */
  issueResetCode(userId: string, email: string, businessId: string | null, createdBy: string, ttlMinutes = 30): { code: string; expiresAt: string } {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I - it is read aloud
    const chars: string[] = [];
    for (let index = 0; index < 12; index += 1) chars.push(alphabet.charAt(randomInt(alphabet.length)));
    const code = `${chars.slice(0, 4).join('')}-${chars.slice(4, 8).join('')}-${chars.slice(8, 12).join('')}`;
    const expiresAt = new Date(Date.now() + ttlMinutes * 60_000).toISOString();
    // A new code retires every earlier unused one, so only one is ever live.
    this.db.run('UPDATE password_resets SET used_at = ? WHERE user_id = ? AND used_at IS NULL', [new Date().toISOString(), userId]);
    this.db.run(
      'INSERT INTO password_resets (id, business_id, user_id, email, code_hash, expires_at, used_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)',
      [randomUUID(), businessId, userId, normalizeEmail(email), hashResetCode(code), expiresAt, createdBy, new Date().toISOString()],
    );
    return { code, expiresAt };
  }

  /** Redeem a code. Returns the user on success, null when wrong/expired/used. */
  consumeResetCode(email: string, code: string): UserRow | null {
    const now = new Date().toISOString();
    const row = this.db.get<{ id: string; user_id: string; code_hash: string; expires_at: string }>(
      'SELECT * FROM password_resets WHERE email = ? AND used_at IS NULL ORDER BY created_at DESC LIMIT 1',
      [normalizeEmail(email)],
    );
    if (!row) return null;
    const stored = Buffer.from(row.code_hash, 'hex');
    const supplied = Buffer.from(hashResetCode(code), 'hex');
    if (stored.length !== supplied.length || !timingSafeEqual(stored, supplied)) return null;
    if (row.expires_at <= now) return null;
    const user = this.db.get<UserRow>('SELECT * FROM users WHERE id = ? AND is_active = 1', [row.user_id]);
    if (!user) return null;
    this.db.run('UPDATE password_resets SET used_at = ? WHERE id = ?', [now, row.id]);
    return user;
  }

  /**
   * Set a new password and end every other session for that account. A reset is
   * a security event: whoever was signed in (possibly an intruder) is cut off.
   */
  setPassword(userId: string, password: string, keepSessionId?: string): void {
    const { hash, salt } = hashPassword(password);
    this.db.run('UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?', [hash, salt, userId]);
    if (keepSessionId) this.db.run('DELETE FROM sessions WHERE user_id = ? AND id <> ?', [userId, keepSessionId]);
    else this.db.run('DELETE FROM sessions WHERE user_id = ?', [userId]);
  }

  /** Change your own password while signed in (needs the current one). */
  changePassword(userId: string, currentPassword: string, newPassword: string, keepSessionId?: string): boolean {
    const user = this.db.get<UserRow>('SELECT * FROM users WHERE id = ?', [userId]);
    if (!user || !verifyPassword(currentPassword, user.password_hash, user.password_salt)) return false;
    this.setPassword(userId, newPassword, keepSessionId);
    return true;
  }

  /** Drop expired sessions (called by the background job). */
  pruneExpiredSessions(): number {
    return this.db.run('DELETE FROM sessions WHERE expires_at <= ?', [new Date().toISOString()]).changes;
  }
}
