# TASKS.md — the 18 phases, marked honestly

Evidence is a **file path**, a **test name**, or **captured command output**. Nothing here is
marked DONE on the strength of intent. The measurement timestamp and the full command
transcript are in [`TESTING.md`](./TESTING.md).

Legend: **DONE** = built *and* verified by a test/build/command · **PARTIAL** = real code
exists but something material is unverified or missing · **NOT STARTED** = no code.

> ⚠️ The working tree was being written **actively** while this snapshot was taken
> (2026-10-14). Re-run the commands in `TESTING.md` before trusting a number.

---

## Phase 1 — Repository audit and plan — **DONE**

- No prior Small Business Manager source existed to reconcile (the parent folder holds
  unrelated projects: `sfuwt-dashboard`, `tms`, `zakat-platform`, …).
- Baseline architecture, tasks, risks and file map created; the living risk list is
  `IMPLEMENTATION_PLAN.md` §3 (R1–R14).
- Layout decision recorded: `docs/DECISIONS.md` ADR-008 (one domain package, not eight).

## Phase 2 — Foundation — **DONE**

- npm workspaces (`packages/*`, `apps/api`, `apps/web`, `supabase`) — `package.json`.
- `tsconfig.base.json`: `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`,
  `verbatimModuleSyntax`, `isolatedModules`, `NodeNext`, ES2022.
- `.env.example` (83 lines) with **placeholders only**, zero-credential local defaults.
- `.gitignore` excludes `.env`, `.env.*` (keeps `!.env.example`), `*.db`, `dist/`, `.next/`,
  `*.apk`, `*.keystore`, `node_modules/`.
- **CI: NOT STARTED.** No CI configuration exists; verification is local. (The spec allows
  this: "local verification must still be possible".)
- **Linter: PARTIAL.** `apps/mobile/.eslintrc.js` exists; no root lint config, and `lint` is
  not part of `npm run verify`.
- Evidence: `npm run typecheck` passes for **all four** workspaces (see `TESTING.md`).

## Phase 3 — Auth and multi-partner tenancy — **DONE** (with one deviation)

- `apps/api/src/auth.ts`: scrypt (`keylen 64`, 16-byte salt), `timingSafeEqual`,
  dummy-hash timing equalisation on an unknown email, HMAC-SHA256-signed session cookie
  (`HttpOnly` + `Secure` + `SameSite=Lax`), server-side revocable sessions with expiry pruning.
- `Repository.createBusiness` (owner membership + default `Main Store` location),
  `createInvite`/`acceptInvite`/`revokeInvite`/`updateMember`/`listAuditLog`.
- 7 roles × 53 permissions in `packages/domain/src/permissions.ts`, with per-member
  grants/denials (denial wins) and owner-configurable visibility widening.
- 2–5 partner guidance (`partnerCountGuidance`) is guidance, not a hard cap — the schema is
  not capped, so a future plan can raise it without a migration.
- Invite security: 120-bit uniform code, SHA-256 at rest only, 72 h TTL, single use, optional
  email binding, revocable, `role: 'owner'` refused at creation.
- **Deviation:** tenant isolation is **application-level** in `apps/api` (SQLite has no RLS).
  The Postgres/RLS path now exists in `supabase/` (see Phase 3b) but has never run against a
  live server.
- Evidence: `apps/api/test/security.test.ts` (12 tests) + `packages/domain/test/{permissions,tenancy}.test.ts`
  (16 + 10 tests) — e.g. `never lets one business read or mutate another business`,
  `lets one partner belong to two businesses and keeps their data apart`,
  `rejects a member who has been suspended`, `rejects an invite that has expired`,
  `never stores the raw code`, `blocks demoting or removing the only owner`.

## Phase 3b — Shared-cloud database: PostgreSQL/Supabase with RLS — **PARTIAL**

- `supabase/migrations/0001…0007` (7 files, 1226 lines in `0007` alone) + `supabase/functions/0000…0180`
  (10 files) + `supabase/seed.sql`.
- **148 `CREATE POLICY`** statements; every tenant table gets `enable` **and** `force row level
  security`; `security definer` helpers with a pinned `search_path`; append-only tables get
  **no** UPDATE/DELETE policy; two independent double-entry guards (a function check plus a
  deferrable constraint trigger); a deferrable trigger proving shared costs allocate exactly.
