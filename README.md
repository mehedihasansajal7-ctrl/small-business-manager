# Small Business Manager — with a complete Farming module

An **offline-first** business + farm management system for a small business owned by
**2–5 partners in Bangladesh**. Each partner signs in with their own account on their own
device and shares the same business data according to their role.

**Zero mandatory cost.** No paid hosting, no paid AI, no paid API, no Play Store, no card.
Every layer has a free path — and the app works with **no accounts and no cloud at all**.

> ## 📌 Documentation snapshot
> Everything here was measured on **2026-10-14** against the working tree at that time. The
> repository was being actively written while these documents were prepared, so numbers can
> move. **Re-run the commands in [`TESTING.md`](./TESTING.md) — the commands are the
> authority, not this prose.** Where something is unverified, it is labelled as such in
> every document.

---

## 1. What it does

### Core business
Products/services catalog with units and conversions · purchases and supplier bills ·
payables · POS/sales with discounts and permissions · customers · receipts ·
receivables · inventory as an append-only ledger with weighted-average valuation ·
stock transfers between locations · stock counts and reason-coded adjustments ·
cash / bank / **MFS (bKash-style mobile financial service)** accounts · income & expenses ·
account transfers · partner capital and drawings · opening balances ·
**double-entry** journal · reports (trial balance, P&L, balance sheet, cash flow, stock
valuation, receivables, payables, integrity/reconciliation) · CSV export · JSON backup
**and restore** · audit log.

### Farming (the same app, separate navigation and permissions)
Crop · horticulture/greenhouse · livestock · poultry · aquaculture. Farms → units
(plot, field, greenhouse, barn, pen, poultry house, pond, tank) → production cycles/batches.
Input issue from shared stock · labour · machinery/fuel · veterinary · utilities · packaging ·
transport · overhead · observations · mortality & waste (with escalation) · partial and final
harvest · **finished output becomes sellable stock traced back to the cycle** · shared-cost
allocation across cycles with no lost poysha · batch cost ledger · cycle profitability.

### AI Agent
A chat assistant in Bangla/English that explains, plans, flags problems in *your* authorised
data, and researches fertilizer/pesticide/livestock questions with **cited** sources. It
**cannot post anything** — every answer is a suggestion you review and confirm. It runs with
no paid service at all (deterministic rules + curated government/FAO links), or with a model
you run yourself, or with any OpenAI-compatible endpoint you have free access to.

### Bangla + English
Bilingual by construction: Bangla names for accounts, units, roles, statuses and dates,
Bangla digits (`৳১২,৩৪,৫৬৭.৮৯`), and **South-Asian lakh/crore grouping** for BDT/INR.
Defaults are `BDT`, `en` (English initial language, Bangla one tap away), `Asia/Dhaka`.

---

## 2. Zero-cost policy (how it is actually enforced)

| Rule | Where it bites |
|---|---|
| No paid service is a **mandatory** dependency | `SBM_MODE=local` needs no account, no key, no network. `AI_PROVIDER=none` is the default |
| No billing configuration exists in the code | there is no upgrade call, no paid fallback, no card handling anywhere |
| Local development mode needs **no credentials** | verified: the API boots and answers `/api/health` with an empty environment |
| Optional integrations are off by default | AI and web research are `none` until you set them |
| The free tier is never called "free forever" | see [`docs/FREE_TIER_LIMITS.md`](./docs/FREE_TIER_LIMITS.md) — limits change, and it says so |
| Never bundle a secret in a client | the AI key and the Supabase service-role key are server-side only |

**The honest caveat:** this project has **never been deployed by its author** and no free tier
was verified against a live provider. [`DEPLOYMENT_FREE.md`](./DEPLOYMENT_FREE.md) is
instructions, not a record of a live deployment. Read its warning box first.

---

## 3. Architecture at a glance

An npm-workspaces TypeScript monorepo, ES modules throughout:

