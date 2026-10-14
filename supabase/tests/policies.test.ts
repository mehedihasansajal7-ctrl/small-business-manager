import { describe, expect, it } from 'vitest';
import {
  GLOBAL_TABLE_SET,
  createTables,
  functions,
  loadFunctions,
  loadMigrations,
  policies,
  rlsEnabledTables,
  tableBlock,
} from './sql-utils.js';

/**
 * Policy-level invariants. Again: no database connection, the SQL is read and
 * inspected. What is asserted here is that every tenant table is covered by a
 * read policy, that no policy can be satisfied without a business membership,
 * that posted accounting/stock rows cannot be updated or deleted, and that the
 * privileged paths (invite redemption, property helpers) are SECURITY DEFINER
 * with a pinned search_path.
 */

const migrations = loadMigrations();
const allPolicies = policies(migrations);
const tables = createTables(migrations);
const tenantTables = tables.filter((table) => !GLOBAL_TABLE_SET.has(table.name));
const enabled = rlsEnabledTables(migrations);
const allFunctions = functions([...migrations, ...loadFunctions()]);

function policiesFor(table: string) {
  return allPolicies.filter((policy) => policy.table === table);
}

describe('helper functions', () => {
  it('defines is_business_member and has_business_permission', () => {
    const names = allFunctions.map((fn) => fn.name);
    expect(names).toContain('is_business_member');
    expect(names).toContain('has_business_permission');
  });

  it('makes every SECURITY DEFINER function pin search_path', () => {
    const offenders = allFunctions
      .filter((fn) => fn.securityDefiner && !fn.hasSearchPath)
      .map((fn) => `${fn.file}:${fn.name}`);
    expect(offenders, 'SECURITY DEFINER function without `set search_path`').toEqual([]);
  });

  it('reads the role/permission map instead of hard-coding roles in policies', () => {
    const memberHelper = allFunctions.find((fn) => fn.name === 'is_business_member') as { statement: string };
    const permissionHelper = allFunctions.find((fn) => fn.name === 'has_business_permission') as { statement: string };
    expect(memberHelper.statement).toMatch(/from\s+public\.business_members/i);
    expect(permissionHelper.statement).toMatch(/from\s+public\.role_permissions/i);
    expect(permissionHelper.statement).toMatch(/business_members/i);
    // Denials always win, and grants are honoured.
    expect(permissionHelper.statement).toMatch(/denials\s*\?/i);
    expect(permissionHelper.statement).toMatch(/grants\s*\?/i);
  });

  it('mirrors the partner visibility settings from business_settings', () => {
    const helper = allFunctions.find((fn) => fn.name === 'has_business_permission') as { statement: string };
    for (const setting of ['partnerCanSeeFinancialReports', 'partnerCanSeeCosts', 'partnerCanSeeCapital']) {
      expect(helper.statement, `missing ${setting}`).toContain(setting);
    }
  });
});