- 9 transactional posting RPCs: `post_sale`, `receive_purchase`, `move_stock`, `post_harvest`,
  `allocate_cost`, `post_payment`, `create_journal_entry`, `close_cycle`, `void_document`.
- Money is `numeric(20,6)` — asserted by the test
  `keeps every money/quantity column exact (numeric), never float/real/double precision`.
- **Why PARTIAL, not DONE:** there is no PostgreSQL server in this environment, so the
  migrations were **never executed**. `supabase/tests/` reads the SQL and asserts structural
  invariants (38 tests). That is a static proof, not a live one. Run them against a real
  Supabase project before relying on RLS.

## Phase 4 — Database and repository layer — **DONE**

- `apps/api/src/db.ts`: migrations **v1–v6**, **46 tables**, tracked by `PRAGMA user_version`,
  each applied inside `BEGIN IMMEDIATE` with `ROLLBACK` on failure; `foreign_keys = ON`, WAL
  for file DBs, `busy_timeout = 5000`; a **re-entrant** `transaction()` so a sync batch and the
  posting services share one transaction; `nextReference()` as an atomic upsert-with-`RETURNING`
  per business **per day**.
- `apps/api/src/repository.ts` (2792 lines) is the single SQL surface: posting services for
  purchase, sale, customer receipt, supplier payment, transfer, income/expense, partner
  capital, opening balance, opening stock, stock transfer, farming event, harvest, allocation,
  **void/reversal**, and **backup restore**.
- Evidence: `/api/health` returns `"schemaVersion":6` (captured); every API test exercises the
  repository against a real in-memory database.

## Phase 5 — Offline sync — **DONE on the server; PARTIAL end-to-end**

- `packages/domain/src/sync.ts`: `OutboxEvent` shape, `createOutboxEvent`, business-scoped
  `idempotencyKey = business:aggregate:event`, canonical-JSON `payloadHash` with a
  **dependency-free SHA-256** (verified against the NIST vectors), `retryDelayMs` (1 s base,
  ×2, 15 min cap, ±25 % jitter), `shouldRetry`/`statusAfterFailure`, `classifyRevision`,
  `analyseFieldConflict`/`mergeDraftFields`, `HIGH_RISK_EVENTS`, the 6-state status machine
  and the bilingual `syncBanner`.
- `apps/api/src/sync.ts`: exactly-once application via `processed_events` (PRIMARY KEY on the
  idempotency key) **inside the same transaction as the posting**; `ONLINE_ONLY_EVENTS` guard;
  revision conflict detection on 4 aggregate types; per-event failure classification
  (`REJECTED` for 4xx and recorded, `NEEDS_ATTENTION` otherwise); `pull()` with incremental
  `since`; conflict list + `LOCAL_WINS`/`SERVER_WINS` resolution (audited).
- Clients: `apps/web/src/offline/*` (IndexedDB outbox; 17 outbox tests + a 10-test protocol
  integration test that runs against a **real** API instance) and
  `apps/mobile/src/offline/*` (SQLite outbox). 
- **What is NOT verified:** a kill-mid-sync / restart e2e, and two real devices racing on the
  last 10 kg. The server-side behaviour is tested; the device-side guarantee is not proven here.
- Evidence: `applies an outbox event exactly once, even when retried` (same event twice → one
  sale, stock unchanged, message matches `/idempotent/i`),
  `refuses to apply access changes from an offline queue`,
  `reports a conflict when a partner edits a record that changed on the server`,
  `pulls only the caller own business changes`.

## Phase 6 — Shared inventory, units, lots — **DONE**

- `packages/domain/src/inventory.ts`: append-only ledger, derived balances,
  `weightedAverageValuation` with a **per-movement cost snapshot** so historical COGS never
  changes, `checkStockImpact` (negative stock refused), `planLotIssue` (FIFO/FEFO),
  `reversalMovements`, `itemsBelowReorderLevel`.
- `packages/domain/src/units.ts`: 6 dimensions; **BD land** (katha 720 sqft, bigha 20 katha,
  decimal/shotangsho) and **BD weight** (maund 37.3242 kg, seer) units; explicit,
  note-required cross-dimension conversions; integer-only units; `bagConversion` helper.
