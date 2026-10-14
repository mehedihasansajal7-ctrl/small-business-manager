import { randomUUID } from 'node:crypto';
import {
  ACCOUNT,
  Decimal,
  StockError,
  addMoney,
  addDays,
  allocateCost,
  assignHarvestCost,
  balanceSheet,
  buildCustomerReceiptPosting,
  buildDirectBatchCostPosting,
  buildHarvestPosting,
  buildIncomeExpensePosting,
  buildInputIssuePosting,
  buildInventoryLossPosting,
  buildOpeningBalancePosting,
  buildPartnerCapitalPosting,
  buildPurchasePosting,
  buildReversal,
  buildSalePosting,
  buildSupplierPaymentPosting,
  buildTransferPosting,
  cashBasisOperatingResult,
  cashFlow,
  checkStockImpact,
  currentUnitCost,
  dec,
  defaultBusiness,
  formatMoney,
  generateInviteCode,
  inviteExpiry,
  isValidEmail,
  localDateString,
  money,
  mulMoney,
  normalizeInviteCode,
  pctOf,
  permissionsFor,
  profitAndLoss,
  reversalMovements,
  sha256Hex,
  subMoney,
  sumMoney,
  trialBalance,
  UnitRegistry,
  validateInviteRedemption,
  validateJournalEntry,
  weightedAverageValuation,
  zeroMoney,
} from '@sbm/domain';
import type {
  BusinessVisibilitySettings,
  CostAllocationShare,
  Dimension,
  ExplicitConversion,
  FarmingType,
  FarmUnitKind,
  JournalEntry,
  JournalLine,
  Money,
  Permission,
  Role,
  StockMovement,
  UnitDef,
} from '@sbm/domain';
import type { AuthService, UserRow } from './auth.js';
import type { AppConfig } from './config.js';
import { Database, nextReference, parseJson } from './db.js';
import { HttpError, requireEnum, requireString, optionalString, asRecord } from './http.js';

/** Row shapes (SQLite stores decimals as TEXT and booleans as 0/1). */
export interface BusinessRow {
  id: string;
  name: string;
  slug: string;
  currency: string;
  timezone: string;
  locale: string;
  country: string;
  farming_types: string;
  enabled_modules: string;
  settings: string;
  plan: string;
  revision: number;
  created_at: string;
  created_by: string;
}

export interface MemberRow {
  id: string;
  business_id: string;
  user_id: string;
  email: string;
  display_name: string;
  role: string;
  status: string;
  grants: string;
  denials: string;
  joined_at: string;
  invited_by: string | null;
  last_active_at: string | null;
}

export interface ProductRow {
  id: string;
  business_id: string;
  sku: string | null;
  name: string;
  name_bn: string | null;
  category_id: string | null;
  kind: string;
  unit: string;
  sale_price: string | null;
  purchase_price: string | null;
  tax_rate: string | null;
  reorder_level: string | null;
  track_lots: number;
  is_active: number;
  revision: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface MovementRow {
  id: string;
  business_id: string;
  item_id: string;
  location_id: string;
  direction: 'IN' | 'OUT';
  quantity: string;
  unit: string;
  unit_cost: string;
  currency: string;
  lot_id: string | null;
  expiry_date: string | null;
  source_type: string;
  source_id: string;
  actor_id: string;
  device_id: string | null;
  event_id: string;
  idempotency_key: string;
  reversal_of: string | null;
  reason: string | null;
  occurred_at: string;
  created_at: string;
}

export interface Caller {
  readonly user: UserRow;
  readonly business: BusinessRow;
  readonly member: MemberRow;
  readonly role: Role;
}

const VISIBILITY_KEYS: readonly (keyof BusinessVisibilitySettings)[] = ['partnerCanSeeFinancialReports', 'partnerCanSeeCosts', 'partnerCanSeeCapital'];

/** Length in the longest dimension, for scale limits in numeric handling. */
export function isKnownDimension(value: string): value is Dimension {
  return ['MASS', 'VOLUME', 'COUNT', 'AREA', 'LENGTH', 'TIME'].includes(value);
}

export class Repository {
  constructor(
    readonly db: Database,
    readonly auth: AuthService,
    readonly config: AppConfig,
  ) {}

  private now(): string {
    return new Date().toISOString();
  }

  private id(): string {
    return randomUUID();
  }

  // -------------------------------------------------------------------------
  // Tenancy, membership and audit
  // -------------------------------------------------------------------------

  audit(input: {
    businessId: string | null;
    actorId: string | null;
    action: string;
    entityType: string;
    entityId?: string | null;
    detail?: unknown;
    deviceId?: string | null;
    actorEmail?: string | null;
  }): void {
    // Resolve the actor's email so an audit row is always attributable, even
    // when the caller did not pass it explicitly.
    let actorEmail = input.actorEmail ?? null;
    if (!actorEmail && input.actorId) {
      actorEmail = this.db.get<{ email: string }>('SELECT email FROM users WHERE id = ?', [input.actorId])?.email ?? null;
    }
    this.db.run(
      'INSERT INTO audit_logs (id, business_id, actor_id, actor_email, action, entity_type, entity_id, detail, device_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        this.id(),
        input.businessId,
        input.actorId,
        actorEmail,
        input.action,
        input.entityType,
        input.entityId ?? null,
        JSON.stringify(input.detail ?? {}),
        input.deviceId ?? null,
        this.now(),
      ],
    );
  }

  listBusinessesForUser(userId: string): unknown[] {
    return this.db
      .all<MemberRow & { business_name: string; currency: string; timezone: string; slug: string }>(
        `SELECT m.*, b.name AS business_name, b.currency, b.timezone, b.slug
         FROM members m JOIN businesses b ON b.id = m.business_id
         WHERE m.user_id = ? AND m.status = 'active' AND b.id IS NOT NULL
         ORDER BY m.joined_at`,
        [userId],
      )
      .map((row) => ({
        businessId: row.business_id,
        name: row.business_name,
        slug: row.slug,
        currency: row.currency,
        timezone: row.timezone,
        role: row.role,
        memberId: row.id,
      }));
  }

  getBusiness(businessId: string): BusinessRow {
    const row = this.db.get<BusinessRow>('SELECT * FROM businesses WHERE id = ?', [businessId]);
    if (!row) throw HttpError.notFound('Business not found');
    return row;
  }

  settingsFor(businessId: string): BusinessVisibilitySettings {
    const rows = this.db.all<{ key: string; value: string }>('SELECT key, value FROM business_settings WHERE business_id = ?', [businessId]);
    const settings: Record<string, unknown> = {};
    for (const row of rows) settings[row.key] = parseJson<unknown>(row.value, null);
    const visibility: BusinessVisibilitySettings = {};
    for (const key of VISIBILITY_KEYS) {
      if (settings[key] === true) (visibility as Record<string, unknown>)[key] = true;
    }
    return visibility;
  }

