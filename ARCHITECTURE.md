# ARCHITECTURE.md

## 1. Repository layout â€” as it exists today

```
small-business-manager/
â”œâ”€â”€ package.json              npm workspaces root (packages/*, apps/api, apps/web, supabase)
â”œâ”€â”€ tsconfig.base.json        strict, ES2022, NodeNext, isolatedModules
â”œâ”€â”€ .env.example              every setting, placeholders only
â”œâ”€â”€ README.md  TASKS.md  MASTER_PROMPT.md  IMPLEMENTATION_PLAN.md
â”œâ”€â”€ ARCHITECTURE.md  DATABASE_SCHEMA.md  SYNC_DESIGN.md  SECURITY.md
â”œâ”€â”€ TESTING.md  DEPLOYMENT_FREE.md  ACCOUNTING_RULES.md  AI_AGENT_DESIGN.md
â”œâ”€â”€ packages/
â”‚   â””â”€â”€ domain/               @sbm/domain â€” PURE logic, zero deps, zero I/O
â”‚       â”œâ”€â”€ src/  decimal Â· money Â· units Â· inventory Â· accounting Â· farming
â”‚       â”‚          permissions Â· sync Â· tenancy Â· validation Â· hash Â· index
â”‚       â””â”€â”€ test/ 10 files, 148 tests
â”œâ”€â”€ apps/
â”‚   â”œâ”€â”€ api/                  @sbm/api â€” the server (the only thing that touches a DB)
â”‚   â”‚   â”œâ”€â”€ src/  config Â· db Â· http Â· auth Â· repository Â· sync Â· ai Â· routes Â· print Â· server Â· seed
â”‚   â”‚   â”œâ”€â”€ test/ api.test.ts (55) Â· security.test.ts (12) Â· http.test.ts (20)
â”‚   â”‚   â””â”€â”€ data/ runtime (gitignored): sbm.db, backups/, attachments/, .session_secret
â”‚   â”œâ”€â”€ web/                  @sbm/web â€” Vite + React SPA/PWA  [code complete; builds; never
â”‚   â”‚                           opened in a browser here]  screens/ Â· components/ Â· offline/ Â·
â”‚   â”‚                           api/ Â· i18n/ Â· state/ Â· theme/ Â· public/{manifest,sw.js}
â”‚   â””â”€â”€ mobile/               @sbm/mobile â€” Expo/React Native [code complete; NO APK built,
â”‚                               never run on a device]  screens/ (41) Â· navigation/ Â·
â”‚                               offline/ (SQLite) Â· components/ Â· i18n/ Â· auth/
â”œâ”€â”€ supabase/                 @sbm/supabase â€” PostgreSQL/Supabase port: migrations 0001â€“0007,
â”‚                               functions 0000â€“0180 (9 posting RPCs), seed.sql, static tests
â””â”€â”€ docs/                     ROADMAP Â· FREE_TIER_LIMITS Â· PARTNER_GUIDE_BN Â· DECISIONS
```

**Not present, do not look for it:** `packages/ui`, `packages/data`, `packages/offline`,
`packages/accounting`, `packages/farming`, `packages/config`. The master prompt sketches that
split; this implementation deliberately collapsed those five packages into **one**
`packages/domain`, because they are mutually dependent (accounting needs money and inventory;
farming needs money, inventory and accounting) and splitting them would have produced circular
workspace dependencies for no isolation benefit. That is a recorded decision â€” see
`docs/DECISIONS.md` ADR-008.

`apps/mobile` is **not** in the root `workspaces` array on purpose: the Expo dependency tree
is large and installing it must be an explicit, opt-in step (`npm install` in
`apps/mobile/`). `apps/web` **is** a workspace.

---

## 2. The one architectural rule: the domain package is pure

`packages/domain` is **framework-free, I/O-free, dependency-free, and isomorphic**.

- `packages/domain/package.json` has **no `dependencies` and no `devDependencies` of its
  own** beyond the workspace's TypeScript/vitest. `npm ls` for it shows nothing.
- It imports nothing from `node:*`. The one platform capability it needs is Web Crypto
  (`crypto.randomUUID`, `crypto.getRandomValues`) and `TextEncoder` â€” available in Node â‰¥ 19,
  in browsers, and polyfilled on Hermes. SHA-256 is implemented **by hand**
  (`packages/domain/src/hash.ts`) specifically so the same payload hash is computed on a
  phone, in a browser tab and on the server.
