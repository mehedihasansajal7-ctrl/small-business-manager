import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

/**
 * `node:sqlite` is a very new builtin. It is loaded through `createRequire` so
 * bundlers/dev servers that do not yet know the specifier never try to resolve
 * it themselves.
 */
const nodeRequire = createRequire(import.meta.url);
const sqlite = nodeRequire('node:sqlite') as typeof import('node:sqlite');

/**
 * Embedded SQLite storage (no external database, no cost, works offline).
 *
 * Every tenant-owned table carries `business_id` and all reads go through a
 * repository that filters by the caller's business, which is how tenant
 * isolation is enforced server-side.
 */

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'core_identity_tenancy',
    sql: `
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  locale TEXT NOT NULL DEFAULT 'en',
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  last_login_at TEXT
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  business_id TEXT REFERENCES businesses(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  user_agent TEXT
);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expiry ON sessions(expires_at);

CREATE TABLE businesses (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  currency TEXT NOT NULL DEFAULT 'BDT',
  timezone TEXT NOT NULL DEFAULT 'Asia/Dhaka',
  locale TEXT NOT NULL DEFAULT 'en',
  country TEXT NOT NULL DEFAULT 'BD',
  farming_types TEXT NOT NULL DEFAULT '[]',
  enabled_modules TEXT NOT NULL DEFAULT '[]',
  settings TEXT NOT NULL DEFAULT '{}',
  plan TEXT NOT NULL DEFAULT 'free',
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL
);

CREATE TABLE members (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  grants TEXT NOT NULL DEFAULT '[]',
  denials TEXT NOT NULL DEFAULT '[]',
  joined_at TEXT NOT NULL,
  invited_by TEXT,
  last_active_at TEXT,
  UNIQUE (business_id, user_id)
);
CREATE INDEX idx_members_business ON members(business_id);
CREATE INDEX idx_members_user ON members(user_id);

CREATE TABLE invites (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  email TEXT,
  role TEXT NOT NULL,
  code_hash TEXT NOT NULL UNIQUE,
  code_prefix TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  accepted_at TEXT,
  accepted_by TEXT,
  use_count INTEGER NOT NULL DEFAULT 0,
  max_uses INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_invites_business ON invites(business_id);

CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT 'web',
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  UNIQUE (business_id, user_id, id)
);

CREATE TABLE audit_logs (
  id TEXT PRIMARY KEY,
  business_id TEXT REFERENCES businesses(id) ON DELETE CASCADE,
  actor_id TEXT,
  actor_email TEXT,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  detail TEXT NOT NULL DEFAULT '{}',
  device_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_audit_business_time ON audit_logs(business_id, created_at);
  `,
  },
  {
    version: 2,
    name: 'catalog_inventory',
    sql: `
CREATE TABLE locations (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'STORE',
  address TEXT,
  is_default INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_locations_business ON locations(business_id);

CREATE TABLE product_categories (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  parent_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE products (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  sku TEXT,
  name TEXT NOT NULL,
  name_bn TEXT,
  category_id TEXT,
  kind TEXT NOT NULL DEFAULT 'PRODUCT',
  unit TEXT NOT NULL,
  sale_price TEXT,
  purchase_price TEXT,
  tax_rate TEXT,
  reorder_level TEXT,
  track_lots INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX idx_products_business ON products(business_id, is_active);

CREATE TABLE explicit_conversions (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  from_unit TEXT NOT NULL,
  to_unit TEXT NOT NULL,
  factor TEXT NOT NULL,
  note TEXT NOT NULL,
  item_id TEXT,
  approved_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE customers (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  address TEXT,
  opening_balance TEXT NOT NULL DEFAULT '0',
  credit_limit TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_customers_business ON customers(business_id);

CREATE TABLE suppliers (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  address TEXT,
  opening_balance TEXT NOT NULL DEFAULT '0',
  is_active INTEGER NOT NULL DEFAULT 1,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_suppliers_business ON suppliers(business_id);

CREATE TABLE stock_lots (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  lot_no TEXT,
  unit_cost TEXT NOT NULL,
  currency TEXT NOT NULL,
  received_at TEXT NOT NULL,
  expiry_date TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_lots_item ON stock_lots(business_id, item_id);

CREATE TABLE stock_movements (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  direction TEXT NOT NULL CHECK (direction IN ('IN','OUT')),
  quantity TEXT NOT NULL,
  unit TEXT NOT NULL,
  unit_cost TEXT NOT NULL,
  currency TEXT NOT NULL,
  lot_id TEXT REFERENCES stock_lots(id) ON DELETE SET NULL,
  expiry_date TEXT,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  device_id TEXT,
  event_id TEXT NOT NULL UNIQUE,
  idempotency_key TEXT NOT NULL UNIQUE,
  reversal_of TEXT,
  reason TEXT,
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_stock_item ON stock_movements(business_id, item_id, occurred_at);
CREATE INDEX idx_stock_source ON stock_movements(business_id, source_type, source_id);
  `,
  },
  {
    version: 3,
    name: 'commerce_finance',
    sql: `
CREATE TABLE financial_accounts (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  name_bn TEXT,
  kind TEXT NOT NULL DEFAULT 'CASH' CHECK (kind IN ('CASH','BANK','MFS')),
  account_code TEXT NOT NULL DEFAULT '1000',
  identifier TEXT,
  opening_balance TEXT NOT NULL DEFAULT '0',
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  UNIQUE (business_id, code)
);

CREATE TABLE purchases (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  reference TEXT NOT NULL,
  supplier_id TEXT REFERENCES suppliers(id) ON DELETE SET NULL,
  document_date TEXT NOT NULL,
  currency TEXT NOT NULL,
  subtotal TEXT NOT NULL,
  discount TEXT NOT NULL DEFAULT '0',
  tax TEXT NOT NULL DEFAULT '0',
  total TEXT NOT NULL,
  paid TEXT NOT NULL DEFAULT '0',
  payable TEXT NOT NULL DEFAULT '0',
  status TEXT NOT NULL DEFAULT 'POSTED',
  note TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  device_id TEXT,
  event_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (business_id, reference)
);
CREATE INDEX idx_purchases_date ON purchases(business_id, document_date);

CREATE TABLE purchase_lines (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  purchase_id TEXT NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
  product_id TEXT REFERENCES products(id) ON DELETE SET NULL,
  description TEXT,
  quantity TEXT NOT NULL,
  unit TEXT NOT NULL,
  unit_cost TEXT NOT NULL,
  discount TEXT NOT NULL DEFAULT '0',
  tax TEXT NOT NULL DEFAULT '0',
  line_total TEXT NOT NULL,
  location_id TEXT,
  lot_no TEXT,
  expiry_date TEXT
);
CREATE INDEX idx_purchase_lines ON purchase_lines(purchase_id);

CREATE TABLE sales (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  reference TEXT NOT NULL,
  customer_id TEXT REFERENCES customers(id) ON DELETE SET NULL,
  document_date TEXT NOT NULL,
  currency TEXT NOT NULL,
  gross TEXT NOT NULL,
  discount TEXT NOT NULL DEFAULT '0',
  tax TEXT NOT NULL DEFAULT '0',
  net TEXT NOT NULL,
  cash_received TEXT NOT NULL DEFAULT '0',
  receivable TEXT NOT NULL DEFAULT '0',
  cogs TEXT NOT NULL DEFAULT '0',
  status TEXT NOT NULL DEFAULT 'POSTED',
  note TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  device_id TEXT,
  event_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (business_id, reference)
);
CREATE INDEX idx_sales_date ON sales(business_id, document_date);

CREATE TABLE sale_lines (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  sale_id TEXT NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  product_id TEXT REFERENCES products(id) ON DELETE SET NULL,
  description TEXT,
  quantity TEXT NOT NULL,
  unit TEXT NOT NULL,
  unit_price TEXT NOT NULL,
  discount TEXT NOT NULL DEFAULT '0',
  tax TEXT NOT NULL DEFAULT '0',
  line_total TEXT NOT NULL,
  unit_cost TEXT NOT NULL DEFAULT '0',
  location_id TEXT,
  lot_id TEXT
);
CREATE INDEX idx_sale_lines ON sale_lines(sale_id);

CREATE TABLE payments (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  party_type TEXT NOT NULL,
  party_id TEXT,
  document_date TEXT NOT NULL,
  currency TEXT NOT NULL,
  amount TEXT NOT NULL,
  account_code TEXT NOT NULL DEFAULT '1000',
  reference TEXT NOT NULL,
  note TEXT,
  created_by TEXT NOT NULL,
  device_id TEXT,
  event_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_payments_date ON payments(business_id, document_date);

CREATE TABLE account_transfers (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  document_date TEXT NOT NULL,
  currency TEXT NOT NULL,
  amount TEXT NOT NULL,
  from_account TEXT NOT NULL,
  to_account TEXT NOT NULL,
  reference TEXT NOT NULL,
  note TEXT,
  created_by TEXT NOT NULL,
  event_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE income_expenses (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('INCOME','EXPENSE')),
  category_account TEXT NOT NULL,
  document_date TEXT NOT NULL,
  currency TEXT NOT NULL,
  amount TEXT NOT NULL,
  account_code TEXT NOT NULL DEFAULT '1000',
  paid INTEGER NOT NULL DEFAULT 1,
  reference TEXT NOT NULL,
  note TEXT,
  created_by TEXT NOT NULL,
  event_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_income_expenses_date ON income_expenses(business_id, document_date);

CREATE TABLE partner_capital (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('CONTRIBUTION','WITHDRAWAL')),
  document_date TEXT NOT NULL,
  currency TEXT NOT NULL,
  amount TEXT NOT NULL,
  account_code TEXT NOT NULL DEFAULT '1000',
  reference TEXT NOT NULL,
  note TEXT,
  created_by TEXT NOT NULL,
  event_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE journal_entries (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  document_date TEXT NOT NULL,
  reference TEXT NOT NULL,
  description TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  currency TEXT NOT NULL,
  posted_by TEXT NOT NULL,
  device_id TEXT,
  event_id TEXT NOT NULL UNIQUE,
  reversal_of TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_journal_date ON journal_entries(business_id, document_date);
CREATE INDEX idx_journal_source ON journal_entries(business_id, source_type, source_id);

CREATE TABLE journal_lines (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  entry_id TEXT NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
  account TEXT NOT NULL,
  debit TEXT NOT NULL DEFAULT '0',
  credit TEXT NOT NULL DEFAULT '0',
  currency TEXT NOT NULL,
  memo TEXT,
  partner_id TEXT,
  cost_center TEXT
);
CREATE INDEX idx_journal_lines_entry ON journal_lines(entry_id);
CREATE INDEX idx_journal_lines_account ON journal_lines(business_id, account);
  `,
  },
  {
    version: 4,
    name: 'farming',
    sql: `
CREATE TABLE farms (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  location_id TEXT REFERENCES locations(id) ON DELETE SET NULL,
  address TEXT,
  area TEXT,
  area_unit TEXT,
  latitude TEXT,
  longitude TEXT,
  notes TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_farms_business ON farms(business_id);

CREATE TABLE farm_units (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  farm_id TEXT NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  area TEXT,
  area_unit TEXT,
  capacity TEXT,
  capacity_unit TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_farm_units ON farm_units(farm_id);

CREATE TABLE production_cycles (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  farm_id TEXT NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  unit_id TEXT NOT NULL REFERENCES farm_units(id) ON DELETE CASCADE,
  reference TEXT NOT NULL,
  farming_type TEXT NOT NULL,
  title TEXT NOT NULL,
  crop_or_species TEXT,
  variety_or_breed TEXT,
  season TEXT,
  responsible_member_id TEXT,
  start_date TEXT NOT NULL,
  expected_end_date TEXT,
  actual_end_date TEXT,
  planned_output TEXT,
  planned_output_unit TEXT,
  status TEXT NOT NULL DEFAULT 'PLANNED',
  starting_population TEXT,
  notes TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (business_id, reference)
);
CREATE INDEX idx_cycles_business ON production_cycles(business_id, status);

CREATE TABLE farming_events (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  cycle_id TEXT NOT NULL REFERENCES production_cycles(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  occurred_on TEXT NOT NULL,
  quantity TEXT,
  unit TEXT,
  amount TEXT,
  currency TEXT,
  account_code TEXT,
  product_id TEXT,
  notes TEXT,
  payload TEXT NOT NULL DEFAULT '{}',
  actor_id TEXT NOT NULL,
  device_id TEXT,
  event_id TEXT NOT NULL UNIQUE,
  reversal_of TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_farm_events ON farming_events(business_id, cycle_id, occurred_on);

CREATE TABLE cost_sources (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  cycle_id TEXT REFERENCES production_cycles(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  currency TEXT NOT NULL,
  amount TEXT NOT NULL,
  shared INTEGER NOT NULL DEFAULT 0,
  incurred_on TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  note TEXT,
  allocated_at TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_cost_sources ON cost_sources(business_id, cycle_id);

CREATE TABLE cost_allocations (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  cost_source_id TEXT NOT NULL REFERENCES cost_sources(id) ON DELETE CASCADE,
  cycle_id TEXT NOT NULL REFERENCES production_cycles(id) ON DELETE CASCADE,
  basis TEXT NOT NULL,
  basis_value TEXT NOT NULL,
  share_ratio TEXT NOT NULL,
  currency TEXT NOT NULL,
  amount TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_cost_allocations ON cost_allocations(cost_source_id);

CREATE TABLE harvests (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  cycle_id TEXT NOT NULL REFERENCES production_cycles(id) ON DELETE CASCADE,
  occurred_on TEXT NOT NULL,
  quantity TEXT NOT NULL,
  unit TEXT NOT NULL,
  product_id TEXT REFERENCES products(id) ON DELETE SET NULL,
  location_id TEXT,
  lot_no TEXT,
  costing_method TEXT NOT NULL,
  cost_basis TEXT NOT NULL,
  unit_cost TEXT NOT NULL,
  currency TEXT NOT NULL,
  grade TEXT,
  notes TEXT,
  created_by TEXT NOT NULL,
  device_id TEXT,
  event_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_harvests_cycle ON harvests(business_id, cycle_id, occurred_on);

CREATE TABLE observations (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  cycle_id TEXT NOT NULL REFERENCES production_cycles(id) ON DELETE CASCADE,
  observed_on TEXT NOT NULL,
  kind TEXT NOT NULL,
  value TEXT,
  unit TEXT,
  notes TEXT,
  recorded_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_observations ON observations(business_id, cycle_id);

CREATE TABLE mortality_losses (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  cycle_id TEXT NOT NULL REFERENCES production_cycles(id) ON DELETE CASCADE,
  occurred_on TEXT NOT NULL,
  quantity TEXT NOT NULL,
  unit TEXT NOT NULL,
  reason TEXT NOT NULL,
  book_value TEXT,
  currency TEXT,
  abnormal INTEGER NOT NULL DEFAULT 0,
  recorded_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
  `,
  },
  {
    version: 5,
    name: 'sync_ai_attachments',
    sql: `
CREATE TABLE processed_events (
  idempotency_key TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  server_revision INTEGER NOT NULL,
  result TEXT NOT NULL DEFAULT '{}',
  processed_at TEXT NOT NULL
);
CREATE INDEX idx_processed_business ON processed_events(business_id, processed_at);

CREATE TABLE sync_conflicts (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  device_id TEXT,
  actor_id TEXT,
  base_revision INTEGER,
  server_revision INTEGER NOT NULL,
  differing_fields TEXT NOT NULL DEFAULT '[]',
  auto_mergeable INTEGER NOT NULL DEFAULT 0,
  detail TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'OPEN',
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  resolved_by TEXT
);
CREATE INDEX idx_conflicts_business ON sync_conflicts(business_id, status);

CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  file_name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  stored_path TEXT NOT NULL,
  checksum TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_attachments_entity ON attachments(business_id, entity_type, entity_id);

CREATE TABLE ai_conversations (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  language TEXT NOT NULL DEFAULT 'bn',
  context_scope TEXT NOT NULL DEFAULT 'business',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX idx_ai_conversations ON ai_conversations(business_id, user_id);

CREATE TABLE ai_messages (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user','assistant','system')),
  content TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'fallback',
  provider TEXT NOT NULL DEFAULT 'none',
  citations TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_ai_messages ON ai_messages(conversation_id, created_at);

CREATE TABLE ai_saved_plans (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'PLAN',
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'DRAFT',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_ai_plans ON ai_saved_plans(business_id);

CREATE TABLE ai_feedback (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  helpful INTEGER NOT NULL,
  comment TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE ai_research_cache (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  query_hash TEXT NOT NULL,
  query TEXT NOT NULL,
  provider TEXT NOT NULL,
  sources TEXT NOT NULL DEFAULT '[]',
  fetched_at TEXT NOT NULL,
  accessed_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  UNIQUE (business_id, query_hash)
);

CREATE TABLE ai_usage (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  mode TEXT NOT NULL,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_ai_usage ON ai_usage(business_id, created_at);
  `,
  },
  {
    version: 6,
    name: 'business_settings_and_indexes',
    sql: `
CREATE TABLE business_settings (
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (business_id, key)
);

CREATE TABLE number_sequences (
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  next_value INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (business_id, kind)
);

-- One explicit conversion per unit pair per business (a second, different
-- factor for the same pair would be ambiguous at the point of conversion).
CREATE UNIQUE INDEX idx_explicit_conversion_pair ON explicit_conversions(business_id, from_unit, to_unit);
  `,
  },
];

