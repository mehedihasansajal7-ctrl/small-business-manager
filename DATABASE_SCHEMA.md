# DATABASE_SCHEMA.md

Source of truth: `apps/api/src/db.ts` → `MIGRATIONS` (versions 1–6) and
`Database.migrate()`. Applied migrations are tracked with SQLite's
`PRAGMA user_version`, each inside its own `BEGIN IMMEDIATE … COMMIT`, with
`ROLLBACK` on failure. `PRAGMA foreign_keys = ON` is set on every connection.
Verified live: `GET /api/health` returns `"schemaVersion":6`.

> **The `supabase/` directory does not exist.** The master prompt asks for a Postgres
> port under `supabase/migrations` + `supabase/seed.sql`; that work has **not been done**.
> §14 describes what the port must preserve and is a plan, not code. Do not look for
> `supabase/migrations` files — there are none.

---

## 1. Storage conventions

| Concern | Decision | Where |
|---|---|---|
| Decimals (money, quantities, rates) | `TEXT`, exact, e.g. `'4500.00'`, `'0.933105'` | every `*_price`, `amount`, `quantity`, `debit`, `credit`, `factor`, `basis_value`, `share_ratio` column |
| Booleans | `INTEGER` `0`/`1` (SQLite has no boolean) | `is_active`, `paid`, `shared`, `abnormal`, `auto_mergeable`, `track_lots`, `is_default` |
| JSON | `TEXT` holding a JSON string, read via `parseJson()` | `grants`, `denials`, `farming_types`, `enabled_modules`, `settings`, `detail`, `payload`, `citations`, `sources` |
| Dates | `TEXT` `YYYY-MM-DD` (business-local calendar date) | `document_date`, `occurred_on`, `start_date`, `expiry_date` |
| Timestamps | `TEXT` ISO-8601 UTC | `created_at`, `updated_at`, `occurred_at`, `expires_at` |
| Concurrency | integer `revision` bumped on update | `businesses`, `products`, `customers`, `suppliers`, `purchases`, `sales`, `production_cycles`, `cost_sources` |
| Optional unique name | partial-unique via `UNIQUE(business_id, reference)` | `purchases`, `sales`, `production_cycles` |

### 1.1 Why money is `TEXT` and never `REAL`

- **No float round-trip error.** `0.1 + 0.2 !== 0.3` in IEEE-754. Money must add up. The
  domain layer (`packages/domain/src/decimal.ts`) does all arithmetic as `bigint`
  scaled integers; the DB's only job is to store the exact decimal string and give it back
  unchanged. `'4500.00'` in → `'4500.00'` out, byte for byte.
- **`REAL`/`NUMERIC` in SQLite is a lottery.** SQLite's `NUMERIC` affinity converts a string
  that looks numeric into `INTEGER`/`REAL` on insert. `'0.1'` would become the float
  `0.1`, and the exactness guarantee would be lost at the storage boundary. `TEXT` affinity
  is the only affinity that guarantees no silent coercion.
- **It is the same guarantee Postgres needs.** Postgres `numeric` is exact; mapping to
  Postgres is therefore `TEXT → numeric` with **no** lossy float step in between. See §14.
- **`BigInt` never reaches JSON.** `http.ts`'s `jsonReplacer` converts any stray `bigint`
  to a string, and `Decimal.toJSON()` returns a string, so API responses carry exact
  decimal strings.

`INTEGER` columns are only ever genuinely integral values (counts, flags, revisions,
byte sizes, token counts). No `INTEGER` column stores money.

---

## 2. Migration 1 — `core_identity_tenancy`

### `users`
| Column | Type | Constraints |
|---|---|---|
| `id` | TEXT | **PK** |
| `email` | TEXT | NOT NULL, **UNIQUE** |
| `display_name` | TEXT | NOT NULL |
| `password_hash` | TEXT | NOT NULL — scrypt, 64 bytes hex |
| `password_salt` | TEXT | NOT NULL — 16 random bytes hex |
| `locale` | TEXT | NOT NULL DEFAULT `'bn-BD'` |
| `is_active` | INTEGER | NOT NULL DEFAULT 1 |
| `created_at` | TEXT | NOT NULL |
| `last_login_at` | TEXT | nullable |

*Why:* one row per human. Email is the login identity and is normalised
(`normalizeEmail`) before every read/write. **No password is ever stored — only a scrypt
hash + per-user salt.** `is_active=0` is a soft block that `authenticate()` respects.

### `sessions`
| Column | Type | Constraints |
|---|---|---|
| `id` | TEXT | **PK** (a UUID; the cookie value is `id` + HMAC, not the id itself) |
| `user_id` | TEXT | NOT NULL → `users(id)` ON DELETE CASCADE |
| `business_id` | TEXT | → `businesses(id)` ON DELETE SET NULL — the *active* workspace |
| `created_at` / `expires_at` / `last_seen_at` | TEXT | NOT NULL |
| `user_agent` | TEXT | nullable |

Indexes: `idx_sessions_user`, `idx_sessions_expiry`.
*Why:* server-side revocable sessions (a signed cookie alone cannot be revoked).
`business_id` here is what makes "switch business" a session property rather than a client
claim, so a tampered client cannot address another workspace.

