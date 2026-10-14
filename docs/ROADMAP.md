# ROADMAP.md

Ordered so that each step makes the product *usable by a real partner* sooner. Dependency
notes are explicit. Nothing here is a promise of a date.

Current honest baseline (2026-10-14): the **server** is a working, tested service (148 domain
+ 32 API tests passing); there is **no verified user interface**; nothing is deployed.

---

## Milestone 0 — Make what exists honest and safe (days, not weeks)

Small, cheap, and each one removes a way this project could embarrass its owner.

| # | Task | Why | Done when |
|---|---|---|---|
| 0.1 | Fix `GET /api/sync/pull` cost leakage | a viewer/cashier can currently read journal lines and `unit_cost` (SECURITY §11.1) | a cashier's pull contains no cost field; a test proves it |
| 0.2 | Restrict `member.manage` grants | an admin can currently self-grant `business.transfer_ownership` (SECURITY §11.2) | you cannot grant a permission you do not hold; a test proves it |
| 0.3 | Map `FarmingError` to 400 | `OVER_ALLOCATION`/`ZERO_BASIS` can surface as 500 | a test asserts 400 for an over-allocated shared cost |
| 0.4 | Return 409 on a duplicate `reference` | two devices typing the same invoice number currently get a 500-shaped failure | the API returns a clean 409 with a usable message |
| 0.5 | Re-run and record the full verification | `apps/web`/`apps/mobile` are moving targets; the current numbers may be stale | `TESTING.md` updated with fresh output |
| 0.6 | Decide on the dead schema | `devices`, `product_categories`, `financial_accounts`, `businesses.settings`, `farms.latitude/longitude` | each is either wired up or dropped |

## Milestone 1 — One verified vertical slice of UI

**Why first:** a tested backend with no screen is not a product, and every UI decision made
before a slice exists tends to be wrong.

| # | Task | Notes |
|---|---|---|
| 1.1 | Get `npm run web:build` green | `tsc` currently fails in `apps/web` (no sources at measurement time) |
| 1.2 | Login → business creation → dashboard | the smallest end-to-end path that touches auth, tenancy and reports |
| 1.3 | Record a sale | includes the negative-stock 409 path and the "review before confirm" flow |
| 1.4 | See it in the trial balance and P&L | proves the ledger is wired to the UI, not to a dashboard formula |
| 1.5 | Bilingual switch + `৳12,34,567.89` formatting | `formatMoney(..., {banglaDigits})` and `formatDateBn` already exist and are tested |
| 1.6 | Sync status chip (Offline/Pending/Syncing/Synced/Needs attention/Conflict) | `syncBanner()` and `SYNC_STATUS_LABEL` are already bilingual and tested |

**Exit criterion:** a partner can sign in, record a sale, and see the accounting result
update — with the mode/status indicators honest.

## Milestone 2 — Real offline on the device

The server side of sync is done and tested (20 domain + 4 API tests). What is missing is the
**client** half: durable local persistence and the outbox worker. The rule for this milestone
is to pick **one** action — "record a sale" — make it work end to end with real persistence and
a real outbox, prove duplicate-safety across a simulated crash, and only then generalise.

| # | Task | Notes |
|---|---|---|
| 2.1 | Durable local store (IndexedDB / SQLite) written in the **same transaction** as the record change | the contract the server already assumes |
| 2.2 | The sync worker: drain the outbox, apply backoff/jitter, honour `nextAttemptAt` | `retryDelayMs`, `shouldRetry`, `statusAfterFailure` already exist and are tested |
| 2.3 | Never show a high-risk event as posted before `SYNCED` | `isConfirmed()`, `HIGH_RISK_EVENTS` exist |
| 2.4 | Conflict screen | `analyseFieldConflict` + `MERGEABLE_FIELDS` exist; the server must start reporting real `differingFields` (SYNC_DESIGN §5.2) |
| 2.5 | Test: kill the app mid-sync, relaunch → no duplicate, no loss | the master prompt's end-to-end checklist |
| 2.6 | Test: two devices sell the last 10 kg concurrently → one succeeds, one gets a visible conflict | the negative-stock guard is already server-side |
| 2.7 | Implement or remove `stock.move` / `journal.post` from `HIGH_RISK_EVENTS` | SYNC_DESIGN §7.1 |

**Exit criterion:** the master prompt's manual e2e checklist
(register owner → invite 2 partners → sales on two devices → disconnect → reconnect → no
duplicates) passes with evidence.

## Milestone 3 — Shared cloud mode (the multi-city case)

Only needed if partners are not on the same network. **This is the largest remaining piece
and it is where the security requirement is strictest.**

| # | Task | Notes |
|---|---|---|
| 3.1 | Extract a `RepositoryPort` interface that today's SQLite `Repository` satisfies | makes the seam a compiled contract, not a convention (ARCHITECTURE §7.2) |
| 3.2 | Postgres/Supabase implementation of that interface | `numeric` for money, never float; keep both `UNIQUE` constraints |
| 3.3 | `supabase/migrations` + `seed.sql` | a direct translation of migrations v1–v6 |
| 3.4 | **RLS policies on every tenant table** and a second-tenant test suite | the master prompt: "UI-only access restrictions are not security" |
| 3.5 | Never ship the service-role key to a client; anon key only, protected by RLS | already the documented rule |
| 3.6 | Restore/backup against the cloud database | there is no restore path today at all |