  setSetting(businessId: string, key: string, value: unknown): void {
    this.db.run(
      `INSERT INTO business_settings (business_id, key, value, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(business_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [businessId, key, JSON.stringify(value), this.now()],
    );
  }

  /** Resolve the caller's membership and role for a business. Throws when absent. */
  caller(user: UserRow, businessId: string): Caller {
    const business = this.getBusiness(businessId);
    const member = this.db.get<MemberRow>(`SELECT * FROM members WHERE business_id = ? AND user_id = ?`, [businessId, user.id]);
    if (!member) throw HttpError.forbidden('You are not a member of this business');
    if (member.status === 'suspended') throw HttpError.forbidden('Your access to this business has been suspended');
    if (member.status === 'removed') throw HttpError.forbidden('You were removed from this business');
    return { user, business, member, role: member.role as Role };
  }

  permissions(caller: Caller): ReadonlySet<Permission> {
    return permissionsFor(
      caller.role,
      { grants: parseJson<Permission[]>(caller.member.grants, []), denials: parseJson<Permission[]>(caller.member.denials, []) },
      this.settingsFor(caller.business.id),
    );
  }

  assertPermission(caller: Caller, permission: Permission): void {
    if (!this.permissions(caller).has(permission)) {
      throw HttpError.forbidden(`Your role (${caller.role}) does not have permission: ${permission}`);
    }
  }

  createBusiness(user: UserRow, input: { name: string; currency?: string; timezone?: string; locale?: string; country?: string }): { business: BusinessRow; member: MemberRow } {
    const name = requireString(input.name, 'name', { maxLength: 120 });
    const businessId = this.id();
    const draft = defaultBusiness({
      id: businessId,
      name,
      ownerId: user.id,
      ...(input.currency ? { currency: input.currency } : {}),
      ...(input.timezone ? { timezone: input.timezone } : {}),
      ...(input.locale ? { locale: input.locale } : {}),
      ...(input.country ? { country: input.country } : {}),
      createdAt: this.now(),
    });
    const slug = this.uniqueSlug(draft.slug);

    return this.db.transaction(() => {
      this.db.run(
        `INSERT INTO businesses (id, name, slug, currency, timezone, locale, country, farming_types, enabled_modules, settings, plan, revision, created_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'free', 1, ?, ?)`,
        [
          businessId,
          draft.name,
          slug,
          draft.currency,
          draft.timezone,
          draft.locale,
          draft.country,
          JSON.stringify(draft.farmingTypes),
          JSON.stringify(draft.enabledModules),
          JSON.stringify({}),
          this.now(),
          user.id,
        ],
      );
      const memberId = this.id();
      this.db.run(
        `INSERT INTO members (id, business_id, user_id, email, display_name, role, status, grants, denials, joined_at)
         VALUES (?, ?, ?, ?, ?, 'owner', 'active', '[]', '[]', ?)`,
        [memberId, businessId, user.id, user.email, user.display_name, this.now()],
      );
      // A default cash location so the first purchase/sale can be recorded immediately.
      this.db.run(`INSERT INTO locations (id, business_id, name, kind, is_default, is_active, created_at) VALUES (?, ?, 'Main Store', 'STORE', 1, 1, ?)`, [
        this.id(),
        businessId,
        this.now(),
      ]);
      this.audit({ businessId, actorId: user.id, actorEmail: user.email, action: 'business.create', entityType: 'business', entityId: businessId, detail: { name: draft.name } });
      return { business: this.getBusiness(businessId), member: this.db.get<MemberRow>('SELECT * FROM members WHERE id = ?', [memberId]) as MemberRow };
    });
  }

  private uniqueSlug(base: string): string {
    let candidate = base;
    let suffix = 1;
    while (this.db.get('SELECT id FROM businesses WHERE slug = ?', [candidate])) {
      suffix += 1;
      candidate = `${base}-${suffix}`;
    }
    return candidate;
  }

  updateBusiness(caller: Caller, patch: Record<string, unknown>): BusinessRow {
    this.assertPermission(caller, 'business.settings');
    const name = patch.name === undefined ? caller.business.name : requireString(patch.name, 'name', { maxLength: 120 });
    const currency = patch.currency === undefined ? caller.business.currency : requireString(patch.currency, 'currency', { maxLength: 8 }).toUpperCase();
    const timezone = patch.timezone === undefined ? caller.business.timezone : requireString(patch.timezone, 'timezone', { maxLength: 64 });
    const locale = patch.locale === undefined ? caller.business.locale : requireString(patch.locale, 'locale', { maxLength: 16 });
    const farmingTypes = patch.farmingTypes === undefined ? parseJson<string[]>(caller.business.farming_types, []) : (patch.farmingTypes as string[]);

    this.db.run('UPDATE businesses SET name = ?, currency = ?, timezone = ?, locale = ?, farming_types = ?, revision = revision + 1 WHERE id = ?', [
      name,
      currency,
      timezone,
      locale,
      JSON.stringify(farmingTypes),
      caller.business.id,
    ]);
    this.audit({ businessId: caller.business.id, actorId: caller.user.id, action: 'business.update', entityType: 'business', entityId: caller.business.id, detail: patch });
    return this.getBusiness(caller.business.id);
  }

  listMembers(caller: Caller): unknown[] {
    this.assertPermission(caller, 'member.view');
    return this.db.all<MemberRow>('SELECT * FROM members WHERE business_id = ? ORDER BY joined_at', [caller.business.id]).map((m) => ({
      id: m.id,
      userId: m.user_id,
      email: m.email,
      displayName: m.display_name,
      role: m.role,
      status: m.status,
      grants: parseJson<string[]>(m.grants, []),
      denials: parseJson<string[]>(m.denials, []),
      joinedAt: m.joined_at,
      lastActiveAt: m.last_active_at,
    }));
  }

  createInvite(caller: Caller, input: { role: string; email?: string | null; ttlHours?: number }): { code: string; invite: Record<string, unknown> } {
    this.assertPermission(caller, 'member.invite');
    const role = requireEnum(input.role, 'role', ['admin', 'manager', 'cashier', 'inventory_manager', 'farm_manager', 'viewer'] as const);
    const email = input.email ? requireString(input.email, 'email', { maxLength: 254 }).toLowerCase() : null;
    if (email && !isValidEmail(email)) throw HttpError.badRequest('VALIDATION', 'email is not a valid address');

    const code = generateInviteCode();
    const now = this.now();
    const expiresAt = inviteExpiry(now, input.ttlHours ?? 72);
    const id = this.id();
    this.db.run(
      `INSERT INTO invites (id, business_id, email, role, code_hash, code_prefix, status, created_at, expires_at, created_by, use_count, max_uses)
       VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, 0, 1)`,
      [id, caller.business.id, email, role, sha256Hex(normalizeInviteCode(code)), normalizeInviteCode(code).slice(0, 4), now, expiresAt, caller.user.id],
    );
    this.audit({ businessId: caller.business.id, actorId: caller.user.id, action: 'member.invite', entityType: 'invite', entityId: id, detail: { role, email } });
    return { code, invite: { id, role, email, expiresAt, codePrefix: normalizeInviteCode(code).slice(0, 4) } };
  }

  listInvites(caller: Caller): unknown[] {
    this.assertPermission(caller, 'member.invite');
    return this.db
      .all<{ id: string; email: string | null; role: string; status: string; created_at: string; expires_at: string; use_count: number; max_uses: number; code_prefix: string }>(
        'SELECT id, email, role, status, created_at, expires_at, use_count, max_uses, code_prefix FROM invites WHERE business_id = ? ORDER BY created_at DESC',
        [caller.business.id],
      )
      .map((row) => ({ id: row.id, email: row.email, role: row.role, status: row.status, createdAt: row.created_at, expiresAt: row.expires_at, uses: row.use_count, maxUses: row.max_uses, codePrefix: row.code_prefix }));
  }

  revokeInvite(caller: Caller, inviteId: string): void {
    this.assertPermission(caller, 'member.invite');
    const changed = this.db.run(`UPDATE invites SET status = 'revoked' WHERE id = ? AND business_id = ? AND status = 'open'`, [inviteId, caller.business.id]).changes;
    if (changed === 0) throw HttpError.notFound('Open invite not found');
    this.audit({ businessId: caller.business.id, actorId: caller.user.id, action: 'invite.revoke', entityType: 'invite', entityId: inviteId });
  }

  /** Redeem an invite. Validated server-side and atomically, one time only. */
  acceptInvite(user: UserRow, code: string): { businessId: string; role: string } {
    const normalized = normalizeInviteCode(code);
    const codeHash = sha256Hex(normalized);
    return this.db.transaction(() => {
      const invite = this.db.get<{
        id: string;
        business_id: string;
        email: string | null;
        role: string;
        code_hash: string;
        status: string;
        expires_at: string;
        use_count: number;
        max_uses: number;
      }>('SELECT * FROM invites WHERE code_hash = ?', [codeHash]);

      const verdict = validateInviteRedemption({
        code: normalized,
        invite: invite
          ? {
              codeHash: invite.code_hash,
              status: invite.status as 'open' | 'accepted' | 'expired' | 'revoked',
              expiresAt: invite.expires_at,
              useCount: invite.use_count,
              maxUses: invite.max_uses,
              email: invite.email,
            }
          : null,
        now: this.now(),
        redeemingEmail: user.email,
        codeHashOf: (value) => sha256Hex(normalizeInviteCode(value)),
      });
      if (!verdict.ok) throw HttpError.badRequest('INVALID_INVITE', `This invitation cannot be used (${verdict.reason})`);
      if (!invite) throw HttpError.badRequest('INVALID_INVITE', 'This invitation cannot be used');

      const existing = this.db.get<MemberRow>('SELECT * FROM members WHERE business_id = ? AND user_id = ?', [invite.business_id, user.id]);
      if (existing && existing.status === 'active') {
        this.db.run(`UPDATE invites SET status = 'accepted', accepted_at = ?, accepted_by = ?, use_count = use_count + 1 WHERE id = ?`, [this.now(), user.id, invite.id]);
        return { businessId: invite.business_id, role: existing.role };
      }

      if (existing) {
        this.db.run(`UPDATE members SET status = 'active', role = ?, joined_at = ? WHERE id = ?`, [invite.role, this.now(), existing.id]);
      } else {
        this.db.run(
          `INSERT INTO members (id, business_id, user_id, email, display_name, role, status, grants, denials, joined_at, invited_by)
           VALUES (?, ?, ?, ?, ?, ?, 'active', '[]', '[]', ?, ?)`,
          [this.id(), invite.business_id, user.id, user.email, user.display_name, invite.role, this.now(), null],
        );
      }
      this.db.run(`UPDATE invites SET status = 'accepted', accepted_at = ?, accepted_by = ?, use_count = use_count + 1 WHERE id = ?`, [this.now(), user.id, invite.id]);
      this.audit({ businessId: invite.business_id, actorId: user.id, actorEmail: user.email, action: 'member.join', entityType: 'member', entityId: user.id, detail: { role: invite.role } });
      return { businessId: invite.business_id, role: invite.role };
    });
  }

  updateMember(caller: Caller, memberId: string, patch: { role?: string; status?: string; grants?: string[]; denials?: string[] }): void {
    const target = this.db.get<MemberRow>('SELECT * FROM members WHERE id = ? AND business_id = ?', [memberId, caller.business.id]);
    if (!target) throw HttpError.notFound('Member not found');

    const ownerCount = this.db.get<{ count: number }>(`SELECT COUNT(*) AS count FROM members WHERE business_id = ? AND role = 'owner' AND status = 'active'`, [caller.business.id])?.count ?? 0;
    const newRole = patch.role ?? target.role;
    const actorIsOwner = caller.role === 'owner';
    const actingOnSelf = target.user_id === caller.user.id;

    // --- Guardrails -------------------------------------------------------
    // 1. Per-member permission OVERRIDES are an owner-only action, and nobody
    //    may edit their own: without this, any member with `member.manage`
    //    could simply grant themselves `business.transfer_ownership` (or
    //    `business.delete`) and escalate out of their role.
    if (patch.grants !== undefined || patch.denials !== undefined) {
      if (!actorIsOwner) throw HttpError.forbidden('Only the owner can change per-member permission overrides');
      if (actingOnSelf) throw HttpError.badRequest('VALIDATION', 'You cannot change your own permission overrides');
    }
    // 2. Only the owner may touch an owner's row (including their denials).
    if (target.role === 'owner' && !actorIsOwner) throw HttpError.forbidden('Only the owner can change another owner');
    // 3. An admin cannot modify another admin: that would let two admins fight
    //    over access. Admins keep day-to-day control over lower roles only.
    if (!actorIsOwner && target.role === 'admin' && caller.role === 'admin' && !actingOnSelf) {
      throw HttpError.forbidden('Only the owner can change another admin');
    }
    // 4. Nobody may hand out a permission they do not themselves hold.
    if (patch.grants) {
      const allPermissions = permissionsFor('owner');
      const held = this.permissions(caller);
      for (const granted of patch.grants) {
        if (!allPermissions.has(granted as Permission)) throw HttpError.badRequest('VALIDATION', `Unknown permission: ${granted}`);
        if (!held.has(granted as Permission)) throw HttpError.forbidden(`You cannot grant a permission you do not hold: ${granted}`);
      }
    }
    if (patch.denials) {
      const allPermissions = permissionsFor('owner');
      for (const denied of patch.denials) {
        if (!allPermissions.has(denied as Permission)) throw HttpError.badRequest('VALIDATION', `Unknown permission: ${denied}`);
      }
    }
    // 5. A member cannot suspend or remove themselves.
    if (patch.status !== undefined && patch.status !== 'active' && actingOnSelf) {
      throw HttpError.badRequest('VALIDATION', 'You cannot suspend or remove yourself');
    }

    if (patch.role && patch.role !== target.role) {
      // Ownership transfer needs the explicit permission; other role changes are
      // ordinary management.
      if (newRole === 'owner' || target.role === 'owner') this.assertPermission(caller, 'business.transfer_ownership');
      else this.assertPermission(caller, 'member.manage');
      if (target.role === 'owner' && newRole !== 'owner' && ownerCount <= 1) {
        throw HttpError.conflict('LAST_OWNER', 'Cannot demote the only owner. Transfer ownership to another member first.');
      }
    } else if (patch.status !== undefined) {
      this.assertPermission(caller, 'member.manage');
      if (patch.status !== 'active' && target.role === 'owner' && ownerCount <= 1) {
        throw HttpError.conflict('LAST_OWNER', 'Cannot deactivate the only owner.');
      }
    } else if (patch.role === undefined && patch.status === undefined && patch.grants === undefined && patch.denials === undefined) {
      throw HttpError.badRequest('VALIDATION', 'Nothing to update');
    } else {
      this.assertPermission(caller, 'member.manage');
    }

    if (patch.role && newRole !== target.role) this.db.run(`UPDATE members SET role = ? WHERE id = ?`, [newRole, memberId]);
    if (patch.status) this.db.run('UPDATE members SET status = ? WHERE id = ?', [patch.status, memberId]);
    if (patch.grants) this.db.run('UPDATE members SET grants = ? WHERE id = ?', [JSON.stringify(patch.grants), memberId]);
    if (patch.denials) this.db.run('UPDATE members SET denials = ? WHERE id = ?', [JSON.stringify(patch.denials), memberId]);

    if (patch.status === 'removed' || patch.status === 'suspended') {
      this.db.run('DELETE FROM sessions WHERE user_id = ? AND business_id = ?', [target.user_id, caller.business.id]);
    }
    this.audit({
      businessId: caller.business.id,
      actorId: caller.user.id,
      action: 'member.update',
      entityType: 'member',
      entityId: memberId,
      detail: patch,
    });
  }

  listAuditLog(caller: Caller, limit = 100): unknown[] {
    this.assertPermission(caller, 'audit.view');
    return this.db
      .all<{ id: string; actor_email: string | null; action: string; entity_type: string; entity_id: string | null; detail: string; created_at: string }>(
        'SELECT id, actor_email, action, entity_type, entity_id, detail, created_at FROM audit_logs WHERE business_id = ? ORDER BY created_at DESC LIMIT ?',
        [caller.business.id, Math.min(500, limit)],
      )
      .map((row) => ({
        id: row.id,
        actor: row.actor_email,
        action: row.action,
        entityType: row.entity_type,
        entityId: row.entity_id,
        detail: parseJson<Record<string, unknown>>(row.detail, {}),
        at: row.created_at,
      }));
  }

  // -------------------------------------------------------------------------
  // Units
  // -------------------------------------------------------------------------

  unitRegistry(businessId: string): UnitRegistry {
    const rows = this.db.all<{ from_unit: string; to_unit: string; factor: string; note: string; item_id: string | null; approved_by: string; id: string }>(
      'SELECT * FROM explicit_conversions WHERE business_id = ?',
      [businessId],
    );
    const conversions: ExplicitConversion[] = rows.map((row) => ({
      id: row.id,
      from: row.from_unit,
      to: row.to_unit,
      factor: dec(row.factor),
      note: row.note,
      approvedBy: row.approved_by,
      ...(row.item_id ? { itemId: row.item_id } : {}),
    }));
    return new UnitRegistry([], conversions);
  }

  listUnits(caller: Caller, dimension?: string): unknown[] {
    const registry = this.unitRegistry(caller.business.id);
    const units = dimension ? registry.list(dimension as Dimension) : registry.list();
    return units.map((unit: UnitDef) => ({ code: unit.code, name: unit.name, nameBn: unit.nameBn ?? unit.name, dimension: unit.dimension, factor: unit.factor.toString(), integerOnly: Boolean(unit.integerOnly) }));
  }

  // -------------------------------------------------------------------------
  // Catalog: locations, products, customers, suppliers
  // -------------------------------------------------------------------------

  assertBusinessValue<T>(row: T | undefined, label: string): T {
    if (!row) throw HttpError.notFound(`${label} not found`);
    return row;
  }

  defaultLocationId(businessId: string): string {
    const row = this.db.get<{ id: string }>(`SELECT id FROM locations WHERE business_id = ? AND is_active = 1 ORDER BY is_default DESC, created_at LIMIT 1`, [businessId]);
    if (!row) throw HttpError.badRequest('NO_LOCATION', 'Create a stock location first (Settings → Locations)');
    return row.id;
  }

  createLocation(caller: Caller, input: Record<string, unknown>): { id: string } {
    this.assertPermission(caller, 'location.manage');
    const id = this.id();
    this.db.run('INSERT INTO locations (id, business_id, name, kind, address, is_default, is_active, created_at) VALUES (?, ?, ?, ?, ?, 0, 1, ?)', [
      id,
      caller.business.id,
      requireString(input.name, 'name', { maxLength: 80 }),
      optionalString(input.kind, 'kind', 32) ?? 'STORE',
      optionalString(input.address, 'address', 300),
      this.now(),
    ]);
    this.audit({ businessId: caller.business.id, actorId: caller.user.id, action: 'location.create', entityType: 'location', entityId: id });
    return { id };
  }

  listLocations(caller: Caller): unknown[] {
    return this.db
      .all<{ id: string; name: string; kind: string; address: string | null; is_default: number; is_active: number }>(
        'SELECT id, name, kind, address, is_default, is_active FROM locations WHERE business_id = ? ORDER BY is_default DESC, name',
        [caller.business.id],
      )
      .map((row) => ({ id: row.id, name: row.name, kind: row.kind, address: row.address, isDefault: row.is_default === 1, isActive: row.is_active === 1 }));
  }

  createProduct(caller: Caller, input: Record<string, unknown>): ProductRow {
    this.assertPermission(caller, 'product.manage');
    const id = this.id();
    const now = this.now();
    const unit = requireString(input.unit, 'unit', { maxLength: 24 });
    this.unitRegistry(caller.business.id).getUnit(unit);
    this.db.run(
      `INSERT INTO products (id, business_id, sku, name, name_bn, category_id, kind, unit, sale_price, purchase_price, tax_rate, reorder_level, track_lots, is_active, revision, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?)`,
      [
        id,
        caller.business.id,
        optionalString(input.sku, 'sku', 60),
        requireString(input.name, 'name', { maxLength: 160 }),
        optionalString(input.nameBn, 'nameBn', 160),
        optionalString(input.categoryId, 'categoryId', 64),
        requireEnum(input.kind ?? 'PRODUCT', 'kind', ['PRODUCT', 'SERVICE', 'INPUT', 'OUTPUT', 'LIVESTOCK'] as const),
        unit,
        input.salePrice === undefined || input.salePrice === null ? null : dec(String(input.salePrice)).toString(),
        input.purchasePrice === undefined || input.purchasePrice === null ? null : dec(String(input.purchasePrice)).toString(),
        input.taxRate === undefined || input.taxRate === null ? null : dec(String(input.taxRate)).toString(),
        input.reorderLevel === undefined || input.reorderLevel === null ? null : dec(String(input.reorderLevel)).toString(),
        input.trackLots ? 1 : 0,
        now,
        now,
      ],
    );
    this.audit({ businessId: caller.business.id, actorId: caller.user.id, action: 'product.create', entityType: 'product', entityId: id });
    return this.db.get<ProductRow>('SELECT * FROM products WHERE id = ?', [id]) as ProductRow;
  }

  updateProduct(caller: Caller, productId: string, patch: Record<string, unknown>): ProductRow {
    this.assertPermission(caller, 'product.manage');
    const existing = this.assertBusinessValue(this.db.get<ProductRow>('SELECT * FROM products WHERE id = ? AND business_id = ?', [productId, caller.business.id]), 'Product');
    const fields: string[] = [];
    const params: unknown[] = [];
    const map: Record<string, string> = {
      name: 'name', nameBn: 'name_bn', sku: 'sku', unit: 'unit', kind: 'kind', categoryId: 'category_id', salePrice: 'sale_price',
      purchasePrice: 'purchase_price', taxRate: 'tax_rate', reorderLevel: 'reorder_level',
    };
    for (const [key, column] of Object.entries(map)) {
      if (patch[key] === undefined) continue;
      if (key === 'unit') this.unitRegistry(caller.business.id).getUnit(String(patch[key]));
      const numeric = ['salePrice', 'purchasePrice', 'taxRate', 'reorderLevel'].includes(key);
      fields.push(`${column} = ?`);
      params.push(patch[key] === null ? null : numeric ? dec(String(patch[key])).toString() : String(patch[key]));
    }
    if (patch.isActive !== undefined) {
      fields.push('is_active = ?');
      params.push(patch.isActive ? 1 : 0);
    }
    if (patch.trackLots !== undefined) {
      fields.push('track_lots = ?');
      params.push(patch.trackLots ? 1 : 0);
    }
    if (fields.length === 0) return existing;
    fields.push('revision = revision + 1', 'updated_at = ?');
    params.push(this.now(), productId, caller.business.id);
    this.db.run(`UPDATE products SET ${fields.join(', ')} WHERE id = ? AND business_id = ?`, params);
    this.audit({ businessId: caller.business.id, actorId: caller.user.id, action: 'product.update', entityType: 'product', entityId: productId, detail: patch });
    return this.db.get<ProductRow>('SELECT * FROM products WHERE id = ?', [productId]) as ProductRow;
  }

  listProducts(caller: Caller, options: { search?: string; kind?: string; activeOnly?: boolean } = {}): unknown[] {
    const clauses = ['business_id = ?', 'deleted_at IS NULL'];
    const params: unknown[] = [caller.business.id];
    if (options.search) {
      clauses.push('(name LIKE ? OR name_bn LIKE ? OR sku LIKE ?)');
      const like = `%${options.search}%`;
      params.push(like, like, like);
    }
    if (options.kind) {
      clauses.push('kind = ?');
      params.push(options.kind);
    }
    if (options.activeOnly !== false) clauses.push('is_active = 1');
    const rows = this.db.all<ProductRow>(`SELECT * FROM products WHERE ${clauses.join(' AND ')} ORDER BY name LIMIT 500`, params);
    return rows.map((row) => this.productView(row, caller));
  }

  productView(row: ProductRow, caller: Caller): Record<string, unknown> {
    const showCost = this.permissions(caller).has('purchase.cost.view');
    const balance = this.stockBalance(caller.business.id, row.id);
    return {
      id: row.id,
      sku: row.sku,
      name: row.name,
      nameBn: row.name_bn,
      kind: row.kind,
      unit: row.unit,
      categoryId: row.category_id,
      isActive: row.is_active === 1,
      trackLots: row.track_lots === 1,
      revision: row.revision,
      salePrice: row.sale_price,
      reorderLevel: row.reorder_level,
      ...(showCost ? { purchasePrice: row.purchase_price, taxRate: row.tax_rate } : {}),
      onHand: balance.quantity.toString(),
      onHandUnit: row.unit,
    };
  }

  createCustomer(caller: Caller, input: Record<string, unknown>): { id: string } {
    this.assertPermission(caller, 'customer.manage');
    const id = this.id();
    const now = this.now();
    this.db.run(
      `INSERT INTO customers (id, business_id, name, phone, email, address, opening_balance, credit_limit, is_active, revision, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?)`,
      [
        id,
        caller.business.id,
        requireString(input.name, 'name', { maxLength: 160 }),
        optionalString(input.phone, 'phone', 32),
        optionalString(input.email, 'email', 254),
        optionalString(input.address, 'address', 400),
        input.openingBalance === undefined ? '0' : dec(String(input.openingBalance)).toString(),
        input.creditLimit === undefined || input.creditLimit === null ? null : dec(String(input.creditLimit)).toString(),
        now,
        now,
      ],
    );
    this.audit({ businessId: caller.business.id, actorId: caller.user.id, action: 'customer.create', entityType: 'customer', entityId: id });
    return { id };
  }

  listCustomers(caller: Caller, search?: string): unknown[] {
    this.assertPermission(caller, 'customer.view');
    const like = `%${search ?? ''}%`;
    return this.db
      .all<{ id: string; name: string; phone: string | null; email: string | null; opening_balance: string }>(
        'SELECT id, name, phone, email, opening_balance FROM customers WHERE business_id = ? AND (name LIKE ? OR phone LIKE ?) AND is_active = 1 ORDER BY name LIMIT 500',
        [caller.business.id, like, like],
      )
      .map((row) => ({ id: row.id, name: row.name, phone: row.phone, email: row.email, receivable: this.receivableFor(caller.business.id, row.id).amount.toString() }));
  }

  createSupplier(caller: Caller, input: Record<string, unknown>): { id: string } {
    this.assertPermission(caller, 'supplier.manage');
    const id = this.id();
    const now = this.now();
    this.db.run(
      `INSERT INTO suppliers (id, business_id, name, phone, email, address, opening_balance, is_active, revision, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?)`,
      [
        id,
        caller.business.id,
        requireString(input.name, 'name', { maxLength: 160 }),
        optionalString(input.phone, 'phone', 32),
        optionalString(input.email, 'email', 254),
        optionalString(input.address, 'address', 400),
        input.openingBalance === undefined ? '0' : dec(String(input.openingBalance)).toString(),
        now,
        now,
      ],
    );
    this.audit({ businessId: caller.business.id, actorId: caller.user.id, action: 'supplier.create', entityType: 'supplier', entityId: id });
    return { id };
  }

  listSuppliers(caller: Caller, search?: string): unknown[] {
    this.assertPermission(caller, 'supplier.view');
    const like = `%${search ?? ''}%`;
    return this.db
      .all<{ id: string; name: string; phone: string | null; opening_balance: string }>(
        'SELECT id, name, phone, opening_balance FROM suppliers WHERE business_id = ? AND name LIKE ? AND is_active = 1 ORDER BY name LIMIT 500',
        [caller.business.id, like],
      )
      .map((row) => ({ id: row.id, name: row.name, phone: row.phone, payable: this.payableFor(caller.business.id, row.id).amount.toString() }));
  }

  // -------------------------------------------------------------------------
  // Ledger + stock helpers
  // -------------------------------------------------------------------------

  journalEntries(businessId: string, range: { from?: string; to?: string } = {}): JournalEntry[] {
    const clauses = ['e.business_id = ?'];
    const params: unknown[] = [businessId];
    if (range.from) {
      clauses.push('e.document_date >= ?');
      params.push(range.from);
    }
    if (range.to) {
      clauses.push('e.document_date <= ?');
      params.push(range.to);
    }
    const entries = this.db.all<{ id: string; document_date: string; reference: string; description: string; source_type: string; source_id: string; currency: string; posted_by: string; device_id: string | null; event_id: string; reversal_of: string | null; created_at: string }>(
      `SELECT * FROM journal_entries e WHERE ${clauses.join(' AND ')} ORDER BY document_date, created_at`,
      params,
    );
    if (entries.length === 0) return [];
    const ids = entries.map((e) => e.id);
    const placeholders = ids.map(() => '?').join(',');
    const lines = this.db.all<{ id: string; entry_id: string; account: string; debit: string; credit: string; currency: string; memo: string | null; partner_id: string | null; cost_center: string | null }>(
      `SELECT * FROM journal_lines WHERE entry_id IN (${placeholders}) ORDER BY rowid`,
      ids,
    );
    const byEntry = new Map<string, JournalLine[]>();
    for (const line of lines) {
      const list = byEntry.get(line.entry_id) ?? [];
      list.push({
        account: line.account,
        debit: money(line.currency, line.debit),
        credit: money(line.currency, line.credit),
        ...(line.memo ? { memo: line.memo } : {}),
        ...(line.partner_id ? { partnerId: line.partner_id } : {}),
      });
      byEntry.set(line.entry_id, list);
    }
    return entries.map((entry) => ({
      id: entry.id,
      businessId,
      date: entry.document_date,
      reference: entry.reference,
      description: entry.description,
      sourceType: entry.source_type,
      sourceId: entry.source_id,
      lines: byEntry.get(entry.id) ?? [],
      currency: entry.currency,
      postedBy: entry.posted_by,
      ...(entry.device_id ? { deviceId: entry.device_id } : {}),
      eventId: entry.event_id,
      createdAt: entry.created_at,
      reversalOf: entry.reversal_of,
    }));
  }

  /** Persist a validated journal entry, refusing duplicates and unbalanced entries. */
  postJournal(caller: Caller, entry: JournalEntry, options: { allowDuplicateReference?: boolean } = {}): string {
    const validation = validateJournalEntry(entry);
    if (!validation.ok) throw HttpError.badRequest('UNBALANCED_ENTRY', `Journal entry rejected: ${validation.errors.join('; ')}`);
    const eventId = entry.eventId ?? entry.id;
    const existing = this.db.get<{ id: string }>('SELECT id FROM journal_entries WHERE event_id = ?', [eventId]);
    if (existing) return existing.id;

    const entryId = this.id();
    this.db.run(
      `INSERT INTO journal_entries (id, business_id, document_date, reference, description, source_type, source_id, currency, posted_by, device_id, event_id, reversal_of, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entryId,
        caller.business.id,
        entry.date,
        options.allowDuplicateReference ? `${entry.reference}#${entryId.slice(0, 8)}` : entry.reference,
        entry.description,
        entry.sourceType,
        entry.sourceId,
        entry.currency,
        caller.user.id,
        entry.deviceId ?? null,
        eventId,
        entry.reversalOf ?? null,
        this.now(),
      ],
    );
    for (const line of entry.lines) {
      this.db.run(
        `INSERT INTO journal_lines (id, business_id, entry_id, account, debit, credit, currency, memo, partner_id, cost_center)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          this.id(),
          caller.business.id,
          entryId,
          line.account,
          line.debit.amount.toString(),
          line.credit.amount.toString(),
          entry.currency,
          line.memo ?? null,
          line.partnerId ?? null,
          line.costCenter ?? null,
        ],
      );
    }
    return entryId;
  }

  private movements(businessId: string, itemId?: string): MovementRow[] {
    const clauses = ['business_id = ?'];
    const params: unknown[] = [businessId];
    if (itemId) {
      clauses.push('item_id = ?');
      params.push(itemId);
    }
    return this.db.all<MovementRow>(`SELECT * FROM stock_movements WHERE ${clauses.join(' AND ')} ORDER BY occurred_at, created_at, rowid`, params);
  }

  toDomainMovements(rows: readonly MovementRow[]): StockMovement[] {
    return rows.map((row) => ({
      id: row.id,
      businessId: row.business_id,
      itemId: row.item_id,
      locationId: row.location_id,
      direction: row.direction,
      quantity: dec(row.quantity),
      unit: row.unit,
      unitCost: money(row.currency, row.unit_cost),
      lotId: row.lot_id,
      expiryDate: row.expiry_date,
      sourceType: row.source_type as never,
      sourceId: row.source_id,
      actorId: row.actor_id,
      deviceId: row.device_id ?? '',
      eventId: row.event_id,
      idempotencyKey: row.idempotency_key,
      reversalOf: row.reversal_of,
      reason: row.reason,
      occurredAt: row.occurred_at,
      createdAt: row.created_at,
    }));
  }

  stockBalance(businessId: string, itemId: string, locationId?: string): { quantity: Decimal; unit: string } {
    const rows = this.movements(businessId, itemId).filter((r) => !locationId || r.location_id === locationId);
    let quantity = Decimal.ZERO;
    let unit = '';
    for (const row of rows) {
      unit = unit || row.unit;
      quantity = row.direction === 'IN' ? quantity.add(dec(row.quantity)) : quantity.sub(dec(row.quantity));
    }
    return { quantity, unit };
  }

  itemUnitCost(businessId: string, itemId: string, currency: string): Money {
    const rows = this.movements(businessId, itemId);
    if (rows.length === 0) return zeroMoney(currency);
    return currentUnitCost(this.toDomainMovements(rows), { itemId, currency });
  }

  recordMovement(
    caller: Caller,
    input: {
      itemId: string;
      locationId?: string;
      direction: 'IN' | 'OUT';
      quantity: Decimal;
      unit: string;
      unitCost: Money;
      sourceType: string;
      sourceId: string;
      lotId?: string | null;
      expiryDate?: string | null;
      reason?: string | null;
      occurredAt?: string;
      allowNegative?: boolean;
    },
  ): string {
    const locationId = input.locationId ?? this.defaultLocationId(caller.business.id);
    const rows = this.movements(caller.business.id, input.itemId);
    const check = checkStockImpact(this.toDomainMovements(rows), {
      itemId: input.itemId,
      locationId,
      direction: input.direction,
      quantity: input.quantity,
      unit: input.unit,
    }, { allowNegative: input.allowNegative === true });
    if (!check.ok) {
      throw new StockError(check.code ?? 'NEGATIVE_STOCK', check.message ?? 'Stock check failed');
    }
    const id = this.id();
    this.db.run(
      `INSERT INTO stock_movements (id, business_id, item_id, location_id, direction, quantity, unit, unit_cost, currency, lot_id, expiry_date, source_type, source_id, actor_id, device_id, event_id, idempotency_key, reversal_of, reason, occurred_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        caller.business.id,
        input.itemId,
        locationId,
        input.direction,
        input.quantity.toString(),
        input.unit,
        input.unitCost.amount.toString(),
        input.unitCost.currency,
        input.lotId ?? null,
        input.expiryDate ?? null,
        input.sourceType,
        input.sourceId,
        caller.user.id,
        null,
        this.id(),
        `mv:${id}`,
        null,
        input.reason ?? null,
        input.occurredAt ?? this.now(),
        this.now(),
      ],
    );
    return id;
  }

