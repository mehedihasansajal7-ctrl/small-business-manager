import { describe, expect, it } from 'vitest';
import {
  GLOBAL_TABLE_SET,
  allMigrationDdl,
  columnNames,
  countChar,
  createTables,
  loadMigrations,
  loadSeed,
  policies,
  rlsEnabledTables,
  rlsForcedTables,
  tableBlock,
} from './sql-utils.js';

/**
 * These tests never connect to a database (there is no PostgreSQL server in
 * this environment). They read the SQL and assert the invariants that make the
 * shared-cloud schema safe: full RLS coverage, tenant scoping, exact numerics,
 * no plaintext invite codes and single-apply idempotency keys.
 */

const migrations = loadMigrations();
const tables = createTables(migrations);
const tableNames = tables.map((table) => table.name);
const tenantTables = tables.filter((table) => !GLOBAL_TABLE_SET.has(table.name));
const enabled = rlsEnabledTables(migrations);
const forced = rlsForcedTables(migrations);

describe('migration files', () => {
  it('are numbered, ordered and non-empty', () => {
    expect(migrations.length).toBeGreaterThanOrEqual(7);
    let previous = 0;
    for (const file of migrations) {
      expect(file.name).toMatch(/^\d{4}_[a-z0-9_]+\.sql$/);
      const version = Number(file.name.slice(0, 4));
      expect(version).toBeGreaterThan(previous);
      previous = version;
      expect(file.raw.trim().length).toBeGreaterThan(0);
      expect(file.raw).toMatch(/\n/);
    }
  });

  it('has balanced parentheses in every migration (no truncated statements)', () => {
    for (const file of migrations) {
      const open = countChar(file.code, '(');
      const close = countChar(file.code, ')');
      expect(close, `${file.name} has ${open} "(" and ${close} ")"`).toBe(open);
    }
  });

  it('uses `create table if not exists` everywhere so a re-run is safe', () => {
    const createTablesWithoutIfNotExists = migrations.flatMap((file) =>
      [...file.code.matchAll(/create\s+table\s+(?!if\s+not\s+exists)/gi)].map((m) => `${file.name}:${m.index}`),
    );
    expect(createTablesWithoutIfNotExists).toEqual([]);
  });
});

describe('schema shape', () => {
  it('creates the full domain model (identity, inventory, commerce, farming, sync, AI)', () => {
    for (const required of [
      // identity / tenancy
      'profiles', 'businesses', 'business_members', 'business_invites', 'devices', 'audit_logs', 'business_settings', 'number_sequences',
      // catalog / inventory
      'locations', 'product_categories', 'products', 'units', 'unit_conversions', 'stock_lots', 'stock_movements', 'customers', 'suppliers',
      // commerce / finance
      'financial_accounts', 'purchases', 'purchase_lines', 'sales', 'sale_lines', 'payments', 'account_transfers',
      'income_expenses', 'partner_capital', 'journal_entries', 'journal_lines', 'attachments',
      // farming
      'farms', 'farm_units', 'production_cycles', 'farming_events', 'input_consumptions', 'production_outputs',
      'harvests', 'mortality_losses', 'cost_sources', 'cost_allocations', 'output_lots', 'observations',
      // sync / AI
      'sync_events', 'processed_events', 'sync_conflicts', 'ai_conversations', 'ai_messages', 'ai_saved_plans',
      'ai_feedback', 'ai_research_cache', 'ai_usage',
    ]) {
      expect(tableNames, `missing table ${required}`).toContain(required);
    }
    expect(new Set(tableNames).size).toBe(tableNames.length);
  });

  it('marks every tenant table with business_id (except the documented global tables)', () => {
    for (const table of tenantTables) {
      expect(columnNames(table.block), `${table.name} needs business_id`).toContain('business_id');
    }
  });

  it('keeps every money/quantity column exact (numeric), never float/real/double precision', () => {
    const ddl = allMigrationDdl().toLowerCase();
    expect(ddl).not.toMatch(/\bdouble\s+precision\b/);
    expect(ddl).not.toMatch(/\bfloat\d*\b/);
    expect(ddl).not.toMatch(/\breal\b/);
    // And the money columns really are the exact type we expect.
    for (const table of ['sales', 'purchases', 'journal_lines', 'stock_movements', 'cost_allocations']) {
      expect(tableBlock(table), `${table} block missing`).toMatch(/numeric\(20,\s*6\)/);
    }
  });
});