### `businesses`
| Column | Type | Constraints |
|---|---|---|
| `id` | TEXT | **PK** |
| `name` | TEXT | NOT NULL |
| `slug` | TEXT | NOT NULL, **UNIQUE** (auto-suffixed `-2`, `-3`…) |
| `currency` | TEXT | NOT NULL DEFAULT `'BDT'` |
| `timezone` | TEXT | NOT NULL DEFAULT `'Asia/Dhaka'` |
| `locale` | TEXT | NOT NULL DEFAULT `'bn-BD'` |
| `country` | TEXT | NOT NULL DEFAULT `'BD'` |
| `farming_types` | TEXT | NOT NULL DEFAULT `'[]'` (JSON) |
| `enabled_modules` | TEXT | NOT NULL DEFAULT `'[]'` (JSON) |
| `settings` | TEXT | NOT NULL DEFAULT `'{}'` (JSON; superseded by `business_settings`) |
| `plan` | TEXT | NOT NULL DEFAULT `'free'` |
| `revision` | INTEGER | NOT NULL DEFAULT 1 |
| `created_at` | TEXT | NOT NULL |
| `created_by` | TEXT | NOT NULL (`users.id`, no FK) |

*Why:* the tenant root. `revision` is the **sync watermark** — `SyncService.nextRevision()`
increments it on every applied sync event, and `pull()` returns it as
`businessRevision`, giving a device a single monotonic cursor.
`farming_types` is auto-populated the first time a cycle of a given type is created, so the
Farming module can hide/show per business.

### `members`
| Column | Type | Constraints |
|---|---|---|
| `id` | TEXT | **PK** |
| `business_id` | TEXT | NOT NULL → `businesses(id)` CASCADE |
| `user_id` | TEXT | NOT NULL → `users(id)` CASCADE |
| `email`, `display_name` | TEXT | NOT NULL (denormalised for display + audit) |
| `role` | TEXT | NOT NULL (`owner`\|`admin`\|`manager`\|`cashier`\|`inventory_manager`\|`farm_manager`\|`viewer`) |
| `status` | TEXT | NOT NULL DEFAULT `'active'` (`active`\|`invited`\|`suspended`\|`removed`) |
| `grants` / `denials` | TEXT | NOT NULL DEFAULT `'[]'` (JSON permission arrays) |
| `joined_at` | TEXT | NOT NULL |
| `invited_by` | TEXT | nullable |
| `last_active_at` | TEXT | nullable |

**`UNIQUE (business_id, user_id)`** — one membership per user per business, which is what
stops a duplicate join from an invite replay. Indexes: `idx_members_business`,
`idx_members_user`.
*Why `grants`/`denials`:* per-member overrides on top of the role. Applied as
"grants first, then denials", so a **denial always wins**.

### `invites`
| Column | Type | Constraints |
|---|---|---|
| `id` | TEXT | **PK** |
| `business_id` | TEXT | NOT NULL → `businesses(id)` CASCADE |
| `email` | TEXT | nullable — when set, the invite is bound to that email |
| `role` | TEXT | NOT NULL |
| `code_hash` | TEXT | NOT NULL, **UNIQUE** — SHA-256 of the normalised code |
| `code_prefix` | TEXT | NOT NULL — first 4 chars, shown to the owner |
| `status` | TEXT | NOT NULL DEFAULT `'open'` (`open`\|`accepted`\|`expired`\|`revoked`) |
| `created_at` / `expires_at` | TEXT | NOT NULL |
| `created_by` | TEXT | NOT NULL |
| `accepted_at` / `accepted_by` | TEXT | nullable |
| `use_count` / `max_uses` | INTEGER | NOT NULL DEFAULT 0 / 1 |

Index: `idx_invites_business`. **`code_hash` UNIQUE** also gives an index for O(1)
redemption lookup on the raw code without ever storing the code.
*Why:* single-use (`max_uses=1`), time-boxed (`expires_at`), optionally email-scoped, and
revocable — all enforced server-side and atomically (see SECURITY.md §4).

### `devices`
| Column | Type | Constraints |
|---|---|---|
| `id` | TEXT | **PK** |
| `business_id` | TEXT | NOT NULL → `businesses(id)` CASCADE |
| `user_id` | TEXT | NOT NULL → `users(id)` CASCADE |
| `name` | TEXT | NOT NULL |
| `platform` | TEXT | NOT NULL DEFAULT `'web'` |
| `created_at` / `last_seen_at` | TEXT | NOT NULL |
| | | **UNIQUE (business_id, user_id, id)** |

*Why:* gives offline events a stable origin identity for conflict reporting. No endpoint
registers devices yet — the sync `push` accepts a `deviceId` in the event and stores it on
`stock_movements`/`sales` — so this table is currently **declared but unused**.

### `audit_logs`
| Column | Type | Constraints |
|---|---|---|
| `id` | TEXT | **PK** |
| `business_id` | TEXT | → `businesses(id)` CASCADE (nullable: pre-business events allow NULL) |
| `actor_id`, `actor_email` | TEXT | nullable |
| `action` | TEXT | NOT NULL (e.g. `sale.post`, `member.update`, `backup.export`) |
| `entity_type`, `entity_id` | TEXT | NOT NULL / nullable |
| `detail` | TEXT | NOT NULL DEFAULT `'{}'` (JSON) |
| `device_id` | TEXT | nullable |
| `created_at` | TEXT | NOT NULL |