export class Database {
  readonly db: DatabaseSync;
  /** Nesting depth for `transaction()`, so nested calls join the outer one. */
  private depth = 0;

  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.db = new sqlite.DatabaseSync(file);
    this.db.exec('PRAGMA foreign_keys = ON;');
    if (file !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.migrate();
  }

  /** Apply any outstanding migrations, tracked with `PRAGMA user_version`. */
  migrate(): number {
    const current = (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version ?? 0;
    let applied = 0;
    for (const migration of MIGRATIONS) {
      if (migration.version <= current) continue;
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.db.exec(migration.sql);
        this.db.exec(`PRAGMA user_version = ${migration.version}`);
        this.db.exec('COMMIT');
        applied += 1;
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw new Error(`Migration ${migration.version} (${migration.name}) failed: ${(error as Error).message}`);
      }
    }
    return applied;
  }

  get schemaVersion(): number {
    return (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version ?? 0;
  }

  all<T = Record<string, unknown>>(sql: string, params: readonly unknown[] = []): T[] {
    return this.db.prepare(sql).all(...(params as never[])) as T[];
  }

  get<T = Record<string, unknown>>(sql: string, params: readonly unknown[] = []): T | undefined {
    return this.db.prepare(sql).get(...(params as never[])) as T | undefined;
  }

  run(sql: string, params: readonly unknown[] = []): { changes: number; lastInsertRowid: number | bigint } {
    const result = this.db.prepare(sql).run(...(params as never[]));
    return { changes: Number(result.changes), lastInsertRowid: result.lastInsertRowid };
  }

  /** Run a function inside an IMMEDIATE transaction. Re-entrant: a nested call
   * joins the outer transaction instead of trying to start a second one (which
   * SQLite refuses), so sync batches can reuse the same posting services. */
  transaction<T>(fn: () => T): T {
    if (this.depth > 0) {
      this.depth += 1;
      try {
        return fn();
      } finally {
        this.depth -= 1;
      }
    }
    this.db.exec('BEGIN IMMEDIATE');
    this.depth = 1;
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // The transaction may already be rolled back by SQLite.
      }
      throw error;
    } finally {
      this.depth = 0;
    }
  }

  close(): void {
    this.db.close();
  }
}

export function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || value === '') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

/**
 * A short, unique, human-friendly reference like `SAL-20260501-0007`.
 *
 * Implemented as one atomic upsert with RETURNING so it is safe to call from
 * inside an existing transaction (an offline sync batch, for example).
 */
export function nextReference(db: Database, businessId: string, kind: string, prefix: string, date: string): string {
  const compact = date.replace(/-/g, '');
  const key = `${kind}:${compact}`;
  const row = db.get<{ next_value: number }>(
    `INSERT INTO number_sequences (business_id, kind, next_value) VALUES (?, ?, 1)
     ON CONFLICT(business_id, kind) DO UPDATE SET next_value = number_sequences.next_value + 1
     RETURNING next_value`,
    [businessId, key],
  );
  const next = row?.next_value ?? 1;
  return `${prefix}-${compact}-${String(next).padStart(4, '0')}`;
}