describe('row level security coverage', () => {
  it('enables row level security on every table it creates', () => {
    const missing = tableNames.filter((name) => !enabled.has(name));
    expect(missing, 'tables created without `enable row level security`').toEqual([]);
  });

  it('forces row level security on every tenant table', () => {
    const missing = tenantTables.map((table) => table.name).filter((name) => !forced.has(name));
    expect(missing, 'tenant tables without `force row level security`').toEqual([]);
  });

  it('never enables RLS on a table that does not exist', () => {
    const orphans = [...enabled].filter((name) => !tableNames.includes(name));
    expect(orphans, 'RLS enabled on unknown tables').toEqual([]);
  });
});

describe('invariants the API relies on', () => {
  it('stores only a hash of an invite code, never the plaintext', () => {
    const block = tableBlock('business_invites');
    expect(block).toBeDefined();
    expect(block).toContain('code_hash');
    expect(block).toMatch(/code_hash\s+text\s+not\s+null/);
    expect(block).toMatch(/unique\s*\(\s*code_hash\s*\)/);
    // No bare `code` column (code_hash and code_prefix are fine).
    expect(block).not.toMatch(/(?:^|,|\()\s*code\s+(?:text|varchar|citext|uuid|char)/i);
    // An invite can never hand out ownership.
    expect(block).toMatch(/role\s*<>\s*'owner'/i);
  });

  it('makes the stock and sync idempotency keys unique', () => {
    const movements = tableBlock('stock_movements') as string;
    expect(movements).toMatch(/idempotency_key\s+text\s+not\s+null/);
    expect(movements).toMatch(/unique\s*\(\s*idempotency_key\s*\)/);
    expect(movements).toMatch(/unique\s*\(\s*event_id\s*\)/);

    const processed = tableBlock('processed_events') as string;
    expect(processed).toMatch(/idempotency_key\s+text\s+primary\s+key/);
    expect(processed).toMatch(/business_id\s+uuid\s+not\s+null/);

    const syncEvents = tableBlock('sync_events') as string;
    expect(syncEvents).toMatch(/unique\s*\(\s*business_id\s*,\s*idempotency_key\s*\)/);
  });

  it('constrains movement direction, positive quantities and one positive journal side', () => {
    const movements = tableBlock('stock_movements') as string;
    expect(movements).toMatch(/direction\s+in\s*\(\s*'IN'\s*,\s*'OUT'\s*\)/i);
    expect(movements).toMatch(/check\s*\(\s*quantity\s*>\s*0\s*\)/i);
    expect(movements).toMatch(/check\s*\(\s*unit_cost\s*>=\s*0\s*\)/i);

    const lines = tableBlock('journal_lines') as string;
    expect(lines).toMatch(/\(\s*debit\s*>\s*0\s*\)\s*<>\s*\(\s*credit\s*>\s*0\s*\)/);
  });

  it('keeps document references unique per business', () => {
    for (const table of ['sales', 'purchases', 'production_cycles']) {
      expect(tableBlock(table), `${table} block missing`).toMatch(
        /unique\s*\(\s*business_id\s*,\s*reference\s*\)/,
      );
    }
  });

  it('keeps double-entry arithmetic exact in the header tables', () => {
    const sales = tableBlock('sales') as string;
    expect(sales).toMatch(/net\s*=\s*gross\s*\+\s*tax\s*-\s*discount/);
    expect(sales).toMatch(/receivable\s*=\s*net\s*-\s*cash_received/);

    const purchases = tableBlock('purchases') as string;
    expect(purchases).toMatch(/total\s*=\s*subtotal\s*\+\s*tax\s*-\s*discount/);
    expect(purchases).toMatch(/payable\s*=\s*total\s*-\s*paid/);
  });

  it('caps cost allocations to one share per (cost source, cycle)', () => {
    const allocations = tableBlock('cost_allocations') as string;
    expect(allocations).toMatch(/unique\s*\(\s*cost_source_id\s*,\s*cycle_id\s*\)/);
    expect(allocations).toMatch(/share_ratio\s+numeric/);
    expect(allocations).toMatch(/basis\s+in\s*\(/i);
  });
});

describe('referential integrity of the SQL itself', () => {
  /** Tables referenced by name that live outside this schema. */
  const EXTERNAL_TABLES = new Set(['users']); // auth.users (Supabase), guarded

  it('every foreign key points at a table this schema creates', () => {
    const known = new Set([...tableNames, ...EXTERNAL_TABLES]);
    const offenders: string[] = [];
    for (const table of tables) {
      for (const match of table.block.matchAll(/references\s+(?:public\.)?([a-z_][a-z0-9_]*)\s*\(/gi)) {
        const target = (match[1] as string).toLowerCase();
        if (!known.has(target)) offenders.push(`${table.name} -> ${target}`);
      }
    }
    expect(offenders, 'foreign keys pointing at unknown tables').toEqual([]);
  });

  it('every create index and alter table targets an existing table', () => {
    const known = new Set(tableNames);
    const offenders: string[] = [];
    for (const file of migrations) {
      for (const match of file.code.matchAll(/create\s+(?:unique\s+)?index\s+if\s+not\s+exists\s+([a-z_][a-z0-9_]*)\s+on\s+(?:public\.)?([a-z_][a-z0-9_]*)/gi)) {
        if (!known.has((match[2] as string).toLowerCase())) offenders.push(`${file.name}: index ${match[1]} -> ${match[2]}`);
      }
      for (const match of file.code.matchAll(/alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?(?:public\.)?([a-z_][a-z0-9_]*)\s+(?:enable|force|disable)\s+row\s+level\s+security/gi)) {
        if (!known.has((match[1] as string).toLowerCase())) offenders.push(`${file.name}: alter table ${match[1]}`);
      }
      for (const match of file.code.matchAll(/(?:insert\s+into|update|delete\s+from)\s+public\.([a-z_][a-z0-9_]*)/gi)) {
        if (!known.has((match[1] as string).toLowerCase())) offenders.push(`${file.name}: dml on ${match[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('has one policy name per table and no duplicated index names', () => {
    const allPolicies = policies(migrations);
    const policyIds = allPolicies.map((policy) => `${policy.table}.${policy.name}`);
    expect(new Set(policyIds).size).toBe(policyIds.length);
    const indexNames = migrations.flatMap((file) =>
      [...file.code.matchAll(/create\s+(?:unique\s+)?index\s+if\s+not\s+exists\s+([a-z_][a-z0-9_]*)/gi)].map((m) => m[1] as string),
    );
    expect(new Set(indexNames).size).toBe(indexNames.length);
  });
});

describe('demo seed', () => {
  const seed = loadSeed();

  it('exists, is guarded and is idempotent', () => {
    expect(seed.raw.trim().length).toBeGreaterThan(0);
    expect(seed.code).toMatch(/do\s+\$seed\$/i);
    expect(seed.code).toMatch(/already seeded|nothing to do/i);
    expect(seed.code).toMatch(/on conflict/i);
  });

  it('contains no secrets and no real personal data', () => {
    expect(seed.raw).not.toMatch(/\bpassword\s*[:=]/i);
    expect(seed.raw).not.toMatch(/\$2[aby]\$/); // bcrypt hashes
    expect(seed.raw).not.toMatch(/BEGIN (RSA )?PRIVATE KEY/);
    expect(seed.raw).not.toMatch(/(api[_-]?key|secret|token)\s*[:=]\s*['"][A-Za-z0-9]{12,}/i);

    const emails = [...seed.raw.matchAll(/[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+)/g)].map((m) => m[1] as string);
    expect(emails.length).toBeGreaterThan(0);
    for (const domain of emails) expect(domain.toLowerCase()).toMatch(/example\.(com|org|net)$/);
  });
});