Index: `idx_audit_business_time (business_id, created_at)`.
*Why:* the audit trail demanded for sensitive actions. It is **write-only from the app**
(read through `GET /api/audit` for `audit.view`) and there is no endpoint that updates or
deletes a row.

---

## 3. Migration 2 — `catalog_inventory`

### `locations` — `id` PK; `business_id` → businesses CASCADE; `name` NOT NULL; `kind` DEFAULT `'STORE'`; `address`; `is_default` DEFAULT 0; `is_active` DEFAULT 1; `created_at`. Index `idx_locations_business`.
*Why:* stock must live *somewhere*. `createBusiness()` inserts a default `Main Store`
so the very first purchase is possible with no setup. `defaultLocationId()` picks
`is_default DESC, created_at LIMIT 1` and returns `400 NO_LOCATION` if none exists.

### `product_categories` — `id` PK; `business_id` → businesses CASCADE; `name`; `parent_id`; `created_at`.
*Why:* hierarchy support. **Currently only the table and `products.category_id` exist — no
endpoint creates or lists categories.** Honest status: declared, unused.

### `products`
| Column | Notes |
|---|---|
| `id` PK | |
| `business_id` | NOT NULL → businesses CASCADE |
| `sku`, `name` NOT NULL, `name_bn` | `name_bn` carries the Bangla product name |
| `category_id` | no FK (soft link) |
| `kind` | `PRODUCT`\|`SERVICE`\|`INPUT`\|`OUTPUT`\|`LIVESTOCK`, DEFAULT `PRODUCT` |
| `unit` | NOT NULL, must exist in the `UnitRegistry` |
| `sale_price`, `purchase_price`, `tax_rate`, `reorder_level` | TEXT, nullable |
| `track_lots` | INTEGER DEFAULT 0 |
| `is_active` | INTEGER DEFAULT 1 |
| `revision` | INTEGER DEFAULT 1 — conflict detection |
| `created_at`, `updated_at` NOT NULL, `deleted_at` nullable | |

Index `idx_products_business (business_id, is_active)`. Repository queries additionally
filter `deleted_at IS NULL`.
*Why `kind`:* one catalog serves retail goods, farming inputs, finished farm output and
livestock. `SERVICE` items are excluded from stock movements and COGS. `revision` is the
only master-data revision the sync conflict path actually checks (see SYNC_DESIGN.md).

### `explicit_conversions`
`id` PK; `business_id`; `from_unit`, `to_unit`, `factor` TEXT, `note` NOT NULL,
`item_id` nullable, `approved_by` NOT NULL, `created_at`.
*Why:* kilograms and litres must **not** be silently interchangeable. Cross-dimension
conversions ("1 bag of urea = 50 kg") require an explicitly registered, documented, approved
row; the domain's `UnitRegistry` refuses a cross-dimension conversion with no registered
note. `item_id` scopes a conversion to one product.

### `customers` / `suppliers`
Both: `id` PK; `business_id`; `name` NOT NULL; `phone`; `email`; `address`;
`opening_balance` TEXT DEFAULT `'0'`; `is_active` DEFAULT 1; `revision` DEFAULT 1;
`created_at`, `updated_at`. Index on `business_id`. `customers` additionally has
`credit_limit`.
*Why:* the counterparty for `sales.customer_id` / `purchases.supplier_id`. Balances are
**derived**, not stored: `receivableFor()` = Σ(sale.net − sale.cash_received) −
Σ(CUSTOMER_RECEIPT payments); `payableFor()` = Σ(purchase.payable) − Σ(SUPPLIER_PAYMENT
payments). Storing a running balance would be a second source of truth that can drift.
`opening_balance` is stored but **not** yet folded into those derivations (a known gap).

### `stock_lots`
`id` PK; `business_id`; `item_id` → products CASCADE; `location_id` → locations CASCADE;
`lot_no`; `unit_cost` TEXT NOT NULL; `currency` TEXT NOT NULL; `received_at` NOT NULL;
`expiry_date`; `created_at`. Index `idx_lots_item (business_id, item_id)`.
*Why:* FEFO/FIFO lot selection and expiry alerts for feed, medicine and food. Created only
when a purchase line carries a `lotNo` and the product has `track_lots = 1`.

