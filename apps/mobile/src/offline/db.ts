import * as SQLite from 'expo-sqlite';

/**
 * The on-device mirror database.
 *
 * Design rules (they are the whole point of this file):
 *
 *  1. **Money and quantity columns are TEXT**, exactly like the server. A
 *     SQLite `REAL` would silently reintroduce binary floating point, and the
 *     shared `@sbm/domain` `Decimal` type exists precisely so that 0.1 + 0.2 is
 *     0.3 on a cheap Android phone too. Nothing here is ever parsed with
 *     `Number()` for arithmetic.
 *
 *  2. **The mirror tables hold server-confirmed rows only.** Records the user
 *     creates while offline live in `outbox`, and are rendered as *local
 *     proposals* until the server acknowledges them. Storing an optimistic copy
 *     in `sales` as well would produce duplicates the moment the real row is
 *     pulled, and would let the UI label an unshared record as "posted".
 *
 *  3. **Every local mutation writes the record change and its outbox event in
 *     ONE transaction** (see `src/offline/outbox.ts`), so a crash can never
 *     leave a sale without its sync event or an event without its sale.
 *
 *  4. **`server_conflicts` mirrors the server's conflict inbox** so the conflict
 *     list is still visible with no connection.
 */

export interface Tx {
  runAsync(sql: string, params?: SQLite.SQLiteBindValue[]): Promise<SQLite.SQLiteRunResult>;
  getAllAsync<T>(sql: string, params?: SQLite.SQLiteBindValue[]): Promise<T[]>;
  getFirstAsync<T>(sql: string, params?: SQLite.SQLiteBindValue[]): Promise<T | null>;
  execAsync(sql: string): Promise<void>;
}

const DATABASE_NAME = 'sbm-mobile.db';

interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

// ---------------------------------------------------------------------------
// Migrations. Append only; never edit a released migration.
// ---------------------------------------------------------------------------