- No class in it performs I/O: no `fetch`, no `fs`, no database, no clock beyond
  `new Date().toISOString()` for timestamps.

### Why that matters (not purity for its own sake)

1. **Money must be computed *identically* everywhere.** `0.1 + 0.2` is only guaranteed to
   equal `0.3` because both the phone and the server are running the same `bigint`-based
   `Decimal`. If each platform had its own money code, two devices could disagree about an
   invoice total by one poysha and the sync conflict would be unresolvable.
2. **The same validation must gate both sides.** `checkStockImpact()` runs on the device
   (to warn immediately) *and* on the server (to enforce). If it were duplicated, one copy
   would drift.
3. **Accounting and costing are testable without a database.** 148 tests run in 4.4 seconds
   with no fixtures, no server and no fixtures-per-test setup â€” because the logic takes plain
   data in and returns plain data out.
4. **A pricing/tax/permission rule change is one edit** that lands on web, Android and server
   simultaneously.

The trade-off: the domain cannot do anything itself, so every call site must pass data in.
That is the intended shape.

---

## 3. Layering and module boundaries

```
â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”
â”‚  clients                                                                     â”‚
â”‚   apps/web (React/Vite PWA)               apps/mobile (Expo/React Native)     â”‚
â”‚   â€¢ local store (IndexedDB)               â€¢ local store (SQLite)             â”‚
â”‚   â€¢ outbox + sync worker                  â€¢ outbox + sync worker             â”‚
â”‚   â€¢ imports @sbm/domain for money/rules   â€¢ imports @sbm/domain for rules    â”‚
â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”¬â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”¬â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜
                â”‚  HTTPS, JSON, session cookie                 â”‚
                â–¼                                              â–¼
â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”
â”‚  apps/api   (Node http, zero runtime dependencies)                           â”‚
â”‚                                                                              â”‚
â”‚  routes.ts      HTTP surface: path+method â†’ handler, cookie/session,          â”‚
â”‚                 rate limiters, permission-gated handlers                     â”‚
â”‚      â”‚                                                                       â”‚
â”‚  http.ts        Router Â· HttpError Â· cookie (de)serialisation Â· RateLimiter   â”‚
â”‚                 Â· strict body readers (1 MB JSON / 5 MB upload) Â· validators  â”‚
â”‚      â”‚                                                                       â”‚
â”‚  auth.ts        scrypt hashing Â· HMAC-signed session cookie Â· sessions table  â”‚
â”‚      â”‚                                                                       â”‚
â”‚  repository.ts  THE ONLY SQL. Every method takes a `Caller` and filters by    â”‚
â”‚                 business_id. Posting services (sale/purchase/receipt/         â”‚
â”‚                 payment/transfer/income/journal/farming/harvest/allocation)   â”‚
â”‚                 + report builders. Reads the domain package for all maths.    â”‚
â”‚      â”‚                                                                       â”‚
â”‚  sync.ts        SyncService: push (idempotent, transactional, conflict-aware) â”‚
â”‚                 Â· pull (incremental, business-scoped) Â· conflict resolution   â”‚
â”‚      â”‚                                                                       â”‚
â”‚  ai.ts          AIAgent: provider abstraction, permission-scoped context,     â”‚
â”‚                 curated links, citation validation, caching, rate limits      â”‚
â”‚      â”‚                                                                       â”‚
â”‚  db.ts          MIGRATIONS v1..v6 Â· Database (transaction, migrate) Â·         â”‚
â”‚                 nextReference (atomic per-business-per-day counter)           â”‚
â”‚      â”‚                                                                       â”‚
â”‚  config.ts      env loading + validation, local vs shared mode, secret handlingâ”‚
â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”¬â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜
                â”‚
                â–¼
â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”
â”‚  storage                                                                     â”‚
â”‚   local mode  : node:sqlite embedded file at $DATA_DIR/sbm.db  (zero creds)   â”‚
â”‚   shared mode : DESIGN ONLY â€” no Postgres adapter exists today                â”‚
â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜

              â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”
              â”‚  packages/domain  (pure, isomorphic, zero-dep)â”‚
              â”‚  consumed by web, mobile AND apps/api         â”‚
              â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜
```

### Boundary rules actually observed