- API: `/api/inventory`, `/api/inventory/movements`, `/api/inventory/adjust` (reason ≥ 5 chars
  required), `/api/inventory/transfer` (two legs, one transaction, no gain/loss),
  `/api/inventory/opening`, `/api/reports/stock-valuation`.
- Evidence: 18 inventory + 11 units + 13 validation (timezone) tests; API test
  `moves stock between locations without changing quantity, value or profit`.

## Phase 7 — Purchases and sales — **DONE** (core)

- `createPurchase`/`createSale` post stock + journal + COGS in one transaction; lot creation;
  discount requires `sale.discount.apply`; negative-stock override requires
  `inventory.adjust.approve` **and** a reason; customer receipts and supplier payments;
  derived receivables/payables; `/api/reports/export/:table` CSV (10-table allowlist, UTF-8 BOM).
- **Corrections:** `voidDocument` posts an audited **reversal** of both the journal and the
  stock movements and sets `status = 'VOID'`/`'RETURNED'` — posted history is never mutated.
- **Not built:** separate return *documents* with their own lines, credit-limit enforcement,
  print/PDF.
- Evidence: `records purchase, sale, receipt and expense with correct double entry`
  (`netRevenue 3300.00`, `cogs 2900.00`, `netProfit −600.00`, `payables 3800.00`),
  `refuses negative stock by default, even for the owner` (409 → 400 without a reason → 200
  with one), `rejects a discount without the discount permission` (403),
  `voids a sale with an audited reversal instead of editing history`,
  `requires the void permission and a reason`.

## Phase 8 — Finance and accounting — **DONE** (core)

- 39-account fixed chart (`packages/domain/src/accounting.ts`), incl. `3050 Opening Balance
  Equity`; templates for sale (with COGS), purchase, receipt, payment, transfer, income/expense
  (paid or accrued), partner capital, inventory loss/mortality, input issue, direct batch cost,
  harvest, **opening balance**, reversal.
- `buildReversal` swaps the legs and links `reversalOf`; reversing a reversal is refused.
- Reports: trial balance, P&L (accrual), balance sheet (balanced including the unclosed
  result), cash flow, **`cashBasisOperatingResult`** (documented definition), partner capital
  balances, integrity/reconciliation.
- Evidence: 24 accounting tests incl. `profit is not the same as cash`,
  `treats a stock purchase as an asset, not an operating expense`,
  `does not count a customer receipt as a second revenue`,
  `does not count a supplier payment as a second expense`,
  `treats partner capital as equity, not revenue`,
  `records opening cash and opening stock as equity, never as profit`.
- **Not built:** bad debt (`5500`), depreciation (`5600`), loans/interest (`2100`/`5700`),
  period closing to `3200`, payroll. Accounts exist; no policy, no endpoint.

## Phase 9 — Farming setup — **DONE**

- Migrations v4: `farms`, `farm_units` (9 kinds), `production_cycles`, and the typed child
  tables. `farmingTypes` auto-enabled on first use of a type.
- Evidence: API `runs input purchase → issue → labour → harvest → sale with correct costing`
  asserts farm → shed → cycle creation (`200`).

## Phase 10 — Farming operations — **DONE** (core)

- `recordFarmingEvent` handles input issue (valued at the weighted-average cost, assigned
  **once**), direct labour, machinery/fuel, veterinary, utilities, packaging, transport,
  overhead, observation, mortality, waste, internal use; mortality ≥ 25 units is flagged
  `abnormal` and returns an **escalation** message.
- `closeCycle` releases the remainder with `CLOSING_REMAINDER`.
- Evidence: `flags a large mortality event for escalation`
  (`abnormal === true`, message matches `/veterinar/i`); `INPUT_ISSUE` of 100 kg of 200 kg stock
  moves stock to 100 and adds `6000.00` **once**.
- **Not built:** scheduled/planned operations and missing-operation alerts, breeding,
  milk/egg yield as first-class outputs, animal transfers between units.

## Phase 11 — Costing and sales integration — **DONE**

- `allocateCost` over 7 bases with exact largest-remainder distribution and an explicit
  `unallocated` remainder; **deterministic residual** (largest weight, then lowest cycle id);
  `assignHarvestCost` with `PLANNED_YIELD_PRORATA` / `CLOSING_REMAINDER` and a cap at the
  remaining cost-to-date; `cycleProfit`; `cycleCostLedger`.