const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'mirror_core',
    sql: `
CREATE TABLE local_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE local_business (
  business_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'BDT',
  timezone TEXT NOT NULL DEFAULT 'Asia/Dhaka',
  locale TEXT NOT NULL DEFAULT 'en',
  farming_types TEXT NOT NULL DEFAULT '[]',
  revision INTEGER NOT NULL DEFAULT 1,
  synced_at TEXT NOT NULL
);

-- Catalog ---------------------------------------------------------------
CREATE TABLE locations (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'STORE',
  address TEXT,
  is_default INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT
);

CREATE TABLE products (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL,
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
  created_at TEXT,
  updated_at TEXT,
  deleted_at TEXT
);
CREATE INDEX idx_products_business ON products(business_id, is_active);

CREATE TABLE customers (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL,
  name TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  address TEXT,
  opening_balance TEXT NOT NULL DEFAULT '0',
  credit_limit TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT,
  updated_at TEXT
);
CREATE INDEX idx_customers_business ON customers(business_id);

CREATE TABLE suppliers (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL,
  name TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  address TEXT,
  opening_balance TEXT NOT NULL DEFAULT '0',
  is_active INTEGER NOT NULL DEFAULT 1,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT,
  updated_at TEXT
);
CREATE INDEX idx_suppliers_business ON suppliers(business_id);

-- Commerce --------------------------------------------------------------
CREATE TABLE sales (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL,
  reference TEXT,
  customer_id TEXT,
  document_date TEXT NOT NULL,
  currency TEXT NOT NULL,
  gross TEXT NOT NULL DEFAULT '0',
  discount TEXT NOT NULL DEFAULT '0',
  tax TEXT NOT NULL DEFAULT '0',
  net TEXT NOT NULL DEFAULT '0',
  cash_received TEXT NOT NULL DEFAULT '0',
  receivable TEXT NOT NULL DEFAULT '0',
  cogs TEXT NOT NULL DEFAULT '0',
  status TEXT NOT NULL DEFAULT 'POSTED',
  note TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  created_by TEXT,
  device_id TEXT,
  event_id TEXT,
  created_at TEXT,
  updated_at TEXT
);
CREATE INDEX idx_sales_date ON sales(business_id, document_date);

CREATE TABLE sale_lines (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL,
  sale_id TEXT NOT NULL,
  product_id TEXT,
  description TEXT,
  quantity TEXT NOT NULL DEFAULT '0',
  unit TEXT NOT NULL,
  unit_price TEXT NOT NULL DEFAULT '0',
  discount TEXT NOT NULL DEFAULT '0',
  tax TEXT NOT NULL DEFAULT '0',
  line_total TEXT NOT NULL DEFAULT '0',
  unit_cost TEXT NOT NULL DEFAULT '0',
  location_id TEXT,
  lot_id TEXT
);
CREATE INDEX idx_sale_lines ON sale_lines(sale_id);

CREATE TABLE purchases (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL,
  reference TEXT,
  supplier_id TEXT,
  document_date TEXT NOT NULL,
  currency TEXT NOT NULL,
  subtotal TEXT NOT NULL DEFAULT '0',
  discount TEXT NOT NULL DEFAULT '0',
  tax TEXT NOT NULL DEFAULT '0',
  total TEXT NOT NULL DEFAULT '0',
  paid TEXT NOT NULL DEFAULT '0',
  payable TEXT NOT NULL DEFAULT '0',
  status TEXT NOT NULL DEFAULT 'POSTED',
  note TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  created_by TEXT,
  device_id TEXT,
  event_id TEXT,
  created_at TEXT,
  updated_at TEXT
);
CREATE INDEX idx_purchases_date ON purchases(business_id, document_date);

CREATE TABLE purchase_lines (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL,
  purchase_id TEXT NOT NULL,
  product_id TEXT,
  description TEXT,
  quantity TEXT NOT NULL DEFAULT '0',
  unit TEXT NOT NULL,
  unit_cost TEXT NOT NULL DEFAULT '0',
  discount TEXT NOT NULL DEFAULT '0',
  tax TEXT NOT NULL DEFAULT '0',
  line_total TEXT NOT NULL DEFAULT '0',
  location_id TEXT,
  lot_no TEXT,
  expiry_date TEXT
);
CREATE INDEX idx_purchase_lines ON purchase_lines(purchase_id);

CREATE TABLE stock_movements (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  location_id TEXT,
  direction TEXT NOT NULL,
  quantity TEXT NOT NULL,
  unit TEXT NOT NULL,
  unit_cost TEXT NOT NULL DEFAULT '0',
  currency TEXT NOT NULL DEFAULT 'BDT',
  lot_id TEXT,
  expiry_date TEXT,
  source_type TEXT NOT NULL,
  source_id TEXT,
  actor_id TEXT,
  device_id TEXT,
  event_id TEXT,
  reversal_of TEXT,
  reason TEXT,
  occurred_at TEXT NOT NULL,
  created_at TEXT
);
CREATE INDEX idx_stock_item ON stock_movements(business_id, item_id, occurred_at);

CREATE TABLE journal_entries (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL,
  document_date TEXT NOT NULL,
  reference TEXT NOT NULL,
  description TEXT,
  source_type TEXT,
  source_id TEXT,
  currency TEXT NOT NULL,
  posted_by TEXT,
  device_id TEXT,
  event_id TEXT,
  reversal_of TEXT,
  created_at TEXT
);
CREATE INDEX idx_journal_date ON journal_entries(business_id, document_date);

CREATE TABLE journal_lines (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  account TEXT NOT NULL,
  debit TEXT NOT NULL DEFAULT '0',
  credit TEXT NOT NULL DEFAULT '0',
  currency TEXT NOT NULL,
  memo TEXT,
  partner_id TEXT,
  cost_center TEXT
);
CREATE INDEX idx_journal_lines_entry ON journal_lines(entry_id);

-- Farming ---------------------------------------------------------------
CREATE TABLE farms (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL,
  name TEXT NOT NULL,
  location_id TEXT,
  address TEXT,
  area TEXT,
  area_unit TEXT,
  latitude TEXT,
  longitude TEXT,
  notes TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT,
  updated_at TEXT
);
CREATE INDEX idx_farms_business ON farms(business_id);

CREATE TABLE farm_units (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL,
  farm_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  area TEXT,
  area_unit TEXT,
  capacity TEXT,
  capacity_unit TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT
);
CREATE INDEX idx_farm_units ON farm_units(farm_id);

CREATE TABLE production_cycles (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL,
  farm_id TEXT NOT NULL,
  unit_id TEXT NOT NULL,
  reference TEXT,
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
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  starting_population TEXT,
  notes TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT,
  updated_at TEXT
);
CREATE INDEX idx_cycles_business ON production_cycles(business_id, status);

CREATE TABLE farming_events (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL,
  cycle_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  occurred_on TEXT NOT NULL,
  quantity TEXT,
  unit TEXT,
  amount TEXT,
  currency TEXT,
  account_code TEXT,
  product_id TEXT,
  notes TEXT,
  actor_id TEXT,
  event_id TEXT,
  created_at TEXT
);
CREATE INDEX idx_farm_events ON farming_events(business_id, cycle_id, occurred_on);

CREATE TABLE harvests (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL,
  cycle_id TEXT NOT NULL,
  occurred_on TEXT NOT NULL,
  quantity TEXT NOT NULL DEFAULT '0',
  unit TEXT NOT NULL,
  product_id TEXT,
  location_id TEXT,
  lot_no TEXT,
  costing_method TEXT NOT NULL,
  cost_basis TEXT NOT NULL DEFAULT '0',
  unit_cost TEXT NOT NULL DEFAULT '0',
  currency TEXT NOT NULL,
  grade TEXT,
  notes TEXT,
  created_by TEXT,
  event_id TEXT,
  created_at TEXT
);
CREATE INDEX idx_harvests_cycle ON harvests(business_id, cycle_id, occurred_on);

CREATE TABLE cost_allocations (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL,
  cost_source_id TEXT NOT NULL,
  cycle_id TEXT NOT NULL,
  basis TEXT NOT NULL,
  basis_value TEXT NOT NULL DEFAULT '0',
  share_ratio TEXT NOT NULL DEFAULT '0',
  currency TEXT NOT NULL,
  amount TEXT NOT NULL DEFAULT '0',
  created_by TEXT,
  created_at TEXT
);
CREATE INDEX idx_cost_allocations ON cost_allocations(cost_source_id);

-- Sync bookkeeping ------------------------------------------------------
CREATE TABLE server_conflicts (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  event_id TEXT,
  device_id TEXT,
  base_revision INTEGER,
  server_revision INTEGER,
  differing_fields TEXT NOT NULL DEFAULT '[]',
  auto_mergeable INTEGER NOT NULL DEFAULT 0,
  detail TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'OPEN',
  created_at TEXT,
  resolved_at TEXT
);
CREATE INDEX idx_conflicts_status ON server_conflicts(business_id, status);
`,
  },
  {
    version: 2,
    name: 'outbox_and_attachments',
    sql: `
-- One row per business action performed on this device. The payload holds the
-- exact request body the server's sync service applies, with every money and
-- quantity value already serialised as an exact decimal string.
CREATE TABLE outbox (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  idempotency_key TEXT NOT NULL UNIQUE,
  business_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  schema_version INTEGER NOT NULL DEFAULT 1,
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  base_revision INTEGER,
  payload TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  risk TEXT NOT NULL DEFAULT 'HIGH',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  next_attempt_at TEXT,
  server_revision INTEGER,
  server_message TEXT,
  synced_at TEXT
);
CREATE INDEX idx_outbox_status ON outbox(business_id, status, created_at);
CREATE INDEX idx_outbox_aggregate ON outbox(aggregate_type, aggregate_id);

-- A human-readable summary of the proposal, so lists can render a pending sale
-- without re-deriving money from the raw sync payload.
CREATE TABLE outbox_preview (
  outbox_id TEXT PRIMARY KEY REFERENCES outbox(id) ON DELETE CASCADE,
  business_id TEXT NOT NULL,
  aggregate_type TEXT NOT NULL,
  title TEXT NOT NULL,
  subtitle TEXT,
  amount TEXT,
  currency TEXT,
  document_date TEXT
);
CREATE INDEX idx_outbox_preview_business ON outbox_preview(business_id, aggregate_type, document_date);

-- Photo uploads are queued separately ON PURPOSE. A receipt photo that fails to
-- upload must never roll back or duplicate the sale it belongs to: the business
-- transaction is already durable and idempotent on the server, and the image is
-- merely evidence attached to it. The queue is retried independently.
CREATE TABLE attachment_queue (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  local_uri TEXT NOT NULL,
  file_name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size_bytes INTEGER,
  status TEXT NOT NULL DEFAULT 'PENDING',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  uploaded_at TEXT
);
CREATE INDEX idx_attachment_queue ON attachment_queue(business_id, status);
`,
  },
];