### `stock_movements` — the inventory ledger
| Column | Notes |
|---|---|
| `id` PK | |
| `business_id`, `item_id` → products CASCADE, `location_id` → locations CASCADE | |
| `direction` | NOT NULL, **`CHECK (direction IN ('IN','OUT'))`** |
| `quantity` | TEXT NOT NULL — always positive; direction carries the sign |
| `unit`, `unit_cost` TEXT, `currency` | the **cost snapshot** at movement time |
| `lot_id` → `stock_lots(id)` ON DELETE **SET NULL** | losing a lot must not lose the movement |
| `expiry_date` | |
| `source_type` | `OPENING`\|`PURCHASE`\|`SALE`\|`SALE_RETURN`\|`PURCHASE_RETURN`\|`TRANSFER_OUT`\|`TRANSFER_IN`\|`ADJUSTMENT`\|`COUNT_CORRECTION`\|`INPUT_ISSUE`\|`HARVEST`\|`OUTPUT_SALE`\|`MORTALITY_LOSS`\|`SPOILAGE`\|`INTERNAL_USE`\|`REVERSAL` |
| `source_id` | the document/event reference (e.g. `SAL-20260405-0001`) |
| `actor_id`, `device_id` | who and from where |
| `event_id` | NOT NULL **UNIQUE** |
| `idempotency_key` | NOT NULL **UNIQUE** — the anti-duplication guarantee |
| `reversal_of` | points at the reversed movement |
| `reason` | mandatory for adjustments/overrides |
| `occurred_at`, `created_at` | NOT NULL |

Indexes: `idx_stock_item (business_id, item_id, occurred_at)`,
`idx_stock_source (business_id, source_type, source_id)`.
*Why:* the single, append-only source of stock truth shared by retail and farming —
`stockBalance()` is always *derived*. The two `UNIQUE` constraints are what make a retried
sync event physically unable to double-post a movement.

---

## 4. Migration 3 — `commerce_finance`

### `financial_accounts` — `id` PK; `business_id`; `code` NOT NULL; `name` NOT NULL;
`name_bn`; `kind` NOT NULL DEFAULT `'CASH'` **`CHECK IN ('CASH','BANK','MFS')`**;
`account_code` NOT NULL DEFAULT `'1000'` (the GL account it maps to); `identifier`
(e.g. a bank account no.); `opening_balance` DEFAULT `'0'`; `is_active`; `created_at`;
**`UNIQUE (business_id, code)`**.
*Why:* a business may have several bank/MFS accounts, each mapping to a GL account
(1000/1010/1020). **Declared but unused by any endpoint today** — the API takes a raw
`accountCode` on each posting. Honest status: table only.

### `purchases`
`id` PK; `business_id`; `reference` NOT NULL; `supplier_id` → suppliers **SET NULL**;
`document_date` NOT NULL; `currency`; `subtotal`; `discount` DEFAULT `'0'`; `tax`
DEFAULT `'0'`; `total`; `paid` DEFAULT `'0'`; `payable` DEFAULT `'0'`; `status`
DEFAULT `'POSTED'`; `note`; `revision` DEFAULT 1; `created_by`; `device_id`;
`event_id` NOT NULL **UNIQUE**; `created_at`, `updated_at` NOT NULL;
**`UNIQUE (business_id, reference)`**. Index `idx_purchases_date`.

### `purchase_lines`
`id` PK; `business_id`; `purchase_id` → purchases CASCADE; `product_id` → products
**SET NULL**; `description`; `quantity`, `unit`, `unit_cost`, `discount` DEFAULT `'0'`,
`tax` DEFAULT `'0'`, `line_total` (all TEXT); `location_id`; `lot_no`; `expiry_date`.
Index `idx_purchase_lines (purchase_id)`. `business_id` is denormalised here too, so every
tenant query can filter on one column without a join.

### `sales`
`id` PK; `business_id`; `reference`; `customer_id` → customers **SET NULL**;
`document_date`; `currency`; `gross`; `discount` DEFAULT `'0'`; `tax` DEFAULT `'0'`;
`net`; `cash_received` DEFAULT `'0'`; `receivable` DEFAULT `'0'`; `cogs` DEFAULT `'0'`;
`status` DEFAULT `'POSTED'`; `note`; `revision`; `created_by`; `device_id`;
`event_id` UNIQUE; `created_at`, `updated_at`; **`UNIQUE (business_id, reference)`**.
Index `idx_sales_date`.

### `sale_lines`
`id` PK; `business_id`; `sale_id` → sales CASCADE; `product_id` → products SET NULL;
`description`; `quantity`, `unit`, `unit_price`, `discount`, `tax`, `line_total`,
**`unit_cost` DEFAULT `'0'`**, `location_id`, `lot_id`. Index `idx_sale_lines (sale_id)`.
*Why `sale_lines.unit_cost` exists:* it stores the COGS cost layer **as sold**, so a later
purchase cannot retroactively change an already-reported margin, and
`cycleSales()`/`cycleProfit` can attribute revenue and COGS to a production cycle through
the harvested product.

### `payments`
`id` PK; `business_id`; `kind` NOT NULL (`CUSTOMER_RECEIPT`\|`SUPPLIER_PAYMENT`);
`party_type` NOT NULL (`CUSTOMER`\|`SUPPLIER`); `party_id`; `document_date`; `currency`;
`amount`; `account_code` DEFAULT `'1000'`; `reference` NOT NULL; `note`; `created_by`;
`device_id`; `event_id` UNIQUE; `created_at`. Index `idx_payments_date`.
*Why one table for both directions:* a receipt and a payment have identical shape and
differ only in `kind`, which keeps the ledger queries simple. Neither carries a revenue or
expense leg (see ACCOUNTING_RULES.md §3.3–3.4).

### `account_transfers`
`id` PK; `business_id`; `document_date`; `currency`; `amount`; `from_account`;
`to_account`; `reference` NOT NULL; `note`; `created_by`; `event_id` UNIQUE; `created_at`.

