# IMPLEMENTATION_PLAN.md

What was planned, what was actually delivered, and what is left — ordered by risk.
The 18 phases are the master prompt's own sequence (`MASTER_PROMPT.md` §14); `TASKS.md`
marks each one DONE / PARTIAL / NOT STARTED with evidence. This file is the narrative:
*why* the order, and *what comes next*.

Measured baseline (2026-10-14): `packages/domain` — 148 tests passing;
`apps/api` — 32 tests passing; root `npm test` exits non-zero because `apps/web` has no test
files; `npm run typecheck` passes for domain and api and fails for web. Full transcript in
`TESTING.md`.

---

## 1. The plan, and the reasoning behind it

The dependency order was chosen so that every phase's output is *testable without the
phase after it*:

```
correct money  →  inventory  →  accounting  →  tenancy  →  persistence  →  offline
   (decimal)      (ledger)       (journal)     (members)     (SQLite)        (outbox)
                                                                              │
                          farming costing ────────────────────────────────────┤
                          AI agent (reads only) ──────────────────────────────┤
                          clients (web / android) ────────────────────────────┘
```

Nothing downstream can be correct if the money arithmetic is wrong, so `decimal.ts` and
`money.ts` came first and are the most heavily tested modules. Accounting came before
tenancy because the ledger rules are the product's core promise and were worth locking down
with tests before any HTTP existed.

---

## 2. Delivered, phase by phase

### Phase 1 — Repository audit and plan — **DONE**
Inspected the workspace; found no prior Small Business Manager source to reconcile
(only unrelated sibling projects in the parent folder). Created the baseline
architecture/tasks/risk map and chose the monorepo shape over the master prompt's sketch
(collapsing 8 packages into 1 domain + 2 apps — recorded in `docs/DECISIONS.md`).

### Phase 2 — Foundation — **DONE**
npm workspaces, `tsconfig.base.json` (strict, `noUncheckedIndexedAccess`, `noImplicitOverride`,
`verbatimModuleSyntax`, `isolatedModules`), `.env.example`, `.gitignore`, root scripts.
**No CI** — there is no CI configuration in this repo; verification is local (the master
prompt permits this: "local verification must still be possible").

### Phase 3 — Auth and multi-partner tenancy — **DONE (except cloud RLS)**
`users`/`sessions`/`businesses`/`members`/`invites`/`audit_logs`; scrypt + HMAC-signed
`HttpOnly`/`Secure`/`SameSite=Lax` cookie sessions; business creation on register; invite
creation/redemption (120-bit code, SHA-256 at rest, 72 h TTL, single-use, optional email
binding, revocable); role and permission matrix with per-member grants/denials; ownership
guardrails; audit log. 7 roles × 53 permissions, enforced in the repository.
**Not done:** Supabase/Postgres RLS. Tenant isolation is application-level only.

### Phase 4 — Database and repository layer — **DONE (local only)**
Migrations v1–v6 (37 tables) tracked by `PRAGMA user_version`, applied in `BEGIN IMMEDIATE`,
rolled back on failure; FKs on, WAL, `busy_timeout`; re-entrant `transaction()`; atomic
per-business-per-day reference counter. `Repository` is the single SQL surface with posting
services for purchase, sale, receipt, supplier payment, transfer, income/expense, partner
capital, journal, farming event, harvest and allocation. **Not done:** the IndexedDB/SQLite
*client* stores, and the Postgres port.

### Phase 5 — Offline sync — **DONE on the server; PARTIAL end-to-end**
Outbox event shape, business-scoped idempotency keys, canonical payload hashing with
hand-rolled SHA-256, exactly-once application via `processed_events` in the same transaction
as the posting, revision-based conflict detection for 4 aggregate types, a conflict queue with
`LOCAL_WINS`/`SERVER_WINS` resolution, online-only guard for access/ownership events,
exponential backoff with ±25 % jitter capped at 15 min, and the 6-state status machine with
bilingual labels. Proven by 20 domain tests + 4 API tests.
**Not done / not verified:** the device-side durable outbox and sync worker.

### Phase 6 — Shared inventory, units, lots — **DONE**
Append-only `stock_movements` as the sole source of stock truth; derived balances; weighted-
average valuation with a **cost snapshot** per movement so historical COGS never changes;
negative stock refused with a permission+reason+audit override; FEFO/FIFO lot planning;
13 built-in unit dimensions including BD land (bigha/katha/decimal/shotangsho) and weight
(maund/seer) units; explicit, note-required cross-dimension conversions; incompatible-unit
rejection. 18 inventory + 11 units tests.

