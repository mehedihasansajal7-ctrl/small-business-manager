/**
 * Roles and permissions.
 *
 * IMPORTANT: this module is used by BOTH the UI (to hide/disable things) and the
 * API/sync layer (to enforce). The server is the authority; UI checks are only
 * for a better experience. Every API route must call `assertPermission`.
 */

export type Role = 'owner' | 'admin' | 'manager' | 'cashier' | 'inventory_manager' | 'farm_manager' | 'viewer';

export const ROLES: readonly { readonly role: Role; readonly name: string; readonly nameBn: string; readonly description: string }[] = Object.freeze([
  { role: 'owner', name: 'Owner', nameBn: 'মালিক', description: 'Full control, membership, ownership transfer and all financial data' },
  { role: 'admin', name: 'Admin', nameBn: 'অ্যাডমিন', description: 'Day-to-day management. Cannot transfer ownership.' },
  { role: 'manager', name: 'Manager', nameBn: 'ম্যানেজার', description: 'Sales, purchases, inventory and farming operations' },
  { role: 'cashier', name: 'Cashier', nameBn: 'ক্যাশিয়ার', description: 'Sales and receipts with restricted cost visibility' },
  { role: 'inventory_manager', name: 'Inventory manager', nameBn: 'স্টোর কর্মকর্তা', description: 'Stock, counts, input issues and approved corrections' },
  { role: 'farm_manager', name: 'Farm manager', nameBn: 'খামার ব্যবস্থাপক', description: 'Farming setup, cycles, operations and harvests' },
  { role: 'viewer', name: 'Viewer', nameBn: 'দর্শক', description: 'Read-only access to permitted modules' },
]);

export type Permission =
  // business + members
  | 'business.view'
  | 'business.settings'
  | 'business.transfer_ownership'
  | 'business.delete'
  | 'member.view'
  | 'member.invite'
  | 'member.manage'
  | 'audit.view'
  // catalog + inventory
  | 'product.view'
  | 'product.manage'
  | 'inventory.view'
  | 'inventory.manage'
  | 'inventory.adjust'
  | 'inventory.adjust.approve'
  | 'stock_count.create'
  | 'stock_count.approve'
  | 'location.manage'
  // sales
  | 'customer.view'
  | 'customer.manage'
  | 'sale.view'
  | 'sale.create'
  | 'sale.discount.apply'
  | 'sale.void'
  | 'sale.return'
  // purchases + suppliers
  | 'supplier.view'
  | 'supplier.manage'
  | 'purchase.view'
  | 'purchase.manage'
  | 'purchase.return'
  | 'purchase.cost.view'
  // finance
  | 'finance.view'
  | 'finance.manage'
  | 'finance.opening_balance'
  | 'financial_reports.view'
  | 'partner_capital.view'
  | 'partner_capital.manage'
  | 'payroll.view'
  | 'payroll.manage'
  // farming
  | 'farming.view'
  | 'farming.setup'
  | 'farming.operations'
  | 'farming.input_issue'
  | 'farming.observation'
  | 'farming.harvest'
  | 'farming.sale'
  | 'farming.cost.view'
  | 'farming.close_cycle'
  // reporting + data
  | 'report.view'
  | 'report.export'
  | 'attachment.manage'
  | 'backup.manage'
  | 'personal_data.view'
  // ai
  | 'ai.use';

const ALL: readonly Permission[] = Object.freeze([
  'business.view', 'business.settings', 'business.transfer_ownership', 'business.delete',
  'member.view', 'member.invite', 'member.manage', 'audit.view',
  'product.view', 'product.manage', 'inventory.view', 'inventory.manage', 'inventory.adjust', 'inventory.adjust.approve', 'stock_count.create', 'stock_count.approve', 'location.manage',
  'customer.view', 'customer.manage', 'sale.view', 'sale.create', 'sale.discount.apply', 'sale.void', 'sale.return',
  'supplier.view', 'supplier.manage', 'purchase.view', 'purchase.manage', 'purchase.return', 'purchase.cost.view',
  'finance.view', 'finance.manage', 'finance.opening_balance', 'financial_reports.view', 'partner_capital.view', 'partner_capital.manage', 'payroll.view', 'payroll.manage',
  'farming.view', 'farming.setup', 'farming.operations', 'farming.input_issue', 'farming.observation', 'farming.harvest', 'farming.sale', 'farming.cost.view', 'farming.close_cycle',
  'report.view', 'report.export', 'attachment.manage', 'backup.manage', 'personal_data.view',
  'ai.use',
]);

/** The owner may do everything. */
const OWNER: readonly Permission[] = ALL;