### `income_expenses`
`id` PK; `business_id`; `kind` NOT NULL **`CHECK IN ('INCOME','EXPENSE')`**;
`category_account` NOT NULL; `document_date`; `currency`; `amount`;
`account_code` DEFAULT `'1000'`; `paid` INTEGER DEFAULT 1; `reference`; `note`;
`created_by`; `event_id` UNIQUE; `created_at`. Index `idx_income_expenses_date`.
*Why the `CHECK`:* the kind is a two-value domain and the DB enforces it, not just the API.

### `partner_capital`
`id` PK; `business_id`; `member_id` → members CASCADE; `kind` NOT NULL
**`CHECK IN ('CONTRIBUTION','WITHDRAWAL')`**; `document_date`; `currency`; `amount`;
`account_code` DEFAULT `'1000'`; `reference`; `note`; `created_by`; `event_id` UNIQUE;
`created_at`.
*Why a real FK to `members`:* capital belongs to a *member of this business*. The API
resolves the member against the caller's business and stamps `partnerId` on every journal
line, so partner balances are reportable per partner.

### `journal_entries`
`id` PK; `business_id`; `document_date` NOT NULL; `reference` NOT NULL;
`description` NOT NULL; `source_type` NOT NULL; `source_id` NOT NULL; `currency` NOT NULL;
`posted_by` NOT NULL; `device_id`; **`event_id` NOT NULL UNIQUE**; `reversal_of`;
`created_at`. Indexes `idx_journal_date`, `idx_journal_source (business_id, source_type,
source_id)`. *Why:* the header of the double entry. `event_id` UNIQUE is the idempotency
key for posting; `source_type`/`source_id` link every entry back to the business document
that caused it.

### `journal_lines`
`id` PK; `business_id`; `entry_id` → journal_entries **CASCADE**; `account` NOT NULL;
`debit` DEFAULT `'0'`; `credit` DEFAULT `'0'`; `currency` NOT NULL; `memo`;
`partner_id`; `cost_center`. Indexes `idx_journal_lines_entry`,
`idx_journal_lines_account (business_id, account)`.
*Why:* the lines are the ledger. `partner_id` is stored as a **display name**, not an FK,
which is a deliberate simplification (it survives a member row being removed) but means
partner reporting is by name, not id — documented limitation.

---

## 5. Migration 4 — `farming`

### `farms`
`id` PK; `business_id`; `name` NOT NULL; `location_id` → locations SET NULL; `address`;
`area`; `area_unit`; `latitude`; `longitude`; `notes`; `is_active`; `created_at`,
`updated_at`. Index `idx_farms_business`.
*Why:* a farm is the top of the farming hierarchy and can (but need not) double as a stock
location. Latitude/longitude are optional and **there is no location tracking in the app**
(no geolocation permission is requested) — a farmer may type coordinates.

### `farm_units`
`id` PK; `business_id`; `farm_id` → farms CASCADE; `kind` NOT NULL
(`PLOT`\|`FIELD`\|`GREENHOUSE`\|`BARN`\|`PEN`\|`POULTRY_HOUSE`\|`POND`\|`TANK`\|`OTHER`);
`name`; `area`, `area_unit`, `capacity`, `capacity_unit`; `is_active`; `created_at`.
Index `idx_farm_units (farm_id)`.
*Why:* one `farm_units` table with a `kind` discriminator covers crop plots, greenhouses,
cattle barns, poultry houses and fish ponds without five near-identical tables. Area and
capacity share the unit registry (bigha, katha, decimal…).

### `production_cycles`
`id` PK; `business_id`; `farm_id` → farms CASCADE; `unit_id` → farm_units CASCADE;
`reference` NOT NULL; `farming_type` NOT NULL
(`CROP`\|`HORTICULTURE`\|`LIVESTOCK`\|`POULTRY`\|`AQUACULTURE`); `title` NOT NULL;
`crop_or_species`; `variety_or_breed`; `season`; `responsible_member_id`;
`start_date` NOT NULL; `expected_end_date`; `actual_end_date`; `planned_output`;
`planned_output_unit`; `status` DEFAULT `'PLANNED'`
(`PLANNED`\|`ACTIVE`\|`HARVESTING`\|`CLOSED`\|`CANCELLED`); `starting_population`;
`notes`; `revision` DEFAULT 1; `created_at`, `updated_at`; **`UNIQUE (business_id,
reference)`**. Index `idx_cycles_business (business_id, status)`.
*Why:* the batch is the cost object. `planned_output` is required for
`PLANNED_YIELD_PRORATA` harvest costing; `starting_population` drives mortality %.
`revision` participates in sync conflict detection. The API creates cycles with
`status='ACTIVE'` (the `PLANNED` default is not used by any endpoint today).