```
small-business-manager/
├── packages/domain/     @sbm/domain  — PURE logic: zero deps, zero I/O, isomorphic
│                                        Decimal · money · units · inventory ledger
│                                        double-entry accounting · farming costing
│                                        permissions · tenancy · offline sync · validation
├── apps/api/            @sbm/api     — zero-runtime-dependency Node HTTP API over
│                                        embedded SQLite (node:sqlite), scrypt auth,
│                                        idempotent sync service, AI gateway
├── apps/web/            @sbm/web     — Vite + React SPA / PWA (offline outbox on IndexedDB)
├── apps/mobile/         @sbm/mobile  — Expo / React Native Android app (offline outbox on SQLite)
├── supabase/            @sbm/supabase— PostgreSQL/Supabase port: migrations, RLS policies,
│                                        transactional posting RPCs, seed, static tests
└── docs/                            — ROADMAP · FREE_TIER_LIMITS · PARTNER_GUIDE_BN · DECISIONS
```

The **one architectural rule**: `packages/domain` is pure and isomorphic, so the *same*
money arithmetic, the *same* inventory rules and the *same* permission checks run on the
phone, in the browser and on the server. A poysha cannot disagree between two devices.
See [`ARCHITECTURE.md`](./ARCHITECTURE.md).

Two storage modes:

| | `local` (works today) | `shared` (Postgres/Supabase) |
|---|---|---|
| Storage | embedded `node:sqlite` file — **no credentials** | PostgreSQL with **RLS on every tenant table** |
| Use it when | one machine hosts it; partners on the same network | partners in different places, each on their own account |
| Code | `apps/api/src/db.ts` (migrations v1–v6) | `supabase/migrations` + `supabase/functions` (9 posting RPCs) |

---

## 4. Prerequisites

| Requirement | Why | Verified here |
|---|---|---|
| **Node ≥ 22.5** (`engines.node`) | the API uses the built-in **`node:sqlite`**; Node 20/18 will fail at import | Node **v24.19.0**, npm **11.17.0** |
| npm ≥ 10 (bundled with Node 22+) | npm workspaces | npm 11.17.0 |
| A modern browser | the web app, and the PWA install prompt | not exercised |
| **JDK 17 + Android SDK** (only for the Android APK) | Expo `prebuild` + Gradle | ⚠️ **not installed here — no APK was built** |
| Nothing else | no Docker, no database server, no cloud account | — |

---

## 5. Install, run, build, test — the exact commands

All commands are run from `small-business-manager/`.

```bash
# 1. install (once; npm workspaces)
npm install

# 2. type-check every workspace
npm run typecheck          # builds @sbm/domain first, then tsc --noEmit in each workspace

# 3. run the whole test suite
npm test                   # builds @sbm/domain, then vitest in every workspace

# 4. build everything (domain → api → web)
npm run build
```

### Run it

```bash
# API  (http://127.0.0.1:8787)
npm run api                # = build @sbm/domain, then node apps/api/dist/server.js
npm run api:dev            # watch mode via node --experimental-strip-types

# Web app (http://localhost:5173, proxies /api → 127.0.0.1:8787)
npm run web:dev

# Android (Expo)
cd apps/mobile && npm install && npm run android
#   the API base URL defaults to http://10.0.2.2:8787 (the emulator's alias for your host).
#   For a physical phone on the same Wi-Fi, point it at your machine's LAN IP:
#     EXPO_PUBLIC_API_URL=http://192.168.0.20:8787 npm run android
```

### Keeping the server up (auto-restart)

```bash
npm run api:watchdog                        # supervisor, prints to the terminal
scripts\server-control.cmd status|start|stop|restart
scripts\reset-password.mjs <email>          # owner lockout, no sign-in needed
```

The supervisor is what runs at logon on the authoring machine (the Startup entry
`SBM-API-Server.cmd` calls `scripts\serve-lan-task.cmd`, which now runs the
watchdog). It does three things:

| Situation | What happens |
|---|---|
| The server process dies (crash, killed, out of memory) | restarted with backoff 2s → 5s → 10s → 20s → 30s → 60s; the backoff resets after a minute of uptime |
| The process is alive but wedged | `/api/health` is probed every 30s; three failures in a row kill and restart it |
| Ten fast crashes in a row | waits 5 minutes before the next attempt instead of spinning, then keeps trying |

`stop` is deliberate and is never overridden: it writes `data/server.stop`, the
watchdog stops the child and exits. Logs go to `data/server.log`.