### Phase 7 — Purchases and sales — **DONE (core)**
Purchase and sale documents with lines, lot creation, atomic stock + journal posting in one
transaction, customer receipts and supplier payments, derived receivables/payables, discount
permission, negative-stock override, lists and CSV export.
**Not done:** purchase returns, sale returns, sale void, credit-limit enforcement.

### Phase 8 — Finance and accounting — **DONE (core)**
Fixed chart of accounts, transfers, income/expenses (paid or accrued), partner capital,
journal integrity (balanced, ≥2 lines, non-negative, known accounts), trial balance, P&L,
balance sheet, cash flow, partner capital balances and a **separately defined** cash-basis
operating result.
**Not done:** opening balances, bad debt, depreciation, loans/interest, period closing to
retained earnings, CSV/print reports beyond a generic table export.

### Phase 9 — Farming setup — **DONE**
Farms, typed units (plot/field/greenhouse/barn/pen/poultry house/pond/tank/other) with area
and capacity in real units, production cycles with reference/type/species/breed/season/
responsible member/planned output/starting population, 5 farming types with Bangla labels,
auto-enabling a farming type on first use, and farming-specific permissions
(`farm_manager` role).

### Phase 10 — Farming operations — **DONE (core)**
Operational events: input issue (priced at the weighted-average cost, single cost assignment),
direct labour/machinery/veterinary/utilities/packaging/transport/overhead, observations,
mortality and waste (with reason, book value and automatic escalation at ≥ 25 units),
internal use, and cycle closure with an optional final `CLOSING_REMAINDER` harvest.
**Not done:** scheduled/planned operations and "missed operation" alerts, breeding,
milk/egg yield capture as first-class outputs, transfer of animals between units.

### Phase 11 — Costing and sales integration — **DONE**
Batch cost ledger (`cycleCostToDate` = own costs + allocated shares), 7 allocation bases with
deterministic largest-remainder distribution and an explicit `unallocated` remainder,
rounding residual rule, partial-harvest costing (`PLANNED_YIELD_PRORATA` / `CLOSING_REMAINDER`)
with a cap at remaining cost-to-date, finished output created as **shared sellable stock**
linked to the harvest, COGS on sale from the cost layer, and a cycle profit report that
separates sold margin from cost in unsold stock and cost still in the batch. Full traceability
harvest → product → sale line.

### Phase 12 — Android and Web UX — **NOT DONE / PARTIAL**
At the time of measurement, `apps/web` contained a scaffold (`index.html`, `vite.config.ts`,
`tsconfig.json`, `vitest.config.ts`, `src/main.tsx`, `src/vite-env.d.ts`) and `apps/mobile` an
Expo scaffold (`app.json`, `app.config.ts`, `package.json`, `index.ts`, polyfills, babel/metro
config). Both were being written concurrently with this plan and **neither was verified to
build, run or render a screen**. There is no evidence of navigation, forms, dashboards, the
Bangla/English switch or the PWA offline shell in a running app.
**This is the largest visible gap** — the backend is a working, tested service and there is
essentially no verified UI in front of it.

### Phase 13 — AI agent foundation — **DONE (server)**
`AIProvider`/`ResearchProvider` interfaces, three modes, the offline rule engine,
secret-safe configuration, permission-scoped context builder, Bangla/English answer support,
and per-business+user rate limits.
**Not done:** the AI chat screen in either client.

### Phase 14 — AI research and safety — **PARTIAL**
Curated official-source fallback with honest labelling, source classification
(OFFICIAL/RESEARCH/RETAILER/USER_REVIEW/CURATED_LINK), citation validation, research caching
with a TTL, saved plans (as `DRAFT`), feedback, conversation soft-delete, and the agricultural
safety prompt rules plus the structural "AI cannot post" guarantee.
**Not done:** a live search provider is not configured or tested; there are **no tests** for
prompt-injection resistance, dose/PHI/REI refusal, citation-URL validation or provider
timeouts (see `AI_AGENT_DESIGN.md` §11.2).

### Phase 15 — Exports and backup — **PARTIAL**
`GET /api/reports/export/:table` (10-table allowlist → CSV with a UTF-8 BOM, so Bangla opens
correctly in Excel), `GET /api/reports/backup` (a full per-business JSON dump across ~30
tables), a daily partial JSON snapshot job, and `report.export`/`backup.manage` permissions.
**Not done:** a restore path (there is no import endpoint), a documented restore drill, PDF/
printable reports, attachment export, and the CSV export is not audited.