/** Admin = everything except ownership transfer and business deletion. */
const ADMIN: readonly Permission[] = ALL.filter((p) => p !== 'business.transfer_ownership' && p !== 'business.delete');

const MANAGER: readonly Permission[] = Object.freeze([
  'business.view', 'member.view', 'audit.view',
  'product.view', 'product.manage', 'inventory.view', 'inventory.manage', 'inventory.adjust', 'stock_count.create', 'location.manage',
  'customer.view', 'customer.manage', 'sale.view', 'sale.create', 'sale.discount.apply', 'sale.return',
  'supplier.view', 'supplier.manage', 'purchase.view', 'purchase.manage', 'purchase.return', 'purchase.cost.view',
  'finance.view', 'finance.manage',
  'farming.view', 'farming.setup', 'farming.operations', 'farming.input_issue', 'farming.observation', 'farming.harvest', 'farming.sale', 'farming.cost.view',
  'report.view', 'report.export', 'attachment.manage', 'ai.use',
]);

const CASHIER: readonly Permission[] = Object.freeze([
  'business.view', 'product.view', 'inventory.view',
  'customer.view', 'customer.manage', 'sale.view', 'sale.create', 'sale.return',
  'finance.view', 'finance.manage', 'report.view', 'attachment.manage', 'ai.use',
]);

const INVENTORY_MANAGER: readonly Permission[] = Object.freeze([
  'business.view', 'product.view', 'product.manage', 'inventory.view', 'inventory.manage', 'inventory.adjust', 'stock_count.create', 'location.manage',
  'supplier.view', 'purchase.view', 'purchase.manage', 'purchase.return', 'purchase.cost.view',
  'farming.view', 'farming.input_issue', 'farming.observation',
  'report.view', 'report.export', 'attachment.manage', 'ai.use',
]);

const FARM_MANAGER: readonly Permission[] = Object.freeze([
  'business.view', 'product.view', 'inventory.view', 'inventory.manage', 'location.manage',
  'farming.view', 'farming.setup', 'farming.operations', 'farming.input_issue', 'farming.observation', 'farming.harvest', 'farming.sale', 'farming.cost.view', 'farming.close_cycle',
  'sale.view', 'sale.create',
  'report.view', 'attachment.manage', 'ai.use',
]);

const VIEWER: readonly Permission[] = Object.freeze([
  'business.view', 'product.view', 'inventory.view', 'customer.view', 'supplier.view', 'sale.view', 'purchase.view', 'farming.view', 'report.view',
]);

export const ROLE_PERMISSIONS: Readonly<Record<Role, readonly Permission[]>> = Object.freeze({
  owner: OWNER,
  admin: ADMIN,
  manager: MANAGER,
  cashier: CASHIER,
  inventory_manager: INVENTORY_MANAGER,
  farm_manager: FARM_MANAGER,
  viewer: VIEWER,
});

/** Per-member overrides applied on top of the role (owner-configurable). */
export interface PermissionOverrides {
  readonly grants?: readonly Permission[];
  readonly denials?: readonly Permission[];
}

/**
 * Business-level settings that widen a role's default visibility. The owner
 * decides whether partners see full cost/profit detail; the default is
 * least-privilege.
 */
export interface BusinessVisibilitySettings {
  /** Let non-owner/admin members see financial reports (P&L, balance sheet). */
  readonly partnerCanSeeFinancialReports?: boolean;
  /** Let non-owner/admin members see purchase cost & margins. */
  readonly partnerCanSeeCosts?: boolean;
  /** Let non-owner/admin members see partner capital & drawings. */
  readonly partnerCanSeeCapital?: boolean;
}

const FINANCIAL_GRANTS: readonly Permission[] = Object.freeze(['financial_reports.view', 'purchase.cost.view', 'farming.cost.view']);
const CAPITAL_GRANTS: readonly Permission[] = Object.freeze(['partner_capital.view']);

export function permissionsFor(role: Role, overrides: PermissionOverrides = {}, settings: BusinessVisibilitySettings = {}): ReadonlySet<Permission> {
  const base = new Set<Permission>(ROLE_PERMISSIONS[role]);
  const privileged = role === 'owner' || role === 'admin';

  if (!privileged) {
    if (settings.partnerCanSeeFinancialReports) {
      base.add('financial_reports.view');
      base.add('report.export');
    }
    if (settings.partnerCanSeeCosts) for (const p of FINANCIAL_GRANTS) base.add(p);
    if (settings.partnerCanSeeCapital) for (const p of CAPITAL_GRANTS) base.add(p);
  }
  // Explicit grants first, then denials, so a denial ALWAYS wins: a de-scoped
  // member can never regain access by a role change or a stale grant.
  for (const p of overrides.grants ?? []) base.add(p);
  for (const p of overrides.denials ?? []) base.delete(p);
  return base;
}