> Environment is **optional** in local mode. `.env` is read from the repo root or
> `apps/api/`; existing process env always wins. Copy [`.env.example`](./.env.example)
> to change the port, `DATA_DIR`, timezone, session secret or AI providers.
> In `local` mode, an unset `SESSION_SECRET` is generated once and kept in
> `DATA_DIR/.session_secret` (mode `0600`) so sessions survive restarts.

### Demo data and its sign-in

```bash
npm run seed                        # writes to DATA_DIR
node apps/api/dist/seed.js --memory # throw-away in-memory demo (no files written)

cd supabase && npm test             # static checks on the Postgres migrations + RLS
```

The seed creates a realistic business — *Rahim Agro & General Store* — with 3 partners, a
shop (purchase, cash sale, credit sale, receipt, expenses, transfer) and a full broiler cycle
(feed purchase → input issue → labour/vet/utilities → mortality → observation → shared-cost
allocation → harvest → sale → cycle profit), then prints a summary **and runs the integrity
report**.

| Role | Email | Password |
|---|---|---|
| owner | `owner@demo.sbm` | `demo1234` |
| manager | `partner@demo.sbm` | `demo1234` |
| farm_manager | `farm@demo.sbm` | `demo1234` |

> These are **demo credentials for locally seeded data only**. They are not a secret and not
> a production account. Create real users by registering; the seed is idempotent and does
> nothing if the demo user already exists.

---

## 6. Feature status — done / partial / not built

Verified means: a test, a build or a captured command output proves it. See
[`TESTING.md`](./TESTING.md) for the transcript.

| Area | Status | Evidence / limitation |
|---|---|---|
| Exact decimal money (`Decimal`, bigint-backed) | **DONE** | 13 decimal + 10 money tests |
| Units + BD land/weight units (bigha, katha, decimal, maund, seer) | **DONE** | 11 tests; incompatible units refused |
| Append-only inventory ledger + weighted average with cost snapshots | **DONE** | 18 tests; negative stock → `409` |
| Double-entry journal + sale/purchase/receipt/payment/transfer/capital/opening templates | **DONE** | 24 accounting tests; trial balance balances |
| Farming costing: input issue, allocation, partial harvest, cycle profit | **DONE** | 13 farming tests + end-to-end API tests |
| Roles + 53 permissions across 7 roles, per-member grants/denials | **DONE** | 16 tests; enforced server-side; 403 otherwise |
| Tenancy: business workspace, invites, membership, audit log | **DONE** | invite entropy/expiry/single-use tests; isolation tests |
| Offline sync — **server** (idempotency, revisions, conflicts, backoff) | **DONE** | 20 domain + sync/security API tests |
| Offline sync — **web + Android clients** (durable outbox, worker) | **PARTIAL** | code exists and the web outbox has 17 tests incl. a protocol integration test; **no restart-kill e2e was run by the author** |
| Web app (16 screens, routing, i18n, offline, PWA manifest + service worker) | **BUILDS** | `vite build` → `dist/` (351 kB JS / 101 kB gzip); **never opened in a browser here** |
| Android app (Expo, 41 screens, SQLite offline store) | **CODE PRESENT** | typechecks as part of the repo; ⚠️ **no APK built, never run on a device or emulator** |
| Postgres/Supabase port with RLS on every tenant table | **CODE + STATIC TESTS** | 7 migrations, 148 `CREATE POLICY` statements, 9 posting RPCs, 38 static tests; ⚠️ **never executed against a live Postgres** |
| AI agent: 3 modes, offline fallback, curated official links, permission-scoped context | **DONE** | API tests for fallback labelling, curated links, cost redaction, permission denial |
| AI: live search provider, prompt-injection test, dose/PHI refusal test | **NOT BUILT / NOT TESTED** | guardrails are prompt-level; see `AI_AGENT_DESIGN.md` §11.2 |
| Backup (JSON) **and restore** | **DONE** | restore is owner-only, empty-workspace-only, re-keys ids, refuses an unbalanced backup |
| Return/void of a posted document | **DONE** | `sale.void` / purchase return via audited reversal; posted rows are never edited |
| Reports: trial balance, P&L, balance sheet, cash flow, stock valuation, integrity | **DONE** | API tests + integrity report is a real reconciliation self-audit |
| Reports: printable output | **PARTIAL** | `GET /api/reports/print/:report` returns print-ready HTML (tested); there is **no** server-side PDF generator — use the browser's print-to-PDF |
| Bad debt, depreciation, loans/interest, period close to retained earnings | **NOT BUILT** | accounts exist; no policy, no endpoint — deliberately not faked |
| Payroll | **NOT BUILT** | `payroll.view`/`manage` permissions exist; no feature |
| CI configuration | **NOT BUILT** | local verification only (permitted by the spec) |
| Linter | **PARTIAL** | `apps/mobile` has an eslint config; the other workspaces do not |
| Deployment of any kind | **NOT DONE** | nothing is live anywhere; no APK artifact |