| Boundary | Rule |
|---|---|
| domain â†” everything | the domain **never** imports an app. Everything else imports the domain |
| routes â†” repository | routes do **not** contain SQL. Every DB access goes through a `Repository` method (the single exception is a handful of inline report/export queries inside `routes.ts`, e.g. the purchase/sale list projections â€” a known inconsistency, noted below) |
| repository â†” domain | the repository converts rows â†’ domain objects (`toDomainMovements`, `money(...)`, `dec(...)`), calls pure functions, and writes the *results* back. All arithmetic lives in the domain |
| sync â†” repository | `SyncService` **reuses** the repository's posting methods. There is no second, weaker offline path |
| ai â†” repository | `AIAgent` only **reads** through the repository and only writes its own five tables |
| clients â†” API | JSON + a session cookie. Types are not shared through the network (no codegen); the payload shapes are the same objects the repository validates |

### Known boundary violations (honest)

- `routes.ts` contains inline SQL for: the purchases/sales list projections, the `/api/accounts`
  balance aggregation, `/api/farming/events`, and the export allowlist. The `/api/accounts`
  handler also aggregates using `toNumber()` (a float) purely for **display** formatting of the
  chart of accounts â€” the authoritative figures elsewhere are exact.
- `routes.ts` imports `describeConfig` from `config.ts` and `toCsv` is defined in `routes.ts`
  rather than a util module.

None of these are correctness problems for the ledger (all postings route through the
repository), but they mean "repository is the only SQL" is a *goal*, ~95% achieved.

---

## 4. Request lifecycle

```
1. createServer callback â†’ applySecurityHeaders(res)
2. new URL(req.url) â†’ Method + pathname
3. CORS headers + preflight short-circuit (only when CORS_ORIGIN is set)
4. router.match(method, pathname)
     â€¢ path segments compared; `:param` captured (decodeURIComponent)
     â€¢ if the path matched but the method did not â†’ 405 METHOD_NOT_ALLOWED
     â€¢ no path â†’ 404 NOT_FOUND
5. body: for POST/PUT/PATCH/DELETE (except /api/attachments/*) â†’ readJsonBody()
     â€¢ > 1 000 000 bytes â†’ 413 PAYLOAD_TOO_LARGE
     â€¢ invalid JSON â†’ 400 INVALID_JSON
6. handler({req,res,method,url,params,query,body})
     a. requireSession()  â†’ parseCookies â†’ auth.resolveSession(cookie)
          invalid signature / no row / expired / inactive user â†’ 401 UNAUTHORIZED
     b. requireCaller()   â†’ businessId = explicit ?? query ?? session.businessId
          none â†’ 400 NO_BUSINESS
          repo.caller(user, businessId) â†’ membership + status check â†’ 403 otherwise
     c. rate limiters (register / login / invite) where applicable
     d. repository method â†’ assertPermission() â†’ 403
          â†’ db.transaction(() => { validate â†’ write rows â†’ post journal â†’ audit })
     e. domain functions do all money/stock/accounting maths and may throw
7. response
     â€¢ handler returned a value        â†’ 200 + JSON (cache-control: no-store)
     â€¢ handler returned undefined      â†’ 204
     â€¢ handler wrote the response itself (CSV export, upload) â†’ left alone
8. errors â†’ error mapping (Â§5)
9. `finally`: if the request took > 1500 ms, one line to stderr: [slow] METHOD path Nms ip=â€¦
```

Every route handler that mutates data opens **one** `db.transaction()`. `Database.transaction`
is re-entrant (depth counter) so a sync batch can wrap several postings in one outer
transaction, and a nested call joins it instead of issuing a second `BEGIN IMMEDIATE`.

---

## 5. Error mapping

### 5.1 Explicit errors â€” `HttpError`

`HttpError` carries `{status, code, message, details?}` and is serialised as
`{ error: { code, message, details? } }`.

| Status | Code | Raised by |
|---|---|---|
| 400 | `VALIDATION` | `requireString`/`optionalString`/`requireEnum`/`asRecord`/`asArray`, `WEAK_PASSWORD`, `INVALID_INVITE`, `NO_LOCATION`, `NO_BUSINESS`, `UNBALANCED_ENTRY`, `UNKNOWN_EVENT`, `INVALID_JSON` |
| 401 | `UNAUTHORIZED` | no/invalid/expired session; bad credentials |
| 403 | `FORBIDDEN` | not a member; suspended/removed; `assertPermission` failure; AI without `ai.use`; cross-business sign-in attempt |
| 404 | `NOT_FOUND` | unknown entity within **this** business; unknown route; open conflict not found |
| 405 | `METHOD_NOT_ALLOWED` | path matched, method did not |
| 409 | `EMAIL_TAKEN`, `LAST_OWNER`, `CYCLE_CLOSED`, `STOCK_CONFLICT` | duplicate email; last-owner guardrails; activity on a closed cycle; negative stock |
| 413 | `PAYLOAD_TOO_LARGE` | JSON body > 1 MB; upload > 5 MB |
| 429 | `RATE_LIMITED` | register / login / invite / AI windows |
| 500 | `INTERNAL` | anything unexpected (message only, never a stack trace) |