export function hasPermission(
  role: Role,
  permission: Permission,
  overrides: PermissionOverrides = {},
  settings: BusinessVisibilitySettings = {},
): boolean {
  return permissionsFor(role, overrides, settings).has(permission);
}

export function hasAnyPermission(
  role: Role,
  permissions: readonly Permission[],
  overrides: PermissionOverrides = {},
  settings: BusinessVisibilitySettings = {},
): boolean {
  const set = permissionsFor(role, overrides, settings);
  return permissions.some((p) => set.has(p));
}

export function hasAllPermissions(
  role: Role,
  permissions: readonly Permission[],
  overrides: PermissionOverrides = {},
  settings: BusinessVisibilitySettings = {},
): boolean {
  const set = permissionsFor(role, overrides, settings);
  return permissions.every((p) => set.has(p));
}

export class PermissionError extends Error {
  readonly permission: Permission;
  readonly role: Role;
  constructor(permission: Permission, role: Role) {
    super(`Your role (${role}) does not have permission: ${permission}`);
    this.name = 'PermissionError';
    this.permission = permission;
    this.role = role;
  }
}

export function assertPermission(
  role: Role,
  permission: Permission,
  overrides: PermissionOverrides = {},
  settings: BusinessVisibilitySettings = {},
): void {
  if (!hasPermission(role, permission, overrides, settings)) throw new PermissionError(permission, role);
}

/** Guard the money-detail fields a member is not allowed to see. */
export function redactForRole<T extends Record<string, unknown>>(role: Role, row: T, costFields: readonly (keyof T)[], settings: BusinessVisibilitySettings = {}): T {
  const allowed = hasPermission(role, 'financial_reports.view', {}, settings) || hasPermission(role, 'purchase.cost.view', {}, settings);
  if (allowed) return row;
  const clone = { ...row };
  for (const field of costFields) delete clone[field];
  return clone;
}

export interface MemberRoleChangeCheck {
  readonly ok: boolean;
  readonly reason?: string;
}

/**
 * Guardrails for membership changes. Blocks the two classic lock-out mistakes:
 * removing/demoting the last owner, and a non-owner promoting themselves.
 */
export function canChangeMemberRole(input: {
  actorRole: Role;
  targetCurrentRole: Role;
  newRole: Role;
  ownerCount: number;
  actorIsTarget: boolean;
}): MemberRoleChangeCheck {
  const lastOwner = input.targetCurrentRole === 'owner' && input.ownerCount <= 1;
  const demotingLastOwner = lastOwner && input.newRole !== 'owner';
  if (demotingLastOwner) {
    return { ok: false, reason: 'Cannot demote the only owner. Transfer ownership to another member first.' };
  }
  if (input.actorRole !== 'owner') {
    if (input.newRole === 'owner') return { ok: false, reason: 'Only the current owner can transfer ownership.' };
    if (input.targetCurrentRole === 'owner') return { ok: false, reason: 'Only the current owner can change another owner.' };
  }
  if (input.actorIsTarget && input.actorRole === 'owner' && input.newRole !== 'owner') {
    return { ok: false, reason: 'Transfer ownership to another member before changing your own role.' };
  }
  return { ok: true };
}

export function canRemoveMember(input: { targetRole: Role; ownerCount: number; actorRole: Role; actorIsTarget: boolean }): MemberRoleChangeCheck {
  if (input.actorIsTarget) return { ok: false, reason: 'You cannot remove yourself from the business.' };
  if (input.targetRole === 'owner' && input.ownerCount <= 1) return { ok: false, reason: 'Cannot remove the only owner.' };
  if (input.actorRole !== 'owner' && input.targetRole === 'owner') return { ok: false, reason: 'Only the owner can remove another owner.' };
  return { ok: true };
}

/** The 2-5 partner expectation. The schema is not capped so a future plan can increase it. */
export const PARTNER_SOFT_MIN = 2;
export const PARTNER_SOFT_MAX = 5;

export function partnerCountGuidance(activeMemberCount: number): { level: 'ok' | 'below' | 'above'; message: string } {
  if (activeMemberCount < PARTNER_SOFT_MIN) {
    return { level: 'below', message: `This business has ${activeMemberCount} member(s). Small Business Manager is designed for 2-5 partners - invite the rest.` };
  }
  if (activeMemberCount > PARTNER_SOFT_MAX) {
    return { level: 'above', message: `This business has ${activeMemberCount} members, above the 2-5 partner guidance. Data isolation still applies, but review access.` };
  }
  return { level: 'ok', message: `${activeMemberCount} partners can share this workspace.` };
}
