# ROADMAP.md

Ordered so that each step makes the product *usable by a real partner* sooner. Dependency
notes are explicit. Nothing here is a promise of a date.

Current honest baseline (2026-10-14, 13:44â€“13:47): **336 tests passing** (148 domain, 87 api,
63 web, 38 supabase); `npm run typecheck` passes in all four workspaces; `npm run build`
succeeds and produces the web bundle. The server, the web client, the Android client and the
Postgres/RLS layer all exist as code. **Nothing is deployed, no APK exists, no device has
rendered a screen, and no Postgres server has ever run the migrations.**

---

## Milestone 0 â€” Make what exists honest and safe (days, not weeks)

Small, cheap, and each one removes a way this project could embarrass its owner.

| # | Task | Why | Done when |
|---|---|---|---|
| 0.1 | Fix `GET /api/sync/pull` cost leakage | a viewer/cashier can read journal lines and `unit_cost`; the same is true of the `journal_lines` **CSV export** for a manager (SECURITY Â§11.1) | a cashier's pull and a manager's export contain no cost field; tests prove it |
| 0.2 | Restrict `member.manage` grants | an admin can self-grant `business.transfer_ownership` (SECURITY Â§11.2) | you cannot grant a permission you do not hold; a test proves it |
| 0.3 | Map `FarmingError` to 400 | `OVER_ALLOCATION`/`ZERO_BASIS` can surface as 500 | a test asserts 400 for an over-allocated shared cost |
| 0.4 | Return 409 on a duplicate `reference` | two devices typing the same invoice number currently get a 500-shaped failure | the API returns a clean 409 with a usable message |
| 0.5 | Re-run and record the full verification | the tree changes fast; `TESTING.md` can go stale | `TESTING.md` updated with fresh output |
| 0.6 | Decide on the dead schema | `devices`, `product_categories`, `financial_accounts`, `businesses.settings`, `farms.latitude/longitude` | each is either wired up or dropped |
| 0.7 | De-duplicate `GET /api/sync/pull` in `routes.ts` | it is registered twice | one registration |

## Milestone 1 â€” Actually run the app

**Why first:** the code builds and passes 336 tests, but **no human has seen a screen**. Bugs
in layout, navigation, cookie handling, IndexedDB, native modules and the service worker are
all invisible until it runs.

| # | Task | Notes |
|---|---|---|
| 1.1 | `npm run web:dev` and walk SignIn â†’ Setup â†’ Dashboard | set `INSECURE_COOKIES=1` for local HTTP or the session cookie will not be stored |
| 1.2 | Record a sale through the UI | includes the negative-stock `409` path and the "review before confirm" flow |
| 1.3 | Confirm the trial balance and P&L update from a UI action | proves the ledger is wired to the screen, not to a dashboard formula |
| 1.4 | Verify the bilingual switch and `à§³12,34,567.89` formatting on screen | the formatter is already unit-tested |
| 1.5 | Verify the sync status chip and the PWA install prompt | `manifest.webmanifest` + `sw.js` exist; service workers need HTTPS or `localhost` |
| 1.6 | Run the Expo app on an emulator and walk the same path | nothing about the native app has been observed |

**Exit criterion:** someone has completed a sale in a real browser **and** on an emulator, and
the reports they see match the API's numbers.

## Milestone 2 â€” Prove offline on a real device

The server side of sync is done and tested. The client outbox now **exists** in both clients
(IndexedDB + SQLite, 17 unit tests, plus a 10-test protocol suite driving a real API). What is
still missing is proof on a device.

| # | Task | Notes |
|---|---|---|
| 2.1 | Confirm local persistence is written in the **same transaction** as the record change | the contract the server assumes |
| 2.2 | Test: kill the app mid-sync, relaunch â†’ no duplicate, no loss | the master prompt's core offline promise; **never run** |
| 2.3 | Test: two devices sell the last 10 kg while offline, then both reconnect | one succeeds, one gets a visible conflict â€” never a silent negative balance |
| 2.4 | Make the server report real `differingFields` (today it writes `["unknown"]`) | so the conflict screen can show *what* differed (SYNC_DESIGN Â§5.2) |
| 2.5 | Implement or remove `stock.move` / `journal.post` from `HIGH_RISK_EVENTS` | the web outbox already refuses them; the two lists should agree (SYNC_DESIGN Â§7.1) |
| 2.6 | Verify a `LOCAL_WINS` decision actually replays the payload | today the server only records the decision; the client must re-submit |

**Exit criterion:** the master prompt's e2e checklist (register owner â†’ invite 2 partners â†’
sales on two devices â†’ disconnect â†’ reconnect â†’ no duplicates) passes with evidence.

## Milestone 3 â€” Make shared mode real

The schema, RLS and 9 RPCs exist in `supabase/`. What is missing is (a) **running them once**
and (b) the adapter in `apps/api`.