### Phase 16 — Quality and security pass — **PARTIAL**
180 automated tests passing (148 domain + 32 API) covering tenant isolation, permissions,
idempotency, conflict detection, negative stock, rate limiting, audit and AI permission
scoping. **Not done:** no dependency/SCA audit tooling, no linter configured in the repo, no
CI, no accessibility pass, no frontend tests, and the two findings in `SECURITY.md` §11.1–11.2
are open (sync-pull cost leakage; admin self-granting `business.transfer_ownership`).

### Phase 17 — Free deployment preparation — **PARTIAL**
`.env.example` complete with zero-credential local defaults; local run verified (startup line
and `/api/health` captured); seed verified; `DEPLOYMENT_FREE.md` written with exact commands for
local mode, a user-owned Supabase free tier, static hosting, three no-cost AI routes, and APK
sideloading. **Not done:** nothing was deployed, no free tier was verified against a live
provider, no APK was produced.

### Phase 18 — Final verification and handover — **DONE (documentation)**
README, TASKS, ARCHITECTURE, DATABASE_SCHEMA, SYNC_DESIGN, SECURITY, TESTING,
DEPLOYMENT_FREE, ACCOUNTING_RULES, AI_AGENT_DESIGN and `docs/` written from the code and from
real command output. Every claim is either backed by a file/test/command or explicitly marked
unverified.

---

## 3. Remaining work, ordered by risk

Risk = (likelihood of causing real money/business harm) × (how hard it is to notice).

### R1 — Critical: a client UI does not exist (verified)
Nothing has been seen to run in a browser or on Android. The API is genuinely usable by
`curl`, and the whole product is only half-built from a user's point of view.
**Next:** get `apps/web` to `npm run build` cleanly, then a single vertical slice
(login → dashboard → record a sale → see it in the trial balance) before adding breadth.
Verify offline in the browser (IndexedDB + service worker) before claiming offline support.

### R2 — Critical: `shared` mode is a promise with no code
`SBM_MODE=shared` changes nothing except a status string and a stricter secret rule.
Multi-partner "across the internet, each on their own account/devices" — the master prompt's
central requirement — works today only if a partner hosts the one Node server themselves.
**Next, in order:**
1. define a `RepositoryPort` interface that the current `Repository` satisfies;
2. write the Postgres implementation of the same methods over Supabase;
3. **add RLS policies on every tenant table** and test them from a second tenant's session
   (the master prompt is explicit that UI-only restriction is not security);
4. migration + seed scripts under `supabase/`; keep `numeric`, never `float`.

### R3 — High: `GET /api/sync/pull` leaks cost data to low-privilege members (verified in code)
A `viewer`/`cashier` deliberately denied `financial_reports.view` or `purchase.cost.view` can
pull journal lines and `unit_cost` for the whole business. This directly defeats the owner's
cost-visibility setting. **Next:** permission-filter the pull payload (or exclude cost columns
for roles without the cost permissions) and add a test asserting a cashier's pull contains no
cost fields.

### R4 — High: an admin can self-grant `business.transfer_ownership` (verified in code)
`updateMember` does not restrict which permissions may be granted, and `permissionsFor` applies
grants unconditionally, so `member.manage` (held by admin) is enough to escalate to owner
powers. **Next:** forbid granting a permission the caller does not itself hold, and add a test.

### R5 — High: no tests for the highest-risk AI behaviour
The dose/PHI/REI refusal, prompt-injection resistance and citation-URL validation are the
safety-critical parts of the AI feature and are **only** prompt-enforced, with no test.
**Next:** add tests for `validateCitations` (rejects `javascript:`/malformed), for a
`FarmingError`-style refusal when a chemical question has no official source, and for the
provider-timeout fallback path.

### R6 — Medium: `FarmingError` can surface as HTTP 500
`NO_TARGETS`/`ZERO_BASIS`/`OVER_ALLOCATION` are client-input errors but are not in the
`server.ts` error classifier, so they can become `500 INTERNAL`. **Next:** one-line classifier
fix + a test for an over-allocated shared cost.

### R7 — Medium: `stock.move` / `journal.post` are high-risk events with no server handler
A device that queues one gets `REJECTED: Unsupported sync event type`. **Next:** either
implement the two handlers or remove them from `HIGH_RISK_EVENTS` so the client cannot offer
them.

