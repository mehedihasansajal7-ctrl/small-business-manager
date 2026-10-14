import { describe, expect, it } from 'vitest';
import {
  PARTNER_SOFT_MAX,
  PermissionError,
  ROLE_PERMISSIONS,
  ROLES,
  assertPermission,
  canChangeMemberRole,
  canRemoveMember,
  hasAllPermissions,
  hasAnyPermission,
  hasPermission,
  partnerCountGuidance,
  permissionsFor,
  redactForRole,
  type Role,
} from '../src/permissions.js';

void (ROLE_PERMISSIONS satisfies Record<Role, readonly string[]>);

describe('role permission matrix', () => {
  it('every role is declared exactly once with a Bangla name', () => {
    expect(ROLES).toHaveLength(7);
    expect(new Set(ROLES.map((r) => r.role)).size).toBe(7);
    expect(ROLES.every((r) => r.nameBn.length > 0)).toBe(true);
  });

  it('owner can do everything', () => {
    expect(hasPermission('owner', 'business.transfer_ownership')).toBe(true);
    expect(hasPermission('owner', 'partner_capital.manage')).toBe(true);
    expect(hasPermission('owner', 'financial_reports.view')).toBe(true);
  });

  it('admin cannot transfer ownership or delete the business', () => {
    expect(hasPermission('admin', 'business.settings')).toBe(true);
    expect(hasPermission('admin', 'member.invite')).toBe(true);
    expect(hasPermission('admin', 'business.transfer_ownership')).toBe(false);
    expect(hasPermission('admin', 'business.delete')).toBe(false);
  });

  it('gives least privilege by default to non-admin roles', () => {
    expect(hasPermission('manager', 'purchase.cost.view')).toBe(true);
    expect(hasPermission('manager', 'financial_reports.view')).toBe(false);
    expect(hasPermission('manager', 'partner_capital.view')).toBe(false);

    expect(hasPermission('cashier', 'sale.create')).toBe(true);
    expect(hasPermission('cashier', 'sale.discount.apply')).toBe(false);
    expect(hasPermission('cashier', 'purchase.cost.view')).toBe(false);
    expect(hasPermission('cashier', 'purchase.manage')).toBe(false);

    expect(hasPermission('farm_manager', 'farming.harvest')).toBe(true);
    expect(hasPermission('farm_manager', 'farming.cost.view')).toBe(true);
    expect(hasPermission('farm_manager', 'member.manage')).toBe(false);

    expect(hasPermission('viewer', 'report.view')).toBe(true);
    expect(hasPermission('viewer', 'sale.create')).toBe(false);
    expect(hasPermission('viewer', 'purchase.cost.view')).toBe(false);
  });

  it('lets the owner widen visibility for partners', () => {
    const settings = { partnerCanSeeFinancialReports: true, partnerCanSeeCosts: true, partnerCanSeeCapital: true };
    expect(hasPermission('manager', 'financial_reports.view', {}, settings)).toBe(true);
    expect(hasPermission('viewer', 'financial_reports.view', {}, settings)).toBe(true);
    expect(hasPermission('viewer', 'partner_capital.view', {}, settings)).toBe(true);
    // ...but it never grants a completely unrelated right
    expect(hasPermission('viewer', 'sale.create', {}, settings)).toBe(false);
  });

  it('applies per-member grants and denials, with denials winning', () => {
    expect(hasPermission('viewer', 'sale.create', { grants: ['sale.create'] })).toBe(true);
    expect(hasPermission('cashier', 'sale.create', { denials: ['sale.create'] })).toBe(false);
    // denials win over grants for the same permission
    expect(hasPermission('manager', 'sale.create', { grants: ['sale.create'], denials: ['sale.create'] })).toBe(false);
  });

  it('supports any/all permission checks', () => {
    expect(hasAnyPermission('cashier', ['purchase.manage', 'sale.create'])).toBe(true);
    expect(hasAllPermissions('cashier', ['purchase.manage', 'sale.create'])).toBe(false);
    expect(hasAllPermissions('owner', ['purchase.manage', 'sale.create', 'business.delete'])).toBe(true);
  });

  it('every role has at least one usable permission', () => {
    for (const [, permissions] of Object.entries(ROLE_PERMISSIONS)) {
      expect(permissions.length).toBeGreaterThan(3);
    }
  });
});

