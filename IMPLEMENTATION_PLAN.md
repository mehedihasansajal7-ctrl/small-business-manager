# IMPLEMENTATION_PLAN.md

What was planned, what was actually delivered, and what is left — ordered by risk.
The 18 phases are the master prompt's own sequence (`MASTER_PROMPT.md` §14); `TASKS.md`
marks each one DONE / PARTIAL / NOT STARTED with evidence. This file is the narrative:
*why* the order, and *what comes next*.

Measured baseline (2026-10-14, 13:44–13:47): **330 tests passing** — 148 domain, 81 api,
63 web, 38 supabase; `npm run typecheck` passes in all four workspaces; `npm run build`
succeeds (domain + api + web). Nothing is deployed and no APK exists. Full transcript in
`TESTING.md`.

---

## 1. The plan, and the reasoning behind it

The dependency order was chosen so that every phase's output is *testable without the
phase after it*:

```
correct money  →  inventory  →  accounting  →  tenancy  →  persistence  →  offline
   (decimal)      (ledger)       (journal)     (members)     (SQLite)        (outbox)
                                                                              │
        clients (web / android) ──────────────────────────────────────────────┤
        Postgres + RLS (supabase/) ───────────────────────────────────────────┤
        farming costing ──────────────────────────────────────────────────────┤
        AI agent (reads only) ────────────────────────────────────────────────┘
```

Nothing downstream can be correct if the money arithmetic is wrong, so `decimal.ts` and
`money.ts` came first and are the most heavily tested modules. Accounting came before
tenancy because the ledger rules are the product's core promise and were worth locking down
with tests before any HTTP existed. The Postgres/RLS layer came late because it is only
needed once partners are in different places — and, crucially, because it is the layer where
a mistake is *silent*.

---

## 2. Delivered, phase by phase

### Phase 1 — Repository audit and plan — **DONE**
Inspected the workspace; found no prior Small Business Manager source to reconcile
(the parent folder holds unrelated sibling projects). Created the baseline
architecture/tasks/risk map and chose the monorepo shape over the master prompt's sketch
(collapsing 8 packages into 2 — see `docs/DECISIONS.md` ADR-008).

### Phase 2 — Foundation — **DONE**
npm workspaces (`packages/*`, `apps/api`, `apps/web`, `supabase`), `tsconfig.base.json`
(strict, `noUncheckedIndexedAccess`, `noImplicitOverride`, `verbatimModuleSyntax`,
`isolatedModules`), `.env.example`, `.gitignore`, root scripts.
**No CI** and **no root linter** — verification is local (the master prompt permits this:
"local verification must still be possible"). `apps/mobile` has its own eslint config.

### Phase 3 — Auth and multi-partner tenancy — **DONE (application level)**
`users`/`sessions`/`businesses`/`members`/`invites`/`devices`/`audit_logs`; scrypt + HMAC-signed
`HttpOnly`/`Secure`/`SameSite=Lax` cookie sessions; business creation on register; invite
creation/redemption (120-bit uniform code, SHA-256 at rest only, 72 h TTL, single-use, optional
email binding, revocable, `role: 'owner'` refused); 7 roles × 53 permissions with per-member
grants/denials (denial wins) and owner-configurable visibility widening; ownership guardrails;
audit log.
*Evidence:* `security.test.ts` (12) + `permissions.test.ts` (16) + `tenancy.test.ts` (10).

### Phase 3b — Shared-cloud database (PostgreSQL/Supabase + RLS) — **PARTIAL**
`supabase/migrations/0001…0007` + `supabase/functions/0000…0180` + `seed.sql`:
**148 `CREATE POLICY`** statements, `enable` **and** `force` RLS on every tenant table,
`security definer` helpers with a pinned `search_path`, append-only tables with no
UPDATE/DELETE policy, two independent double-entry guards, a deferrable trigger proving shared
costs allocate exactly, and 9 transactional posting RPCs. Money is `numeric(20,6)`.
**Why PARTIAL:** there is no PostgreSQL server in this environment, so the migrations were
**never executed**; the 38 tests assert structure by reading the SQL. Apply and verify before
relying on RLS (`supabase/README.md` §2–3).