  listStock(caller: Caller): unknown[] {
    this.assertPermission(caller, 'inventory.view');
    const showCost = this.permissions(caller).has('purchase.cost.view');
    const products = this.db.all<ProductRow>(`SELECT * FROM products WHERE business_id = ? AND is_active = 1 AND kind != 'SERVICE' ORDER BY name`, [caller.business.id]);
    return products.map((product) => {
      const balance = this.stockBalance(caller.business.id, product.id);
      const value = this.stockValue(caller.business.id, product.id, caller.business.currency);
      return {
        itemId: product.id,
        name: product.name,
        unit: product.unit,
        onHand: balance.quantity.toString(),
        reorderLevel: product.reorder_level,
        belowReorder: product.reorder_level ? balance.quantity.lte(dec(product.reorder_level)) : false,
        ...(showCost ? { unitCost: value.unitCost.amount.toString(), value: value.value.amount.toString() } : {}),
      };
    });
  }

  stockValue(businessId: string, itemId: string, currency: string): { quantity: Decimal; value: Money; unitCost: Money } {
    const rows = this.movements(businessId, itemId);
    if (rows.length === 0) return { quantity: Decimal.ZERO, value: zeroMoney(currency), unitCost: zeroMoney(currency) };
    const valuation = weightedAverageValuation(this.toDomainMovements(rows), { itemId, currency });
    return { quantity: valuation.quantity, value: valuation.value, unitCost: valuation.unitCost };
  }

  listMovements(caller: Caller, itemId?: string): unknown[] {
    this.assertPermission(caller, 'inventory.view');
    const rows = itemId ? this.movements(caller.business.id, itemId) : this.movements(caller.business.id);
    return rows
      .slice(-500)
      .reverse()
      .map((row) => ({
        id: row.id,
        itemId: row.item_id,
        locationId: row.location_id,
        direction: row.direction,
        quantity: row.quantity,
        unit: row.unit,
        sourceType: row.source_type,
        sourceId: row.source_id,
        reason: row.reason,
        occurredAt: row.occurred_at,
      }));
  }

  receivableFor(businessId: string, customerId: string): Money {
    const entries = this.journalEntries(businessId);
    const sales = this.db.all<{ net: string; cash_received: string; currency: string }>('SELECT net, cash_received, currency FROM sales WHERE business_id = ? AND customer_id = ?', [businessId, customerId]);
    const receipts = this.db.all<{ amount: string; currency: string }>(`SELECT amount, currency FROM payments WHERE business_id = ? AND party_id = ? AND kind = 'CUSTOMER_RECEIPT'`, [businessId, customerId]);
    const currency = sales[0]?.currency ?? receipts[0]?.currency ?? 'BDT';
    void entries;
    const billed = sales.reduce<Money>((acc, row) => addMoney(acc, money(row.currency, dec(row.net).sub(dec(row.cash_received)))), zeroMoney(currency));
    const paid = receipts.reduce<Money>((acc, row) => addMoney(acc, money(row.currency, row.amount)), zeroMoney(currency));
    return subMoney(billed, paid);
  }

  payableFor(businessId: string, supplierId: string): Money {
    const bills = this.db.all<{ payable: string; currency: string }>('SELECT payable, currency FROM purchases WHERE business_id = ? AND supplier_id = ?', [businessId, supplierId]);
    const payments = this.db.all<{ amount: string; currency: string }>(`SELECT amount, currency FROM payments WHERE business_id = ? AND party_id = ? AND kind = 'SUPPLIER_PAYMENT'`, [businessId, supplierId]);
    const currency = bills[0]?.currency ?? payments[0]?.currency ?? 'BDT';
    const owed = bills.reduce<Money>((acc, row) => addMoney(acc, money(row.currency, row.payable)), zeroMoney(currency));
    const paid = payments.reduce<Money>((acc, row) => addMoney(acc, money(row.currency, row.amount)), zeroMoney(currency));
    return subMoney(owed, paid);
  }

  // -------------------------------------------------------------------------
  // Commerce: purchases, sales, payments
  // -------------------------------------------------------------------------