- Traceability: a harvest can create the finished product; sales of that product are
  attributed back to the cycle for revenue/COGS.
- Evidence: `never assigns the whole batch cost to a partial harvest`; API test
  `runs input purchase → issue → labour → harvest → sale` (cost 9000 over a planned 1000 kg →
  a 500 kg harvest is assigned exactly `4500.00`, `capped === false`, `4500.00` left in the
  batch); `splits a shared cost across cycles without losing a poysha`
  (10:20 of 1000 → 333.33/666.67, sums to 1000).

## Phase 12 — Android and Web UX — **PARTIAL (code + build present, not device-verified)**

- `apps/web`: 18 screens, routing, i18n (`bn`/`bn-BD` + `en`), theme, offline layer
  (IndexedDB outbox, sync worker, merge, cached list), `SyncBanner`, `InstallPrompt`,
  `public/manifest.webmanifest`, `public/sw.js`. **`vite build` succeeds** (351 kB JS /
  101 kB gzip) — captured. Types are exact-mirrored in `api/types*.ts`.
- `apps/mobile`: Expo SDK 52 + React Native 0.76, ~50 screens across auth/onboarding/
  dashboard/catalog/sales/purchases/inventory/finance/farming/team/reports/settings/sync/ai,
  stack + bottom-tab navigators, SQLite offline store, `OfflineBanner`, `SyncStatusScreen`,
  `PermissionGate`, `PhotoPicker`, `AIModeBadge`, polyfills for `TextEncoder`/`crypto`,
  generated icon/splash assets, `apk:debug`/`apk:release` scripts, `eas.json`.
  Deliberately **not** in the root workspaces so the Expo tree is an explicit install step.
- **NOT verified:** no browser was opened here; no emulator or device was used; **no APK was
  built** (no JDK/Android SDK). Nothing about layout, accessibility or real offline behaviour
  has been observed.

## Phase 13 — AI agent foundation — **DONE (server)**

- `AIProvider`/`ResearchProvider` interfaces; three modes with the exact fallback chain
  (not configured → fallback; provider error/timeout → fallback + limitation; empty answer →
  fallback + limitation) — `apps/api/src/ai.ts`.
- Secret-safe config (`describeConfig` exposes booleans, never keys); permission-scoped
  `buildContext`; per-business+user rate limiting; bilingual output.
- Evidence: `answers in offline fallback mode and says so` (`mode === 'fallback'`, text matches
  `/offline rule-based mode/i`, limitations non-empty);
  `rejects AI use for a role without the permission` (403 for a viewer);
  `never leaks restricted cost data to a role that cannot see it` (a cashier's `factsUsed`
  contains `restricted`, and the secret amount appears nowhere).

## Phase 14 — AI web research and safety — **PARTIAL**

- Curated source list (6 government/FAO links) always available and clearly labelled
  `CURATED_LINK` with a "not a live search result" note; `classifySource`
  (OFFICIAL/RESEARCH/RETAILER/USER_REVIEW); `validateCitations` (http(s) only, de-duplicated);
  research cache with a TTL (`ai_research_cache`, unique per business+query hash); saved
  plans as `DRAFT`; feedback; conversation soft-delete; the agricultural safety prompt rules
  and the structural "the AI cannot post" guarantee.
- Evidence: `returns curated official links (clearly labelled) for a pesticide question`
  (`dae.gov.bd` present, **every** citation `kind === 'CURATED_LINK'`, limitations mention
  "not live search results");
  `stores conversations, supports deletion, and caches research` (second identical query
  returns `cached: true`).
- **NOT verified:** no live search provider is configured or tested; there are **no tests**
  for prompt-injection resistance, dose/PHI/REI refusal with no official source, citation-URL
  rejection, provider timeouts, or AI rate limiting. See `AI_AGENT_DESIGN.md` §11.2.

## Phase 15 — Exports and backup — **DONE** (core)

- CSV export with a UTF-8 BOM so Bangla opens correctly in Excel (10-table allowlist);
  `GET /api/reports/backup` (full per-business JSON across ~30 tables); **`POST /api/reports/restore`**
  — owner-only, **empty-workspace-only**, refuses a backup whose journal does not balance,
  re-keys every id and remaps every declared FK plus known textual references, runs in one
  transaction, and reports what it did; a **daily partial JSON snapshot** job; and an
  **integrity/reconciliation report** with 9 independent derived checks.
