import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../src/hash.js';
import {
  DEFAULT_MODULES,
  INVITE_DEFAULT_TTL_HOURS,
  defaultBusiness,
  generateInviteCode,
  inviteExpiry,
  normalizeInviteCode,
  slugify,
  validateInviteRedemption,
  type BusinessInvite,
} from '../src/tenancy.js';

const codeHashOf = (code: string) => sha256Hex(normalizeInviteCode(code));

function invite(overrides: Partial<BusinessInvite> = {}): BusinessInvite {
  const code = 'K7QM-3XZP-9HTR-4WDN';
  return {
    id: 'inv-1',
    businessId: 'biz-1',
    email: null,
    role: 'manager',
    codeHash: codeHashOf(code),
    codePrefix: normalizeInviteCode(code).slice(0, 4),
    status: 'open',
    createdAt: '2026-05-01T00:00:00.000Z',
    expiresAt: '2026-05-04T00:00:00.000Z',
    createdBy: 'owner-1',
    useCount: 0,
    maxUses: 1,
    ...overrides,
  };
}

describe('invite codes', () => {
  it('generates high-entropy, human-readable codes', () => {
    const code = generateInviteCode();
    expect(code).toMatch(/^[A-Z2-9]{4}(-[A-Z2-9]{4})+$/);
    // No confusing characters (0/O, 1/I) end up in a code.
    expect(code).not.toMatch(/[01OI]/);
    expect(new Set(Array.from({ length: 50 }, () => generateInviteCode())).size).toBe(50);
  });

  it('normalises a pasted code', () => {
    expect(normalizeInviteCode('k7qm 3xzp-9htr4wdn')).toBe('K7QM3XZP9HTR4WDN');
  });

  it('sets expiry from the configured ttl', () => {
    const expiry = inviteExpiry('2026-05-01T00:00:00.000Z', INVITE_DEFAULT_TTL_HOURS);
    expect(expiry).toBe('2026-05-04T00:00:00.000Z');
  });

  it('never stores the raw code', () => {
    const generated = generateInviteCode();
    expect(invite().codeHash).not.toContain(generated);
    expect(invite().codeHash).toHaveLength(64);
  });
});

describe('invite redemption (server-side, atomic)', () => {
  const code = 'K7QM-3XZP-9HTR-4WDN';
  const now = '2026-05-02T00:00:00.000Z';

  it('accepts a valid, unexpired, unused invite', () => {
    const verdict = validateInviteRedemption({ code, invite: invite(), now, redeemingEmail: 'partner@example.com', codeHashOf });
    expect(verdict.ok).toBe(true);
  });

  it('rejects an unknown code without revealing whether the business exists', () => {
    expect(validateInviteRedemption({ code: 'ZZZZ-ZZZZ-ZZZZ-ZZZZ', invite: invite(), now, redeemingEmail: 'a@b.com', codeHashOf })).toEqual({ ok: false, reason: 'NOT_FOUND' });
    expect(validateInviteRedemption({ code, invite: null, now, redeemingEmail: 'a@b.com', codeHashOf })).toEqual({ ok: false, reason: 'NOT_FOUND' });
  });

  it('rejects expired, revoked, already-used and exhausted invites', () => {
    expect(validateInviteRedemption({ code, invite: invite({ expiresAt: '2026-05-01T00:00:00.000Z' }), now, redeemingEmail: 'a@b.com', codeHashOf }).ok).toBe(false);
    expect(validateInviteRedemption({ code, invite: invite({ expiresAt: '2026-05-01T00:00:00.000Z' }), now, redeemingEmail: 'a@b.com', codeHashOf })).toEqual({ ok: false, reason: 'EXPIRED' });
    expect(validateInviteRedemption({ code, invite: invite({ status: 'revoked' }), now, redeemingEmail: 'a@b.com', codeHashOf })).toEqual({ ok: false, reason: 'REVOKED' });
    expect(validateInviteRedemption({ code, invite: invite({ status: 'accepted' }), now, redeemingEmail: 'a@b.com', codeHashOf })).toEqual({ ok: false, reason: 'ALREADY_USED' });
    expect(validateInviteRedemption({ code, invite: invite({ useCount: 1, maxUses: 1 }), now, redeemingEmail: 'a@b.com', codeHashOf })).toEqual({ ok: false, reason: 'EXHAUSTED' });
  });

  it('binds an email-scoped invite to that email only', () => {
    const scoped = invite({ email: 'partner@example.com' });
    expect(validateInviteRedemption({ code, invite: scoped, now, redeemingEmail: 'partner@example.com', codeHashOf }).ok).toBe(true);
    expect(validateInviteRedemption({ code, invite: scoped, now, redeemingEmail: 'someone.else@example.com', codeHashOf })).toEqual({ ok: false, reason: 'EMAIL_MISMATCH' });
  });
});

describe('business defaults', () => {
  it('creates a Bangladesh-first free business workspace', () => {
    const business = defaultBusiness({ id: 'biz-1', name: '  Rahim Agro & Store  ', ownerId: 'user-1' });
    expect(business.name).toBe('Rahim Agro & Store');
    expect(business.slug).toBe('rahim-agro-store');
    expect(business.currency).toBe('BDT');
    expect(business.timezone).toBe('Asia/Dhaka');
    expect(business.locale).toBe('bn-BD');
    expect(business.plan).toBe('free');
    expect(business.revision).toBe(1);
    expect(business.farmingTypes).toEqual([]);
    expect(business.enabledModules).toEqual([...DEFAULT_MODULES]);
  });

  it('slugifies safely for any input', () => {
    expect(slugify('Mehedi Hasan Sajal')).toBe('mehedi-hasan-sajal');
    expect(slugify('আমার দোকান')).toBe('business');
    expect(slugify('!!!')).toBe('business');
    expect(slugify('  A  B  ')).toBe('a-b');
  });
});