### Phase 4 — Database and repository layer — **DONE**
Migrations **v1–v6 (46 tables)** tracked by `PRAGMA user_version`, applied in
`BEGIN IMMEDIATE`, rolled back on failure; FKs on, WAL, `busy_timeout`; a **re-entrant**
`transaction()` so a sync batch and the posting services share one transaction; an atomic
per-business-per-day reference counter. `Repository` (2792 lines) is the single SQL surface
with posting services for purchase, sale, receipt, supplier payment, transfer, income/expense,
partner capital, opening balance, opening stock, stock transfer, farming event, harvest,
allocation, void/reversal and **backup restore**.
**Not done:** the TypeScript Postgres adapter (Phase 3b is SQL only).

### Phase 5 — Offline sync — **DONE on both sides; the device e2e is unproven**
Outbox event shape, business-scoped idempotency keys, canonical payload hashing with a
hand-rolled SHA-256 (NIST vectors), exactly-once application via `processed_events` in the
same transaction as the posting, revision-based conflict detection for 4 aggregate types, a
conflict queue with `LOCAL_WINS`/`SERVER_WINS`, an online-only guard for access/ownership
events, exponential backoff with ±25 % jitter capped at 15 min, and the 6-state status machine
with bilingual labels.
**Clients:** a real IndexedDB outbox + sync worker in `apps/web` (17 outbox tests + a
**10-test protocol integration suite that drives a real API**), and a SQLite outbox in
`apps/mobile`.
**Not verified:** a kill-mid-sync/restart e2e, and two real devices racing on the last item.

### Phase 6 — Shared inventory, units, lots — **DONE**
Append-only `stock_movements` as the sole source of stock truth; derived balances;
weighted-average valuation with a **cost snapshot** per movement so historical COGS never
changes; negative stock refused with a permission+reason+audit override; FEFO/FIFO lot
planning; 6 unit dimensions including BD land (bigha/katha/decimal/shotangsho) and weight
(maund/seer); explicit, note-required cross-dimension conversions; incompatible-unit rejection;
stock transfer between locations; opening stock. 18 inventory + 11 units tests.

### Phase 7 — Purchases and sales — **DONE (core)**
Purchase and sale documents with lines, lot creation, atomic stock + journal posting in one
transaction, customer receipts and supplier payments, derived receivables/payables, discount
permission, negative-stock override, CSV export, and **void with an audited reversal** rather
than editing history.
**Not done:** separate return *documents* with their own lines, credit-limit enforcement.

### Phase 8 — Finance and accounting — **DONE (core)**
39-account fixed chart (incl. `3050 Opening Balance Equity`), transfers, income/expenses
(paid or accrued), partner capital, **opening balance and opening stock**, journal integrity
(balanced, ≥2 lines, non-negative, known accounts), trial balance, P&L, balance sheet, cash
flow, partner capital balances, a **separately defined cash-basis operating result**, and an
**integrity/reconciliation report** with 9 independent checks.
**Not done:** bad debt, depreciation, loans/interest, period closing to retained earnings,
payroll.

### Phase 9 — Farming setup — **DONE**
Farms, typed units (plot/field/greenhouse/barn/pen/poultry house/pond/tank/other) with area and
capacity in real units, production cycles with reference/type/species/breed/season/responsible
member/planned output/starting population, 5 farming types with Bangla labels, auto-enabling a
farming type on first use, and farming-specific permissions (`farm_manager` role).

### Phase 10 — Farming operations — **DONE (core)**
Operational events: input issue (priced at the weighted-average cost, single cost assignment),
direct labour/machinery/veterinary/utilities/packaging/transport/overhead, observations,
mortality and waste (reason, book value, automatic escalation at ≥ 25 units), internal use, and
cycle closure with a final `CLOSING_REMAINDER` harvest.
**Not done:** scheduled/planned operations and "missed operation" alerts, breeding,
milk/egg yield as first-class outputs, animal transfers between units.

### Phase 11 — Costing and sales integration — **DONE**
Batch cost ledger, 7 allocation bases with deterministic largest-remainder distribution and an
explicit `unallocated` remainder, partial-harvest costing (`PLANNED_YIELD_PRORATA` /
`CLOSING_REMAINDER`) capped at remaining cost-to-date, finished output created as **shared
sellable stock linked to the harvest**, COGS on sale from the cost layer, and a cycle profit
report separating sold margin from cost in unsold stock and cost still in the batch. Full
traceability harvest → product → sale line.