### `farming_events` — the operational event log
`id` PK; `business_id`; `cycle_id` → production_cycles CASCADE; `event_type` NOT NULL;
`occurred_on` NOT NULL; `quantity`, `unit`, `amount`, `currency`, `account_code`,
`product_id`, `notes`; `payload` NOT NULL DEFAULT `'{}'`; `actor_id` NOT NULL;
`device_id`; **`event_id` NOT NULL UNIQUE**; `reversal_of`; `created_at`.
Index `idx_farm_events (business_id, cycle_id, occurred_on)`.
*Why:* a single journal of everything that happened on a batch — input issue, labour,
machinery, veterinary, utilities, packaging, transport, overhead, observation, mortality,
internal use, waste. Typed child tables (`observations`, `mortality_losses`, `harvests`)
carry the detail when it needs structure; the event row is the timeline entry. `event_id`
UNIQUE makes an event idempotent too.

### `cost_sources`
`id` PK; `business_id`; `cycle_id` → production_cycles CASCADE **nullable** (NULL = a
shared pool); `kind` NOT NULL; `currency`; `amount` NOT NULL; `shared` INTEGER DEFAULT 0;
`incurred_on` NOT NULL; `source_type` NOT NULL; `source_id` NOT NULL; `note`;
`allocated_at`; `revision` DEFAULT 1; `created_at`. Index `idx_cost_sources`.
*Why the `shared` + nullable `cycle_id` design:* a cost incurred for several cycles has no
single owner. It is stored **once** as a pool row (`shared=1`, `cycle_id=NULL`) and then
distributed into `cost_allocations`. This is precisely what prevents
"charged once per batch" double counting. `allocated_at` timestamps the distribution so an
unallocated pool cost remains visible.

### `cost_allocations`
`id` PK; `business_id`; `cost_source_id` → cost_sources CASCADE; `cycle_id` →
production_cycles CASCADE; `basis` NOT NULL; `basis_value`; `share_ratio`; `currency`;
`amount` NOT NULL; `created_by` NOT NULL; `created_at`. Index on `cost_source_id`.
*Why:* the audit trail of an allocation: which basis, what weight, what ratio, what amount,
who approved it. Because shares arrive from `Decimal.allocate()`, the sum of `amount` over a
`cost_source_id` equals that pool's amount to the poysha.

### `harvests`
`id` PK; `business_id`; `cycle_id` → production_cycles CASCADE; `occurred_on` NOT NULL;
`quantity` NOT NULL; `unit` NOT NULL; `product_id` → products SET NULL; `location_id`;
`lot_no`; `costing_method` NOT NULL (`PLANNED_YIELD_PRORATA`\|`CLOSING_REMAINDER`);
`cost_basis` NOT NULL; `unit_cost` NOT NULL; `currency`; `grade`; `notes`;
`created_by`; `device_id`; `event_id` UNIQUE; `created_at`.
Index `idx_harvests_cycle (business_id, cycle_id, occurred_on)`.
*Why:* partial harvests accumulate here. `harvestedQuantity()` sums this table to know what
has already been harvested and how much cost has already been released
(`assignedCostToDate`), which is what stops a second partial harvest re-releasing the same
cost. `product_id` is the **traceability link**: sales of that product are attributed back
to this cycle by `cycleSales()`.

### `observations`
`id` PK; `business_id`; `cycle_id` CASCADE; `observed_on`; `kind` NOT NULL; `value`;
`unit`; `notes`; `recorded_by`; `created_at`. Index `idx_observations`.
*Why:* growth/health samples (weight, water quality, plant height) that feed FCR, yield and
output-per-animal metrics without being financial records.

### `mortality_losses`
`id` PK; `business_id`; `cycle_id` CASCADE; `occurred_on`; `quantity` NOT NULL;
`unit` NOT NULL; `reason` NOT NULL; `book_value`; `currency`;
`abnormal` INTEGER DEFAULT 0; `recorded_by`; `created_at`.
*Why always a row, even for 1 bird:* mortality must be **visible and reason-coded**, not a
silent stock adjustment. `book_value` lets the loss be posted to `5400`; `abnormal` flags a
loss ≥ 25 units for escalation. There is no index on this table (it is read per cycle) —
acceptable at this scale, noted here for honesty.

---

## 6. Migration 5 — `sync_ai_attachments`

### `processed_events` — the exactly-once guarantee
| Column | Notes |
|---|---|
| `idempotency_key` | **PRIMARY KEY** |
| `business_id` | NOT NULL → businesses CASCADE |
| `event_id`, `event_type`, `aggregate_type`, `aggregate_id` | NOT NULL |
| `payload_hash` | NOT NULL |
| `server_revision` | INTEGER NOT NULL (0 for replayed/rejected/needs-attention) |
| `result` | NOT NULL DEFAULT `'{}'` (JSON of what was applied) |
| `processed_at` | NOT NULL |

Index `idx_processed_business (business_id, processed_at)`.
*Why:* the primary key **is** the mechanism. `SyncService.applyOne()` first does
`SELECT … WHERE idempotency_key = ?`; if a row exists the event is reported `SYNCED`
("Already applied earlier (idempotent replay)") and **nothing is applied again**. The API
test retries the identical event and asserts the stock balance is still 50 kg and there is
still exactly one sale.