| # | Task | Notes |
|---|---|---|
| 3.1 | Apply `supabase/migrations` + `functions` to a real Postgres/Supabase project | **never done**; `supabase/tests` reads SQL instead |
| 3.2 | Prove RLS from a second tenant's session | the Â§3 verification queries in `supabase/README.md`; a valid-looking policy can still be wrong |
| 3.3 | Extract a `RepositoryPort` interface that today's SQLite `Repository` satisfies | makes the seam a compiled contract, not a convention |
| 3.4 | Write the Postgres adapter (or call the existing RPCs) from `apps/api` | until then `SBM_MODE=shared` is cosmetic |
| 3.5 | Never ship the service-role key to a client; anon key only, protected by RLS | already the documented rule |
| 3.6 | A cloud backup + restore drill | the free plan has no daily backups |

**Exit criterion:** two businesses' sessions cannot see or mutate each other's rows **even with
the API bypassed** (RLS proven, not just app code), and a partner in another city can sign in
and sync.

## Milestone 4 â€” Android that a partner can install

| # | Task | Notes |
|---|---|---|
| 4.1 | Install JDK 17 + Android SDK (or use a free Expo account with `eas build`) | no APK was produced here because neither is present in this environment |
| 4.2 | `expo prebuild` + `gradlew assembleRelease`, sign with a local keystore | `apps/mobile` already declares `apk:debug`/`apk:release` |
| 4.3 | Sideload and test on a real cheap phone | must work on a low-end device, not just an emulator |
| 4.4 | Point the APK at a reachable API (`EXPO_PUBLIC_API_URL`) over HTTPS | Android blocks cleartext HTTP in release builds |
| 4.5 | Bangla IME/typing and small-screen testing | a Bangla-first product must be usable in Bangla |

**Explicitly out of scope forever:** Google Play publication. It costs money and is not
required.

## Milestone 5 â€” Farming depth

| # | Task | Notes |
|---|---|---|
| 5.1 | Species-specific typed children beside `observations` | e.g. water-quality parameters with safe ranges, lactation, weight-growth curves |
| 5.2 | Scheduled/planned operations + "missed operation" alerts | the master prompt lists this; nothing implements it |
| 5.3 | Milk/egg/wool as first-class output types with their own units and yield metrics | `outputPerAnimal()` exists but there is no capture UI/type |
| 5.4 | Livestock transfer between units (animals moving, not stock) | needs its own event type |
| 5.5 | Breeding/birth events and offspring valuation | **requires a written policy first** â€” the master prompt forbids inventing biological accounting |
| 5.6 | IAS-41-style fair value (optional, off by default) | do not approximate with a journal entry |
| 5.7 | Alerts: expected harvest, low inputs, expiry, high mortality, unpaid bills, overdue receivables | the master prompt lists these; only low-stock and mortality-threshold exist |

## Milestone 6 â€” Accounting and reporting completeness

| # | Task | Notes |
|---|---|---|
| 6.1 | Returns: sales returns (`4910`), purchase returns | accounts exist; **no endpoint, no policy** |
| 6.2 | Opening balances | `finance.opening_balance` permission exists; no endpoint, and `customers/suppliers.opening_balance` is not folded into receivables/payables |
| 6.3 | Bad debt (`5500`), depreciation (`5600`), loans/interest (`2100`/`5700`) | each needs a documented policy |
| 6.4 | Period closing to retained earnings (`3200`) | currently the result is reported without a closing entry |
| 6.5 | Printable/PDF reports (and Bengali fonts) | the sibling SFUWT project bundles `Nirmala.ttf`; reuse that approach |
| 6.6 | Restore from backup + a tested restore drill | backup without restore is not a backup |
| 6.7 | CSV exports must be audited; add attachment export | SECURITY Â§6 |
| 6.8 | Rounding: make `GET /api/accounts` aggregate with `Decimal` | IMPLEMENTATION_PLAN R9 |

## Milestone 7 â€” AI safety hardening

| # | Task | Notes |
|---|---|---|
| 7.1 | Unit tests for `validateCitations` (reject `javascript:`/malformed) | highest-value missing test |
| 7.2 | Test + harden the dose/PHI/REI refusal when no official source exists | currently prompt-only |
| 7.3 | Test the provider-timeout / provider-error / empty-answer fallback paths | three code paths, zero tests |
| 7.4 | Prompt-injection test (instructions inside a retrieved page are not followed) | assert the absence of a tool surface |
| 7.5 | Test AI rate limiting (31st request â†’ 429) | the limiter exists, untested |
| 7.6 | Test conversation isolation between two partners in one business | business data is tested; AI data is not |
| 7.7 | AI conversation export + feedback retention | master prompt asks for export controls |
| 7.8 | IPM-first branch in the deterministic engine | currently prompt-only |

## Milestone 8 â€” Operational maturity

| # | Task |
|---|---|
| 8.1 | Configure a linter (there is none) and add it to `npm run verify` |
| 8.2 | Add CI (free tier) running `typecheck` + `test` + build â€” while keeping full local verification working |
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
- **Cloud Storage / Cloud Functions on a paid tier** â€” the sibling Family Finance project
  documents the same choice: degrade gracefully rather than require billing.
- **Fair-value/biological-asset modelling** until a policy is written by a qualified person.
- **Formal tax/VAT/statutory reporting.** This is a management ledger, and
  `ACCOUNTING_RULES.md` says so at the top.
- **Location tracking.** `farms.latitude/longitude` are optional text fields and the Android
  manifest blocks the location permissions on purpose.