### R8 — Medium: reference-number collision on manual entry
`UNIQUE (business_id, reference)` on `sales`/`purchases` means two devices that both type the
same manual reference get a `500`-looking failure rather than a clean `409`. **Next:** map the
unique-constraint violation to `409 DUPLICATE_REFERENCE` and surface "use a different
reference" in the UI.

### R9 — Medium: rounding is exact but *display* uses floats in one place
`GET /api/accounts` aggregates with `toNumber()` for the chart-of-accounts screen. Harmless at
small magnitudes, wrong at large ones. **Next:** sum with `Decimal` and format at the end.

### R10 — Medium: attachments are effectively write-only and unvalidated
No download endpoint, MIME taken from the client header, no malware scan, no delete, and
`checksum` never re-verified. **Next:** add a permission-checked download, verify magic bytes
(the sibling SFUWT project already has this code to borrow), and add delete/retention.

### R11 — Low/Medium: Android APK not built
No JDK or Android SDK in this environment. `apps/mobile` declares `apk:debug`/`apk:release`
scripts and `eas.json`, but nothing was compiled. **Next:** install JDK 17 + Android SDK (or
use `eas build` with a free Expo account), run `expo prebuild` then
`gradlew assembleRelease`, and sideload — never require Play Store.

### R12 — Low: gaps in the audit and backup story
Failed logins, logouts, attachments, AI Q&A and **CSV exports** are not audited; `backup.manage`
has no restore counterpart; the daily snapshot overwrites itself, keeps no history and is
partial. **Next:** audit the missing events, add a retention policy, and document (and test) a
restore drill.

### R13 — Low: dead schema and unused columns
`devices`, `product_categories`, `financial_accounts`, `businesses.settings`,
`farms.latitude/longitude`, `products.deleted_at`, `customers/suppliers.opening_balance`.
**Next:** wire up or drop; an unused table that *looks* implemented is worse than no table.

### R14 — Low: documentation drift risk
`apps/mobile` and `apps/web` are moving targets. Re-run `npm run typecheck`, `npm test` and the
seed after they settle, and update `TASKS.md`/`TESTING.md` with the fresh output rather than
trusting this snapshot.

---

## 4. Definition of done — honest scorecard

| Master-prompt requirement | Status |
|---|---|
| Android and Web source exist and build successfully in the available environment | **NO** — scaffolds exist; `apps/web` does not typecheck; no Android build attempted |
| Core business workflows implemented, not demo-only | **YES** on the server (purchase/sale/payment/expense/transfer/capital/reports/journal), untested in a UI |
| Farming end-to-end crop/horticulture/livestock/poultry/aquaculture | **PARTLY** — one engine covers all five types; proven end-to-end by tests for poultry/crop; horticulture/livestock/aquaculture differ only by labels; no breeding or yield-type capture |
| Two users join one business, different roles, shared synced data; tenant isolation tested | **YES on the server** (`api.test.ts`); no cross-device client evidence |
| 2–5 partner onboarding + safe invitation | **YES** on the server; onboarding UI not built |
| Offline records survive restart; durable outbox syncs idempotently; conflicts visible/recoverable | **Server side YES and tested; device side NOT VERIFIED** |
| Inventory reconciles to the ledger; posted events cannot duplicate | **YES** — derived balances + unique `event_id`/`idempotency_key` |
| Input costs allocated once; partial-harvest costs and COGS correct; cash vs profit distinguished | **YES and tested** |
| Automated unit/integration/security/sync tests run; results documented | **YES** — 148 + 32 passing, real output in `TESTING.md` |
| `.env.example` placeholders only; no secrets committed | **YES** |
| Free deployment and APK instructions tested as far as access permits; no mandatory paid dependency | **INSTRUCTIONS ONLY** — nothing deployed, no APK, no free tier verified |
| README, free deployment guide, backup/restore, limitations complete | **YES** for README/deployment/limitations; restore is documented as missing |
| AI supports help, planning, contextual suggestions and cited research where a provider is configured; pesticide guidance follows the guardrails | **Server side YES** in fallback mode; no live provider was tested; guardrails are prompt-level with no test |
| AI works with no mandatory paid service, reports its mode, respects permissions, fabricates no sources, cannot act | **YES except "reports its mode" is a UI requirement not yet built** |
| Final handover states what works, exact commands and results, artifact path, manual steps | **YES** |