### `sync_conflicts`
`id` PK; `business_id` CASCADE; `aggregate_type`, `aggregate_id`, `event_id` NOT NULL;
`device_id`, `actor_id`; `base_revision`; `server_revision` NOT NULL;
`differing_fields` NOT NULL DEFAULT `'[]'`; `auto_mergeable` INTEGER DEFAULT 0;
`detail` NOT NULL DEFAULT `'{}'`; `status` NOT NULL DEFAULT `'OPEN'`;
`created_at`, `resolved_at`, `resolved_by`. Index `idx_conflicts_business (business_id,
status)`.
*Why:* a divergence is never auto-resolved for money/stock. It is parked as an `OPEN` row
the user can see and resolve (`LOCAL_WINS`/`SERVER_WINS`), preserving who, which device and
which revisions were involved.

### `attachments`
`id` PK; `business_id` CASCADE; `entity_type`, `entity_id` NOT NULL; `file_name` NOT NULL;
`mime` NOT NULL; `size_bytes` INTEGER NOT NULL; `stored_path` NOT NULL; `checksum` NOT NULL
(SHA-256); `created_by`; `created_at`. Index `idx_attachments_entity`.
*Why:* metadata in SQL, bytes on disk under `DATA_DIR/attachments/<business_id>/`. The API
response says plainly: *"Attachments are stored on this server and are NOT shared with
partners who are offline."* The `checksum` allows later integrity verification.

### `ai_conversations`
`id` PK; `business_id` CASCADE; `user_id` → users CASCADE; `title` NOT NULL;
`language` DEFAULT `'bn'`; `context_scope` DEFAULT `'business'`; `created_at`, `updated_at`;
`deleted_at` (soft delete). Index `idx_ai_conversations (business_id, user_id)`.
*Why `user_id` as well as `business_id`:* a conversation is **private to the person**, so
one partner cannot read another partner's chat even inside the same business.

### `ai_messages`
`id` PK; `business_id` CASCADE; `conversation_id` → ai_conversations CASCADE;
`role` NOT NULL **`CHECK IN ('user','assistant','system')`**; `content` NOT NULL;
`mode` DEFAULT `'fallback'`; `provider` DEFAULT `'none'`; `citations` DEFAULT `'[]'`;
`created_at`. Index `idx_ai_messages (conversation_id, created_at)`.
*Why `mode`+`provider` on every message:* so a stored answer can always be labelled
"rule engine, not AI" retroactively, and no one mistakes offline rules for a model answer.

### `ai_saved_plans`
`id` PK; `business_id` CASCADE; `user_id` CASCADE; `kind` DEFAULT `'PLAN'`;
`title` NOT NULL; `content` NOT NULL; `status` DEFAULT `'DRAFT'`; `created_at`.
Index `idx_ai_plans`. *Why `status='DRAFT'`:* an AI plan is a suggestion until a human
confirms it.

### `ai_feedback`
`id` PK; `business_id`; `message_id` NOT NULL (no FK — feedback outlives edits);
`user_id`; `helpful` INTEGER NOT NULL; `comment`; `created_at`.

### `ai_research_cache`
`id` PK; `business_id` CASCADE; `query_hash` NOT NULL; `query` NOT NULL; `provider` NOT NULL;
`sources` NOT NULL DEFAULT `'[]'`; `fetched_at`, `accessed_at`, `expires_at` NOT NULL;
**`UNIQUE (business_id, query_hash)`**.
*Why:* a research query is cached per tenant with a TTL (`RESEARCH_CACHE_TTL_HOURS`,
default 168 h). The cache stores **citation metadata only** (title, publisher, URL, excerpt,
kind) — never a full third-party page — and is upserted on `(business_id, query_hash)`, so
repeated questions cost nothing.

### `ai_usage`
`id` PK; `business_id`; `user_id`; `provider`; `mode`; `tokens_in` INTEGER DEFAULT 0;
`tokens_out` INTEGER DEFAULT 0; `created_at`. Index `idx_ai_usage (business_id, created_at)`.
*Why:* usage visibility for the *user's own* free-tier budget, so a quota can be seen before
it is hit. Every `/api/ai/ask` writes one row.

---

## 7. Migration 6 — `business_settings_and_indexes`

### `business_settings`
`business_id` NOT NULL → businesses CASCADE; `key` NOT NULL; `value` NOT NULL (JSON);
`updated_at` NOT NULL; **`PRIMARY KEY (business_id, key)`**.
*Why key/value:* visibility toggles (`partnerCanSeeFinancialReports`,
`partnerCanSeeCosts`, `partnerCanSeeCapital`) plus (`lowStockAlerts`,
`mortalityWarningPercent`, `decimalPlaces`) — a small, owner-configurable set that should
grow without a migration each time. `settingsFor()` reads only the three visibility keys;
the endpoint whitelists all six keys it will accept. Upserted with
`ON CONFLICT(business_id, key) DO UPDATE`.

### `number_sequences`
`business_id` CASCADE; `kind` NOT NULL; `next_value` INTEGER NOT NULL DEFAULT 1;
**`PRIMARY KEY (business_id, kind)`**.
*Why:* human-readable references (`SAL-20260405-0001`). `nextReference()` does a single
atomic `INSERT … ON CONFLICT DO UPDATE … RETURNING next_value`, which is safe to call
**inside an existing transaction** (e.g. a sync batch) and cannot hand the same number to
two concurrent callers. The counter is keyed per business **and per day**
(`kind = "sale:20260405"`).

---

## 8. Tenant isolation in the schema