Note the deliberate use of **404 rather than 403** for another tenant's entity: you cannot
distinguish "does not exist" from "exists but is not yours", so nothing leaks.

### 5.2 Implicit errors â€” domain exception â†’ HTTP status

The domain package throws plain typed errors (it must not know about HTTP). `server.ts`
maps them centrally in the catch block:

```ts
const stockConflict =
  name === 'StockError' ||
  /NEGATIVE_STOCK|DUPLICATE_IDEMPOTENCY|UNIT_MISMATCH|MIXED_CURRENCY/.test(message);

const badInput =
  name === 'CurrencyError' || name === 'UnitError' ||
  name === 'AccountingError' ||
  /Unknown currency|Unknown unit|not balanced|Cannot convert/.test(message);

const status = stockConflict ? 409 : badInput ? 400 : 500;
const code   = stockConflict ? 'STOCK_CONFLICT' : badInput ? 'VALIDATION' : 'INTERNAL';
```

| Domain error | Example | HTTP |
|---|---|---|
| `StockError('NEGATIVE_STOCK')` | a sale of 10 kg with 0 on hand | **409 `STOCK_CONFLICT`** |
| `StockError('DUPLICATE_IDEMPOTENCY_KEY')` | key reuse | **409 `STOCK_CONFLICT`** |
| `StockError('UNIT_MISMATCH' / 'MIXED_CURRENCY')` | kg vs litre; BDT vs USD on one item | **409 `STOCK_CONFLICT`** |
| `CurrencyError` | `Unknown currency: XYZ` | **400 `VALIDATION`** |
| `UnitError` | `Cannot convert kg (MASS) to l (VOLUME)` | **400 `VALIDATION`** |
| `AccountingError` | `Invalid journal entry: â€¦ not balanced` | **400 `VALIDATION`** |
| `FarmingError` (`NO_TARGETS`, `ZERO_BASIS`, `OVER_ALLOCATION`, â€¦) | an empty allocation target list | **400 `VALIDATION`** via the message regex only where matched; otherwise the message propagates with `500` â€” see the gap below |
| `PermissionError` | from `assertPermission` in the **domain** helper (`Repository` uses `HttpError.forbidden` instead) | 500 if ever reached |
| anything else | a bug | **500 `INTERNAL`** (message only) |

**Gap to note:** `FarmingError('OVER_ALLOCATION')` / `('ZERO_BASIS')` / `('NO_TARGETS')` are
*not* in the `badInput` name list, so unless their message happens to match the regex they
surface as `500 INTERNAL` rather than `400`. The API tests only exercise the happy
allocation path. Fixing this is a one-line addition to the classifier (TASKS.md phase 16).

### 5.3 Sync errors are not HTTP errors

`SyncService.applyOne()` catches per-event and converts failures into a **result status**
(`REJECTED` for a 4xx `HttpError`, `NEEDS_ATTENTION` otherwise) rather than failing the whole
batch. An unknown `eventType` throws `400 UNKNOWN_EVENT` inside `applyEvent`, which becomes
`REJECTED` for that event only, and is recorded in `processed_events` so it cannot loop.

---

## 6. Background jobs

Started in `createApp().start()` when the server begins listening. Both timers are `unref()`'d
so they never hold the process open, and both are wrapped in `try/catch` that logs to stderr
rather than crashing.

| Job | Interval | What it does |
|---|---|---|
| `runJobs()` | every **60 minutes** | `auth.pruneExpiredSessions()` â€” deletes sessions whose `expires_at <= now` |
| `writeDailyBackup()` | every **24 hours**, and **immediately on start** | writes `$DATA_DIR/backups/sbm-YYYY-MM-DD.json`: for every business, its `businesses` row plus `members`, `journal_lines`, `stock_movements` and `harvests`. Logs `[jobs] wrote backup <path>` |