### Phase 12 — Android and Web UX — **PARTIAL (code + build, not device-verified)**
`apps/web`: 16 screens, routing, i18n, theme, styles, offline layer, `SyncBanner`,
`InstallPrompt`, `public/manifest.webmanifest`, `public/sw.js`; **`vite build` succeeds**
(351 kB JS / 101 kB gzip) and 63 tests pass including a real-API integration suite.
`apps/mobile`: Expo SDK 52 + RN 0.76, 41 screens (auth, onboarding, dashboard, catalog, sales,
purchases, inventory, finance, farming, team, reports, settings, sync, AI), stack + bottom-tab
navigators, SQLite offline store, `OfflineBanner`, `SyncStatusScreen`, `PermissionGate`,
`PhotoPicker`, `AIModeBadge`, runtime polyfills, generated assets, `apk:*` scripts, `eas.json`.
**NOT verified:** no browser was opened; no emulator or device was used; **no APK was built**
(no JDK/Android SDK in this environment). Layout, accessibility and real offline behaviour have
never been observed.

### Phase 13 — AI agent foundation — **DONE (server)**
`AIProvider`/`ResearchProvider` interfaces, three modes with the exact fallback chain
(not configured / provider error / timeout / empty answer all degrade to the labelled offline
engine), secret-safe configuration, permission-scoped context builder, Bangla/English answers,
per-business+user rate limits. **Not built:** the AI chat screen has no device verification.

### Phase 14 — AI research and safety — **PARTIAL**
Curated official-source fallback with honest labelling, source classification
(OFFICIAL/RESEARCH/RETAILER/USER_REVIEW/CURATED_LINK), citation validation, research caching
with a TTL, saved plans as `DRAFT`, feedback, conversation soft-delete, the agricultural safety
prompt rules, and the structural "the AI cannot post" guarantee.
**Not done:** no live search provider is configured or tested, and there are **no tests** for
prompt-injection resistance, dose/PHI/REI refusal with no official source, citation-URL
rejection, provider timeouts or AI rate limiting (`AI_AGENT_DESIGN.md` §11.2).

### Phase 15 — Exports and backup — **DONE (core)**
CSV export (10-table allowlist, UTF-8 BOM so Bangla opens in Excel), a full per-business JSON
backup (~30 tables), **a real restore** (owner-only, empty-workspace-only, refuses an
unbalanced backup, re-keys every id and remaps every reference, one transaction), a daily
partial snapshot job, and the integrity report.
**Not done:** PDF/printable **server-side** file generation (a print-ready HTML view does
exist), attachment export, retention/pruning, and the CSV export is still not audited.

### Phase 16 — Quality and security pass — **PARTIAL**
`http.test.ts` (20), `api.test.ts` (49), `security.test.ts` (12), 148 domain, 63 web
(including a real-API integration suite) and 38 static SQL tests — **330 passing, exit 0**.
Covered: tenant isolation, permissions/least privilege, cost redaction, invite expiry/email
binding/single use, last-owner guardrails, suspension, idempotent replay, conflict detection,
negative stock + override, discount permission, audit coverage, restore validity, stock
valuation redaction, integrity checks, outbox/backoff/merge, AI fallback labelling.
**Not done:** no dependency/SCA scan, no penetration test, no accessibility pass, no CI, no
coverage report, and **two open security findings** (`SECURITY.md` §11.1–11.2).

### Phase 17 — Free deployment preparation — **PARTIAL**
`.env.example` complete with zero-credential defaults; local mode verified end to end
(booted, `/api/health` → `200` `schemaVersion: 6`, 93 routes in `/api/meta`); the seed verified
with `ALL CHECKS PASSED` from the integrity report; the web build produced;
`supabase/README.md` has exact migration + RLS-verification steps; `DEPLOYMENT_FREE.md` covers
local, Supabase free, static hosting, three no-cost AI routes, APK sideloading and backups.
**Not done:** **nothing was deployed**; no free tier was checked; **no APK artifact**.

