import type { Permission } from './permissions.js';
import type { Role } from './permissions.js';

/** Tenancy: one business shared by 2-5 partners, each with their own login. */

export type BusinessPlan = 'free' | 'standard';

export interface Business {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly currency: string;
  readonly timezone: string;
  readonly locale: string;
  readonly country: string;
  /** Farming types enabled for this business. Empty means the module is hidden. */
  readonly farmingTypes: readonly string[];
  readonly enabledModules: readonly string[];
  readonly plan: BusinessPlan;
  readonly createdAt: string;
  readonly createdBy: string;
  readonly revision: number;
}

export type MemberStatus = 'active' | 'invited' | 'suspended' | 'removed';

export interface BusinessMember {
  readonly id: string;
  readonly businessId: string;
  readonly userId: string;
  readonly email: string;
  readonly displayName: string;
  readonly role: Role;
  readonly status: MemberStatus;
  /** Extra permissions on top of the role. */
  readonly grants: readonly Permission[];
  /** Permissions removed from the role for this member. */
  readonly denials: readonly Permission[];
  readonly joinedAt: string;
  readonly invitedBy?: string | null;
  readonly lastActiveAt?: string | null;
}

export type InviteStatus = 'open' | 'accepted' | 'expired' | 'revoked';

export interface BusinessInvite {
  readonly id: string;
  readonly businessId: string;
  readonly email?: string | null;
  readonly role: Role;
  /** SHA-256 of the invite code; the code itself is never stored. */
  readonly codeHash: string;
  /** First characters of the code, shown to the owner so they can identify it. */
  readonly codePrefix: string;
  readonly status: InviteStatus;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly createdBy: string;
  readonly acceptedAt?: string | null;
  readonly acceptedBy?: string | null;
  readonly useCount: number;
  readonly maxUses: number;
}

export const INVITE_DEFAULT_TTL_HOURS = 72;
export const INVITE_CODE_BYTES = 24;
/** Invite codes are base32-ish, easy to read out over the phone. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function randomBytes(length: number): Uint8Array {
  const cryptoObj = (globalThis as { crypto?: { getRandomValues?: (array: Uint8Array) => Uint8Array } }).crypto;
  if (!cryptoObj?.getRandomValues) throw new Error('tenancy: Web Crypto getRandomValues is required');
  const bytes = new Uint8Array(length);
  cryptoObj.getRandomValues(bytes);
  return bytes;
}

/**
 * High-entropy, human-readable invite code, e.g. `K7QM-3XZP-9HTR-4WDN`.
 * 32^20 possibilities, so brute force is not a realistic attack.
 */
export function generateInviteCode(bytes = INVITE_CODE_BYTES, groupSize = 4): string {
  const raw = randomBytes(bytes);
  let out = '';
  for (const byte of raw) out += CODE_ALPHABET[byte % CODE_ALPHABET.length] as string;
  const groups: string[] = [];
  for (let i = 0; i < out.length; i += groupSize) groups.push(out.slice(i, i + groupSize));
  return groups.join('-');
}

export function normalizeInviteCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export interface InviteRedeemContext {
  readonly code: string;
  readonly invite: Pick<BusinessInvite, 'codeHash' | 'status' | 'expiresAt' | 'useCount' | 'maxUses' | 'email'> | null;
  readonly now: string;
  readonly redeemingEmail: string;
  readonly codeHashOf: (code: string) => string;
}

export type InviteRedeemVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'NOT_FOUND' | 'EXPIRED' | 'REVOKED' | 'ALREADY_USED' | 'EXHAUSTED' | 'EMAIL_MISMATCH' };

/**
 * Server-side invite validation. Always runs on the server, atomically, so a
 * code cannot be replayed or brute forced from the client.
 */
export function validateInviteRedemption(context: InviteRedeemContext): InviteRedeemVerdict {
  const invite = context.invite;
  if (!invite) return { ok: false, reason: 'NOT_FOUND' };
  if (context.codeHashOf(context.code) !== invite.codeHash) return { ok: false, reason: 'NOT_FOUND' };
  if (invite.status === 'revoked') return { ok: false, reason: 'REVOKED' };
  if (invite.status === 'accepted') return { ok: false, reason: 'ALREADY_USED' };
  if (invite.expiresAt <= context.now) return { ok: false, reason: 'EXPIRED' };
  if (invite.useCount >= invite.maxUses) return { ok: false, reason: 'EXHAUSTED' };
  if (invite.email && invite.email.toLowerCase() !== context.redeemingEmail.toLowerCase()) {
    return { ok: false, reason: 'EMAIL_MISMATCH' };
  }
  return { ok: true };
}

export function inviteExpiry(from: Date | string, ttlHours = INVITE_DEFAULT_TTL_HOURS): string {
  const start = from instanceof Date ? from : new Date(from);
  return new Date(start.getTime() + ttlHours * 3_600_000).toISOString();
}

/** `slug` is used for URLs; keep it stable and URL-safe. */
export function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 40)
    .replace(/^-|-$/g, '');
  return base === '' ? 'business' : base;
}

export const DEFAULT_MODULES = [
  'dashboard', 'sales', 'purchases', 'inventory', 'customers', 'suppliers', 'finance', 'farming', 'reports', 'team', 'settings', 'ai',
] as const;

export type ModuleId = (typeof DEFAULT_MODULES)[number];

export function defaultBusiness(input: {
  id: string;
  name: string;
  ownerId: string;
  currency?: string;
  timezone?: string;
  locale?: string;
  country?: string;
  createdAt?: string;
}): Business {
  return {
    id: input.id,
    name: input.name.trim(),
    slug: slugify(input.name),
    currency: input.currency ?? 'BDT',
    timezone: input.timezone ?? 'Asia/Dhaka',
    locale: input.locale ?? 'en',
    country: input.country ?? 'BD',
    farmingTypes: [],
    enabledModules: [...DEFAULT_MODULES],
    plan: 'free',
    createdAt: input.createdAt ?? new Date().toISOString(),
    createdBy: input.ownerId,
    revision: 1,
  };
}