Notes and limitations, stated plainly:

- The backup is a **partial** snapshot (journal lines, stock movements, harvests, members â€” not
  purchases/sales/customers/products). The complete per-business dump is the
  `GET /api/reports/backup` endpoint (`backup.manage`), which is what a user should actually
  rely on. `writeDailyBackup` is a safety net, not the backup strategy.
- The same file is **overwritten** for the same calendar date (UTC), so it is one file per day
  and the second run of a day replaces the first. There is **no retention/pruning** of old
  backup files, so they accumulate indefinitely.
- There is no scheduled export of the SQLite file itself.
- `backups/` sits inside `DATA_DIR`, so it lives wherever the data volume lives. Putting that
  volume on ephemeral container storage loses the backups too.

---

## 7. `local` mode vs `shared` mode, and the adapter boundary

`SBM_MODE` (not `MODE` â€” bundlers claim that name) selects one of two modes. **The Node API
(`apps/api`) only ever uses `local`.** The Postgres layer exists as a separate, complete
schema/RLS/RPC port in `supabase/` â€” but `apps/api` has no adapter for it.

| | `local` (default, fully working) | `shared` |
|---|---|---|
| Storage | embedded `node:sqlite` file, `$DATA_DIR/sbm.db` | PostgreSQL/Supabase â€” **schema + RLS + RPCs exist in `supabase/`; no adapter in `apps/api`** |
| Auth | this app's own scrypt users + HMAC session cookie | intended to be Supabase Auth |
| Credentials needed | **none** | your own free-tier `SUPABASE_URL` + anon key + server-side service-role key |
| Multi-partner on one device? | yes, separate logins, same process | yes, in principle |
| Multi-partner across the internet? | only by exposing the one server (LAN or a host) | yes, in principle |
| Tenant isolation | application-level (`Repository` + `Caller`) | **RLS on every tenant table** (148 `CREATE POLICY`) *plus* application-level |
| Migrations | `MIGRATIONS` v1â€“v6 in `db.ts` | `supabase/migrations/0001â€¦0007` |
| Verified? | **yes** â€” booted, health-checked, seeded, 87 API tests | âš ï¸ **never executed** â€” no PostgreSQL server in this environment; 38 static SQL tests only |
| Setup | `npm run api` | apply the migrations + functions, then write the adapter |

### 7.1 What the config layer does for shared mode

`loadConfig()` is honest about it:

- `SBM_MODE` accepts only `local` or `shared` (anything else throws at startup);
- in `shared` mode, `SESSION_SECRET` must be **at least 32 characters** or startup throws â€”
  the app refuses to run with a weak signing key rather than doing it silently;
- `supabase` config is built only when **both** `SUPABASE_URL` and `SUPABASE_ANON_KEY` are
  present, otherwise it is `null`;
- `describeConfig()` reports `supabaseConfigured: boolean` and, in shared mode,
  `database: 'shared-cloud'` â€” so `/api/status` can never imply that a cloud database is
  being used when it is not;
- the service-role key is read but **never** returned or logged.

But there is **no code branch anywhere that uses `config.supabase`** to store or read data.
`SBM_MODE=shared` therefore changes nothing about behaviour today except the reported status
string and the stricter secret rule. **This remains the largest single gap in the project** and
is recorded as such in `TASKS.md`, `IMPLEMENTATION_PLAN.md` (R2) and `docs/ROADMAP.md`.

### 7.2 The adapter boundary that exists, and the one that does not

- **The design seam is `Repository`.** It is the only class that holds SQL and it takes a
  `Database` in its constructor. A Postgres implementation would replace `db.ts` + the SQL in
  `repository.ts` (and the handful of inline queries in `routes.ts`), leaving the domain, the
  services, the routes and the clients untouched because they never see SQL.
- **`Database` is also a seam:** `MIGRATIONS` is a data array, not imperative code, so a port
  needs a translation layer rather than a rewrite.
- **The Postgres half of the seam already exists** as SQL: 46-shaped tables with `numeric`
  money, RLS policies, integrity triggers, and 9 transactional posting RPCs
  (`post_sale`, `receive_purchase`, `move_stock`, `post_harvest`, `allocate_cost`,
  `post_payment`, `create_journal_entry`, `close_cycle`, `void_document`). What is missing is
  the **TypeScript adapter** in `apps/api` that calls them.