describe('permission enforcement', () => {
  it('throws a PermissionError naming the missing right', () => {
    expect(() => assertPermission('cashier', 'purchase.cost.view')).toThrow(PermissionError);
    try {
      assertPermission('cashier', 'purchase.cost.view');
    } catch (error) {
      const permissionError = error as PermissionError;
      expect(permissionError.permission).toBe('purchase.cost.view');
      expect(permissionError.role).toBe('cashier');
      expect(permissionError.message).toMatch(/does not have permission/);
    }
    expect(() => assertPermission('owner', 'purchase.cost.view')).not.toThrow();
  });

  it('redacts cost fields for roles that may not see them', () => {
    const row = { id: 's1', reference: 'SAL-1', amount: '100.00', unitCost: '68.00', margin: '32.00' };
    const redacted = redactForRole('cashier' as Role, row, ['unitCost', 'margin']);
    expect(Object.keys(redacted)).toEqual(['id', 'reference', 'amount']);
    const full = redactForRole('owner', row, ['unitCost', 'margin']);
    expect(full).toEqual(row);
  });

  it('returns the effective permission set', () => {
    const set = permissionsFor('cashier');
    expect(set.has('sale.create')).toBe(true);
    expect(set.has('purchase.cost.view')).toBe(false);
    expect(set.size).toBe(ROLE_PERMISSIONS.cashier.length);
  });
});

describe('membership guardrails', () => {
  it('blocks demoting or removing the last owner', () => {
    expect(canChangeMemberRole({ actorRole: 'owner', targetCurrentRole: 'owner', newRole: 'manager', ownerCount: 1, actorIsTarget: false })).toEqual({
      ok: false,
      reason: expect.stringMatching(/Transfer ownership/),
    });
    expect(canRemoveMember({ targetRole: 'owner', ownerCount: 1, actorRole: 'owner', actorIsTarget: false }).ok).toBe(false);
  });

  it('allows transferring ownership when another owner remains', () => {
    expect(canChangeMemberRole({ actorRole: 'owner', targetCurrentRole: 'admin', newRole: 'owner', ownerCount: 1, actorIsTarget: false }).ok).toBe(true);
    expect(canChangeMemberRole({ actorRole: 'owner', targetCurrentRole: 'owner', newRole: 'manager', ownerCount: 2, actorIsTarget: false }).ok).toBe(true);
  });

  it('stops a non-owner from promoting anyone to owner', () => {
    expect(canChangeMemberRole({ actorRole: 'admin', targetCurrentRole: 'manager', newRole: 'owner', ownerCount: 1, actorIsTarget: false }).ok).toBe(false);
    expect(canChangeMemberRole({ actorRole: 'manager', targetCurrentRole: 'cashier', newRole: 'viewer', ownerCount: 1, actorIsTarget: false }).ok).toBe(true);
  });

  it('stops self-lockout and self-removal', () => {
    expect(canChangeMemberRole({ actorRole: 'owner', targetCurrentRole: 'owner', newRole: 'viewer', ownerCount: 1, actorIsTarget: true }).ok).toBe(false);
    expect(canRemoveMember({ targetRole: 'manager', ownerCount: 1, actorRole: 'owner', actorIsTarget: true }).ok).toBe(false);
  });

  it('guides the 2-5 partner expectation without hard-blocking', () => {
    expect(partnerCountGuidance(1).level).toBe('below');
    expect(partnerCountGuidance(3).level).toBe('ok');
    expect(partnerCountGuidance(PARTNER_SOFT_MAX + 1).level).toBe('above');
  });
});