---

## 7. The UI, described without screenshots

**Web (`apps/web`)** — a responsive single-page app. A **top bar** carries the business
name/switch, the online/offline **sync status chip** ("Pending", "Syncing", "Synced",
"Needs attention", "Conflict" — with Bangla equivalents), the language switch and sign-out.
A **left navigation** (a bottom bar on narrow screens) has: Dashboard · Sales · Purchases ·
Inventory · Customers · Suppliers · Finance · Farming · Reports · Team · AI · Settings.
Screens are lists + forms: searchable tables, money right-aligned and formatted with
`৳` and South-Asian grouping, a date-range picker on every report, and explicit
loading / empty / error states. Destructive and high-risk actions ask for confirmation.
The **Sales editor** is a line-item grid with a running total, discount and a
cash-received field; a sale that would drive stock negative is refused with a clear message
and only proceeds with an explicit override plus a written reason. The **Conflicts** screen
lists diverged records with who/when/which device and offers *server wins* / *local wins*.
The **AI screen** always shows a mode badge (`fallback` / `local` / `generative`) beside
every answer, renders citations as openable source cards with a publisher and a
`CURATED_LINK` / `OFFICIAL` / `RETAILER` label, and offers *save as draft plan* and
*helpful / not helpful*. A PWA manifest and a service worker make it installable
("Add to Home Screen") with an offline app shell.

**Android (`apps/mobile`)** — a native-feeling stack navigator with a bottom tab bar:
Dashboard · Sales · Inventory · Farming · More. Forms use large touch targets and numeric
keypads; money is formatted with the same `@sbm/domain` formatter as the web app (the app
never uses `Number()` on an amount). An **OfflineBanner** sits at the top of every screen,
a **SyncStatusScreen** shows the queue by state with a *Sync now* action and the last
successful sync time, and a **PermissionGate** hides or disables actions the role lacks
(the server enforces them regardless). A photo picker attaches a receipt to a document —
and the UI states plainly that attachments are **not** shared with partners who are
offline. Location, microphone and contacts permissions are explicitly **blocked** in the
manifest.

Both clients are Bangla/English switchable at runtime, and both are permission-aware: a
user who lacks a permission sees the action disabled with an explanation rather than a
failure.

---

## 8. Honest limitations

Read these before trusting the app with money.

1. **Nothing is deployed.** No URL, no APK, no live database. See
   [`DEPLOYMENT_FREE.md`](./DEPLOYMENT_FREE.md).
2. **No Android APK was produced** — this environment has no JDK or Android SDK. The Expo
   project, the Gradle scripts (`apk:debug`/`apk:release`) and `eas.json` are in place.
3. **The Postgres migrations have never run against a live PostgreSQL.** The RLS policies
   are asserted by static SQL tests, not by a live second-tenant query.
4. **The web and Android UIs were never exercised on a device here.** They typecheck and the
   web app builds; that is not the same as "it works".
5. **Two known security findings are open** (both provable from the code):
   `GET /api/sync/pull` is not permission-filtered, so a low-privilege member can read cost
   columns and journal lines; and `member.manage` does not restrict *which* permissions may
   be granted, so an admin can self-grant `business.transfer_ownership`.
   See [`SECURITY.md`](./SECURITY.md) §11.