describe('tenant isolation', () => {
  it('gives every tenant table at least one select policy', () => {
    const missing = tenantTables
      .map((table) => table.name)
      .filter((name) => !policiesFor(name).some((policy) => policy.command === 'select'));
    expect(missing, 'tenant tables without a select policy').toEqual([]);
  });

  it('never lets a policy be satisfied without a membership or the caller profile', () => {
    const offenders = allPolicies
      .filter((policy) => !GLOBAL_TABLE_SET.has(policy.table))
      .filter(
        (policy) =>
          !/is_business_member\(/.test(policy.text) &&
          !/has_business_permission\(/.test(policy.text) &&
          !/current_profile_id\(/.test(policy.text),
      )
      .map((policy) => `${policy.table}:${policy.name}`);
    expect(offenders, 'policies that do not call a membership helper').toEqual([]);
  });

  it('only creates policies on tables that have RLS enabled', () => {
    const offenders = [...new Set(allPolicies.map((policy) => policy.table))].filter(
      (table) => !enabled.has(table),
    );
    expect(offenders).toEqual([]);
  });

  it('references both helpers from the policy set', () => {
    const text = allPolicies.map((policy) => policy.text).join('\n');
    expect(text).toContain('is_business_member(');
    expect(text).toContain('has_business_permission(');
    expect(allPolicies.length).toBeGreaterThan(100);
  });
});

describe('append-only accounting and stock', () => {
  const appendOnly = [
    'stock_movements',
    'journal_entries',
    'journal_lines',
    'processed_events',
    'payments',
    'income_expenses',
    'account_transfers',
    'partner_capital',
    'harvests',
    'sale_lines',
    'purchase_lines',
    'mortality_losses',
    'observations',
    'cost_allocations',
  ];

  it('creates no update/delete policy for posted rows', () => {
    for (const table of appendOnly) {
      const commands = policiesFor(table).map((policy) => policy.command);
      expect(commands, `${table} must not be updatable`).not.toContain('update');
      expect(commands, `${table} must not be deletable`).not.toContain('delete');
      expect(commands, `${table} must be readable`).toContain('select');
    }
  });

  it('keeps audit_logs append-only (select + insert only)', () => {
    const commands = policiesFor('audit_logs').map((policy) => policy.command).sort();
    expect(commands).toEqual(['insert', 'select']);
  });

  it('uses void/reversal semantics instead of deletes on documents', () => {
    const sales = tableBlock('sales') as string;
    const purchases = tableBlock('purchases') as string;
    expect(sales).toMatch(/voided_at/);
    expect(purchases).toMatch(/voided_at/);
    expect(sales).toMatch(/'VOID'/);
    expect(policiesFor('sales').some((policy) => policy.command === 'delete')).toBe(false);
  });
});

describe('privileged paths', () => {
  it('redeems invites through a SECURITY DEFINER function bound to code_hash', () => {
    const redeem = allFunctions.find((fn) => fn.name === 'redeem_invite');
    expect(redeem, 'public.redeem_invite is missing').toBeDefined();
    expect(redeem?.securityDefiner).toBe(true);
    expect(redeem?.hasSearchPath).toBe(true);
    const statement = (redeem as { statement: string }).statement;
    expect(statement).toMatch(/code_hash/i);
    expect(statement).toMatch(/insert\s+into\s+public\.business_members/i);
    expect(statement).toMatch(/for\s+update/i);
    expect(statement).toMatch(/expires_at/i);
    expect(statement).toMatch(/max_uses/i);
    // The plaintext code is only ever hashed, never stored.
    expect(statement).toMatch(/sha256\(/i);
  });

  it('lets a valid redemption set the role without tripping the role guard', () => {
    const redeem = allFunctions.find((fn) => fn.name === 'redeem_invite') as { statement: string };
    const guard = allFunctions.find((fn) => fn.name === 'guard_member_role_change') as { statement: string };
    expect(redeem.statement).toMatch(/set_config\('app\.membership_change'/);
    expect(guard.statement).toMatch(/current_setting\('app\.membership_change'/);
    expect(redeem.statement).toMatch(/'invite_redemption'/);
    expect(guard.statement).toMatch(/'invite_redemption'/);
  });

  it('protects the last owner with a guard trigger', () => {
    const guard = allFunctions.find((fn) => fn.name === 'protect_last_owner');
    expect(guard, 'app.protect_last_owner is missing').toBeDefined();
    const statement = (guard as { statement: string }).statement;
    expect(statement).toMatch(/role\s*=\s*'owner'/i);
    expect(statement).toMatch(/raise\s+exception/i);
    expect(statement).toMatch(/business_members/i);
  });

  it('enforces double entry and full cost allocation with deferrable triggers', () => {
    const code = migrations.map((file) => file.code).join('\n');
    expect(code).toMatch(/assert_entry_balanced/);
    expect(code).toMatch(/journal_lines_balanced[\s\S]{0,200}deferrable\s+initially\s+deferred/i);
    expect(code).toMatch(/assert_cost_allocation_balanced/);
    expect(code).toMatch(/cost_allocations_balanced[\s\S]{0,200}deferrable\s+initially\s+deferred/i);
  });

  it('exposes transactional posting functions with an idempotency key and processed_events', () => {
    const expected = [
      'post_sale',
      'receive_purchase',
      'move_stock',
      'post_harvest',
      'allocate_cost',
      'post_payment',
      'create_journal_entry',
      'close_cycle',
    ];
    for (const name of expected) {
      const fn = allFunctions.find((entry) => entry.name === name);
      expect(fn, `${name} is missing`).toBeDefined();
      expect(fn?.securityDefiner, `${name} must be SECURITY DEFINER`).toBe(true);
      expect(fn?.hasSearchPath, `${name} must pin search_path`).toBe(true);
      const statement = (fn as { statement: string }).statement;
      expect(statement, `${name} must accept an idempotency key`).toMatch(/p_idempotency_key/);
      expect(statement, `${name} must record the event`).toMatch(/app\.record_event|processed_events/);
      expect(statement, `${name} must check out the prior result`).toMatch(/app\.idempotent_result|processed_events/);
      expect(statement, `${name} must check a permission`).toMatch(/app\.require_permission/);
    }
  });

  it('refuses negative stock in the sale and stock paths', () => {
    const sale = allFunctions.find((fn) => fn.name === 'post_sale') as { statement: string };
    const move = allFunctions.find((fn) => fn.name === 'move_stock') as { statement: string };
    expect(sale.statement).toMatch(/on_hand_qty/);
    expect(sale.statement).toMatch(/STOCK_CONFLICT/);
    expect(move.statement).toMatch(/STOCK_CONFLICT/);
    expect(move.statement).toMatch(/inventory\.adjust\.approve/);
  });

  it('audits member, opening-balance, reversal, adjustment, allocation and export events', () => {
    const code = migrations.map((file) => file.code).join('\n');
    for (const marker of [
      'audit_business_members',
      'audit_opening_balance_accounts',
      'audit_opening_balance_customers',
      'audit_opening_balance_suppliers',
      'audit_stock_reversals',
      'audit_stock_adjustments',
      'audit_journal_reversals',
      'audit_cost_allocations',
    ]) {
      expect(code, `missing audit trigger ${marker}`).toContain(marker);
    }
    expect(code).toMatch(/report\.export/);
  });
});