**Exit criterion:** two businesses' sessions cannot see or mutate each other's rows **even
with the API bypassed** (i.e. RLS proven, not just app code).

## Milestone 4 — Android that a partner can install

| # | Task | Notes |
|---|---|---|
| 4.1 | Install JDK 17 + Android SDK (or use a free Expo account with `eas build`) | no APK was produced here because neither is present in this environment |
| 4.2 | `expo prebuild` + `gradlew assembleRelease`, sign with a local keystore | `apps/mobile` already declares `apk:debug`/`apk:release` |
| 4.3 | Sideload and test on a real cheap phone | must work on a low-end device, not just an emulator |
| 4.4 | PWA installability on the web build | manifest + service worker + offline app shell |
| 4.5 | Bangla IME/typing and small-screen testing | a Bangla-first product must be usable in Bangla |

**Explicitly out of scope forever:** Google Play publication. It costs money and is not
required.

## Milestone 5 — Farming depth

| # | Task | Notes |
|---|---|---|
| 5.1 | Species-specific typed children beside `observations` | e.g. water-quality parameters with safe ranges, lactation, weight-growth curves |
| 5.2 | Scheduled/planned operations + "missed operation" alerts | the master prompt lists this; nothing implements it |
| 5.3 | Milk/egg/wool as first-class output types with their own units and yield metrics | `outputPerAnimal()` exists but there is no capture UI/type |
| 5.4 | Livestock transfer between units (animals moving, not stock) | needs its own event type |
| 5.5 | Breeding/birth events and offspring valuation | **requires a written policy first** — the master prompt forbids inventing biological accounting |
| 5.6 | IAS-41-style fair value (optional, off by default) | do not approximate with a journal entry |
| 5.7 | Alerts: expected harvest, low inputs, expiry, high mortality, unpaid bills, overdue receivables | the master prompt lists these; only low-stock and mortality-threshold exist |

## Milestone 6 — Accounting and reporting completeness

| # | Task | Notes |
|---|---|---|
| 6.1 | Returns: sales returns (`4910`), purchase returns | accounts exist; **no endpoint, no policy** |
| 6.2 | Opening balances | `finance.opening_balance` permission exists; no endpoint, and `customers/suppliers.opening_balance` is not folded into receivables/payables |
| 6.3 | Bad debt (`5500`), depreciation (`5600`), loans/interest (`2100`/`5700`) | each needs a documented policy |
| 6.4 | Period closing to retained earnings (`3200`) | currently the result is reported without a closing entry |
| 6.5 | Printable/PDF reports (and Bengali fonts) | the sibling SFUWT project bundles `Nirmala.ttf`; reuse that approach |
| 6.6 | Restore from backup + a tested restore drill | backup without restore is not a backup |
| 6.7 | CSV exports must be audited; add attachment export | SECURITY §6 |
| 6.8 | Rounding: make `GET /api/accounts` aggregate with `Decimal` | IMPLEMENTATION_PLAN R9 |

## Milestone 7 — AI safety hardening

| # | Task | Notes |
|---|---|---|
| 7.1 | Unit tests for `validateCitations` (reject `javascript:`/malformed) | highest-value missing test |
| 7.2 | Test + harden the dose/PHI/REI refusal when no official source exists | currently prompt-only |
| 7.3 | Test the provider-timeout / provider-error / empty-answer fallback paths | three code paths, zero tests |
| 7.4 | Prompt-injection test (instructions inside a retrieved page are not followed) | assert the absence of a tool surface |
| 7.5 | Test AI rate limiting (31st request → 429) | the limiter exists, untested |
| 7.6 | Test conversation isolation between two partners in one business | business data is tested; AI data is not |
| 7.7 | AI conversation export + feedback retention | master prompt asks for export controls |
| 7.8 | IPM-first branch in the deterministic engine | currently prompt-only |

## Milestone 8 — Operational maturity

| # | Task |
|---|---|
| 8.1 | Configure a linter (there is none) and add it to `npm run verify` |
| 8.2 | Add CI (free tier) running `typecheck` + `test` + build — while keeping full local verification working |
| 8.3 | Dependency/SCA scanning |
| 8.4 | Accessibility pass and error-state pass (every list: loading/empty/error) |
| 8.5 | Frontend tests (component + a real offline e2e) |
| 8.6 | Retention/pruning for `audit_logs`, `ai_usage`, backups, attachments |
| 8.7 | Multi-replica support or an explicit "single instance only" deployment guard (the rate limiter is in-memory; SQLite is a file) |

---

## Deliberately NOT on this roadmap

Stated so nobody builds them by accident:

- **Paid anything.** No paid hosting, API, SMS, WhatsApp, email delivery, maps, analytics,
  monitoring, Play Store registration, or premium UI kit.
- **Google Play publication.**
- **Cloud Storage / Cloud Functions on a paid tier** — the sibling Family Finance project
  documents the same choice: degrade gracefully rather than require billing.
- **Fair-value/biological-asset modelling** until a policy is written by a qualified person.
- **Formal tax/VAT/statutory reporting.** This is a management ledger, and
  `ACCOUNTING_RULES.md` says so at the top.
- **Location tracking.** `farms.latitude/longitude` are optional text fields and the Android
  manifest blocks the location permissions on purpose.