### Phase 18 — Final verification and handover — **DONE**
README, TASKS, IMPLEMENTATION_PLAN, ARCHITECTURE, DATABASE_SCHEMA, SYNC_DESIGN, SECURITY,
TESTING, DEPLOYMENT_FREE, ACCOUNTING_RULES, AI_AGENT_DESIGN and four `docs/` files written from
the code and from captured command output, with every unverified claim labelled.

---

## 3. Remaining work, ordered by risk

Risk = (likelihood of causing real money/business harm) × (how hard it is to notice).

### R1 — Critical: the UIs have never run
The web app **builds** and passes 63 tests (including a real-API integration suite), and the
Android app typechecks — but no browser and no device has rendered a single screen. Layout
bugs, broken navigation, IndexedDB/SQLite misbehaviour and native-module problems are all
undetectable until someone runs it.
**Next:** `npm run web:dev`, walk SignIn → Setup → Dashboard → record a sale → Reports. Then
run the Expo app on an emulator. Fix what breaks before adding anything.

### R2 — Critical: `apps/api` has no Postgres adapter
The schema, RLS and 9 RPCs exist in `supabase/`, but the running API always writes SQLite. So
the master prompt's central scenario — 2–5 partners in different places, separate accounts and
devices, over the internet — works today only if a partner hosts the one Node server
themselves.
**Next, in order:**
1. define a `RepositoryPort` interface that today's `Repository` satisfies;
2. write the Postgres implementation of the same methods (or call the existing RPCs);
3. **run the migrations against a real project and prove RLS from a second tenant's session**
   (`supabase/README.md` §3) — this has never been done;
4. a restore/backup procedure for the cloud database.

### R3 — High: `GET /api/sync/pull` leaks cost data to low-privilege members (verified in code)
The route calls `requireCaller` but no `assertPermission`, and `SyncService.pull()` returns
`stockMovements` (with `unit_cost`), `journalEntries`/`journalLines` (every account, debit and
credit) and the `sales`/`purchases` cost columns for the whole business. A `viewer` or
`cashier` deliberately denied `financial_reports.view`/`purchase.cost.view` can read the same
numbers this way, defeating the owner's cost-visibility setting.
**Next:** permission-filter the pull payload (or omit cost columns for roles without the cost
permissions) and add a test asserting a cashier's pull contains no cost field.

### R4 — High: `member.manage` permits self-granting `business.transfer_ownership` (verified in code)
`Repository.permissions()` applies per-member `grants` unconditionally, and `updateMember`
writes `patch.grants` without restricting which permissions may be granted. Admin holds
`member.manage`, so an admin can grant themselves `business.transfer_ownership` (and
`business.delete`) and then transfer ownership — which the role matrix says only an owner can
do. The Postgres port reads a `role_permissions` table instead of member grants, so the two
layers may disagree.
**Next:** forbid granting a permission the caller does not itself hold (or restrict grants to
a safe subset), and add a test.

### R5 — High: no tests for the highest-risk AI behaviour
The dose/PHI/REI refusal, prompt-injection resistance and citation-URL validation are the
safety-critical parts of the AI feature and are **only** prompt-enforced, with no test. Three
fallback code paths (provider timeout, provider error, empty answer) are also untested.
**Next:** unit-test `validateCitations` (rejects `javascript:`/malformed); test that a chemical
question with no official source yields no dose; test the provider-failure paths; assert that
the retrieved-content instruction is not followed.

### R6 — Medium: `FarmingError` can surface as HTTP 500
`NO_TARGETS`/`ZERO_BASIS`/`OVER_ALLOCATION` are client-input errors but are not in the
`server.ts` error classifier, so they can become `500 INTERNAL`. **Next:** one-line classifier
fix + a test for an over-allocated shared cost.

### R7 — Medium: `stock.move` / `journal.post` are high-risk events with no server handler
They are listed in `HIGH_RISK_EVENTS` but absent from `applyEvent`, so a device that queues one
gets `REJECTED: Unsupported sync event type`. The web outbox *refuses* to create them (there is
a test), which mitigates it — but the two lists should agree.
**Next:** implement the handlers or remove the two from the high-risk set.

### R8 — Medium: duplicate manual reference is not a clean 409
`UNIQUE (business_id, reference)` on `sales`/`purchases` means two devices entering the same
invoice number get a `500`-shaped failure instead of a usable message. **Next:** map the
unique-constraint violation to `409 DUPLICATE_REFERENCE`.