// ---------------------------------------------------------------------------
// Connection + migration runner
// ---------------------------------------------------------------------------

let database: SQLite.SQLiteDatabase | null = null;
let opening: Promise<SQLite.SQLiteDatabase> | null = null;

export async function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (database) return database;
  if (!opening) {
    opening = (async () => {
      const db = await SQLite.openDatabaseAsync(DATABASE_NAME);
      await db.execAsync('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
      await migrate(db);
      database = db;
      return db;
    })();
  }
  return opening;
}

async function migrate(db: SQLite.SQLiteDatabase): Promise<void> {
  const row = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  let current = row?.user_version ?? 0;
  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;
    // `execAsync` runs the whole batch inside one SQLite transaction, so a
    // partial migration cannot be recorded.
    await db.execAsync(`BEGIN;\n${migration.sql}\nPRAGMA user_version = ${migration.version};\nCOMMIT;`);
    current = migration.version;
  }
}

/** Only for tests / "reset local data" in Settings. */
export async function resetDatabase(): Promise<void> {
  const db = await getDb();
  const tables = [
    'outbox_preview',
    'outbox',
    'attachment_queue',
    'server_conflicts',
    'cost_allocations',
    'harvests',
    'farming_events',
    'production_cycles',
    'farm_units',
    'farms',
    'journal_lines',
    'journal_entries',
    'stock_movements',
    'purchase_lines',
    'purchases',
    'sale_lines',
    'sales',
    'suppliers',
    'customers',
    'products',
    'locations',
    'local_business',
    'local_meta',
  ];
  for (const table of tables) await db.runAsync(`DELETE FROM ${table}`);
}

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