- **Not built:** printable/PDF reports, attachment export, and the CSV export is still not
  audited (the JSON backup and restore are).
- Evidence: `restores a backup into a fresh workspace and reproduces the same books`;
  `refuses to restore a backup whose journal does not balance`;
  `passes on a healthy set of books and detects a broken ledger`.

## Phase 16 — Quality and security pass — **PARTIAL**

- **325 automated tests pass** — 148 domain, 76 api, 63 web, 38 supabase (captured).
  `npm run typecheck` passes for all four workspaces; `npm run build` succeeds
  (domain + api + web).
- Covered: tenant isolation, permissions/least privilege, cost redaction, invite expiry &
  email binding & single use, last-owner guardrails, suspension, idempotent replay, conflict
  detection, negative stock + override, discount permission, audit coverage, malformed input,
  login rate limiting, AI fallback labelling and permission denial, restore validity, stock
  valuation redaction, integrity checks, outbox/backoff/merge logic, and the HTTP layer
  (20 tests).
- **NOT done:** no dependency/SCA scan, no penetration test, no accessibility pass, no CI,
  and **the two open security findings in `SECURITY.md` §11**
  (sync-pull cost leakage; admin self-granting `business.transfer_ownership`).

## Phase 17 — Free deployment preparation — **PARTIAL**

- `.env.example` complete with zero-credential defaults; `local` mode verified end-to-end
  (booted, `/api/health` → `200` `schemaVersion: 6`, `/api/status`, `/api/meta` → 93 routes);
  seed verified (full summary + `ALL CHECKS PASSED`); web build produced; `supabase/README.md`
  has exact migration/RLS-verification steps; `DEPLOYMENT_FREE.md` written with exact commands
  for local, a user-owned Supabase project, static hosting, three no-cost AI routes, and APK
  sideloading.
- **NOT done:** **nothing was deployed.** No URL, no cloud resource, no free-tier verification,
  **no APK artifact** (no JDK/Android SDK in this environment).

## Phase 18 — Final verification and handover — **DONE**

- README, TASKS, IMPLEMENTATION_PLAN, ARCHITECTURE, DATABASE_SCHEMA, SYNC_DESIGN, SECURITY,
  TESTING, DEPLOYMENT_FREE, ACCOUNTING_RULES, AI_AGENT_DESIGN and the four `docs/` files
  written from the code and from captured command output, with every unverified claim labelled.

---

## 🚧 Blocked / needs a human (cannot be done from this environment)

| Blocker | What is needed | Consequence if not done |
|---|---|---|
| **Android APK** | JDK 17 + Android SDK (`expo prebuild`, then `gradlew assembleRelease`), or a free Expo account for `eas build` | no installable Android app; only the Expo dev client route works |
| **Live Postgres/Supabase** | the user's own free Supabase project (or any Postgres ≥ 15) to run `supabase/migrations` + `functions` | RLS and the 9 posting RPCs stay **statically tested only** |
| **Hosted AI provider key** | a free OpenAI-compatible endpoint key, or a local Ollama install | the AI stays in offline fallback mode (fully usable, but not generative) |
| **Live search provider** | a self-hosted SearXNG URL or a free search API | research returns curated official links instead of live results |
| **A real web host / domain** | a free static host account (Cloudflare Pages / Netlify / GitHub Pages) | the web build stays on disk |
| **Two real devices + two partners** | people and phones | the offline e2e (disconnect → reconnect → no duplicates) cannot be proven |
| **A card-free email/SMS provider** | — | invites are shared as codes/links by the owner; nothing is emailed. **By design** (no paid email) |
| **Free-tier quota verification** | opening each provider's pricing page | `docs/FREE_TIER_LIMITS.md` stays unverified |
| **A qualified accountant / vet / extension officer** | a person | the tax/accounting and agronomy limits documented in `ACCOUNTING_RULES.md` and `AI_AGENT_DESIGN.md` stay open |

---

## ✅ Verified vs ⚠️ unverified — mirroring the master prompt's Definition of Done