  createPurchase(caller: Caller, input: Record<string, unknown>): Record<string, unknown> {
    this.assertPermission(caller, 'purchase.manage');
    const body = asRecord(input, 'purchase');
    const lines = Array.isArray(body.lines) ? body.lines : [];
    if (lines.length === 0) throw HttpError.badRequest('VALIDATION', 'At least one purchase line is required');
    const documentDate = requireString(body.documentDate, 'documentDate', { maxLength: 10 });
    const currency = String(body.currency ?? caller.business.currency).toUpperCase();
    const supplierId = optionalString(body.supplierId, 'supplierId', 64);
    if (supplierId) this.assertBusinessValue(this.db.get('SELECT id FROM suppliers WHERE id = ? AND business_id = ?', [supplierId, caller.business.id]), 'Supplier');
    const locationId = optionalString(body.locationId, 'locationId', 64) ?? this.defaultLocationId(caller.business.id);
    const reference = optionalString(body.reference, 'reference', 40) ?? nextReference(this.db, caller.business.id, 'purchase', 'PUR', documentDate);
    const eventId = randomUUID();
    const now = this.now();

    return this.db.transaction(() => {
      let inventoryValue = zeroMoney(currency);
      let taxTotal = zeroMoney(currency);
      const prepared: { productId: string | null; quantity: Decimal; unit: string; unitCost: Money; lineTotal: Money; lotNo: string | null; expiryDate: string | null }[] = [];

      for (const raw of lines) {
        const line = asRecord(raw, 'purchase line');
        const quantity = dec(String(line.quantity ?? '0'));
        if (!quantity.isPositive()) throw HttpError.badRequest('VALIDATION', 'Purchase quantity must be greater than zero');
        const unit = requireString(line.unit, 'unit', { maxLength: 24 });
        const unitCost = money(currency, String(line.unitCost ?? '0'));
        const lineTotal = mulMoney(unitCost, quantity);
        const tax = money(currency, String(line.tax ?? '0'));
        inventoryValue = addMoney(inventoryValue, lineTotal);
        taxTotal = addMoney(taxTotal, tax);
        prepared.push({
          productId: optionalString(line.productId, 'productId', 64),
          quantity,
          unit,
          unitCost,
          lineTotal,
          lotNo: optionalString(line.lotNo, 'lotNo', 60),
          expiryDate: optionalString(line.expiryDate, 'expiryDate', 10),
        });
      }

      const paid = money(currency, String(body.paid ?? '0'));
      const total = addMoney(inventoryValue, taxTotal);
      const payable = subMoney(total, paid);
      const purchaseId = this.id();

      this.db.run(
        `INSERT INTO purchases (id, business_id, reference, supplier_id, document_date, currency, subtotal, discount, tax, total, paid, payable, status, note, revision, created_by, device_id, event_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, '0', ?, ?, ?, ?, 'POSTED', ?, 1, ?, ?, ?, ?, ?)`,
        [
          purchaseId,
          caller.business.id,
          reference,
          supplierId,
          documentDate,
          currency,
          inventoryValue.amount.toString(),
          taxTotal.amount.toString(),
          total.amount.toString(),
          paid.amount.toString(),
          payable.amount.toString(),
          optionalString(body.note, 'note', 500),
          caller.user.id,
          optionalString(body.deviceId, 'deviceId', 64),
          eventId,
          now,
          now,
        ],
      );

      for (const line of prepared) {
        if (!line.productId) throw HttpError.badRequest('VALIDATION', 'Each purchase line needs a productId in this build');
        const product = this.assertBusinessValue(this.db.get<ProductRow>('SELECT * FROM products WHERE id = ? AND business_id = ?', [line.productId, caller.business.id]), 'Product');
        this.db.run(
          `INSERT INTO purchase_lines (id, business_id, purchase_id, product_id, description, quantity, unit, unit_cost, discount, tax, line_total, location_id, lot_no, expiry_date)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, '0', '0', ?, ?, ?, ?)`,
          [this.id(), caller.business.id, purchaseId, line.productId, product.name, line.quantity.toString(), line.unit, line.unitCost.amount.toString(), line.lineTotal.amount.toString(), locationId, line.lotNo, line.expiryDate],
        );
        let lotId: string | null = null;
        if (product.track_lots === 1 && line.lotNo) {
          lotId = this.id();
          this.db.run('INSERT INTO stock_lots (id, business_id, item_id, location_id, lot_no, unit_cost, currency, received_at, expiry_date, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [
            lotId,
            caller.business.id,
            line.productId,
            locationId,
            line.lotNo,
            line.unitCost.amount.toString(),
            currency,
            documentDate,
            line.expiryDate,
            now,
          ]);
        }
        this.recordMovement(caller, {
          itemId: line.productId,
          locationId,
          direction: 'IN',
          quantity: line.quantity,
          unit: line.unit,
          unitCost: line.unitCost,
          sourceType: 'PURCHASE',
          sourceId: reference,
          lotId,
          expiryDate: line.expiryDate,
          occurredAt: documentDate,
        });
      }

      const entry = buildPurchasePosting({
        businessId: caller.business.id,
        date: documentDate,
        reference,
        currency,
        inventoryValue,
        inputTax: taxTotal,
        paid,
        cashAccount: optionalString(body.accountCode, 'accountCode', 8) ?? '1000',
        postedBy: caller.user.id,
        eventId: `${eventId}:journal`,
        description: `Purchase ${reference}`,
      });
      this.postJournal(caller, entry);

      this.audit({ businessId: caller.business.id, actorId: caller.user.id, action: 'purchase.post', entityType: 'purchase', entityId: purchaseId, detail: { reference, total: total.amount.toString() } });
      return { id: purchaseId, reference, total: total.amount.toString(), payable: payable.amount.toString(), paid: paid.amount.toString(), currency };
    });
  }

  createSale(caller: Caller, input: Record<string, unknown>): Record<string, unknown> {
    this.assertPermission(caller, 'sale.create');
    const body = asRecord(input, 'sale');
    const lines = Array.isArray(body.lines) ? body.lines : [];
    if (lines.length === 0) throw HttpError.badRequest('VALIDATION', 'At least one sale line is required');
    const documentDate = requireString(body.documentDate, 'documentDate', { maxLength: 10 });
    const currency = String(body.currency ?? caller.business.currency).toUpperCase();
    const customerId = optionalString(body.customerId, 'customerId', 64);
    if (customerId) this.assertBusinessValue(this.db.get('SELECT id FROM customers WHERE id = ? AND business_id = ?', [customerId, caller.business.id]), 'Customer');
    const locationId = optionalString(body.locationId, 'locationId', 64) ?? this.defaultLocationId(caller.business.id);
    const reference = optionalString(body.reference, 'reference', 40) ?? nextReference(this.db, caller.business.id, 'sale', 'SAL', documentDate);
    const headerDiscount = money(currency, String(body.discount ?? '0'));
    if (headerDiscount.amount.isPositive()) this.assertPermission(caller, 'sale.discount.apply');
    const eventId = randomUUID();
    const now = this.now();

    return this.db.transaction(() => {
      let revenue = zeroMoney(currency);
      let lineDiscountTotal = zeroMoney(currency);
      let taxTotal = zeroMoney(currency);
      let cogs = zeroMoney(currency);
      const prepared: { product: ProductRow | null; quantity: Decimal; unit: string; unitPrice: Money; lineTotal: Money; unitCost: Money; description: string }[] = [];

      for (const raw of lines) {
        const line = asRecord(raw, 'sale line');
        const quantity = dec(String(line.quantity ?? '0'));
        if (!quantity.isPositive()) throw HttpError.badRequest('VALIDATION', 'Sale quantity must be greater than zero');
        const unit = requireString(line.unit, 'unit', { maxLength: 24 });
        const unitPrice = money(currency, String(line.unitPrice ?? '0'));
        const lineDiscount = money(currency, String(line.discount ?? '0'));
        const lineTax = money(currency, String(line.tax ?? '0'));
        const productId = optionalString(line.productId, 'productId', 64);
        const product = productId ? this.assertBusinessValue(this.db.get<ProductRow>('SELECT * FROM products WHERE id = ? AND business_id = ?', [productId, caller.business.id]), 'Product') : null;
        const unitCost = product ? this.itemUnitCost(caller.business.id, product.id, currency) : zeroMoney(currency);

        revenue = addMoney(revenue, mulMoney(unitPrice, quantity));
        lineDiscountTotal = addMoney(lineDiscountTotal, lineDiscount);
        taxTotal = addMoney(taxTotal, lineTax);
        if (product && product.kind !== 'SERVICE') cogs = addMoney(cogs, mulMoney(unitCost, quantity));
        prepared.push({ product, quantity, unit, unitPrice, lineTotal: subMoney(mulMoney(unitPrice, quantity), lineDiscount), unitCost, description: String(line.description ?? product?.name ?? 'Item') });
      }

      const discountTotal = addMoney(headerDiscount, lineDiscountTotal);
      const net = subMoney(addMoney(revenue, taxTotal), discountTotal);
      const cashReceived = money(currency, String(body.cashReceived ?? net.amount.toString()));
      const receivable = subMoney(net, cashReceived);
      const saleId = this.id();

      this.db.run(
        `INSERT INTO sales (id, business_id, reference, customer_id, document_date, currency, gross, discount, tax, net, cash_received, receivable, cogs, status, note, revision, created_by, device_id, event_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'POSTED', ?, 1, ?, ?, ?, ?, ?)`,
        [
          saleId,
          caller.business.id,
          reference,
          customerId,
          documentDate,
          currency,
          revenue.amount.toString(),
          discountTotal.amount.toString(),
          taxTotal.amount.toString(),
          net.amount.toString(),
          cashReceived.amount.toString(),
          receivable.amount.toString(),
          cogs.amount.toString(),
          optionalString(body.note, 'note', 500),
          caller.user.id,
          optionalString(body.deviceId, 'deviceId', 64),
          eventId,
          now,
          now,
        ],
      );

      for (const line of prepared) {
        this.db.run(
          `INSERT INTO sale_lines (id, business_id, sale_id, product_id, description, quantity, unit, unit_price, discount, tax, line_total, unit_cost, location_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            this.id(),
            caller.business.id,
            saleId,
            line.product?.id ?? null,
            line.description,
            line.quantity.toString(),
            line.unit,
            line.unitPrice.amount.toString(),
            '0',
            '0',
            line.lineTotal.amount.toString(),
            line.unitCost.amount.toString(),
            locationId,
          ],
        );
        if (line.product && line.product.kind !== 'SERVICE') {
          // Negative stock is refused by DEFAULT for every role. An override
          // needs an explicit request, the approval permission and a reason.
          const allowNegative = body.allowNegative === true;
          if (allowNegative) {
            this.assertPermission(caller, 'inventory.adjust.approve');
            if (!optionalString(body.negativeReason, 'negativeReason', 400)) {
              throw HttpError.badRequest('VALIDATION', 'negativeReason is required when overriding negative stock');
            }
          }
          this.recordMovement(caller, {
            itemId: line.product.id,
            locationId,
            direction: 'OUT',
            quantity: line.quantity,
            unit: line.unit,
            unitCost: line.unitCost,
            sourceType: 'SALE',
            sourceId: reference,
            occurredAt: documentDate,
            allowNegative,
            reason: allowNegative ? `Negative-stock override: ${String(body.negativeReason)}` : null,
          });
        }
      }

      const entry = buildSalePosting({
        businessId: caller.business.id,
        date: documentDate,
        reference,
        currency,
        revenue,
        discount: discountTotal,
        tax: taxTotal,
        cashReceived,
        cogs,
        cashAccount: optionalString(body.accountCode, 'accountCode', 8) ?? '1000',
        postedBy: caller.user.id,
        eventId: `${eventId}:journal`,
        description: `Sale ${reference}`,
      });
      this.postJournal(caller, entry);

      this.audit({ businessId: caller.business.id, actorId: caller.user.id, action: 'sale.post', entityType: 'sale', entityId: saleId, detail: { reference, net: net.amount.toString(), cogs: cogs.amount.toString() } });
      return { id: saleId, reference, gross: revenue.amount.toString(), discount: discountTotal.amount.toString(), net: net.amount.toString(), cashReceived: cashReceived.amount.toString(), receivable: receivable.amount.toString(), cogs: cogs.amount.toString(), currency };
    });
  }

  // -------------------------------------------------------------------------
  // Corrections: posted documents are never edited or deleted, they are voided
  // with an audited reversal (reversal journal entry + reversing stock moves).
  // -------------------------------------------------------------------------

  voidDocument(caller: Caller, kind: 'sale' | 'purchase', documentId: string, input: Record<string, unknown>): Record<string, unknown> {
    this.assertPermission(caller, kind === 'sale' ? 'sale.void' : 'purchase.return');
    const body = asRecord(input ?? {}, 'void');
    const reason = requireString(body.reason, 'reason', { minLength: 5, maxLength: 400 });
    const date = requireString(body.date, 'date', { maxLength: 10 });
    const restock = body.restock !== false;

    const table = kind === 'sale' ? 'sales' : 'purchases';
    const document = this.assertBusinessValue(
      this.db.get<{ id: string; reference: string; status: string; currency: string; event_id: string; total?: string; net?: string }>(
        kind === 'sale'
          ? 'SELECT id, reference, status, currency, event_id, net AS total FROM sales WHERE id = ? AND business_id = ?'
          : 'SELECT id, reference, status, currency, event_id, total FROM purchases WHERE id = ? AND business_id = ?',
        [documentId, caller.business.id],
      ),
      kind === 'sale' ? 'Sale' : 'Purchase',
    );
    if (document.status === 'VOID' || document.status === 'RETURNED') {
      throw HttpError.conflict('ALREADY_VOID', `${document.reference} has already been reversed`);
    }

    const eventId = randomUUID();
    return this.db.transaction(() => {
      // 1. Reverse the accounting impact exactly (never mutate posted history).
      const original = this.journalEntries(caller.business.id).find((entry) => entry.sourceType === (kind === 'sale' ? 'SALE' : 'PURCHASE') && entry.sourceId === document.reference);
      if (!original) throw HttpError.conflict('NO_JOURNAL', `No posted journal entry found for ${document.reference}`);
      const reversal = buildReversal(original, {
        id: `${eventId}:journal`,
        date,
        reference: `${document.reference}-REV`,
        postedBy: caller.user.id,
        reason,
      });
      this.postJournal(caller, reversal);

      // 2. Reverse the stock impact (goods come back, or leave again).
      let reversedMovements = 0;
      if (restock) {
        const rows = this.db.all<MovementRow>('SELECT * FROM stock_movements WHERE business_id = ? AND source_type = ? AND source_id = ?', [
          caller.business.id,
          kind === 'sale' ? 'SALE' : 'PURCHASE',
          document.reference,
        ]);
        for (const row of rows) {
          const [domain] = this.toDomainMovements([row]);
          if (!domain) continue;
          const reversalMove = reversalMovements(domain, {
            id: this.id(),
            eventId: randomUUID(),
            idempotencyKey: `reversal:${row.id}`,
            actorId: caller.user.id,
            deviceId: 'server',
            occurredAt: date,
            reason: `${kind === 'sale' ? 'Sale' : 'Purchase'} reversal: ${reason}`,
          });
          this.db.run(
            `INSERT INTO stock_movements (id, business_id, item_id, location_id, direction, quantity, unit, unit_cost, currency, lot_id, expiry_date, source_type, source_id, actor_id, device_id, event_id, idempotency_key, reversal_of, reason, occurred_at, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'REVERSAL', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              reversalMove.id,
              caller.business.id,
              reversalMove.itemId,
              reversalMove.locationId,
              reversalMove.direction,
              reversalMove.quantity.toString(),
              reversalMove.unit,
              reversalMove.unitCost.amount.toString(),
              reversalMove.unitCost.currency,
              reversalMove.lotId ?? null,
              reversalMove.expiryDate ?? null,
              document.reference,
              caller.user.id,
              'server',
              reversalMove.eventId,
              reversalMove.idempotencyKey,
              row.id,
              reversalMove.reason ?? null,
              date,
              this.now(),
            ],
          );
          reversedMovements += 1;
        }
      }

      this.db.run(`UPDATE ${table} SET status = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND business_id = ?`, [
        kind === 'sale' ? 'VOID' : 'RETURNED',
        this.now(),
        documentId,
        caller.business.id,
      ]);
      this.audit({
        businessId: caller.business.id,
        actorId: caller.user.id,
        action: `${kind}.void`,
        entityType: kind,
        entityId: documentId,
        detail: { reference: document.reference, reason, restock, reversedMovements },
      });
      return {
        id: documentId,
        reference: document.reference,
        status: kind === 'sale' ? 'VOID' : 'RETURNED',
        reversalReference: `${document.reference}-REV`,
        reversedStockMovements: reversedMovements,
        amountReversed: document.total,
        note: 'Posted history was not edited: an audited reversal entry and reversing stock movements were added.',
      };
    });
  }

  // -------------------------------------------------------------------------
  // Master data updates
  // -------------------------------------------------------------------------

  updateParty(caller: Caller, kind: 'customer' | 'supplier', id: string, patch: Record<string, unknown>): Record<string, unknown> {
    this.assertPermission(caller, kind === 'customer' ? 'customer.manage' : 'supplier.manage');
    const table = kind === 'customer' ? 'customers' : 'suppliers';
    const existing = this.assertBusinessValue(this.db.get<Record<string, unknown>>(`SELECT * FROM ${table} WHERE id = ? AND business_id = ?`, [id, caller.business.id]), kind === 'customer' ? 'Customer' : 'Supplier');
    const columns: Record<string, string> = { name: 'name', phone: 'phone', email: 'email', address: 'address', creditLimit: 'credit_limit', openingBalance: 'opening_balance' };
    const fields: string[] = [];
    const params: unknown[] = [];
    for (const [key, column] of Object.entries(columns)) {
      if (patch[key] === undefined) continue;
      if (key === 'name') {
        fields.push(`${column} = ?`);
        params.push(requireString(patch[key], 'name', { maxLength: 160 }));
        continue;
      }
      if (key === 'openingBalance' || key === 'creditLimit') {
        fields.push(`${column} = ?`);
        params.push(patch[key] === null ? null : dec(String(patch[key])).toString());
        continue;
      }
      fields.push(`${column} = ?`);
      params.push(optionalString(patch[key], key, 400));
    }
    if (patch.isActive !== undefined) {
      fields.push('is_active = ?');
      params.push(patch.isActive ? 1 : 0);
    }
    if (fields.length === 0) return existing;
    fields.push('revision = revision + 1', 'updated_at = ?');
    params.push(this.now(), id, caller.business.id);
    this.db.run(`UPDATE ${table} SET ${fields.join(', ')} WHERE id = ? AND business_id = ?`, params);
    this.audit({ businessId: caller.business.id, actorId: caller.user.id, action: `${kind}.update`, entityType: kind, entityId: id, detail: patch });
    return this.db.get<Record<string, unknown>>(`SELECT * FROM ${table} WHERE id = ?`, [id]) as Record<string, unknown>;
  }

  // -------------------------------------------------------------------------
  // Backup restore (into a freshly created workspace only)
  // -------------------------------------------------------------------------

  /** Tables that can be restored, in foreign-key-safe insertion order. */
  private static readonly RESTORE_ORDER: readonly string[] = [
    'locations', 'product_categories', 'products', 'customers', 'suppliers', 'explicit_conversions',
    'stock_lots', 'stock_movements', 'purchases', 'purchase_lines', 'sales', 'sale_lines',
    'payments', 'account_transfers', 'income_expenses', 'partner_capital',
    'journal_entries', 'journal_lines',
    'farms', 'farm_units', 'production_cycles', 'farming_events', 'cost_sources', 'cost_allocations',
    'harvests', 'observations', 'mortality_losses', 'financial_accounts', 'business_settings',
  ];

  /**
   * Columns that hold a reference but are NOT declared as a foreign key.
   * They still have to be remapped on restore or a restored record would point
   * at a row that no longer exists.
   */
  private static readonly RESTORE_REFERENCE_OVERRIDES: Readonly<Record<string, Readonly<Record<string, string>>>> = Object.freeze({
    harvests: { product_id: 'products', location_id: 'locations' },
    farming_events: { product_id: 'products' },
    stock_movements: { reversal_of: 'stock_movements' },
    journal_entries: { reversal_of: 'journal_entries' },
    production_cycles: { responsible_member_id: 'members' },
    // A payment's party is either a customer or a supplier.
    payments: { party_id: 'customers+suppliers' },
  });

  /**
   * Restore a backup produced by `GET /api/reports/backup`.
   *
   * Safety rules, all enforced before anything is written:
   *  - owner only;
   *  - the target workspace must be EMPTY (no documents), so a restore can never
   *    merge into or overwrite live books;
   *  - the payload must declare the expected format;
   *  - every restored journal entry must still balance, or the whole restore is
   *    refused (a backup that cannot be trusted is not applied);
   *  - the whole import runs in ONE transaction, so a failure leaves nothing behind.
   *
   * Because ids are global primary keys, every restored row is RE-KEYED with a new
   * id and all foreign keys (declared and known textual references) are remapped,
   * so a restore works even into the same database the backup came from.
   *
   * Identity rows (users, members, sessions, invites) are deliberately NOT
   * restored: people are re-invited, and an audit log is never rewritten.
   */
  restoreBackup(caller: Caller, payload: unknown): Record<string, unknown> {
    this.assertPermission(caller, 'backup.manage');
    if (caller.role !== 'owner') throw HttpError.forbidden('Only the owner can restore a backup into this workspace');

    const body = asRecord(payload, 'backup');
    if (body.format !== 'sbm-backup-v1') {
      throw HttpError.badRequest('VALIDATION', `Unsupported backup format ${JSON.stringify(body.format)}; expected "sbm-backup-v1"`);
    }
    const tables = asRecord(body.tables, 'tables');

    // 1. The workspace must be empty.
    const nonEmpty: string[] = [];
    for (const table of ['products', 'sales', 'purchases', 'journal_entries', 'stock_movements', 'production_cycles']) {
      const count = this.db.get<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table} WHERE business_id = ?`, [caller.business.id])?.count ?? 0;
      if (count > 0) nonEmpty.push(`${table} (${count})`);
    }
    if (nonEmpty.length > 0) {
      throw HttpError.conflict('WORKSPACE_NOT_EMPTY', `Restore is only allowed into an empty workspace. Found: ${nonEmpty.join(', ')}. Create a new business and restore there.`);
    }

    // 2. Validate the journal before writing anything.
    const journalEntries = Array.isArray(tables.journal_entries) ? (tables.journal_entries as Record<string, unknown>[]) : [];
    const journalLines = Array.isArray(tables.journal_lines) ? (tables.journal_lines as Record<string, unknown>[]) : [];
    const byEntry = new Map<string, { debit: Decimal; credit: Decimal }>();
    for (const line of journalLines) {
      const entryId = String(line.entry_id ?? '');
      const current = byEntry.get(entryId) ?? { debit: Decimal.ZERO, credit: Decimal.ZERO };
      byEntry.set(entryId, {
        debit: current.debit.add(dec(String(line.debit ?? '0'))),
        credit: current.credit.add(dec(String(line.credit ?? '0'))),
      });
    }
    const unbalanced = journalEntries.filter((entry) => {
      const totals = byEntry.get(String(entry.id ?? ''));
      if (!totals) return true;
      return !totals.debit.eq(totals.credit);
    });
    if (unbalanced.length > 0) {
      throw HttpError.badRequest(
        'UNBALANCED_BACKUP',
        `Refusing to restore: ${unbalanced.length} journal entry(ies) in this backup do not balance (e.g. ${String(unbalanced[0]?.reference ?? unbalanced[0]?.id)}).`,
      );
    }

    // 3. Re-key every id and map every reference onto the new ids.
    const idMap = new Map<string, string>(); // `${table}:${oldId}` -> newId
    const newIdFor = (table: string, oldId: unknown): string | null => {
      if (oldId === null || oldId === undefined || oldId === '') return null;
      const key = `${table}:${String(oldId)}`;
      const existing = idMap.get(key);
      if (existing) return existing;
      const created = this.id();
      idMap.set(key, created);
      return created;
    };
    for (const table of Repository.RESTORE_ORDER) {
      const rows = tables[table];
      if (!Array.isArray(rows)) continue;
      for (const raw of rows as Record<string, unknown>[]) {
        if (raw.id !== undefined && raw.id !== null) newIdFor(table, raw.id);
      }
    }
    // Members are not restored, so anything pointing at a member is attributed to
    // the owner who is performing the restore.
    const memberMap = new Map<string, string>();
    for (const member of (Array.isArray(tables.members) ? (tables.members as Record<string, unknown>[]) : [])) {
      if (member.id !== undefined) memberMap.set(String(member.id), caller.member.id);
    }

    const remap = (refTable: string, value: unknown): unknown => {
      if (value === null || value === undefined || value === '') return value ?? null;
      if (refTable === 'members') return memberMap.get(String(value)) ?? caller.member.id;
      if (refTable === 'customers+suppliers') {
        return idMap.get(`customers:${String(value)}`) ?? idMap.get(`suppliers:${String(value)}`) ?? null;
      }
      return idMap.get(`${refTable}:${String(value)}`) ?? null;
    };

    // 4. Import inside a single transaction.
    const inserted: Record<string, number> = {};
    return this.db.transaction(() => {
      for (const table of Repository.RESTORE_ORDER) {
        const rows = tables[table];
        if (!Array.isArray(rows) || rows.length === 0) {
          inserted[table] = 0;
          continue;
        }
        const columns = this.db.all<{ name: string }>(`PRAGMA table_info(${table})`).map((row) => row.name);
        const declaredFks = new Map(
          this.db.all<{ from: string; table: string }>(`PRAGMA foreign_key_list(${table})`).map((fk) => [fk.from, fk.table]),
        );
        const overrides = Repository.RESTORE_REFERENCE_OVERRIDES[table] ?? {};
        let count = 0;
        for (const raw of rows as Record<string, unknown>[]) {
          const keys = Object.keys(raw).filter((key) => columns.includes(key) && key !== 'business_id');
          const newRowId = newIdFor(table, raw.id) as string;
          const values: (string | number | bigint | null | Buffer)[] = [];
          for (const key of keys) {
            if (key === 'id') {
              values.push(newRowId);
              continue;
            }
            // Globally-unique bookkeeping columns (event ids, idempotency keys) are
            // re-derived from the new row id, so a restore can never collide with
            // the rows it was exported from.
            if (key === 'event_id' || key === 'idempotency_key') {
              values.push(`${newRowId}:${key}`);
              continue;
            }
            const refTable = overrides[key] ?? declaredFks.get(key);
            values.push(refTable ? (remap(refTable, raw[key]) as string | null) : normaliseCell(raw[key]));
          }
          const placeholders = ['?', ...keys.map(() => '?')].join(', ');
          this.db.run(`INSERT INTO ${table} (business_id, ${keys.join(', ')}) VALUES (${placeholders})`, [caller.business.id, ...values]);
          count += 1;
        }
        inserted[table] = count;
      }
      this.audit({
        businessId: caller.business.id,
        actorId: caller.user.id,
        action: 'backup.restore',
        entityType: 'business',
        entityId: caller.business.id,
        detail: { source: body.exportedAt ?? null, tables: Object.keys(inserted).length, rows: Object.values(inserted).reduce((a, b) => a + b, 0) },
      });
      return {
        restored: inserted,
        totalRows: Object.values(inserted).reduce((a, b) => a + b, 0),
        note: 'Documents were re-keyed with new ids and every reference was remapped. Members, users and the audit log were NOT restored: re-invite your partners and check Reports after the import.',
      };
    });
  }

  /**
   * Alert feed for the dashboard.
   *
   * Every alert is DERIVED from stored data at read time (nothing is a stored
   * flag that can go stale), and each one says why it fired so a partner can
   * verify it instead of trusting it.
   */
  alerts(caller: Caller, options: { expiryDays?: number; harvestDays?: number; receivableDays?: number; staleDays?: number } = {}) {
    this.assertPermission(caller, 'report.view');
    const businessId = caller.business.id;
    const currency = caller.business.currency;
    const expiryDays = options.expiryDays ?? 30;
    const harvestDays = options.harvestDays ?? 14;
    const receivableDays = options.receivableDays ?? 30;
    const staleDays = options.staleDays ?? 7;
    const today = localDateString(new Date(), caller.business.timezone);
    const addDaysIso = (iso: string, days: number) => addDays(iso, days);

    type Alert = {
      kind: string;
      severity: 'info' | 'warning' | 'critical';
      title: string;
      titleBn: string;
      detail: string;
      entityType?: string;
      entityId?: string;
      amount?: string;
      href?: string;
    };
    const alerts: Alert[] = [];

    // 1. Low stock (at or below the reorder level).
    for (const row of this.listStock(caller) as { itemId: string; name: string; onHand: string; unit: string; reorderLevel: string | null; belowReorder: boolean }[]) {
      if (!row.belowReorder) continue;
      alerts.push({
        kind: 'LOW_STOCK',
        severity: Number(row.onHand) <= 0 ? 'critical' : 'warning',
        title: `Low stock: ${row.name}`,
        titleBn: `মজুদ কম: ${row.name}`,
        detail: `${row.onHand} ${row.unit} on hand against a reorder level of ${row.reorderLevel ?? '0'} ${row.unit}.`,
        entityType: 'product',
        entityId: row.itemId,
        href: '/inventory',
      });
    }

    // 2. Lots expiring soon, and lots already expired but still in stock.
    const lotStock = new Map<string, number>();
    for (const movement of this.db.all<{ lot_id: string | null; direction: string; quantity: string }>(
      'SELECT lot_id, direction, quantity FROM stock_movements WHERE business_id = ? AND lot_id IS NOT NULL',
      [businessId],
    )) {
      if (!movement.lot_id) continue;
      const current = lotStock.get(movement.lot_id) ?? 0;
      lotStock.set(movement.lot_id, movement.direction === 'IN' ? current + Number(movement.quantity) : current - Number(movement.quantity));
    }
    const lots = this.db.all<{ id: string; item_id: string; expiry_date: string; unit: string; lot_no: string | null; name: string }>(
      `SELECT l.id, l.item_id, l.expiry_date, l.unit_cost AS unit, l.lot_no, p.name, p.unit AS item_unit
       FROM stock_lots l JOIN products p ON p.id = l.item_id
       WHERE l.business_id = ? AND l.expiry_date IS NOT NULL AND l.expiry_date <= ?
       ORDER BY l.expiry_date`,
      [businessId, addDaysIso(today, expiryDays)],
    );
    for (const lot of lots) {
      const remaining = lotStock.get(lot.id) ?? 0;
      if (remaining <= 0) continue;
      const expired = lot.expiry_date < today;
      alerts.push({
        kind: expired ? 'LOT_EXPIRED' : 'LOT_EXPIRING',
        severity: expired ? 'critical' : 'warning',
        title: `${expired ? 'Expired' : 'Expiring'} lot: ${lot.name}${lot.lot_no ? ` (${lot.lot_no})` : ''}`,
        titleBn: expired ? `মেয়াদোত্তীর্ণ: ${lot.name}` : `মেয়াদ শেষ হচ্ছে: ${lot.name}`,
        detail: `${remaining} in stock with expiry ${lot.expiry_date}${expired ? ' (already past)' : ` (within ${expiryDays} days)`}.`,
        entityType: 'stock_lot',
        entityId: lot.id,
        href: '/inventory',
      });
    }

    // 3. High mortality in an active cycle.
    const mortality = this.db.all<{ cycle_id: string; reference: string; starting_population: string | null; lost: string }>(
      `SELECT c.id AS cycle_id, c.reference, c.starting_population,
              COALESCE((SELECT SUM(CAST(m.quantity AS REAL)) FROM mortality_losses m WHERE m.cycle_id = c.id), 0) AS lost
       FROM production_cycles c
       WHERE c.business_id = ? AND c.status IN ('ACTIVE','HARVESTING') AND c.starting_population IS NOT NULL`,
      [businessId],
    );
    for (const row of mortality) {
      const starting = Number(row.starting_population ?? 0);
      if (starting <= 0) continue;
      const percent = (Number(row.lost) / starting) * 100;
      if (percent <= 10) continue;
      alerts.push({
        kind: 'HIGH_MORTALITY',
        severity: percent > 25 ? 'critical' : 'warning',
        title: `High mortality in ${row.reference}`,
        titleBn: `${row.reference}-এ বেশি মৃত্যু`,
        detail: `${Number(row.lost).toFixed(0)} of ${starting} lost (${percent.toFixed(1)}%). If the loss is sudden or unexplained, contact a licensed veterinarian or the local livestock office.`,
        entityType: 'production_cycle',
        entityId: row.cycle_id,
        href: '/farming',
      });
    }

    // 4. Expected harvest window reached (or passed).
    const dueCycles = this.db.all<{ id: string; reference: string; title: string; expected_end_date: string; harvested: string }>(
      `SELECT c.id, c.reference, c.title, c.expected_end_date,
              COALESCE((SELECT SUM(CAST(h.quantity AS REAL)) FROM harvests h WHERE h.cycle_id = c.id), 0) AS harvested
       FROM production_cycles c
       WHERE c.business_id = ? AND c.status IN ('ACTIVE','HARVESTING') AND c.expected_end_date IS NOT NULL AND c.expected_end_date <= ?`,
      [businessId, addDaysIso(today, harvestDays)],
    );
    for (const cycle of dueCycles) {
      const late = cycle.expected_end_date < today;
      alerts.push({
        kind: 'EXPECTED_HARVEST',
        severity: late && Number(cycle.harvested) === 0 ? 'warning' : 'info',
        title: `${late ? 'Harvest overdue' : 'Harvest due'}: ${cycle.title}`,
        titleBn: `${cycle.title}: ফসল কাটার সময়`,
        detail: `Expected end ${cycle.expected_end_date}; recorded harvest so far ${Number(cycle.harvested).toFixed(2)}.`,
        entityType: 'production_cycle',
        entityId: cycle.id,
        href: '/farming',
      });
    }

    // 5. Active cycles with no activity for a while (a possibly missed operation).
    const stale = this.db.all<{ id: string; reference: string; title: string; last_activity: string | null }>(
      `SELECT c.id, c.reference, c.title,
              (SELECT MAX(e.occurred_on) FROM farming_events e WHERE e.cycle_id = c.id) AS last_activity
       FROM production_cycles c
       WHERE c.business_id = ? AND c.status IN ('ACTIVE','HARVESTING')`,
      [businessId],
    );
    for (const cycle of stale) {
      const reference = cycle.last_activity ?? null;
      if (reference && reference >= addDaysIso(today, -staleDays)) continue;
      alerts.push({
        kind: 'MISSED_OPERATION',
        severity: 'info',
        title: `No recent activity: ${cycle.title}`,
        titleBn: `${cycle.title}: সাম্প্রতিক কোনো কার্যক্রম নেই`,
        detail: reference
          ? `Last recorded activity was ${reference}, more than ${staleDays} days ago. Check whether a scheduled operation was missed.`
          : `This active cycle has no recorded activity yet. Record the inputs and operations as they happen.`,
        entityType: 'production_cycle',
        entityId: cycle.id,
        href: '/farming',
      });
    }

    // 6. Overdue receivables.
    for (const customer of this.db.all<{ id: string; name: string; oldest: string | null }>(
      `SELECT c.id, c.name, MIN(s.document_date) AS oldest
       FROM customers c JOIN sales s ON s.customer_id = c.id
       WHERE c.business_id = ? AND s.status = 'POSTED'
       GROUP BY c.id`,
      [businessId],
    )) {
      const outstanding = this.receivableFor(businessId, customer.id);
      if (outstanding.amount.isZero() || outstanding.amount.isNegative()) continue;
      const oldest = customer.oldest ?? today;
      const overdue = oldest < addDaysIso(today, -receivableDays);
      alerts.push({
        kind: 'OVERDUE_RECEIVABLE',
        severity: overdue ? 'warning' : 'info',
        title: `Unpaid receivable: ${customer.name}`,
        titleBn: `${customer.name}: বাকি পাওনা`,
        detail: `${formatMoney(outstanding)} outstanding; oldest unpaid sale ${oldest}${overdue ? `, older than ${receivableDays} days.` : '.'}`,
        entityType: 'customer',
        entityId: customer.id,
        amount: outstanding.amount.toString(),
        href: '/reports',
      });
    }

    // 7. Unpaid supplier bills.
    for (const supplier of this.db.all<{ id: string; name: string }>('SELECT id, name FROM suppliers WHERE business_id = ? AND is_active = 1', [businessId])) {
      const payable = this.payableFor(businessId, supplier.id);
      if (payable.amount.lte(0)) continue;
      alerts.push({
        kind: 'UNPAID_PAYABLE',
        severity: 'info',
        title: `Supplier balance: ${supplier.name}`,
        titleBn: `${supplier.name}: প্রদেয়`,
        detail: `${formatMoney(payable)} payable. Record the payment when it is made - it is not a new expense.`,
        entityType: 'supplier',
        entityId: supplier.id,
        amount: payable.amount.toString(),
        href: '/reports',
      });
    }

    const order: Record<Alert['severity'], number> = { critical: 0, warning: 1, info: 2 };
    alerts.sort((a, b) => order[a.severity] - order[b.severity] || a.kind.localeCompare(b.kind));
    return {
      generatedAt: new Date().toISOString(),
      businessDate: today,
      currency,
      thresholds: { expiryDays, harvestDays, receivableDays, staleDays },
      counts: {
        critical: alerts.filter((a) => a.severity === 'critical').length,
        warning: alerts.filter((a) => a.severity === 'warning').length,
        info: alerts.filter((a) => a.severity === 'info').length,
        total: alerts.length,
      },
      alerts,
    };
  }

  /**
   * Integrity / reconciliation report.
   *
   * Every check is derived from the stored data, so this is a real self-audit
   * rather than a stored flag: it is what you run before trusting a report or
   * after a restore. Nothing is "fixed" here - the report only tells the truth.
   */
  integrityReport(caller: Caller) {
    this.assertPermission(caller, 'report.view');
    const businessId = caller.business.id;
    const currency = caller.business.currency;
    type Check = { id: string; ok: boolean; detail: string };
    const checks: Check[] = [];

    // 1. Every journal entry must balance.
    const entryTotals = this.db.all<{ entry_id: string; debit: string; credit: string; reference: string }>(
      `SELECT e.id AS entry_id, e.reference,
              COALESCE(SUM(CAST(l.debit AS REAL)), 0) AS debit,
              COALESCE(SUM(CAST(l.credit AS REAL)), 0) AS credit
       FROM journal_entries e LEFT JOIN journal_lines l ON l.entry_id = e.id
       WHERE e.business_id = ? GROUP BY e.id`,
      [businessId],
    );
    const unbalanced = entryTotals.filter((row) => Math.abs(Number(row.debit) - Number(row.credit)) > 0.0001);
    checks.push({
      id: 'journal_entries_balanced',
      ok: unbalanced.length === 0,
      detail: unbalanced.length === 0 ? `${entryTotals.length} posted entries all balance` : `${unbalanced.length} unbalanced entry(ies), e.g. ${unbalanced[0]?.reference}`,
    });

    // 2. The trial balance must balance.
    const balance = trialBalance(this.journalEntries(businessId), currency);
    checks.push({ id: 'trial_balance_balanced', ok: balance.balanced, detail: `debit ${balance.totalDebit.amount.toString()} vs credit ${balance.totalCredit.amount.toString()}` });

    // 3. No negative stock anywhere (stock is only ever derived from the ledger).
    const itemLocations = this.db.all<{ item_id: string; location_id: string }>(
      'SELECT DISTINCT item_id, location_id FROM stock_movements WHERE business_id = ?',
      [businessId],
    );
    const negative: string[] = [];
    for (const pair of itemLocations) {
      const balance2 = this.stockBalance(businessId, pair.item_id, pair.location_id);
      if (balance2.quantity.isNegative()) negative.push(`${pair.item_id}@${pair.location_id} = ${balance2.quantity.toString()}`);
    }
    checks.push({ id: 'no_negative_stock', ok: negative.length === 0, detail: negative.length === 0 ? `${itemLocations.length} item/location pairs are non-negative` : negative.slice(0, 3).join(', ') });

    // 4. Every movement must point at a live product, location and unit.
    const orphanMovements = this.db.get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM stock_movements m
       LEFT JOIN products p ON p.id = m.item_id
       LEFT JOIN locations l ON l.id = m.location_id
       WHERE m.business_id = ? AND (p.id IS NULL OR l.id IS NULL)`,
      [businessId],
    )?.count ?? 0;
    checks.push({ id: 'stock_movements_reference_live_records', ok: orphanMovements === 0, detail: orphanMovements === 0 ? 'every movement resolves to a product and a location' : `${orphanMovements} orphan movement(s)` });

    // 5. Sale headers must agree with their lines and their posted COGS.
    const saleMismatches = this.db.all<{ reference: string; net: string; computed_net: string; cogs: string; computed_cogs: string }>(
      `SELECT s.reference,
              CAST(s.net AS REAL) AS net,
              (CAST(s.gross AS REAL) + CAST(s.tax AS REAL) - CAST(s.discount AS REAL)) AS computed_net,
              CAST(s.cogs AS REAL) AS cogs,
              COALESCE((SELECT SUM(CAST(l.unit_cost AS REAL) * CAST(l.quantity AS REAL)) FROM sale_lines l WHERE l.sale_id = s.id), 0) AS computed_cogs
       FROM sales s WHERE s.business_id = ? AND s.status = 'POSTED'`,
      [businessId],
    ).filter((row) => Math.abs(Number(row.net) - Number(row.computed_net)) > 0.0001 || Math.abs(Number(row.cogs) - Number(row.computed_cogs)) > 0.0001);
    checks.push({
      id: 'sale_totals_reconcile',
      ok: saleMismatches.length === 0,
      detail: saleMismatches.length === 0 ? 'every sale header equals its lines and its COGS lines' : `${saleMismatches.length} sale(s) disagree, e.g. ${saleMismatches[0]?.reference}`,
    });

    // 6. Purchase headers must agree with their lines.
    const purchaseMismatches = this.db.all<{ reference: string; total: string; computed: string }>(
      `SELECT p.reference, CAST(p.total AS REAL) AS total,
              (COALESCE((SELECT SUM(CAST(l.line_total AS REAL)) FROM purchase_lines l WHERE l.purchase_id = p.id), 0) + CAST(p.tax AS REAL)) AS computed
       FROM purchases p WHERE p.business_id = ? AND p.status = 'POSTED'`,
      [businessId],
    ).filter((row) => Math.abs(Number(row.total) - Number(row.computed)) > 0.0001);
    checks.push({ id: 'purchase_totals_reconcile', ok: purchaseMismatches.length === 0, detail: purchaseMismatches.length === 0 ? 'every purchase header equals its lines plus tax' : `${purchaseMismatches.length} purchase(s) disagree` });

    // 7. A cycle must never release more cost than it has accumulated.
    const overHarvested: string[] = [];
    for (const cycle of this.db.all<{ id: string; reference: string }>('SELECT id, reference FROM production_cycles WHERE business_id = ?', [businessId])) {
      const costToDate = this.cycleCostToDate(businessId, cycle.id, currency);
      const harvested = this.harvestedQuantity(businessId, cycle.id);
      if (harvested.assignedCost.amount.gt(costToDate.amount)) {
        overHarvested.push(`${cycle.reference}: released ${harvested.assignedCost.amount.toString()} of ${costToDate.amount.toString()}`);
      }
    }
    checks.push({ id: 'harvest_cost_within_batch_cost', ok: overHarvested.length === 0, detail: overHarvested.length === 0 ? 'every harvest released at most the accumulated batch cost' : overHarvested.join('; ') });

    // 8. Shared costs must be fully allocated exactly once.
    const sharedProblems: string[] = [];
    for (const source of this.db.all<{ id: string; currency: string; amount: string; allocated_at: string | null }>(
      'SELECT id, currency, amount, allocated_at FROM cost_sources WHERE business_id = ? AND shared = 1',
      [businessId],
    )) {
      const allocated = this.db.get<{ sum: string }>('SELECT COALESCE(SUM(CAST(amount AS REAL)), 0) AS sum FROM cost_allocations WHERE cost_source_id = ?', [source.id])?.sum ?? '0';
      if (Math.abs(Number(allocated) - Number(source.amount)) > 0.0001) {
        sharedProblems.push(`${source.id}: allocated ${allocated} of ${source.amount}`);
      }
      if (!source.allocated_at) sharedProblems.push(`${source.id}: never marked as allocated`);
    }
    checks.push({ id: 'shared_costs_fully_allocated', ok: sharedProblems.length === 0, detail: sharedProblems.length === 0 ? 'every shared cost was allocated exactly once' : sharedProblems.slice(0, 3).join('; ') });

    // 9. Idempotency keys must be unique (no double-posted movement).
    const duplicateKeys = this.db.get<{ count: number }>(
      'SELECT COUNT(*) AS count FROM (SELECT idempotency_key FROM stock_movements WHERE business_id = ? GROUP BY idempotency_key HAVING COUNT(*) > 1)',
      [businessId],
    )?.count ?? 0;
    checks.push({ id: 'no_duplicate_stock_events', ok: duplicateKeys === 0, detail: duplicateKeys === 0 ? 'no duplicate stock event keys' : `${duplicateKeys} duplicated key(s)` });

    const issues = checks.filter((check) => !check.ok);
    return {
      businessId,
      checkedAt: new Date().toISOString(),
      ok: issues.length === 0,
      summary: issues.length === 0 ? 'All reconciliation checks passed.' : `${issues.length} reconciliation check(s) need attention.`,
      checks,
    };
  }

  // -------------------------------------------------------------------------
  // Stock transfers between locations and opening balances
  // -------------------------------------------------------------------------

  /**
   * Move stock between two locations. Both legs are written in ONE transaction at
   * the same cost, so the total quantity and value are unchanged - a transfer is
   * a movement, never a gain or a loss.
   */
  transferStock(caller: Caller, input: Record<string, unknown>): Record<string, unknown> {
    this.assertPermission(caller, 'inventory.manage');
    const body = asRecord(input, 'transfer');
    const itemId = requireString(body.itemId, 'itemId', { maxLength: 64 });
    const fromLocationId = requireString(body.fromLocationId, 'fromLocationId', { maxLength: 64 });
    const toLocationId = requireString(body.toLocationId, 'toLocationId', { maxLength: 64 });
    if (fromLocationId === toLocationId) throw HttpError.badRequest('VALIDATION', 'Source and destination locations must differ');
    const product = this.assertBusinessValue(this.db.get<ProductRow>('SELECT * FROM products WHERE id = ? AND business_id = ?', [itemId, caller.business.id]), 'Product');
    this.assertBusinessValue(this.db.get('SELECT id FROM locations WHERE id = ? AND business_id = ?', [fromLocationId, caller.business.id]), 'Source location');
    this.assertBusinessValue(this.db.get('SELECT id FROM locations WHERE id = ? AND business_id = ?', [toLocationId, caller.business.id]), 'Destination location');
    const quantity = dec(String(body.quantity ?? '0'));
    if (!quantity.isPositive()) throw HttpError.badRequest('VALIDATION', 'Transfer quantity must be greater than zero');
    const unit = optionalString(body.unit, 'unit', 24) ?? product.unit;
    const currency = String(body.currency ?? caller.business.currency).toUpperCase();
    const occurredAt = optionalString(body.occurredAt, 'occurredAt', 10) ?? new Date().toISOString().slice(0, 10);
    const reference = optionalString(body.reference, 'reference', 40) ?? nextReference(this.db, caller.business.id, 'stock_transfer', 'TRN', occurredAt);
    const reason = optionalString(body.reason, 'reason', 400);

    return this.db.transaction(() => {
      const unitCost = this.itemUnitCost(caller.business.id, itemId, currency);
      // Out of the source location first: this is where negative stock is caught.
      this.recordMovement(caller, {
        itemId,
        locationId: fromLocationId,
        direction: 'OUT',
        quantity,
        unit,
        unitCost,
        sourceType: 'TRANSFER_OUT',
        sourceId: reference,
        reason,
        occurredAt,
      });
      this.recordMovement(caller, {
        itemId,
        locationId: toLocationId,
        direction: 'IN',
        quantity,
        unit,
        unitCost,
        sourceType: 'TRANSFER_IN',
        sourceId: reference,
        reason,
        occurredAt,
      });
      this.audit({
        businessId: caller.business.id,
        actorId: caller.user.id,
        action: 'inventory.transfer',
        entityType: 'stock_transfer',
        entityId: reference,
        detail: { itemId, fromLocationId, toLocationId, quantity: quantity.toString(), unitCost: unitCost.amount.toString() },
      });
      return {
        reference,
        itemId,
        quantity: quantity.toString(),
        unit,
        unitCost: unitCost.amount.toString(),
        currency,
        from: this.stockBalance(caller.business.id, itemId, fromLocationId).quantity.toString(),
        to: this.stockBalance(caller.business.id, itemId, toLocationId).quantity.toString(),
        note: 'A transfer does not change total quantity or inventory value, and is not an expense.',
      };
    });
  }

  /** Bring an opening CASH / BANK / MFS balance onto the books (audited). */
  recordOpeningBalance(caller: Caller, input: Record<string, unknown>): Record<string, unknown> {
    this.assertPermission(caller, 'finance.opening_balance');
    const body = asRecord(input, 'opening balance');
    const currency = String(body.currency ?? caller.business.currency).toUpperCase();
    const amount = money(currency, String(body.amount ?? '0'));
    if (amount.amount.isZero()) throw HttpError.badRequest('VALIDATION', 'Opening balance must not be zero');
    const accountCode = requireEnum(body.accountCode ?? '1000', 'accountCode', ['1000', '1010', '1020'] as const);
    const date = requireString(body.date, 'date', { maxLength: 10 });
    const reference = optionalString(body.reference, 'reference', 40) ?? nextReference(this.db, caller.business.id, 'opening', 'OB', date);
    const eventId = randomUUID();
    return this.db.transaction(() => {
      this.postJournal(
        caller,
        buildOpeningBalancePosting({
          businessId: caller.business.id,
          date,
          reference,
          currency,
          assetAccount: accountCode,
          amount,
          postedBy: caller.user.id,
          description: optionalString(body.note, 'note', 200) ?? 'Opening balance',
          eventId: `${eventId}:journal`,
        }),
      );
      this.audit({ businessId: caller.business.id, actorId: caller.user.id, action: 'opening_balance.set', entityType: 'business', entityId: caller.business.id, detail: { accountCode, amount: amount.amount.toString() } });
      return { reference, accountCode, amount: amount.amount.toString(), currency, note: 'Recorded as equity, not revenue.' };
    });
  }

  /** Bring opening STOCK onto the books: a ledger movement plus the matching entry. */
  recordOpeningStock(caller: Caller, input: Record<string, unknown>): Record<string, unknown> {
    this.assertPermission(caller, 'finance.opening_balance');
    const body = asRecord(input, 'opening stock');
    const itemId = requireString(body.itemId, 'itemId', { maxLength: 64 });
    const product = this.assertBusinessValue(this.db.get<ProductRow>('SELECT * FROM products WHERE id = ? AND business_id = ?', [itemId, caller.business.id]), 'Product');
    const quantity = dec(String(body.quantity ?? '0'));
    if (!quantity.isPositive()) throw HttpError.badRequest('VALIDATION', 'Opening quantity must be greater than zero');
    const unit = optionalString(body.unit, 'unit', 24) ?? product.unit;
    const currency = String(body.currency ?? caller.business.currency).toUpperCase();
    const unitCost = money(currency, String(body.unitCost ?? '0'));
    if (!unitCost.amount.isPositive()) throw HttpError.badRequest('VALIDATION', 'unitCost must be greater than zero');
    const date = requireString(body.date, 'date', { maxLength: 10 });
    const reference = optionalString(body.reference, 'reference', 40) ?? nextReference(this.db, caller.business.id, 'opening', 'OB', date);
    const eventId = randomUUID();
    const value = mulMoney(unitCost, quantity);

    return this.db.transaction(() => {
      this.recordMovement(caller, {
        itemId,
        locationId: optionalString(body.locationId, 'locationId', 64) ?? undefined,
        direction: 'IN',
        quantity,
        unit,
        unitCost,
        sourceType: 'OPENING',
        sourceId: reference,
        occurredAt: date,
      });
      this.postJournal(
        caller,
        buildOpeningBalancePosting({
          businessId: caller.business.id,
          date,
          reference,
          currency,
          assetAccount: '1200',
          amount: value,
          postedBy: caller.user.id,
          description: `Opening stock: ${product.name}`,
          eventId: `${eventId}:journal`,
        }),
      );
      this.audit({ businessId: caller.business.id, actorId: caller.user.id, action: 'opening_balance.set', entityType: 'product', entityId: itemId, detail: { quantity: quantity.toString(), unitCost: unitCost.amount.toString(), value: value.amount.toString() } });
      return { reference, itemId, quantity: quantity.toString(), unit, unitCost: unitCost.amount.toString(), value: value.amount.toString(), currency, note: 'Opening stock is equity, not profit.' };
    });
  }

  /** Stock valuation report: quantity, weighted-average unit cost and total value. */
  stockValuationReport(caller: Caller, locationId?: string) {
    this.assertPermission(caller, 'inventory.view');
    const currency = caller.business.currency;
    const showCost = this.permissions(caller).has('purchase.cost.view');
    const products = this.db.all<ProductRow>(`SELECT * FROM products WHERE business_id = ? AND is_active = 1 AND kind != 'SERVICE' ORDER BY name`, [caller.business.id]);
    type ValuationRow = { itemId: string; name: string; unit: string; quantity: string; unitCost?: string; value?: string };
    const rows: ValuationRow[] = products.map((product) => {
      const rowsFor = locationId ? this.movements(caller.business.id, product.id).filter((m) => m.location_id === locationId) : this.movements(caller.business.id, product.id);
      if (rowsFor.length === 0) return { itemId: product.id, name: product.name, unit: product.unit, quantity: '0' };
      const valuation = weightedAverageValuation(this.toDomainMovements(rowsFor), { itemId: product.id, currency });
      return {
        itemId: product.id,
        name: product.name,
        unit: valuation.unit,
        quantity: valuation.quantity.toString(),
        ...(showCost ? { unitCost: valuation.unitCost.amount.toString(), value: valuation.value.amount.toString() } : {}),
      };
    });
    const total = rows.reduce<Money>((acc, row) => (row.value ? addMoney(acc, money(currency, row.value)) : acc), zeroMoney(currency));
    return {
      currency,
      method: 'WEIGHTED_AVERAGE' as const,
      totalValue: showCost ? total.amount.toString() : null,
      costVisibility: showCost ? 'full' : ('restricted' as const),
      rows,
    };
  }

  recordCustomerReceipt(caller: Caller, input: Record<string, unknown>): Record<string, unknown> {
    this.assertPermission(caller, 'finance.manage');
    const body = asRecord(input, 'receipt');
    const currency = String(body.currency ?? caller.business.currency).toUpperCase();
    const amount = money(currency, String(body.amount ?? '0'));
    if (!amount.amount.isPositive()) throw HttpError.badRequest('VALIDATION', 'Receipt amount must be greater than zero');
    const documentDate = requireString(body.documentDate, 'documentDate', { maxLength: 10 });
    const reference = optionalString(body.reference, 'reference', 40) ?? nextReference(this.db, caller.business.id, 'receipt', 'RCP', documentDate);
    const customerId = optionalString(body.customerId, 'customerId', 64);
    const eventId = randomUUID();
    return this.db.transaction(() => {
      this.db.run(
        `INSERT INTO payments (id, business_id, kind, party_type, party_id, document_date, currency, amount, account_code, reference, note, created_by, device_id, event_id, created_at)
         VALUES (?, ?, 'CUSTOMER_RECEIPT', 'CUSTOMER', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [this.id(), caller.business.id, customerId, documentDate, currency, amount.amount.toString(), optionalString(body.accountCode, 'accountCode', 8) ?? '1000', reference, optionalString(body.note, 'note', 400), caller.user.id, null, eventId, this.now()],
      );
      const entry = buildCustomerReceiptPosting({
        businessId: caller.business.id,
        date: documentDate,
        reference,
        currency,
        amount,
        cashAccount: optionalString(body.accountCode, 'accountCode', 8) ?? '1000',
        postedBy: caller.user.id,
        eventId: `${eventId}:journal`,
      });
      this.postJournal(caller, entry);
      this.audit({ businessId: caller.business.id, actorId: caller.user.id, action: 'receipt.post', entityType: 'payment', entityId: reference, detail: { amount: amount.amount.toString() } });
      return { reference, amount: amount.amount.toString(), receivableRemaining: customerId ? this.receivableFor(caller.business.id, customerId).amount.toString() : null };
    });
  }

  recordSupplierPayment(caller: Caller, input: Record<string, unknown>): Record<string, unknown> {
    this.assertPermission(caller, 'finance.manage');
    const body = asRecord(input, 'payment');
    const currency = String(body.currency ?? caller.business.currency).toUpperCase();
    const amount = money(currency, String(body.amount ?? '0'));
    if (!amount.amount.isPositive()) throw HttpError.badRequest('VALIDATION', 'Payment amount must be greater than zero');
    const documentDate = requireString(body.documentDate, 'documentDate', { maxLength: 10 });
    const reference = optionalString(body.reference, 'reference', 40) ?? nextReference(this.db, caller.business.id, 'payment', 'PAY', documentDate);
    const supplierId = optionalString(body.supplierId, 'supplierId', 64);
    const eventId = randomUUID();
    return this.db.transaction(() => {
      this.db.run(
        `INSERT INTO payments (id, business_id, kind, party_type, party_id, document_date, currency, amount, account_code, reference, note, created_by, device_id, event_id, created_at)
         VALUES (?, ?, 'SUPPLIER_PAYMENT', 'SUPPLIER', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [this.id(), caller.business.id, supplierId, documentDate, currency, amount.amount.toString(), optionalString(body.accountCode, 'accountCode', 8) ?? '1000', reference, optionalString(body.note, 'note', 400), caller.user.id, null, eventId, this.now()],
      );
      const entry = buildSupplierPaymentPosting({
        businessId: caller.business.id,
        date: documentDate,
        reference,
        currency,
        amount,
        cashAccount: optionalString(body.accountCode, 'accountCode', 8) ?? '1000',
        postedBy: caller.user.id,
        eventId: `${eventId}:journal`,
      });
      this.postJournal(caller, entry);
      this.audit({ businessId: caller.business.id, actorId: caller.user.id, action: 'supplier_payment.post', entityType: 'payment', entityId: reference, detail: { amount: amount.amount.toString() } });
      return { reference, amount: amount.amount.toString(), payableRemaining: supplierId ? this.payableFor(caller.business.id, supplierId).amount.toString() : null };
    });
  }

  // -------------------------------------------------------------------------
  // Finance
  // -------------------------------------------------------------------------

  recordTransfer(caller: Caller, input: Record<string, unknown>): Record<string, unknown> {
    this.assertPermission(caller, 'finance.manage');
    const body = asRecord(input, 'transfer');
    const currency = String(body.currency ?? caller.business.currency).toUpperCase();
    const amount = money(currency, String(body.amount ?? '0'));
    if (!amount.amount.isPositive()) throw HttpError.badRequest('VALIDATION', 'Transfer amount must be greater than zero');
    const fromAccount = requireString(body.fromAccount, 'fromAccount', { maxLength: 8 });
    const toAccount = requireString(body.toAccount, 'toAccount', { maxLength: 8 });
    const documentDate = requireString(body.documentDate, 'documentDate', { maxLength: 10 });
    const reference = optionalString(body.reference, 'reference', 40) ?? nextReference(this.db, caller.business.id, 'transfer', 'TRF', documentDate);
    const eventId = randomUUID();
    return this.db.transaction(() => {
      this.db.run(
        `INSERT INTO account_transfers (id, business_id, document_date, currency, amount, from_account, to_account, reference, note, created_by, event_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [this.id(), caller.business.id, documentDate, currency, amount.amount.toString(), fromAccount, toAccount, reference, optionalString(body.note, 'note', 400), caller.user.id, eventId, this.now()],
      );
      const entry = buildTransferPosting({ businessId: caller.business.id, date: documentDate, reference, currency, amount, fromAccount, toAccount, postedBy: caller.user.id, eventId: `${eventId}:journal` });
      this.postJournal(caller, entry);
      this.audit({ businessId: caller.business.id, actorId: caller.user.id, action: 'transfer.post', entityType: 'transfer', entityId: reference, detail: { amount: amount.amount.toString(), fromAccount, toAccount } });
      return { reference, amount: amount.amount.toString() };
    });
  }

  recordIncomeExpense(caller: Caller, input: Record<string, unknown>): Record<string, unknown> {
    this.assertPermission(caller, 'finance.manage');
    const body = asRecord(input, 'income/expense');
    const kind = requireEnum(body.kind, 'kind', ['INCOME', 'EXPENSE'] as const);
    const categoryAccount = requireString(body.categoryAccount, 'categoryAccount', { maxLength: 8 });
    const account = ACCOUNT[categoryAccount];
    if (!account) throw HttpError.badRequest('VALIDATION', `Unknown account code ${categoryAccount}`);
    const expectedType = kind === 'INCOME' ? 'REVENUE' : 'EXPENSE';
    if (account.type !== expectedType) throw HttpError.badRequest('VALIDATION', `${categoryAccount} is a ${account.type} account, not ${expectedType}`);
    const currency = String(body.currency ?? caller.business.currency).toUpperCase();
    const amount = money(currency, String(body.amount ?? '0'));
    if (!amount.amount.isPositive()) throw HttpError.badRequest('VALIDATION', 'Amount must be greater than zero');
    const documentDate = requireString(body.documentDate, 'documentDate', { maxLength: 10 });
    const reference = optionalString(body.reference, 'reference', 40) ?? nextReference(this.db, caller.business.id, kind.toLowerCase(), kind === 'INCOME' ? 'INC' : 'EXP', documentDate);
    const paid = body.paid === undefined ? true : Boolean(body.paid);
    const eventId = randomUUID();
    return this.db.transaction(() => {
      this.db.run(
        `INSERT INTO income_expenses (id, business_id, kind, category_account, document_date, currency, amount, account_code, paid, reference, note, created_by, event_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [this.id(), caller.business.id, kind, categoryAccount, documentDate, currency, amount.amount.toString(), optionalString(body.accountCode, 'accountCode', 8) ?? '1000', paid ? 1 : 0, reference, optionalString(body.note, 'note', 400), caller.user.id, eventId, this.now()],
      );
      const entry = buildIncomeExpensePosting({
        businessId: caller.business.id,
        date: documentDate,
        reference,
        currency,
        amount,
        categoryAccount,
        cashAccount: optionalString(body.accountCode, 'accountCode', 8) ?? '1000',
        paid,
        postedBy: caller.user.id,
        eventId: `${eventId}:journal`,
        description: optionalString(body.note, 'note', 200) ?? `${kind} ${reference}`,
      });
      this.postJournal(caller, entry);
      this.audit({ businessId: caller.business.id, actorId: caller.user.id, action: `${kind.toLowerCase()}.post`, entityType: 'income_expense', entityId: reference, detail: { amount: amount.amount.toString(), categoryAccount } });
      return { reference, amount: amount.amount.toString() };
    });
  }

  recordPartnerCapital(caller: Caller, input: Record<string, unknown>): Record<string, unknown> {
    const body = asRecord(input, 'partner capital');
    const memberId = requireString(body.memberId, 'memberId', { maxLength: 64 });
    const isSelf = memberId === caller.member.id;
    // A partner may record their own contribution; managing others needs the permission.
    if (!isSelf) this.assertPermission(caller, 'partner_capital.manage');
    else this.assertPermission(caller, 'partner_capital.view');
    const member = this.assertBusinessValue(this.db.get<MemberRow>('SELECT * FROM members WHERE id = ? AND business_id = ?', [memberId, caller.business.id]), 'Member');
    const kind = requireEnum(body.kind, 'kind', ['CONTRIBUTION', 'WITHDRAWAL'] as const);
    const currency = String(body.currency ?? caller.business.currency).toUpperCase();
    const amount = money(currency, String(body.amount ?? '0'));
    if (!amount.amount.isPositive()) throw HttpError.badRequest('VALIDATION', 'Amount must be greater than zero');
    const documentDate = requireString(body.documentDate, 'documentDate', { maxLength: 10 });
    const reference = optionalString(body.reference, 'reference', 40) ?? nextReference(this.db, caller.business.id, 'capital', kind === 'CONTRIBUTION' ? 'PC' : 'PW', documentDate);
    const eventId = randomUUID();
    return this.db.transaction(() => {
      this.db.run(
        `INSERT INTO partner_capital (id, business_id, member_id, kind, document_date, currency, amount, account_code, reference, note, created_by, event_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [this.id(), caller.business.id, memberId, kind, documentDate, currency, amount.amount.toString(), optionalString(body.accountCode, 'accountCode', 8) ?? '1000', reference, optionalString(body.note, 'note', 400), caller.user.id, eventId, this.now()],
      );
      const entry = buildPartnerCapitalPosting({
        businessId: caller.business.id,
        date: documentDate,
        reference,
        currency,
        amount,
        partnerId: member.display_name,
        cashAccount: optionalString(body.accountCode, 'accountCode', 8) ?? '1000',
        kind,
        postedBy: caller.user.id,
        eventId: `${eventId}:journal`,
      });
      this.postJournal(caller, entry);
      this.audit({ businessId: caller.business.id, actorId: caller.user.id, action: `capital.${kind.toLowerCase()}`, entityType: 'partner_capital', entityId: reference, detail: { amount: amount.amount.toString(), memberId } });
      return { reference, amount: amount.amount.toString(), kind };
    });
  }

  // -------------------------------------------------------------------------
  // Reports
  // -------------------------------------------------------------------------

  dashboard(caller: Caller, range: { from: string; to: string }): Record<string, unknown> {
    this.assertPermission(caller, 'report.view');
    const currency = caller.business.currency;
    const entries = this.journalEntries(caller.business.id);
    const inRange = entries.filter((e) => e.date >= range.from && e.date <= range.to);
    const pnl = profitAndLoss(inRange, { from: range.from, to: range.to, currency });
    const flow = cashFlow(entries, { from: range.from, to: range.to, currency });
    const showCost = this.permissions(caller).has('financial_reports.view');
    const sales = sumMoney(
      this.db
        .all<{ net: string; currency: string }>(`SELECT net, currency FROM sales WHERE business_id = ? AND document_date >= ? AND document_date <= ? AND status = 'POSTED'`, [caller.business.id, range.from, range.to])
        .map((r) => money(r.currency, r.net)),
      currency,
    );
    const purchases = sumMoney(
      this.db
        .all<{ total: string; currency: string }>(`SELECT total, currency FROM purchases WHERE business_id = ? AND document_date >= ? AND document_date <= ? AND status = 'POSTED'`, [caller.business.id, range.from, range.to])
        .map((r) => money(r.currency, r.total)),
      currency,
    );
    const lowStock = this.listStock(caller).filter((row) => (row as { belowReorder: boolean }).belowReorder).length;
    const receivables = this.db
      .all<{ id: string }>('SELECT id FROM customers WHERE business_id = ? AND is_active = 1', [caller.business.id])
      .reduce<Money>((acc, row) => addMoney(acc, this.receivableFor(caller.business.id, row.id)), zeroMoney(currency));
    const payables = this.db
      .all<{ id: string }>('SELECT id FROM suppliers WHERE business_id = ? AND is_active = 1', [caller.business.id])
      .reduce<Money>((acc, row) => addMoney(acc, this.payableFor(caller.business.id, row.id)), zeroMoney(currency));

    return {
      range,
      currency,
      sales: sales.amount.toString(),
      purchases: purchases.amount.toString(),
      cashBalance: flow.closing.amount.toString(),
      cashReceived: flow.inflows.amount.toString(),
      cashPaid: flow.outflows.amount.toString(),
      receivables: receivables.amount.toString(),
      payables: payables.amount.toString(),
      lowStockItems: lowStock,
      ...(showCost
        ? {
            revenue: pnl.netRevenue.amount.toString(),
            costOfGoodsSold: pnl.costOfGoodsSold.amount.toString(),
            grossProfit: pnl.grossProfit.amount.toString(),
            operatingExpenses: pnl.operatingExpenses.amount.toString(),
            netProfit: pnl.netProfit.amount.toString(),
            cashBasisResult: cashBasisOperatingResult(entries, { from: range.from, to: range.to, currency }).amount.toString(),
          }
        : { costVisibility: 'restricted' }),
    };
  }

  profitAndLossReport(caller: Caller, range: { from: string; to: string }) {
    this.assertPermission(caller, 'financial_reports.view');
    const currency = caller.business.currency;
    const pnl = profitAndLoss(this.journalEntries(caller.business.id), { from: range.from, to: range.to, currency });
    return {
      from: range.from,
      to: range.to,
      currency,
      basis: 'ACCRUAL' as const,
      revenue: pnl.revenue.amount.toString(),
      contraRevenue: pnl.contraRevenue.amount.toString(),
      netRevenue: pnl.netRevenue.amount.toString(),
      costOfGoodsSold: pnl.costOfGoodsSold.amount.toString(),
      grossProfit: pnl.grossProfit.amount.toString(),
      operatingExpenses: pnl.operatingExpenses.amount.toString(),
      expensesByAccount: pnl.expensesByAccount.map((row) => ({ account: row.account, name: row.name, amount: row.amount.amount.toString() })),
      otherIncome: pnl.otherIncome.amount.toString(),
      netProfit: pnl.netProfit.amount.toString(),
      cashBasisResult: cashBasisOperatingResult(this.journalEntries(caller.business.id), { from: range.from, to: range.to, currency }).amount.toString(),
      note: 'Accrual basis: stock purchases are assets until sold. The cash-basis figure is reported separately.',
    };
  }

  balanceSheetReport(caller: Caller, asOf: string) {
    this.assertPermission(caller, 'financial_reports.view');
    const currency = caller.business.currency;
    const sheet = balanceSheet(this.journalEntries(caller.business.id), { asOf, currency });
    return {
      asOf,
      currency,
      assets: sheet.assets.map((row) => ({ account: row.account, name: row.name, amount: row.debit.amount.sub(row.credit.amount).toString() })),
      liabilities: sheet.liabilities.map((row) => ({ account: row.account, name: row.name, amount: row.credit.amount.sub(row.debit.amount).toString() })),
      equity: sheet.equity.map((row) => ({ account: row.account, name: row.name, amount: row.credit.amount.sub(row.debit.amount).toString() })),
      totalAssets: sheet.totalAssets.amount.toString(),
      totalLiabilities: sheet.totalLiabilities.amount.toString(),
      totalEquity: sheet.totalEquity.amount.toString(),
      totalEquityIncludingResult: sheet.totalEquityIncludingResult.amount.toString(),
      balanced: sheet.balanced,
    };
  }

  trialBalanceReport(caller: Caller, range: { from: string; to: string }) {
    this.assertPermission(caller, 'financial_reports.view');
    const currency = caller.business.currency;
    const balance = trialBalance(this.journalEntries(caller.business.id, range), currency);
    return {
      currency,
      balanced: balance.balanced,
      totalDebit: balance.totalDebit.amount.toString(),
      totalCredit: balance.totalCredit.amount.toString(),
      rows: balance.rows.map((row) => ({ account: row.account, name: row.name, type: row.type, debit: row.debit.amount.toString(), credit: row.credit.amount.toString() })),
    };
  }

  cashFlowReport(caller: Caller, range: { from: string; to: string }) {
    this.assertPermission(caller, 'finance.view');
    const currency = caller.business.currency;
    const flow = cashFlow(this.journalEntries(caller.business.id), { from: range.from, to: range.to, currency });
    return {
      from: range.from,
      to: range.to,
      currency,
      opening: flow.opening.amount.toString(),
      inflows: flow.inflows.amount.toString(),
      outflows: flow.outflows.amount.toString(),
      netChange: flow.netChange.amount.toString(),
      closing: flow.closing.amount.toString(),
    };
  }

  // -------------------------------------------------------------------------
  // Farming
  // -------------------------------------------------------------------------

  createFarm(caller: Caller, input: Record<string, unknown>): { id: string } {
    this.assertPermission(caller, 'farming.setup');
    const id = this.id();
    const now = this.now();
    this.db.run(
      `INSERT INTO farms (id, business_id, name, location_id, address, area, area_unit, latitude, longitude, notes, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      [
        id,
        caller.business.id,
        requireString(input.name, 'name', { maxLength: 120 }),
        optionalString(input.locationId, 'locationId', 64),
        optionalString(input.address, 'address', 400),
        input.area === undefined || input.area === null ? null : dec(String(input.area)).toString(),
        optionalString(input.areaUnit, 'areaUnit', 24),
        optionalString(input.latitude, 'latitude', 32),
        optionalString(input.longitude, 'longitude', 32),
        optionalString(input.notes, 'notes', 1000),
        now,
        now,
      ],
    );
    this.audit({ businessId: caller.business.id, actorId: caller.user.id, action: 'farm.create', entityType: 'farm', entityId: id });
    return { id };
  }

  listFarms(caller: Caller): unknown[] {
    this.assertPermission(caller, 'farming.view');
    return this.db
      .all<{ id: string; name: string; address: string | null; area: string | null; area_unit: string | null }>('SELECT id, name, address, area, area_unit FROM farms WHERE business_id = ? AND is_active = 1 ORDER BY name', [
        caller.business.id,
      ])
      .map((row) => ({
        id: row.id,
        name: row.name,
        address: row.address,
        area: row.area,
        areaUnit: row.area_unit,
        units: this.db.all('SELECT id, kind, name, area, area_unit, capacity, capacity_unit FROM farm_units WHERE farm_id = ? AND is_active = 1', [row.id]),
      }));
  }

  createFarmUnit(caller: Caller, input: Record<string, unknown>): { id: string } {
    this.assertPermission(caller, 'farming.setup');
    const farmId = requireString(input.farmId, 'farmId', { maxLength: 64 });
    this.assertBusinessValue(this.db.get('SELECT id FROM farms WHERE id = ? AND business_id = ?', [farmId, caller.business.id]), 'Farm');
    const kind = requireEnum<FarmUnitKind>(input.kind, 'kind', ['PLOT', 'FIELD', 'GREENHOUSE', 'BARN', 'PEN', 'POULTRY_HOUSE', 'POND', 'TANK', 'OTHER'] as const);
    const id = this.id();
    this.db.run(
      `INSERT INTO farm_units (id, business_id, farm_id, kind, name, area, area_unit, capacity, capacity_unit, is_active, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      [
        id,
        caller.business.id,
        farmId,
        kind,
        requireString(input.name, 'name', { maxLength: 120 }),
        input.area === undefined || input.area === null ? null : dec(String(input.area)).toString(),
        optionalString(input.areaUnit, 'areaUnit', 24),
        input.capacity === undefined || input.capacity === null ? null : dec(String(input.capacity)).toString(),
        optionalString(input.capacityUnit, 'capacityUnit', 24),
        this.now(),
      ],
    );
    this.audit({ businessId: caller.business.id, actorId: caller.user.id, action: 'farm_unit.create', entityType: 'farm_unit', entityId: id });
    return { id };
  }

  createCycle(caller: Caller, input: Record<string, unknown>): Record<string, unknown> {
    this.assertPermission(caller, 'farming.setup');
    const farmId = requireString(input.farmId, 'farmId', { maxLength: 64 });
    const unitId = requireString(input.unitId, 'unitId', { maxLength: 64 });
    this.assertBusinessValue(this.db.get('SELECT id FROM farms WHERE id = ? AND business_id = ?', [farmId, caller.business.id]), 'Farm');
    this.assertBusinessValue(this.db.get('SELECT id FROM farm_units WHERE id = ? AND business_id = ?', [unitId, caller.business.id]), 'Farm unit');
    const farmingType = requireEnum<FarmingType>(input.farmingType, 'farmingType', ['CROP', 'HORTICULTURE', 'LIVESTOCK', 'POULTRY', 'AQUACULTURE'] as const);
    const startDate = requireString(input.startDate, 'startDate', { maxLength: 10 });
    const reference = optionalString(input.reference, 'reference', 40) ?? nextReference(this.db, caller.business.id, 'cycle', 'CYC', startDate);
    const id = this.id();
    const now = this.now();
    this.db.run(
      `INSERT INTO production_cycles (id, business_id, farm_id, unit_id, reference, farming_type, title, crop_or_species, variety_or_breed, season, responsible_member_id, start_date, expected_end_date, planned_output, planned_output_unit, status, starting_population, notes, revision, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?, 1, ?, ?)`,
      [
        id,
        caller.business.id,
        farmId,
        unitId,
        reference,
        farmingType,
        requireString(input.title, 'title', { maxLength: 160 }),
        optionalString(input.cropOrSpecies, 'cropOrSpecies', 120),
        optionalString(input.varietyOrBreed, 'varietyOrBreed', 120),
        optionalString(input.season, 'season', 60),
        optionalString(input.responsibleMemberId, 'responsibleMemberId', 64),
        startDate,
        optionalString(input.expectedEndDate, 'expectedEndDate', 10),
        input.plannedOutput === undefined || input.plannedOutput === null ? null : dec(String(input.plannedOutput)).toString(),
        optionalString(input.plannedOutputUnit, 'plannedOutputUnit', 24),
        input.startingPopulation === undefined || input.startingPopulation === null ? null : dec(String(input.startingPopulation)).toString(),
        optionalString(input.notes, 'notes', 1000),
        now,
        now,
      ],
    );
    // Enable the farming type on the business the first time it is used.
    const business = this.getBusiness(caller.business.id);
    const types = new Set(parseJson<string[]>(business.farming_types, []));
    if (!types.has(farmingType)) {
      types.add(farmingType);
      this.db.run('UPDATE businesses SET farming_types = ? WHERE id = ?', [JSON.stringify([...types]), caller.business.id]);
    }
    this.audit({ businessId: caller.business.id, actorId: caller.user.id, action: 'cycle.create', entityType: 'production_cycle', entityId: id, detail: { reference, farmingType } });
    return { id, reference, status: 'ACTIVE' };
  }

  listCycles(caller: Caller, status?: string): unknown[] {
    this.assertPermission(caller, 'farming.view');
    const showCost = this.permissions(caller).has('farming.cost.view');
    const rows = this.db.all<{
      id: string; reference: string; farming_type: string; title: string; crop_or_species: string | null; variety_or_breed: string | null;
      status: string; start_date: string; expected_end_date: string | null; planned_output: string | null; planned_output_unit: string | null; starting_population: string | null;
      farm_id: string; unit_id: string;
    }>(
      status
        ? 'SELECT * FROM production_cycles WHERE business_id = ? AND status = ? ORDER BY start_date DESC'
        : 'SELECT * FROM production_cycles WHERE business_id = ? ORDER BY start_date DESC',
      status ? [caller.business.id, status] : [caller.business.id],
    );
    return rows.map((row) => {
      const cost = this.cycleCostToDate(caller.business.id, row.id);
      const harvested = this.harvestedQuantity(caller.business.id, row.id);
      const revenue = this.cycleRevenue(caller.business.id, row.id, caller.business.currency);
      const soldCogs = this.cycleSoldCogs(caller.business.id, row.id);
      return {
        id: row.id,
        reference: row.reference,
        farmingType: row.farming_type,
        title: row.title,
        cropOrSpecies: row.crop_or_species,
        varietyOrBreed: row.variety_or_breed,
        status: row.status,
        farmId: row.farm_id,
        unitId: row.unit_id,
        startDate: row.start_date,
        expectedEndDate: row.expected_end_date,
        plannedOutput: row.planned_output,
        plannedOutputUnit: row.planned_output_unit,
        startingPopulation: row.starting_population,
        harvestedQuantity: harvested.quantity.toString(),
        ...(showCost
          ? {
              costToDate: cost.amount.toString(),
              revenue: revenue.amount.toString(),
              cogs: soldCogs.amount.toString(),
              grossProfit: revenue.amount.sub(soldCogs.amount).toString(),
            }
          : { costVisibility: 'restricted' }),
      };
    });
  }

  cycleCostToDate(businessId: string, cycleId: string, currency = 'BDT'): Money {
    const rows = this.db.all<{ amount: string; currency: string }>('SELECT amount, currency FROM cost_sources WHERE business_id = ? AND cycle_id = ?', [businessId, cycleId]);
    const base = rows.reduce<Money>((acc, row) => addMoney(acc, money(row.currency, row.amount)), zeroMoney(rows[0]?.currency ?? currency));
    const allocated = this.db.all<{ amount: string; currency: string }>('SELECT amount, currency FROM cost_allocations WHERE business_id = ? AND cycle_id = ?', [businessId, cycleId]);
    return allocated.reduce<Money>((acc, row) => addMoney(acc, money(row.currency, row.amount)), base);
  }

  harvestedQuantity(businessId: string, cycleId: string): { quantity: Decimal; unit: string; assignedCost: Money } {
    const rows = this.db.all<{ quantity: string; unit: string; cost_basis: string; currency: string }>('SELECT quantity, unit, cost_basis, currency FROM harvests WHERE business_id = ? AND cycle_id = ? ORDER BY occurred_on, created_at', [
      businessId,
      cycleId,
    ]);
    let quantity = Decimal.ZERO;
    let unit = '';
    let assigned = zeroMoney(rows[0]?.currency ?? 'BDT');
    for (const row of rows) {
      quantity = quantity.add(dec(row.quantity));
      unit = unit || row.unit;
      assigned = addMoney(assigned, money(row.currency, row.cost_basis));
    }
    return { quantity, unit, assignedCost: assigned };
  }

  private cycleRevenue(businessId: string, cycleId: string, currency: string): Money {
    return this.cycleSales(businessId, cycleId, currency).revenue;
  }

  private cycleSoldCogs(businessId: string, cycleId: string): Money {
    return this.cycleSales(businessId, cycleId, 'BDT').cogs;
  }

  /**
   * Attribute sales to a cycle through real traceability: the products that were
   * actually harvested from that cycle. This is why finished output is stored as
   * a stock item linked to the harvest.
   */
  private cycleSales(businessId: string, cycleId: string, currency: string): { revenue: Money; cogs: Money } {
    const productIds = this.db
      .all<{ product_id: string }>('SELECT DISTINCT product_id FROM harvests WHERE business_id = ? AND cycle_id = ? AND product_id IS NOT NULL', [businessId, cycleId])
      .map((row) => row.product_id);
    if (productIds.length === 0) return { revenue: zeroMoney(currency), cogs: zeroMoney(currency) };
    const placeholders = productIds.map(() => '?').join(',');
    const rows = this.db.all<{ quantity: string; line_total: string; unit_cost: string; currency: string }>(
      `SELECT l.quantity, l.line_total, l.unit_cost, s.currency
       FROM sale_lines l JOIN sales s ON s.id = l.sale_id
       WHERE l.business_id = ? AND l.product_id IN (${placeholders})`,
      [businessId, ...productIds],
    );
    const revenue = rows.reduce<Money>((acc, row) => addMoney(acc, money(row.currency, row.line_total)), zeroMoney(currency));
    const cogs = rows.reduce<Money>((acc, row) => addMoney(acc, mulMoney(money(row.currency, row.unit_cost), dec(row.quantity))), zeroMoney(currency));
    return { revenue, cogs };
  }

  recordFarmingEvent(caller: Caller, input: Record<string, unknown>): Record<string, unknown> {
    const body = asRecord(input, 'farming event');
    const cycleId = requireString(body.cycleId, 'cycleId', { maxLength: 64 });
    const cycle = this.assertBusinessValue(this.db.get<{ id: string; reference: string; status: string }>('SELECT id, reference, status FROM production_cycles WHERE id = ? AND business_id = ?', [cycleId, caller.business.id]), 'Production cycle');
    if (cycle.status === 'CLOSED') throw HttpError.conflict('CYCLE_CLOSED', 'This cycle is closed; reopen it before recording new activity');
    const eventType = requireEnum(
      body.eventType,
      'eventType',
      ['INPUT_ISSUE', 'DIRECT_LABOUR', 'MACHINERY_FUEL', 'VETERINARY', 'UTILITIES', 'PACKAGING', 'TRANSPORT', 'OVERHEAD', 'OBSERVATION', 'MORTALITY', 'INTERNAL_USE', 'WASTE'] as const,
    );
    const occurredOn = requireString(body.occurredOn, 'occurredOn', { maxLength: 10 });
    const currency = String(body.currency ?? caller.business.currency).toUpperCase();
    const eventId = randomUUID();

    if (eventType === 'OBSERVATION') {
      this.assertPermission(caller, 'farming.observation');
      this.db.run(
        `INSERT INTO observations (id, business_id, cycle_id, observed_on, kind, value, unit, notes, recorded_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [this.id(), caller.business.id, cycleId, occurredOn, requireString(body.kind, 'kind', { maxLength: 60 }), optionalString(body.value, 'value', 60), optionalString(body.unit, 'unit', 24), optionalString(body.notes, 'notes', 1000), caller.user.id, this.now()],
      );
      this.db.run(
        `INSERT INTO farming_events (id, business_id, cycle_id, event_type, occurred_on, quantity, unit, amount, currency, account_code, product_id, notes, payload, actor_id, device_id, event_id, created_at)
         VALUES (?, ?, ?, 'OBSERVATION', ?, ?, ?, NULL, NULL, NULL, NULL, ?, '{}', ?, NULL, ?, ?)`,
        [this.id(), caller.business.id, cycleId, occurredOn, optionalString(body.value, 'value', 60), optionalString(body.unit, 'unit', 24), optionalString(body.notes, 'notes', 1000), caller.user.id, eventId, this.now()],
      );
      return { eventType, cycleReference: cycle.reference, recorded: true };
    }

    if (eventType === 'MORTALITY' || eventType === 'WASTE') {
      this.assertPermission(caller, 'farming.operations');
      const quantity = dec(String(body.quantity ?? '0'));
      if (!quantity.isPositive()) throw HttpError.badRequest('VALIDATION', 'Mortality quantity must be greater than zero');
      const unit = requireString(body.unit, 'unit', { maxLength: 24 });
      const reason = requireString(body.reason, 'reason', { minLength: 3, maxLength: 400 });
      const bookValue = body.bookValue === undefined || body.bookValue === null ? null : money(currency, String(body.bookValue));
      const abnormal = quantity.gte(dec('25')) ? 1 : 0;
      const lossCount = this.db.get<{ count: number }>('SELECT COUNT(*) AS count FROM mortality_losses WHERE business_id = ? AND cycle_id = ?', [caller.business.id, cycleId])?.count ?? 0;
      this.db.run(
        `INSERT INTO mortality_losses (id, business_id, cycle_id, occurred_on, quantity, unit, reason, book_value, currency, abnormal, recorded_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [this.id(), caller.business.id, cycleId, occurredOn, quantity.toString(), unit, reason, bookValue?.amount.toString() ?? null, bookValue ? currency : null, abnormal, caller.user.id, this.now()],
      );
      if (bookValue && bookValue.amount.isPositive()) {
        this.postJournal(
          caller,
          buildInventoryLossPosting({
            businessId: caller.business.id,
            date: occurredOn,
            reference: `${cycle.reference}-LOSS-${lossCount + 1}`,
            currency,
            amount: bookValue,
            reason: `${eventType === 'MORTALITY' ? 'Mortality' : 'Waste'} in ${cycle.reference}: ${reason}`,
            kind: 'MORTALITY',
            postedBy: caller.user.id,
            eventId: `${eventId}:journal`,
          }),
        );
      }
      this.audit({ businessId: caller.business.id, actorId: caller.user.id, action: 'farming.mortality', entityType: 'production_cycle', entityId: cycleId, detail: { quantity: quantity.toString(), reason, abnormal: abnormal === 1 } });
      return { eventType, quantity: quantity.toString(), abnormal: abnormal === 1, escalation: abnormal === 1 ? 'Contact a licensed veterinarian or the local agricultural extension officer.' : null };
    }

    // Cost-bearing events.
    this.assertPermission(caller, 'farming.operations');
    let cost = zeroMoney(currency);
    const kindMap: Record<string, string> = {
      INPUT_ISSUE: 'INPUT_ISSUE', DIRECT_LABOUR: 'DIRECT_LABOUR', MACHINERY_FUEL: 'MACHINERY_FUEL', VETERINARY: 'VETERINARY',
      UTILITIES: 'UTILITIES', PACKAGING: 'PACKAGING', TRANSPORT: 'TRANSPORT', OVERHEAD: 'OVERHEAD', INTERNAL_USE: 'OTHER_DIRECT',
    };

    return this.db.transaction(() => {
      if (eventType === 'INPUT_ISSUE') {
        this.assertPermission(caller, 'farming.input_issue');
        const productId = requireString(body.productId, 'productId', { maxLength: 64 });
        const product = this.assertBusinessValue(this.db.get<ProductRow>('SELECT * FROM products WHERE id = ? AND business_id = ?', [productId, caller.business.id]), 'Input product');
        const quantity = dec(String(body.quantity ?? '0'));
        if (!quantity.isPositive()) throw HttpError.badRequest('VALIDATION', 'Issued quantity must be greater than zero');
        const unit = optionalString(body.unit, 'unit', 24) ?? product.unit;
        const unitCost = this.itemUnitCost(caller.business.id, product.id, currency);
        cost = mulMoney(unitCost, quantity);
        this.recordMovement(caller, {
          itemId: product.id,
          direction: 'OUT',
          quantity,
          unit,
          unitCost,
          sourceType: 'INPUT_ISSUE',
          sourceId: cycle.reference,
          occurredAt: occurredOn,
        });
        this.postJournal(
          caller,
          buildInputIssuePosting({
            businessId: caller.business.id,
            date: occurredOn,
            reference: `${cycle.reference}-INPUT-${Date.now()}`,
            currency,
            cost,
            batchReference: cycle.reference,
            postedBy: caller.user.id,
            eventId: `${eventId}:journal`,
          }),
        );
      } else {
        cost = money(currency, String(body.amount ?? '0'));
        if (!cost.amount.isPositive()) throw HttpError.badRequest('VALIDATION', 'A positive amount is required');
        const accountCode = optionalString(body.accountCode, 'accountCode', 8) ?? defaultAccountForEvent(eventType);
        this.postJournal(
          caller,
          buildDirectBatchCostPosting({
            businessId: caller.business.id,
            date: occurredOn,
            reference: `${cycle.reference}-${eventType}-${Date.now()}`,
            currency,
            cost,
            expenseAccount: accountCode,
            cashAccount: optionalString(body.paymentAccount, 'paymentAccount', 8) ?? '1000',
            paid: body.paid === undefined ? true : Boolean(body.paid),
            batchReference: cycle.reference,
            postedBy: caller.user.id,
            eventId: `${eventId}:journal`,
          }),
        );
      }

      const costId = this.id();
      this.db.run(
        `INSERT INTO cost_sources (id, business_id, cycle_id, kind, currency, amount, shared, incurred_on, source_type, source_id, note, revision, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, 1, ?)`,
        [costId, caller.business.id, cycleId, kindMap[eventType] ?? 'OTHER_DIRECT', currency, cost.amount.toString(), occurredOn, eventType, cycle.reference, optionalString(body.notes, 'notes', 600), this.now()],
      );
      this.db.run(
        `INSERT INTO farming_events (id, business_id, cycle_id, event_type, occurred_on, quantity, unit, amount, currency, account_code, product_id, notes, payload, actor_id, device_id, event_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
        [
          this.id(),
          caller.business.id,
          cycleId,
          eventType,
          occurredOn,
          optionalString(body.quantity, 'quantity', 40),
          optionalString(body.unit, 'unit', 24),
          cost.amount.toString(),
          currency,
          optionalString(body.accountCode, 'accountCode', 8),
          optionalString(body.productId, 'productId', 64),
          optionalString(body.notes, 'notes', 1000),
          JSON.stringify({}),
          caller.user.id,
          eventId,
          this.now(),
        ],
      );
      this.audit({ businessId: caller.business.id, actorId: caller.user.id, action: `farming.${eventType.toLowerCase()}`, entityType: 'production_cycle', entityId: cycleId, detail: { cost: cost.amount.toString() } });
      return { eventType, cost: cost.amount.toString(), currency, costToDate: this.cycleCostToDate(caller.business.id, cycleId, currency).amount.toString() };
    });
  }

  recordHarvest(caller: Caller, input: Record<string, unknown>): Record<string, unknown> {
    this.assertPermission(caller, 'farming.harvest');
    const body = asRecord(input, 'harvest');
    const cycleId = requireString(body.cycleId, 'cycleId', { maxLength: 64 });
    const cycle = this.assertBusinessValue(
      this.db.get<{ id: string; reference: string; planned_output: string | null; planned_output_unit: string | null; status: string }>(
        'SELECT id, reference, planned_output, planned_output_unit, status FROM production_cycles WHERE id = ? AND business_id = ?',
        [cycleId, caller.business.id],
      ),
      'Production cycle',
    );
    const quantity = dec(String(body.quantity ?? '0'));
    if (!quantity.isPositive()) throw HttpError.badRequest('VALIDATION', 'Harvest quantity must be greater than zero');
    const unit = requireString(body.unit, 'unit', { maxLength: 24 });
    const occurredOn = requireString(body.occurredOn, 'occurredOn', { maxLength: 10 });
    const currency = String(body.currency ?? caller.business.currency).toUpperCase();
    const method = requireEnum(body.method ?? 'PLANNED_YIELD_PRORATA', 'method', ['PLANNED_YIELD_PRORATA', 'CLOSING_REMAINDER'] as const);
    const eventId = randomUUID();

    return this.db.transaction(() => {
      const costToDate = this.cycleCostToDate(caller.business.id, cycleId, currency);
      const harvested = this.harvestedQuantity(caller.business.id, cycleId);
      const assignment = assignHarvestCost(
        {
          cycleId,
          costToDate,
          harvestedQuantityToDate: harvested.quantity,
          assignedCostToDate: harvested.assignedCost,
          outputUnit: harvested.unit || unit,
        },
        quantity,
        method,
        cycle.planned_output ? { plannedOutput: dec(cycle.planned_output) } : {},
      );

      const harvestId = this.id();
      this.db.run(
        `INSERT INTO harvests (id, business_id, cycle_id, occurred_on, quantity, unit, product_id, location_id, lot_no, costing_method, cost_basis, unit_cost, currency, grade, notes, created_by, device_id, event_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          harvestId,
          caller.business.id,
          cycleId,
          occurredOn,
          quantity.toString(),
          unit,
          optionalString(body.productId, 'productId', 64),
          optionalString(body.locationId, 'locationId', 64),
          optionalString(body.lotNo, 'lotNo', 60),
          method,
          assignment.assignedCost.amount.toString(),
          assignment.costPerUnit.amount.toString(),
          currency,
          optionalString(body.grade, 'grade', 40),
          optionalString(body.notes, 'notes', 1000),
          caller.user.id,
          null,
          eventId,
          this.now(),
        ],
      );

      if (assignment.assignedCost.amount.isPositive()) {
        this.postJournal(
          caller,
          buildHarvestPosting({
            businessId: caller.business.id,
            date: occurredOn,
            reference: `${cycle.reference}-HARVEST-${harvestId.slice(0, 6)}`,
            currency,
            costBasis: assignment.assignedCost,
            postedBy: caller.user.id,
            eventId: `${eventId}:journal`,
          }),
        );
      }

      // Finished output becomes sellable stock at the assigned cost per unit.
      const productId = optionalString(body.productId, 'productId', 64);
      if (productId) {
        const product = this.assertBusinessValue(this.db.get<ProductRow>('SELECT * FROM products WHERE id = ? AND business_id = ?', [productId, caller.business.id]), 'Output product');
        this.recordMovement(caller, {
          itemId: product.id,
          locationId: optionalString(body.locationId, 'locationId', 64) ?? undefined,
          direction: 'IN',
          quantity,
          unit,
          unitCost: assignment.costPerUnit,
          sourceType: 'HARVEST',
          sourceId: cycle.reference,
          occurredAt: occurredOn,
        });
      }

      const remaining = subMoney(costToDate, assignment.nextState.assignedCostToDate);
      this.audit({ businessId: caller.business.id, actorId: caller.user.id, action: 'farming.harvest', entityType: 'production_cycle', entityId: cycleId, detail: { quantity: quantity.toString(), cost: assignment.assignedCost.amount.toString() } });
      return {
        harvestId,
        quantity: quantity.toString(),
        unitCost: assignment.costPerUnit.amount.toString(),
        costBasis: assignment.assignedCost.amount.toString(),
        capped: assignment.capped,
        costToDate: costToDate.amount.toString(),
        remainingCostInBatch: remaining.amount.toString(),
        currency,
        note: 'Unsold harvest stays in finished-goods inventory; profit is recognised only when sold.',
      };
    });
  }

  allocateSharedCost(caller: Caller, input: Record<string, unknown>): Record<string, unknown> {
    this.assertPermission(caller, 'farming.setup');
    const body = asRecord(input, 'cost allocation');
    const currency = String(body.currency ?? caller.business.currency).toUpperCase();
    const amount = money(currency, String(body.amount ?? '0'));
    const basis = requireEnum(body.basis, 'basis', ['ACTUAL_USAGE', 'AREA', 'TIME', 'OUTPUT_QTY', 'ANIMAL_COUNT', 'BIOMASS', 'MANUAL_PERCENT'] as const);
    const targets = asRecordArray(body.targets).map((target) => ({
      cycleId: requireString(target.cycleId, 'target.cycleId', { maxLength: 64 }),
      basisValue: dec(String(target.basisValue ?? '0')),
      ...(target.manualPercent !== undefined ? { manualPercent: dec(String(target.manualPercent)) } : {}),
    }));
    const result = allocateCost(amount, targets, basis, { costSourceId: randomUUID() });

    return this.db.transaction(() => {
      for (const target of targets) this.assertBusinessValue(this.db.get('SELECT id FROM production_cycles WHERE id = ? AND business_id = ?', [target.cycleId, caller.business.id]), 'Production cycle');
      const costSourceId = this.id();
      this.db.run(
        `INSERT INTO cost_sources (id, business_id, cycle_id, kind, currency, amount, shared, incurred_on, source_type, source_id, note, revision, created_at)
         VALUES (?, ?, NULL, 'OVERHEAD', ?, ?, 1, ?, 'ALLOCATION', ?, ?, 1, ?)`,
        [costSourceId, caller.business.id, currency, amount.amount.toString(), requireString(body.incurredOn, 'incurredOn', { maxLength: 10 }), costSourceId, optionalString(body.note, 'note', 600), this.now()],
      );
      for (const share of result.shares as readonly CostAllocationShare[]) {
        this.db.run(
          `INSERT INTO cost_allocations (id, business_id, cost_source_id, cycle_id, basis, basis_value, share_ratio, currency, amount, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [this.id(), caller.business.id, costSourceId, share.cycleId, basis, share.basisValue.toString(), share.shareRatio.toString(), currency, share.amount.amount.toString(), caller.user.id, this.now()],
        );
      }
      this.db.run('UPDATE cost_sources SET allocated_at = ? WHERE id = ?', [this.now(), costSourceId]);
      this.audit({ businessId: caller.business.id, actorId: caller.user.id, action: 'farming.allocate', entityType: 'cost_source', entityId: costSourceId, detail: { amount: amount.amount.toString(), basis, shares: result.shares.length } });
      return {
        costSourceId,
        basis,
        currency,
        totalCost: amount.amount.toString(),
        shares: result.shares.map((share) => ({ cycleId: share.cycleId, amount: share.amount.amount.toString(), ratio: share.shareRatio.toString() })),
        allocatedTotal: result.allocatedTotal.amount.toString(),
        unallocated: result.unallocated.amount.toString(),
      };
    });
  }

  cycleProfitReport(caller: Caller, cycleId: string): Record<string, unknown> {
    this.assertPermission(caller, 'farming.cost.view');
    const cycle = this.assertBusinessValue(
      this.db.get<{ id: string; reference: string; title: string; farming_type: string; planned_output_unit: string | null; planned_output: string | null }>(
        'SELECT id, reference, title, farming_type, planned_output_unit, planned_output FROM production_cycles WHERE id = ? AND business_id = ?',
        [cycleId, caller.business.id],
      ),
      'Production cycle',
    );
    const currency = caller.business.currency;
    const costs = this.db.all<{ kind: string; amount: string; currency: string; shared: number }>('SELECT kind, amount, currency, shared FROM cost_sources WHERE business_id = ? AND cycle_id = ?', [caller.business.id, cycleId]);
    const allocations = this.db.all<{ amount: string; currency: string }>('SELECT amount, currency FROM cost_allocations WHERE business_id = ? AND cycle_id = ?', [caller.business.id, cycleId]);
    const costToDate = this.cycleCostToDate(caller.business.id, cycleId, currency);
    const harvested = this.harvestedQuantity(caller.business.id, cycleId);
    const sales = this.cycleSales(caller.business.id, cycleId, currency);
    const revenue = sales.revenue;
    const soldCogs = sales.cogs;
    const unit = harvested.unit || cycle.planned_output_unit || 'unit';

    const byKind = new Map<string, Money>();
    for (const row of [...costs.filter((c) => c.shared === 0), ...allocations.map((a) => ({ kind: 'OVERHEAD (allocated)', amount: a.amount, currency: a.currency }))]) {
      byKind.set(row.kind, addMoney(byKind.get(row.kind) ?? zeroMoney(row.currency), money(row.currency, row.amount)));
    }

    return {
      cycleId,
      reference: cycle.reference,
      title: cycle.title,
      farmingType: cycle.farming_type,
      currency,
      costToDate: costToDate.amount.toString(),
      costBreakdown: [...byKind.entries()].map(([kind, amount]) => ({ kind, amount: amount.amount.toString() })).sort((a, b) => Number(b.amount) - Number(a.amount)),
      harvestedQuantity: harvested.quantity.toString(),
      outputUnit: unit,
      assignedToFinishedStock: harvested.assignedCost.amount.toString(),
      costRemainingInBatch: subMoney(costToDate, harvested.assignedCost).amount.toString(),
      revenue: revenue.amount.toString(),
      cogs: soldCogs.amount.toString(),
      grossProfit: revenue.amount.sub(soldCogs.amount).toString(),
      costInUnsoldOutput: subMoney(harvested.assignedCost, soldCogs).amount.toString(),
      note: 'Accrual basis. Profit counts only sold output; unsold harvest remains inventory.',
    };
  }

  closeCycle(caller: Caller, cycleId: string, input: Record<string, unknown>): Record<string, unknown> {
    this.assertPermission(caller, 'farming.close_cycle');
    const cycle = this.assertBusinessValue(this.db.get<{ id: string; reference: string }>('SELECT id, reference FROM production_cycles WHERE id = ? AND business_id = ?', [cycleId, caller.business.id]), 'Production cycle');
    const body = asRecord(input ?? {}, 'close');
    const occurredOn = optionalString(body.closedOn, 'closedOn', 10) ?? new Date().toISOString().slice(0, 10);
    const harvestRemainder = body.harvestRemainingCost !== false;
    let released: Money | null = null;
    const currency = caller.business.currency;

    if (harvestRemainder) {
      const quantityRaw = optionalString(body.remainingQuantity, 'remainingQuantity', 40);
      if (quantityRaw) {
        const harvested = this.harvestedQuantity(caller.business.id, cycleId);
        const costToDate = this.cycleCostToDate(caller.business.id, cycleId, currency);
        const assignment = assignHarvestCost(
          { cycleId, costToDate, harvestedQuantityToDate: harvested.quantity, assignedCostToDate: harvested.assignedCost, outputUnit: harvested.unit || 'unit' },
          dec(quantityRaw),
          'CLOSING_REMAINDER',
        );
        if (assignment.assignedCost.amount.isPositive()) {
          const eventId = randomUUID();
          this.postJournal(
            caller,
            buildHarvestPosting({
              businessId: caller.business.id,
              date: occurredOn,
              reference: `${cycle.reference}-CLOSE`,
              currency,
              costBasis: assignment.assignedCost,
              postedBy: caller.user.id,
              eventId: `${eventId}:journal`,
            }),
          );
          this.db.run(
            `INSERT INTO harvests (id, business_id, cycle_id, occurred_on, quantity, unit, costing_method, cost_basis, unit_cost, currency, notes, created_by, event_id, created_at)
             VALUES (?, ?, ?, ?, ?, ?, 'CLOSING_REMAINDER', ?, ?, ?, 'Final harvest on cycle close', ?, ?, ?)`,
            [
              this.id(),
              caller.business.id,
              cycleId,
              occurredOn,
              dec(quantityRaw).toString(),
              harvested.unit || 'unit',
              assignment.assignedCost.amount.toString(),
              assignment.costPerUnit.amount.toString(),
              currency,
              caller.user.id,
              eventId,
              this.now(),
            ],
          );
          released = assignment.assignedCost;
        }
      }
    }

    this.db.run(`UPDATE production_cycles SET status = 'CLOSED', actual_end_date = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND business_id = ?`, [
      occurredOn,
      this.now(),
      cycleId,
      caller.business.id,
    ]);
    this.audit({ businessId: caller.business.id, actorId: caller.user.id, action: 'cycle.close', entityType: 'production_cycle', entityId: cycleId, detail: { released: released?.amount.toString() ?? '0' } });
    return { cycleId, status: 'CLOSED', releasedToFinishedStock: released?.amount.toString() ?? '0' };
  }

  farmingDashboard(caller: Caller) {
    this.assertPermission(caller, 'farming.view');
    const currency = caller.business.currency;
    const cycles = this.listCycles(caller) as { id: string; status: string; costToDate?: string; revenue?: string }[];
    const active = cycles.filter((c) => c.status === 'ACTIVE' || c.status === 'HARVESTING');
    const totalCost = active.reduce<Money>((acc, c) => addMoney(acc, money(currency, c.costToDate ?? '0')), zeroMoney(currency));
    const revenue = active.reduce<Money>((acc, c) => addMoney(acc, money(currency, c.revenue ?? '0')), zeroMoney(currency));
    const mortality = this.db.all<{ cycle_id: string; quantity: string; abnormal: number }>('SELECT cycle_id, quantity, abnormal FROM mortality_losses WHERE business_id = ?', [caller.business.id]);
    const losses = this.db.all<{ cycle_id: string; cost: string }>('SELECT cycle_id, unit_cost AS cost FROM harvests WHERE business_id = ?', [caller.business.id]);
    void losses;
    return {
      currency,
      activeCycles: active.length,
      closedCycles: cycles.length - active.length,
      totalCostToDate: totalCost.amount.toString(),
      revenue: revenue.amount.toString(),
      grossProfit: revenue.amount.sub(totalCost.amount).toString(),
      mortalityAlerts: mortality.filter((m) => m.abnormal === 1).length,
      mortalityRecords: mortality.length,
      cycles,
    };
  }
}

function asRecordArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw HttpError.badRequest('VALIDATION', 'targets must be an array');
  return value.map((item) => asRecord(item, 'target'));
}

/** SQLite only accepts null, number, string, bigint or Buffer as a bound value. */
function normaliseCell(value: unknown): string | number | bigint | null | Buffer {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') return value;
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  return JSON.stringify(value);
}

function defaultAccountForEvent(eventType: string): string {
  switch (eventType) {
    case 'DIRECT_LABOUR':
      return '5110';
    case 'MACHINERY_FUEL':
      return '5140';
    case 'VETERINARY':
      return '5150';
    case 'UTILITIES':
      return '5120';
    case 'PACKAGING':
      return '5180';
    case 'TRANSPORT':
      return '5130';
    default:
      return '5100';
  }
}

export { pctOf };