### R9 — Medium: rounding in a display path uses floats
`GET /api/accounts` aggregates with `toNumber()`. Harmless at small magnitudes, wrong at large
ones. **Next:** sum with `Decimal` and format at the end. (The authoritative reports do not
have this problem; the integrity report and `profitAndLoss` are exact.)

### R10 — Medium: attachment MIME is trusted from the client
`content-type` is stored as sent; there is no magic-byte check, no malware scan, no delete or
retention, and the stored checksum is never re-verified. A permission-checked **content
download** endpoint now exists. **Next:** verify magic bytes (the sibling SFUWT project has
this code to borrow), add delete/retention.

### R11 — Medium/High: no Android APK
No JDK or Android SDK in this environment. `apps/mobile` declares `apk:debug`/`apk:release` and
`eas.json`. **Next:** install JDK 17 + Android SDK (or use a free Expo account with `eas build`),
run `expo prebuild` then `gradlew assembleRelease`, and sideload to a real low-end phone.

### R12 — Low/Medium: audit and backup gaps remain
Failed logins, logouts, attachments, AI Q&A and **CSV exports** are not audited. The daily
snapshot overwrites itself, keeps no history and is partial. Restore exists and is tested, but
no operator-level restore drill is documented. **Next:** audit the missing events, add backup
retention, document + rehearse a restore.

### R13 — Low: dead schema and unused columns
`devices`, `product_categories`, `financial_accounts`, `businesses.settings`,
`farms.latitude/longitude`, `products.deleted_at`, `customers/suppliers.opening_balance`.
**Next:** wire up or drop; an unused table that *looks* implemented is worse than no table.

### R14 — Low: documentation drift
This tree was written very fast and kept changing during this documentation pass. Re-run
`npm run typecheck`, `npm test`, `npm run build`, the seed and the web smoke test after it
settles, and update `TASKS.md`/`TESTING.md` with fresh output rather than trusting this
snapshot.

---

## 4. Definition of done — honest scorecard

| Master-prompt requirement | Status |
|---|---|
| Android and Web source exist and build successfully in the available environment | **PARTIAL** — Web builds (verified). Android typechecks but was **never built** (no JDK/SDK) |
| Core business workflows implemented, not demo-only | **YES on the server**; untested in a running UI |
| Farming end-to-end for crop/horticulture/livestock/poultry/aquaculture | **YES** for the shared engine, proven end-to-end for poultry + crop; no breeding or yield-type capture |
| Two users, one business, different roles, shared synced data; tenant isolation tested | **YES on the server and in the client protocol**; not proven across two physical devices |
| 2–5 partner onboarding + safe invitation | **YES on the server**; onboarding UI exists but is unverified |
| Offline records survive restart; durable outbox syncs idempotently; conflicts visible/recoverable | **Server: proven.** **Clients: code + unit/integration tests; the device restart e2e was NOT run** |
| Inventory reconciles to the ledger; posted events cannot duplicate | **YES** — derived balances, UNIQUE `event_id`/`idempotency_key`, integrity report, retry test |
| Input costs allocated once; partial-harvest costs and COGS correct; cash vs profit distinguished | **YES and tested** |
| Automated unit/integration/security/sync tests run; results documented | **YES** — 330 passing, transcript in `TESTING.md` |
| `.env.example` placeholders only; no secrets committed | **YES** |
| Free deployment and APK instructions tested as far as access permits; no mandatory paid dependency | **PARTIAL** — instructions only; nothing deployed; no APK; no free tier verified. Local (zero-cost) mode **was** verified |
| README, free deployment guide, backup/restore, limitations complete | **YES** — including a tested restore path |
| AI supports help, planning, suggestions and cited research where a provider is configured; pesticide guidance follows the guardrails | **PARTIAL** — all of it works and is tested **in fallback mode**; no live provider/search was tested; guardrails are prompt-level with no test |
| AI works with no mandatory paid service, reports its mode, respects permissions, fabricates no sources, cannot act | **YES on the server**; the "reports its mode" UI exists but is unverified on a device |
| Final handover states what works, exact commands and results, artifact path, manual steps | **YES** — APK path: **not generated** |