| # | Definition-of-Done item | Status | Evidence / gap |
|---|---|---|---|
| 1 | Android and Web source exist and **build successfully** | ⚠️ **PARTIAL** | Web: `vite build` succeeded (captured). Android: code + config exist, but **no APK build was run** (no JDK/SDK) |
| 2 | Core business workflows implemented, not demo-only | ✅ **YES (server)** | purchase/sale/receipt/payment/transfer/income-expense/partner capital/opening/void/restore/reports all real and tested; UI not device-verified |
| 3 | Farming supports crop/horticulture/livestock/poultry/aquaculture end-to-end | ✅ **YES** | one engine covers all 5 types; proven end-to-end for poultry + crop; species-specific depth (breeding, milk/egg) not built |
| 4 | Two users join one business, different roles, shared synced data; tenant isolation tested | ✅ **YES (server)** | `never lets one business read or mutate another business`, `lets an owner invite a partner…different role`, `enforces least privilege server-side…`. Not proven across two physical devices |
| 5 | 2–5 partner onboarding + safe invitation mechanism | ✅ **YES (server)** | 120-bit code, SHA-256 at rest, 72 h TTL, single use, email binding, revocable, `owner` role refused; `partnerCountGuidance` warns outside 2–5 |
| 6 | Offline records survive restart; durable outbox syncs idempotently; conflicts visible & recoverable | ⚠️ **PARTIAL** | **Server: proven.** Client outbox code + 17 unit tests + a 10-test protocol integration test against a real API. **A restart/kill e2e and a two-device race were NOT run** |
| 7 | Inventory reconciles to the ledger; posted events cannot duplicate | ✅ **YES** | balances are *derived*; `stock_movements.event_id` + `idempotency_key` are UNIQUE; the integrity report re-checks it; the retry test proves no duplicate |
| 8 | Input costs allocated once; partial-harvest costs and COGS correct; cash vs profit distinguished | ✅ **YES** | `never assigns the whole batch cost to a partial harvest`, `splits a shared cost…without losing a poysha`, `profit is not the same as cash` |
| 9 | Automated unit/integration/security/sync tests run; actual results documented | ✅ **YES** | **325 tests pass** (148 + 76 + 63 + 38); full transcript in `TESTING.md` |
| 10 | `.env.example` placeholders only; no secrets committed or bundled | ✅ **YES** | `.env.example` header states placeholders; `.gitignore` excludes `.env`/`.env.*`; no key appears in any client bundle source |
| 11 | Free deployment and APK instructions tested as far as access permits; no paid dependency mandatory | ⚠️ **PARTIAL** | instructions written; **nothing deployed, no free tier verified, no APK**; `local` mode (zero cost, zero credentials) **was** verified |
| 12 | README, free deployment guide, backup/restore, known limitations complete | ✅ **YES** | README §8 limitations; `DEPLOYMENT_FREE.md`; backup **and restore** implemented and tested |
| 13 | AI supports help, planning, suggestions, cited research; pesticide guidance follows the guardrails | ⚠️ **PARTIAL** | help/suggestions/curated citations/plan-saving **work and are tested**; **no live provider or live search was tested**; guardrails are prompt-level with **no test** |
| 14 | AI works with no mandatory paid service, reports its mode, respects permissions, fabricates no sources, cannot act | ✅ **YES** | `AI_PROVIDER=none` default; `mode`/`provider` on every answer and stored per message; cost redaction test; curated links labelled; no write path from an AI answer exists |
| 15 | Final handover states what works, exact commands, test results, APK path if generated, manual steps | ✅ **YES** | this file + `TESTING.md` + `README.md`. **APK path: not generated** |

**Legend:** ✅ = verified with evidence · ⚠️ = real code exists but a material part is
unverified or missing · ❌ = no code (none of the five DoD-critical items is ❌).

### Recommended next actions, in order

1. Fix the two open security findings (`SECURITY.md` §11.1–11.2) — both are small, and one
   lets an admin take over ownership.
2. Run one real end-to-end on two devices: register → invite → sale → disconnect → reconnect →
   verify no duplicates. That single test converts the largest ⚠️ into ✅.
3. Run `supabase/migrations` against a real free Supabase project and prove RLS from a second
   tenant session.
4. Build one APK (JDK 17 + Android SDK) and sideload it.
5. Add the missing AI safety tests (`AI_AGENT_DESIGN.md` §11.2).