6. **Not formal accounting.** No tax, VAT, BFRS/IFRS/IAS compliance, no statutory returns.
   It is a management ledger. See [`ACCOUNTING_RULES.md`](./ACCOUNTING_RULES.md).
7. **Several features from the specification are deliberately absent** and are listed as
   such rather than stubbed: payroll, a server-side PDF generator (a print-ready HTML view
   does exist), bad debt, depreciation, loans,
   period closing, sales/purchase *returns as separate documents* (voiding exists), breeding/
   biological-asset valuation, scheduled-operation alerts, and AI conversation export.
8. **No CI, no dependency/SCA scanning, no penetration test, no accessibility audit.**
9. **The rate limiter is per-process and in-memory**; the embedded SQLite file assumes a
   single API instance. Running multiple replicas is not supported.
10. **Backups are the owner's job.** The built-in daily snapshot is partial and overwrites
    itself for the same date; use `GET /api/reports/backup` and test a restore.
11. **Free tiers change and can pause.** A paused database stops sync; the client keeps its
    outbox. Verify every quota yourself — nothing in
    [`docs/FREE_TIER_LIMITS.md`](./docs/FREE_TIER_LIMITS.md) was checked against a provider.

---

## 9. Documentation map

| Document | Read it for |
|---|---|
| [`MASTER_PROMPT.md`](./MASTER_PROMPT.md) | the governing specification (verbatim) + short status |
| [`TASKS.md`](./TASKS.md) | all 18 phases marked DONE/PARTIAL/NOT STARTED with evidence; blocked items; the Definition-of-Done checklist |
| [`IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md) | what was delivered per phase, and remaining work **ordered by risk** |
| [`ARCHITECTURE.md`](./ARCHITECTURE.md) | module boundaries, why the domain package is pure, request lifecycle, error mapping, jobs, local vs shared |
| [`DATABASE_SCHEMA.md`](./DATABASE_SCHEMA.md) | every SQLite table and column, why it exists, and how the Postgres port corresponds |
| [`SYNC_DESIGN.md`](./SYNC_DESIGN.md) | the outbox, idempotency, exactly-once application, conflict rules, backoff numbers, status machine |
| [`SECURITY.md`](./SECURITY.md) | auth, the full permission matrix, invites, tenant isolation, and the open findings |
| [`TESTING.md`](./TESTING.md) | how to run everything, the real results, and what is NOT covered |
| [`DEPLOYMENT_FREE.md`](./DEPLOYMENT_FREE.md) | beginner, zero-cost setup: local, Supabase free, static hosting, free AI, APK sideload |
| [`ACCOUNTING_RULES.md`](./ACCOUNTING_RULES.md) | chart of accounts, the journal template for every event, valuation and costing rules |
| [`AI_AGENT_DESIGN.md`](./AI_AGENT_DESIGN.md) | provider modes, source-quality policy, agricultural safety, retention, limits |
| [`docs/DECISIONS.md`](./docs/DECISIONS.md) | 11 ADRs: why bigint decimals, `TEXT` money, `node:sqlite`, an outbox, curated links, Farm/Unit/Cycle |
| [`docs/ROADMAP.md`](./docs/ROADMAP.md) | milestones 0–8 with exit criteria |
| [`docs/FREE_TIER_LIMITS.md`](./docs/FREE_TIER_LIMITS.md) | the limits table (⚠️ unverified) and what happens at each limit |
| [`docs/PARTNER_GUIDE_BN.md`](./docs/PARTNER_GUIDE_BN.md) | **বাংলা** guide for the actual partners |

Sub-package notes: [`apps/api/README.md`](./apps/api/README.md),
[`apps/web/README.md`](./apps/web/README.md),
[`apps/mobile/README.md`](./apps/mobile/README.md),
[`supabase/README.md`](./supabase/README.md).

---

## 10. Licence / outward assumptions

The chart of accounts, the accounting templates and the farming model are **management-accounting
choices made by this project**, not standards. Agricultural guidance is **not** a substitute
for a licensed veterinarian or your local agricultural extension officer, and the AI is
structurally incapable of applying a chemical, moving stock or posting a transaction.
No claim of regulatory compliance is made anywhere in this repository.