export async function all<T>(sql: string, params: SQLite.SQLiteBindValue[] = []): Promise<T[]> {
  const db = await getDb();
  return db.getAllAsync<T>(sql, params);
}

export async function first<T>(sql: string, params: SQLite.SQLiteBindValue[] = []): Promise<T | null> {
  const db = await getDb();
  return db.getFirstAsync<T>(sql, params);
}

export async function run(sql: string, params: SQLite.SQLiteBindValue[] = []): Promise<SQLite.SQLiteRunResult> {
  const db = await getDb();
  return db.runAsync(sql, params);
}

/**
 * Run `work` inside a real SQLite transaction with an exclusive lock, so two
 * concurrent sync passes (or a sync pass and a user tapping "Save") cannot
 * interleave and half-apply a change.
 *
 * `withExclusiveTransactionAsync` exists from expo-sqlite 14; the fallback keeps
 * older clients working with a plain deferred transaction.
 */
export async function withTransaction<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
  const db = await getDb();
  const candidate = db as unknown as {
    withExclusiveTransactionAsync?: (fn: (txn: Tx) => Promise<void>) => Promise<void>;
    withTransactionAsync?: (fn: () => Promise<void>) => Promise<void>;
  };

  let result: T | undefined;
  let finished = false;

  if (typeof candidate.withExclusiveTransactionAsync === 'function') {
    await candidate.withExclusiveTransactionAsync(async (txn) => {
      result = await work(txn);
      finished = true;
    });
  } else if (typeof candidate.withTransactionAsync === 'function') {
    await candidate.withTransactionAsync(async () => {
      result = await work(db as unknown as Tx);
      finished = true;
    });
  } else {
    throw new Error('expo-sqlite: this build exposes no transaction API');
  }

  if (!finished) throw new Error('Transaction rolled back');
  return result as T;
}

// ---------------------------------------------------------------------------
// local_meta helpers (sync cursor, device id, last error …)
// ---------------------------------------------------------------------------

export async function getMeta(key: string): Promise<string | null> {
  const row = await first<{ value: string }>('SELECT value FROM local_meta WHERE key = ?', [key]);
  return row?.value ?? null;
}

export async function setMeta(key: string, value: string): Promise<void> {
  await run(
    `INSERT INTO local_meta (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [key, value, new Date().toISOString()],
  );
}

export async function setMetaWithin(tx: Tx, key: string, value: string): Promise<void> {
  await tx.runAsync(
    `INSERT INTO local_meta (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [key, value, new Date().toISOString()],
  );
}

export const META_KEYS = {
  syncCursor: 'sync.cursor',
  lastSyncedAt: 'sync.lastSyncedAt',
  deviceId: 'device.id',
  activeBusinessId: 'business.active',
  lastSyncError: 'sync.lastError',
  outboxCreated: 'outbox.createdCount',
} as const;