- **Every tenant table carries `business_id`**, including child tables such as
  `purchase_lines`, `sale_lines`, `journal_lines` — denormalised on purpose so no query
  needs a join to prove ownership, and so an accidental cross-tenant join cannot leak rows.
- FKs are declared on `business_id` → `businesses(id)` with `CASCADE`, so an orphaned row
  cannot exist.
- Enforcement is **in the repository layer**, not in SQL: every read/write takes a `Caller`
  (resolved by `Repository.caller(user, businessId)`, which throws `403` if there is no
  active membership) and filters by `caller.business.id`.
- `SyncService.pull()` and every report/export query include `WHERE business_id = ?` with
  the caller's business. `GET /api/reports/export/:table` uses a hard-coded **allowlist** of
  ten tables and never interpolates the table name.
- **Indexes exist for the tenant+date+status access patterns actually used**:
  `(business_id, document_date)` on sales/purchases/income_expenses,
  `(business_id, item_id, occurred_at)` on stock,
  `(business_id, status)` on cycles/conflicts,
  `(business_id, source_type, source_id)` on stock and journal.
- ⚠️ **RLS is NOT implemented** — SQLite has no row-level security, and the Postgres port
  that would carry `RLS` policies (`supabase/migrations`) does not exist yet. The current
  isolation guarantee is *application-level* (repository + caller), plus the process being
  single-tenant-per-deployment in local mode. See SECURITY.md §3 and §10 for what that
  does and does not buy.

## 9. Soft delete vs reversal — the explicit policy

| Record class | Policy | Implemented as |
|---|---|---|
| Master data (`products`) | soft delete / deactivate | `is_active = 0` (used) + `deleted_at` column (declared, **not set by any endpoint**) |
| Customers / suppliers | deactivate | `is_active = 0` (column exists; no endpoint toggles it yet) |
| Posted accounting (`journal_entries`, `journal_lines`) | **never** updated or deleted | `REVERSAL` entry instead |
| Posted stock (`stock_movements`) | **never** updated or deleted | `REVERSAL` movement or a reason-coded `ADJUSTMENT` |
| Posted commerce (`sales`, `purchases`, `payments`, …) | **never** deleted | no delete endpoint exists at all |
| Farming detail (`harvests`, `mortality_losses`, `cost_sources`) | **never** deleted | `reversal_of` column on the event/harvest for a reversing record |
| AI conversations | soft delete | `deleted_at` set by `DELETE /api/ai/conversations/:id` |
| Invites | status transition | `status = 'revoked'` |
| Members | status transition | `status = 'suspended'`/`'removed'` (+ sessions deleted) |

`ON DELETE CASCADE` is declared on parent→child FKs as a safety net, but **no application
code deletes a business or a posted document**, so no cascade fires in normal operation.

## 10. Known schema gaps (honest list)

| Gap | Impact |
|---|---|
| No `supabase/` migrations or `seed.sql` | shared/cloud mode is DESIGN-ONLY; `SBM_MODE=shared` validates config but there is no Postgres path to store anything |
| No RLS policies anywhere | if this schema is ever put behind a multi-tenant Postgres without adding RLS, the DB would rely entirely on app code |
| `devices`, `product_categories`, `financial_accounts` declared but unused | dead tables; either wire them up or drop them |
| `customers.opening_balance` / `suppliers.opening_balance` stored but not in the balance derivations | an opening balance will not appear in receivables/payables |
| `farms.latitude/longitude` unused | no map, no geo features |
| `businesses.settings` JSON column superseded by `business_settings` | two places could hold settings; only `business_settings` is read |
| `attachments` has no delete/verify endpoint and no virus/content-type validation beyond what the upload path does | metadata accumulates |
| No `mortality_losses` index | fine at small scale, slow if a cycle has tens of thousands of loss rows |
| `journal_lines.partner_id` is a display name, not an FK | partner reporting is by name; a renamed member splits history |

---

## 11. Postgres port (planned, not built)

Nothing in `supabase/` exists. If you build it, these mappings **must** hold, or the
correctness guarantees documented above are lost:

| SQLite here | Postgres must be |
|---|---|
| `TEXT` decimals (`'4500.00'`) | `numeric(20,6)` — **exact**, never `double precision`/`real` |
| `INTEGER` 0/1 booleans | `boolean` |
| ISO `TEXT` dates | `date`; ISO `TEXT` timestamps | `timestamptz` (store UTC) |
| JSON `TEXT` | `jsonb` |
| `PRAGMA user_version` migration tracking | a `schema_migrations (version, name, applied_at)` table |
| `event_id UNIQUE` / `idempotency_key UNIQUE` | keep both unique constraints — they are the anti-duplicate guarantee |
| `UNIQUE (business_id, reference)` | keep |
| `nextReference()` upsert with `RETURNING` | `INSERT … ON CONFLICT … DO UPDATE … RETURNING` (identical semantics) |
| app-level tenant filter | app-level filter **plus RLS policies on every tenant table**, with `business_id` matched against a membership check |
| domain `Decimal` (bigint-scaled) | unchanged — only the storage type changes |

The `Repository` class is the seam: it is the only place that holds SQL. A Postgres
implementation of the same methods, plus an adapter, is the intended boundary — but that
code does not exist today.