- **There is still no `ports`/`adapters` interface package** â€” no `RepositoryPort` interface
  that both implementations satisfy. The boundary is a convention, not a compiled contract.
  Defining that interface first is the right first step (TASKS.md Phase 3b / R2).
- **A useful consequence of `local` mode:** because the API is a plain Node process over a
  file DB, "multi-partner across devices" works **today** without Supabase at all â€” one
  server on a LAN/IP, partners' phones pointed at it, each with their own login. That is a
  legitimate zero-cost deployment and is described in `DEPLOYMENT_FREE.md`. The trade-off is
  that the server must be reachable, i.e. it is not usable from two different cities with no
  host, and there is no RLS behind it.

---

## 8. Why `node:sqlite`

`apps/api` has **zero runtime dependencies** â€” its only `dependencies` entry is the workspace
package `@sbm/domain`. `node:sqlite` (`DatabaseSync`) is a Node builtin, which is why
`engines.node` is `>=22.5.0`.

- No native module to compile, no `better-sqlite3`, no prebuilt-binary mismatch.
- Synchronous API â†’ transactions and postings are straightforward and cannot interleave.
- The whole product installs from `npm ci` with no build toolchain and no cost.
- `db.ts` loads it through `createRequire(import.meta.url)` so bundlers/dev servers that do
  not yet recognise the `node:sqlite` specifier do not try to resolve it themselves.

Consequence to accept: **Node â‰¥ 22.5 is mandatory.** Node 20 or 18 will fail at import.
Verified locally on Node v24.19.0.

---

## 9. Concurrency model

- One Node process, single-threaded event loop, synchronous SQLite calls. There is no
  read/write interleaving **inside** a request.
- Writes that must be atomic use `BEGIN IMMEDIATE`, which takes the write lock up front
  instead of failing later with `SQLITE_BUSY` mid-transaction. `busy_timeout = 5000` gives a
  competing writer 5 seconds.
- `journal_mode = WAL` (file DBs only) means readers do not block the writer.
- `number_sequences` is bumped with a single atomic upsert-with-`RETURNING`, so two requests
  cannot receive the same reference even if they interleave.
- The **real** multi-writer risk is the sync path: two devices pushing stock-changing events.
  The answer is not locking (there is one process) but the **idempotency key + revision
  check**, which turns a concurrent change into an explicit, visible conflict instead of a
  lost update (see SYNC_DESIGN.md Â§5).
- Scaling out to multiple API replicas is **not supported**: the in-memory rate limiters and
  the embedded SQLite file both assume one process. Documented, not hidden.

---

## 10. Build & runtime topology

| Piece | Runtime | Build step | Status |
|---|---|---|---|
| `packages/domain` | any JS runtime | `tsc -p tsconfig.json` â†’ `dist/` (ESM + `.d.ts`) | âœ… builds clean, typechecks clean |
| `apps/api` | Node â‰¥ 22.5 | `tsc -p tsconfig.json` â†’ `dist/`, run `node dist/server.js` | âœ… builds clean, typechecks clean, boots, 87 tests |
| `apps/web` | browser | `vite build` â†’ `dist/` | âœ… builds clean (351 kB JS / 101 kB gzip), typechecks clean, 63 tests â€” âš ï¸ never opened in a browser here |
| `apps/mobile` | Android (Hermes) | `expo prebuild` + Gradle, or `eas build` | âš ï¸ typechecks clean as part of the repo â€” **never built, never run**; no APK |
| `supabase` | PostgreSQL â‰¥ 15 / Supabase | apply `migrations/` then `functions/` | âš ï¸ 38 static SQL tests pass â€” **never executed against a live server** |

Root scripts: `npm run typecheck` / `build` / `test` (all `-ws --if-present`), `verify`
(typecheck + test), `api`, `api:dev`, `web:dev`, `web:build`, `seed`, `supabase:test`.

> Note: an npm-quarantine issue appeared once in earlier output, so `apps/mobile` is installed
> separately (`cd apps/mobile && npm install`) rather than hoisted by `npm install` at the root.
> This is deliberate (ADR-005) â€” the Expo dependency tree is large.
>
> âš ï¸ **No CI.** There is no pipeline configuration in this repository; every gate above is run
> locally, from the same commands.

`apps/api` dev mode uses `node --watch --experimental-strip-types src/server.ts` â€” no
bundler, no ts-node.
