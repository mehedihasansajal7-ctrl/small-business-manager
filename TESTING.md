# TESTING.md

Everything on this page is **captured command output**, not a summary of intent. Where a
command could not be run, it says so.

> ### ðŸ“Œ Snapshot
> Captured **2026-10-14** on Node **v24.19.0**, npm **11.17.0**, Windows.
> The suite was run twice (13:44 and 13:54 local, UTC+6) with **identical totals and exit code
> 0**, so the numbers below are reproducible in this tree. The repository was also being
> written concurrently with this document, so **re-run the commands** â€” they are the authority,
> not the numbers below.

---

## 1. Headline results (real)

| Suite | Command | Files | Tests | Result |
|---|---|---|---|---|
| `packages/domain` | `npm test -w @sbm/domain` | 10 | **148** | âœ… all passed |
| `apps/api` | `npm test -w @sbm/api` | 3 | **81** | âœ… all passed |
| `apps/web` | `npm test -w @sbm/web` | 6 | **63** | âœ… all passed |
| `supabase` | `npm test -w @sbm/supabase` | 2 | **38** | âœ… all passed |
| **Total** | `npm test` | **21** | **336** | âœ… **exit code 0** (confirmed on two runs) |
| Type-check | `npm run typecheck` | 4 workspaces | â€” | âœ… **exit code 0** |
| Production build | `npm run build` | domain + api + web | â€” | âœ… succeeded |

Nothing is failing. Nothing is skipped. There are no `it.skip`/`describe.skip` calls.

---

## 2. The exact commands

```bash
cd small-business-manager

npm test                    # builds @sbm/domain, then vitest in EVERY workspace (exit 0)
npm run typecheck           # builds @sbm/domain, then tsc --noEmit in every workspace (exit 0)
npm run build               # domain (tsc) â†’ api (tsc) â†’ web (tsc --noEmit && vite build)

npm test -w @sbm/domain     # one workspace at a time
npm test -w @sbm/api
npm test -w @sbm/web
npm test -w @sbm/supabase
npx vitest run              # inside a workspace folder

npm run api                 # start the API on http://127.0.0.1:8787
npm run seed                # write the demo business to DATA_DIR
node apps/api/dist/seed.js --memory   # throw-away in-memory demo + summary
npm run web:dev             # Vite dev server on :5173, proxying /api â†’ :8787
```

`npm run verify` = `typecheck && test`.

> The `npm warn -ws is not a valid single-hyphen cli flag` line that appears in the output is
> an **npm 11 deprecation warning about the `-ws` shorthand**, not a test failure; it is
> emitted on stderr and the commands still exit 0. The working form is `--workspaces`.

---

## 3. `packages/domain` â€” 148 tests / 10 files, all passing

```
 âœ“ test/inventory.test.ts   (18 tests)
 âœ“ test/accounting.test.ts  (24 tests)
 âœ“ test/sync.test.ts        (20 tests)
 âœ“ test/tenancy.test.ts     (10 tests)
 âœ“ test/permissions.test.ts (16 tests)
 âœ“ test/validation.test.ts  (13 tests)
 âœ“ test/farming.test.ts     (13 tests)
 âœ“ test/money.test.ts       (10 tests)
 âœ“ test/units.test.ts       (11 tests)
 âœ“ test/decimal.test.ts     (13 tests)
 Test Files  10 passed (10)
      Tests  148 passed (148)
   Duration  6.07s
```

### 3.1 What these prove, rule by rule

**`decimal.test.ts` (13)** â€” construction from plain/signed/fractional/exponent notation;
**invalid input is rejected instead of silently becoming `NaN`**; "never uses binary floating
point" (`0.1 + 0.2 === 0.3`); `pow10`/`roundDiv` helpers; exact add/subtract/multiply;
division **only** with an explicit scale; every rounding mode (`HALF_UP`, `HALF_EVEN`,
`FLOOR`, `CEIL`, `TRUNC`) applied predictably; comparison across different scales;
`allocate()` splits an amount "without losing or inventing a single poysha", respects weights,
and handles percentages that do not sum to 100 deterministically. **Rule proved:** money can
never drift, and rounding is always an explicit decision.

**`money.test.ts` (10)** â€” rounding to the currency minor unit on creation; BDT scale 2 /
JPY scale 0; **refuses to mix currencies**; `mul`/`div`/`pctOf` with explicit rounding;
`allocateMoney` loses no poysha; **South-Asian vs Western digit grouping**; Bangla digits
(à§¦-à§¯) and the Bangla currency name; parsing messy input (`1,23,456.78`, `à§³ 500`, `-1200`);
currency conversion only at an explicit rate; the zero is the right currency.
**Rule proved:** `formatMoney` produces `à§³12,34,567.89`, not `$12,345,678.9`.

**`units.test.ts` (11)** â€” exact in-dimension conversion; **Bangladeshi land and weight units
the way local users expect** (1 bigha = 20 katha, 1 maund = 37.3242 kg); identity; **REFUSES to
convert between incompatible dimensions** (kg â†’ litre); allows a cross-dimension conversion
**only** when registered with a documented note; rejects an explicit conversion whose unit was
never declared; rejects one **without a note**; validates quantities including integer-only
units (`pcs` cannot be 1.5); quantizes to a sensible precision per unit; lists by dimension;
throws for unknown units and duplicate registration.
**Rule proved:** a kg can never silently become a litre or a piece.

**`inventory.test.ts` (18)** â€” the balance is **derived from movements only**; per-location
summaries; **refuses a movement that would make stock negative**; flags a unit mismatch
instead of mixing units; rejects non-positive quantities; detects idempotency-key reuse;
weighted average **recomputed on each inbound movement**; **an issue is valued at the average
in force at that moment and history is never re-valued** (the cost-snapshot rule); movement
and inventory totals; rejects a currency mix on one item; FEFO consumes the earliest expiry
first; FIFO the earliest receipt; reports a shortfall rather than over-issuing; ignores empty
lots; a reversal is the exact opposite movement linked back to the original; **refuses to
reverse a reversal**; low-stock list at/below the reorder level; exposes the current unit cost.
**Rule proved:** balances, valuation and reversals are correct and auditable.

**`accounting.test.ts` (24)** â€” a balanced entry is accepted; unbalanced entries, two-sided
lines, negative amounts and unknown accounts are **rejected**; at least two lines required;
balance totals exposed; **a sale recognises revenue once and books COGS against inventory**;
an unbalanced sale is refused; **a stock purchase is an asset, not an operating expense**;
**a customer receipt is not a second revenue**; **a supplier payment is not a second expense**;
**a transfer is neither income nor expense**; a transfer to the same account is refused;
contributions and withdrawals are equity; **an input purchase does not become a batch expense
until it is issued**; a direct batch cost has no inventory leg; **harvest moves cost out of
WIP and recognises no profit**; mortality is a separate loss account with a reason; a reversal
is an exact mirror; the trial balance always balances; P&L separates revenue/COGS/expenses;
out-of-period entries are excluded; the balance sheet balances **once the unclosed result is
included**; cash flow tracks only the cash accounts; the cash-basis result counts only cash
actually received against revenue/expense; **profit is not the same as cash**.
**Rule proved:** the accrual/cash distinction and the "no double counting" rules are real, not
documented aspirations.

**`farming.test.ts` (13)** â€” a shared cost splits by area losing no poysha; the rounding
residual is deterministic (largest weight, then lowest cycle id); manual percentages leave the
remainder **explicitly unallocated**; invalid allocation inputs are rejected; **the whole batch
cost is never assigned to a partial harvest**; the assignment is capped at the remaining
cost-to-date; `CLOSING_REMAINDER` releases exactly what is left; a planned output and a
positive harvest quantity are required; cycle profitability **separates sold margin from cost
tied up in unsold stock and in the growing batch**; a zero-revenue cycle does not divide by
zero; mortality is summarised and raises an alert above the threshold; FCR, yield-per-area and
output-per-animal are computed; the cycle cost ledger groups every cost once including
allocated shared overhead.
**Rule proved:** batch costing, partial harvests and cycle profit are correct.

**`permissions.test.ts` (16)** â€” every role is declared exactly once **with a Bangla name**;
the owner can do everything; admin cannot transfer ownership or delete the business; non-admin
roles get **least privilege by default**; the owner can widen visibility for partners;
per-member grants and denials are applied with **denials winning**; any/all permission checks;
every role has at least one usable permission; `assertPermission` throws a `PermissionError`
naming the missing right; cost fields are redacted for roles that may not see them; the
effective permission set is returned; **demoting or removing the last owner is blocked**;
ownership transfer is allowed when another owner remains; a non-owner cannot promote anyone to
owner; self-lockout and self-removal are stopped; the 2â€“5 partner guidance does not hard-block.
**Rule proved:** the role matrix and its guardrails.

**`tenancy.test.ts` (10)** â€” invite codes are high-entropy and human-readable; a pasted code is
normalised; expiry follows the TTL; **the raw code is never stored**; a valid unexpired unused
invite is accepted; an unknown code is rejected **without revealing whether the business
exists**; expired/revoked/already-used/exhausted invites are rejected; an email-scoped invite
is bound to that email only; business defaults create a **Bangladesh-first free workspace**;
slugs are safe for any input.

**`sync.test.ts` (20)** â€” SHA-256 matches the **published NIST vectors**; multi-block input;
Bangla UTF-8 hashing is consistent; canonical payload hashing is stable regardless of key
order; changes when a decimal changes; normalises nested arrays/nulls/undefined; an outbox
event gets a business-scoped idempotency key and `PENDING`; descriptive edits are `LOW` risk;
**an event is only "confirmed" once the server acknowledged it**; queue counts by status;
backoff grows exponentially and is deterministic with injected randomness; bounded jitter;
capped at the maximum; terminal states stop retrying and the attempt budget gives up; the
post-failure status is classified; **revision divergence is detected instead of blindly
overwriting**; only safe descriptive fields auto-merge; drafts merge field by field; the sync
banner prioritises conflicts â†’ offline â†’ pending; **it never claims success while offline with
pending changes**.

**`validation.test.ts` (13)** â€” real emails accepted and junk rejected; BD mobile normalisation
(`+880`/`880`/`0`, spaces, dashes) and validation; NID length 10â€“17; the password policy lists
exactly which requirements are missing; upload filenames are stripped of paths and dangerous
characters; decimal input normalisation including **Bangla digits**; whitespace collapsing;
ISO date validation **including impossible dates** (2026-02-30); **the business date uses the
business timezone, not UTC**; a non-Dhaka business is respected; timezone validation and the
current month; `addDays`/`daysBetween`; **dates formatted in Bangla**.

---

## 4. `apps/api` â€” 87 tests / 3 files, all passing

```
 âœ“ test/http.test.ts     (20 tests)
 âœ“ test/security.test.ts (12 tests)
 âœ“ test/api.test.ts      (55 tests)
 Test Files  3 passed (3)
      Tests  87 passed (87)
   Duration  18.47s
```

`api.test.ts` and `security.test.ts` boot a **real server** on a random port over an
in-memory SQLite database (`createApp({ databaseFile: ':memory:', secureCookies: false,
rateLimits: {...} })`) and drive it with a cookie-aware HTTP client â€” so these are true
end-to-end HTTP tests, not mocked unit tests. `http.test.ts` unit-tests the HTTP layer.

> #### Added after this transcript was captured: more API test groups
>
> The counts above are current (87). Between the first transcript and now these groups were
> added to `api.test.ts`, each written to lock down a real defect or an untested rule:
>
> | Group | What it locks down |
> |---|---|
> | `corrections and master data` | Void/return reversals (audited, never editable history), void permission + reason, master-data updates, stock valuation |
> | `backup restore and attachment download` | Restore into an empty workspace reproduces identical books; a non-empty workspace is refused; an unbalanced backup is refused; attachment bytes are membership-scoped and checksum-verified |
> | `stock transfers and opening balances` | A transfer changes neither quantity nor value and is not an expense; opening cash/stock land in **equity**, not revenue |
> | `integrity / reconciliation report` | All 9 derived checks pass on healthy books, and a deliberately corrupted sale header is detected |
> | `printable reports` | All 8 print reports render, and a hostile customer name is HTML-escaped instead of injected |
> | `alerts` | Low stock, expired lot, high mortality (with escalation advice), expected harvest, missed operation, overdue receivable, unpaid bill; severity ordering; thresholds |
> | `cost-visibility leaks (regression tests)` | **Security fix 11.1** in `SECURITY.md`: a cashier's `sync/pull` contains no cost/margin/ledger data, a manager keeps purchase costs but loses COGS and the ledger, and the ledger CSV export is refused without `financial_reports.view` |
> | `member permission escalation guardrails` | **Security fix 11.2** in `SECURITY.md`: an admin cannot self-grant `business.transfer_ownership`, cannot edit an owner's or another admin's access, and cannot grant a permission it does not itself hold |

### 4.1 What the API tests prove, endpoint by endpoint

| Test | Endpoint(s) exercised | What it proves |
|---|---|---|
| `exposes a health endpoint and the role/account catalogue` | `GET /api/health`, `GET /api/meta` | `schemaVersion > 0`; **7 roles**; the chart of accounts contains `4000`; more than 30 routes are registered |
| `reports the zero-cost AI configuration honestly` | `GET /api/status` | `ai.fallbackAvailable` and `research.curatedFallback` are both `true` |
| `registers a user with a business and returns the session user` | `POST /api/auth/register` | a business workspace is created and the session cookie is set |
| `rejects weak or duplicate registrations and bad logins` | `POST /api/auth/register`, `POST /api/auth/login` | a short password is `400`; a duplicate email is `409`; a wrong password is `401` |
| `requires a session for protected endpoints` | `GET /api/businesses/current` | `401` without a session cookie |
| `removes the session on logout` | `POST /api/auth/logout` | the cookie no longer authenticates |
| `never lets one business read or mutate another business` | `/api/products`, cross-tenant ids | **tenant isolation**: another business's rows are invisible and its ids are `404`/`403` |
| `lets an owner invite a partner who joins the same workspace with a different role` | `POST /api/members/invites`, `POST /api/invites/accept` | the invite code works, the role is applied |
| `rejects a revoked invite and an unknown code` | `DELETE /api/members/invites/:id`, `POST /api/invites/accept` | revoked â†’ `400 INVALID_INVITE`; unknown code â†’ `400` |
| `blocks demoting or removing the only owner` | `PATCH /api/members/:id` | `409 LAST_OWNER` |
| `enforces least privilege server-side, not just in the UI` | `/api/purchases`, `/api/members`, â€¦ as a cashier | `403` from the server, not from the UI |
| `lets the owner widen partner visibility with a setting` | `PUT /api/businesses/settings` | `partnerCanSeeCosts` etc. change what a partner may read |
| `records purchase, sale, receipt and expense with correct double entry` | `/api/purchases`, `/api/sales`, `/api/receipts`, `/api/income-expenses`, `/api/reports/{trial-balance,profit-loss,balance-sheet,dashboard}` | purchase 100 kg @58 paid 5800; sale 50 kg @68 with a 100 discount and 3000 cash â†’ `netRevenue 3300.00`, `cogs 2900.00`, `netProfit âˆ’600.00`, `payables 3800.00`; trial balance `balanced === true` with `totalDebit === totalCredit`; balance sheet balanced; dashboard `receivables 0.00`, `payables 3800.00`, `lowStockItems 0` |
| `refuses negative stock by default, even for the owner` | `POST /api/sales` | selling 10 kg with 0 on hand â†’ **`409 STOCK_CONFLICT`**; `allowNegative` without a reason â†’ `400`; with a reason â†’ `200` |
| `rejects a discount without the discount permission` | `POST /api/sales` as a cashier | `403` |
| `treats partner capital as equity, not revenue` | `POST /api/partner-capital`, reports | P&L revenue and profit are both `0.00`; `totalEquity 50000.00`; balance sheet balanced |
| `runs input purchase â†’ issue â†’ labour â†’ harvest â†’ sale with correct costing` | `/api/farming/*`, `/api/inventory`, `/api/sales` | input issue of 100 of 200 kg â†’ stock `100` and cost `6000.00` **once**; cost 9000 over a planned 1000 kg â†’ a 500 kg harvest assigned `4500.00` with `capped === false` and `4500.00` remaining; the sale of those 500 kg carries `cogs 4500.00`; cycle profit `revenue 87500.00`, `grossProfit 83000.00`, `costRemainingInBatch 4500.00` |
| `splits a shared cost across cycles without losing a poysha` | `POST /api/farming/allocations` | a 10:20 area split of 1000 â†’ `333.33` / `666.67`, `unallocated 0.00`, and the parts sum to `1000` |
| `flags a large mortality event for escalation` | `POST /api/farming/cycles/:id/events` | 30 units â†’ `abnormal === true` and an escalation message matching `/veterinar/i` |
| `applies an outbox event exactly once, even when retried` | `POST /api/sync/push`, `/api/inventory`, `/api/sales` | the **identical** event twice â†’ one sale, stock still `50`, message matches `/idempotent/i` |
| `refuses to apply access changes from an offline queue` | `POST /api/sync/push` | a `member.role_change` â†’ `NEEDS_ATTENTION` |
| `reports a conflict when a partner edits a record that changed on the server` | `PATCH /api/products/:id`, `POST /api/sync/push`, `/api/sync/conflicts` | a stale `baseRevision` â†’ `CONFLICT`; one open conflict; resolving with `SERVER_WINS` persists |
| `pulls only the caller own business changes` | `GET /api/sync/pull` | A's product is in A's pull and **not** in B's; each payload carries its own `business.id` |
| `answers in offline fallback mode and says so` | `POST /api/ai/ask` | `mode === 'fallback'`; the text matches `/offline rule-based mode/i` and `/review and confirm/i`; `limitations` is non-empty |
| `returns curated official links (clearly labelled) for a pesticide question` | `POST /api/ai/ask` | citations include `dae.gov.bd`; **every** citation `kind === 'CURATED_LINK'`; limitations mention "not live search results" |
| `never leaks restricted cost data to a role that cannot see it` | `POST /api/ai/ask` as a cashier | `factsUsed` mentions `restricted` and the secret amount `9999` appears nowhere |
| `stores conversations, supports deletion, and caches research` | `/api/ai/conversations`, `/api/ai/research` | history persists; delete removes it; a repeated query returns `cached: true` |
| `rejects AI use for a role without the permission` | `POST /api/ai/ask` as a viewer | `403` |
| `voids a sale with an audited reversal instead of editing history` | `POST /api/sales/:id/void` | a reversal entry is posted; the original is untouched; `status === 'VOID'` |
| `requires the void permission and a reason` | `POST /api/sales/:id/void` | a cashier â†’ `403`; a missing/short reason â†’ `400` |
| `reports stock valuation and hides cost detail without permission` | `GET /api/reports/stock-valuation` | quantities are visible; unit cost/value are absent for a role without cost visibility |
| `restores a backup into a fresh workspace and reproduces the same books` | `GET /api/reports/backup`, `POST /api/reports/restore` | the restored workspace reproduces the same trial balance/P&L; ids are re-keyed |
| `refuses to restore a backup whose journal does not balance` | `POST /api/reports/restore` | `400 UNBALANCED_BACKUP`; nothing is written |
| `serves attachment bytes only to the owning business and verifies the checksum` | `POST/GET /api/attachments/.../content` | another business gets nothing; the returned bytes match the stored checksum |
| `moves stock between locations without changing quantity, value or profit` | `POST /api/inventory/transfer` | two legs â€” `TRANSFER_OUT` then `TRANSFER_IN` â€” total quantity and value unchanged |
| `records opening cash and opening stock as equity, never as profit` | `POST /api/finance/opening-balance`, `POST /api/inventory/opening` | posted against `3050 Opening Balance Equity`; revenue/profit stay `0.00` |
| `passes on a healthy set of books and detects a broken ledger` | `GET /api/reports/integrity` | all 9 checks pass on good data and a deliberately broken ledger is caught |
| `is available to any role with report.view but not to a bare viewer without it` | `GET /api/reports/integrity` | permission enforcement |
| `renders print-ready HTML for each report with the real figures` | printable report endpoint(s) | the figures in the HTML match the report data |
| `raises low stock, expiry, mortality, harvest, receivable and inactivity alerts` | alerts endpoint(s) | each alert class fires on the data that should trigger it |
| `honours the threshold parameters and needs report.view` | alerts endpoint(s) | thresholds are respected; a role without `report.view` is refused |
| `rejects malformed input instead of storing it` | several `POST`s | bad bodies â†’ `400`, nothing persisted |
| `rate limits repeated login failures` | `POST /api/auth/login` | repeated failures â†’ `429 RATE_LIMITED` |

`security.test.ts` (12) additionally proves: **invite expiry**, **email-scoped invites bind to
that email only**, **one partner in two businesses keeps their data apart**, **a suspended
member is rejected**, **an upload is stored for the owning business only with a checksum**, and
that **audit records carry the actor and detail and are read-only for members without
permission**.

`http.test.ts` (20) proves the HTTP layer: `HttpError` status helpers, route matching and
`405 METHOD_NOT_ALLOWED`, cookie parse/serialise (`HttpOnly`/`Secure`/`SameSite`),
the JSON body size limit, `RateLimiter` windows and pruning, `clientIp` from
`x-forwarded-for`, and each validator (`requireString`, `requireEnum`, `asRecord`, â€¦).

### 4.2 Captured API startup and health (real)

```
PS> node apps/api/dist/server.js
[jobs] wrote backup ...\data\backups\sbm-2026-10-14.json
Small Business Manager API listening on http://127.0.0.1:8787 (mode=local)
AI: offline rule engine + curated official links are active (no paid service required).
```

```
GET /api/health  â†’ 200
{"status":"ok","service":"small-business-manager-api","schemaVersion":6,
 "time":"2026-10-14T07:42:21.724Z"}

GET /api/status  â†’ 200
{"mode":"local","database":"embedded-sqlite","timezone":"Asia/Dhaka","currency":"BDT",
 "locale":"bn-BD","supabaseConfigured":false,
 "ai":{"provider":"none","hasKey":false,"model":"llama3.1:8b","rateLimitPerHour":30,
       "fallbackAvailable":true},
 "research":{"provider":"none","hasKey":false,"curatedFallback":true},
 "secureCookies":true}

GET /api/meta    â†’ 200 (93 routes registered)
```

`secureCookies: true` on plain HTTP is expected: `Secure` is on by default and only relaxed
with `INSECURE_COOKIES=1`. The captured run used the defaults, so a browser would refuse to
store the cookie over `http://127.0.0.1` â€” set `INSECURE_COOKIES=1` for local HTTP browsing.

### 4.3 Captured seed output (real)

```
PS> node apps/api/dist/seed.js --memory
  Created 3 partner accounts (owner, partner, farm manager).
  Members: 1 owner, 1 manager, 1 farm manager.
  Catalog: 5 products (2 stock items for resale, 3 farming inputs/outputs).
  Shop: 1 purchase, 2 sales (1 on credit), 1 receipt, 2 expenses, 1 cash transfer.
  Farming: farm + shed + broiler cycle with feed issue, labour, vet, utilities,
           mortality and a weight observation.
  Farming: harvested 1200 kg (cost basis 17652.00 BDT) and sold 600 kg.

=== Seed summary ===
Business          : Rahim Agro & General Store (7e5788d9-1476-4fde-a3e2-354754e348e1)
Partners          : 3 (owner, manager, farm_manager)
Credit sale       : {"id":"874bc238-...","reference":"SAL-20260905-0001","gross":"8160.00",
                     "discount":"60.00","net":"8100.00","cashReceived":"5000.00",
                     "receivable":"3100.00","cogs":"6960.00","currency":"BDT"}
Cycle reference   : CYC-20260901-0001
Cycle cost to date: 20600.00 BDT
Cycle revenue     : 105000.00 BDT | COGS 8826.00 BDT | gross 96174.00 BDT
Month dashboard   : sales 115740.00, net profit 93274.00
Integrity report  : ALL CHECKS PASSED - All reconciliation checks passed.
AI agent mode     : fallback (provider: built-in-rules) - no paid service required

Sign in with: owner@demo.sbm / demo1234   (partners: partner@demo.sbm, farm@demo.sbm - same password)
```

The seed ends by running the **integrity report** on the data it just created, and it passes.

---

## 5. `apps/web` â€” 63 tests / 6 files, all passing

```
 âœ“ test/merge.test.ts               (11 tests)
 âœ“ test/permissions.test.ts          (9 tests)
 âœ“ test/backoff.test.ts              (4 tests)
 âœ“ test/documentMath.test.ts        (12 tests)
 âœ“ test/outbox.test.ts              (17 tests)
 âœ“ test/integration/protocol.test.ts (10 tests)
 Test Files  6 passed (6)
      Tests  63 passed (63)
   Duration  4.73s
```

- **`outbox.test.ts` (17)** â€” event creation with a deterministic idempotency key and payload
  hash; canonical hashing is key-order independent; high-risk events are marked so the UI never
  shows them as posted; **event types the server cannot replay offline are refused**; each
  event type maps to the right local cache store; only the fields the endpoint needs are sent;
  batching selects only `PENDING`/`SYNCING` events whose backoff has elapsed, oldest-first and
  capped; a batch is marked `SYNCING` without touching other statuses; **only
  server-confirmed events become `SYNCED`**; a conflict stays marked and stops automatic
  retries; `REJECTED` is permanent; `NEEDS_ATTENTION` stays out of the automatic queue; a
  transport failure backs off and eventually asks for attention; a whole response is applied by
  idempotency key with unknown events left alone; banner counts; and a failed event can be put
  back on the queue by the user.
- **`documentMath.test.ts` (12)** â€” the client's sale/purchase totals **reproduce the server's
  exact numbers** (the API example: 50 kg Ã— 68 with a 100 discount), default the cash received
  to the net, add tax before discounting, never drift across lines, round half-up exactly where
  float would round down, round each line to the currency minor unit, sum many lines with no
  lost poysha, and keep every quantity and price as a **string**.
- **`merge.test.ts` (11)** â€” pull-merge planning (one upsert per non-empty collection,
  tolerating a malformed payload), **an unsynced local draft wins over the server copy**,
  drafts the server does not know are kept, server rows pass through untouched when nothing is
  pending, and raw snake_case sync rows are normalised into the shapes the screens use.
- **`backoff.test.ts` (4)** â€” per-attempt doubling with a cap, Â±25 % spread so devices do not
  retry in lockstep, next-attempt scheduling from an injected clock, and staying `PENDING`
  until the attempt budget is exhausted.
- **`permissions.test.ts` (9)** â€” the web app's cost/financial/capital visibility rules match
  the domain matrix, honour the owner's visibility settings, hide a column whose permission the
  caller lacks, support columns needing several permissions, **strip cost fields while keeping
  everything else**, redact farm cost separately from purchase cost, return the row untouched
  when allowed, and never mutate the original row.
- **`test/integration/protocol.test.ts` (10)** â€” **the strongest client-side evidence:** it
  boots a **real API** (in-memory SQLite) and drives it through the web client's own code:
  register + read back with permissions; the server error envelope surfaces as a typed
  `ApiError`; create master data â†’ receive stock â†’ post a sale with matching numbers;
  **negative stock is surfaced as `409 STOCK_CONFLICT`** by the POS; a queued sale pushed
  through the outbox is applied **exactly once** and reported `SYNCED`; an access-changing
  event is refused; a pull plans server changes into the local cache; only due events are
  selected for a push batch; and the AI answers in fallback mode with curated links labelled
  as links.

---

## 6. `supabase` â€” 38 tests / 2 files, all passing

```
 âœ“ tests/policies.test.ts (18 tests)
 âœ“ tests/schema.test.ts   (20 tests)
 Test Files  2 passed (2)
      Tests  38 passed (38)
   Duration  3.73s
```

### âš ï¸ These tests do NOT connect to PostgreSQL

There is **no PostgreSQL server in this environment**, so the migrations were **never
executed** anywhere in this repository. These tests **read the SQL files** and assert
structural invariants:

- one `enable` **and** one `force row level security` per created table;
- a `business_id` on every tenant table;
- **no `float` / `real` / `double precision` anywhere** â€” money is `numeric(20,6)`;
- only `code_hash` on `business_invites` (never a plaintext code);
- `unique` idempotency keys on `stock_movements` / `processed_events` / `sync_events`;
- `debit`/`credit` one-sidedness and exact header arithmetic constrained in SQL;
- complete foreign keys;
- a `SELECT` policy for every tenant table;
- **no policy satisfiable without a membership helper**;
- append-only accounting and stock tables (no UPDATE/DELETE policy) with void/reversal
  semantics on documents;
- `security definer` with a pinned `search_path` on every privileged function;
- the presence and atomicity markers of the nine posting RPCs.

That is a **static proof**, not a substitute for running the migrations once against a real
Supabase project and proving RLS from a second tenant's session. See
`supabase/README.md` Â§3 for the exact verification queries.

---

## 7. What is NOT covered (the honest gap list)

| Gap | Why it matters | Where it is tracked |
|---|---|---|
| **No live PostgreSQL run** | RLS could still be wrong at runtime; a policy can be syntactically valid and semantically wrong | `supabase/README.md` known gaps, `TASKS.md` Phase 3b |
| **No Android build, no APK, no emulator/device run** | ~50 screens have never been rendered; native SQLite, netinfo, secure-store and image-picker paths are unexercised | `TASKS.md` Phase 12, R11 |
| **No browser run of the web app** | `vite build` passing proves it compiles, not that it renders or that IndexedDB/service-worker behaviour works | `TASKS.md` Phase 12 |
| **No kill-mid-sync / restart e2e** | the master prompt's core offline promise ("records survive an app restart") is unproven on a device | `SYNC_DESIGN.md` Â§12, R1 |
| **No two-device concurrency test** (two partners race the last 10 kg) | the server logic is tested; the *device* experience of the resulting conflict is not | `SYNC_DESIGN.md` Â§12 |
| **No prompt-injection test** | the defence is a prompt plus the absence of a tool surface; neither is asserted | `AI_AGENT_DESIGN.md` Â§11.2 |
| **No test that a dose/PHI/REI is refused when no official source exists** | this is the highest-risk AI behaviour and it is only prompt-enforced | `AI_AGENT_DESIGN.md` Â§11.2 |
| **No unit tests for `validateCitations`** | it exists and is called, but its rejection of `javascript:`/malformed URLs is untested | `AI_AGENT_DESIGN.md` Â§11.2 |
| **No test for provider timeout / provider error / empty-answer fallback** | three real code paths with no coverage | `AI_AGENT_DESIGN.md` Â§11.2 |
| **No AI rate-limit test** | the login limiter is tested; the AI limiter is not | `AI_AGENT_DESIGN.md` Â§11.2 |
| **No conversation-isolation test between two partners** | business data isolation is tested; `ai_conversations` isolation is not | `AI_AGENT_DESIGN.md` Â§11.2 |
| **`GET /api/sync/pull` cost leakage** | a low-privilege member can read cost columns and journal lines â€” a real, reproducible authorisation hole | `SECURITY.md` Â§11.1 |
| **Admin can self-grant `business.transfer_ownership`** | a privilege-escalation path | `SECURITY.md` Â§11.2 |
| **No load/soak testing** | the integrity report is O(items Ã— movements); large books are untested | â€” |
| **No accessibility audit, no keyboard-navigation test** | the spec asks for it | `TASKS.md` Phase 16 |
| **No dependency/SCA scan, no CI** | nothing checks for a vulnerable transitive dependency | `TASKS.md` Phase 16 |
| **No test of `FarmingError` â†’ JSON status mapping** | `NO_TARGETS`/`ZERO_BASIS`/`OVER_ALLOCATION` can surface as `500`, not `400` | `IMPLEMENTATION_PLAN.md` R6 |
| **No restore drill documented from a real backup file** | restore is tested in-process, not as an operator procedure | `IMPLEMENTATION_PLAN.md` R12 |
| **No coverage report** | no `coverage` script is configured; the numbers above are test counts, not line coverage | â€” |

### Two noted inconsistencies

- `GET /api/sync/pull` appears to be registered **twice** in `routes.ts`. Harmless in practice
  (the router returns the first match), but it is dead code.
- The `npm warn -ws â€¦` deprecation appears on every `npm test`/`npm run typecheck` because the
  root scripts use the single-hyphen `-ws` shorthand. It does not affect the exit code.

---

## 8. Manual end-to-end checklist (the master prompt's own list)

**Status: NOT PERFORMED.** It requires two real devices, two real people and (for the shared
mode) a live database. It is written out exactly so whoever can run it knows what "done" means.
Tick nothing you did not observe.

### 8.1 Two partners, one workspace, no duplicates

| # | Step | Expected observation |
|---|---|---|
| 1 | Create a **brand-new empty workspace** for this test | a fresh business id |
| 2 | Register the owner | signed in, `owner` role |
| 3 | Owner: **Team â†’ Invite** two partners (`manager`, `cashier`) | two invite codes, an expiry timestamp each |
| 4 | Partner A accepts on **device A**; Partner B on **device B** | each is signed in, sees the same business, different role |
| 5 | Sign in to both devices and confirm a **sync** completed | last-sync time updates on both |
| 6 | Device A: create a product and receive stock (a purchase) | sync â†’ `SYNCED` |
| 7 | Device B: pull (reopen/refresh) | **the product and stock appear** on B |
| 8 | **Disconnect both devices** (airplane mode) | both show **Offline**, pending count visible |
| 9 | Device A: record **3 sales** | each is listed as **saved on this device / not yet shared** |
| 10 | Device B: record **2 different sales** | same |
| 11 | Device B: **force-close and relaunch** the app with no network | the 2 sales are **still there** |
| 12 | Reconnect device B | it syncs; the 2 sales become `SYNCED`; the pending count returns to 0 |
| 13 | Reconnect device A | its 3 sales sync |
| 14 | Compare the **sales list** on both devices | **exactly 5** sales; **no duplicates** |
| 15 | Compare the **stock ledger** with the sales | quantity reduction equals the sum of the 5 sales; no double application |
| 16 | Open **Reports â†’ trial balance / P&L** on both devices | identical figures; trial balance **balanced** |
| 17 | Open **Reports â†’ Integrity** | **all checks pass** |
| 18 | **Repeat step 9's exact event** (retry) if you can â€” e.g. kill the app mid-push | the server reports an **idempotent replay**; still exactly 5 sales |
| 19 | Two devices, one low-stock item: both sell the last unit while offline, then both reconnect | one succeeds; the other gets a **visible conflict or a stock refusal** â€” never a silent negative balance |

### 8.2 Farming end-to-end

| # | Step | Expected observation |
|---|---|---|
| 1 | Create a farm (e.g. 12 decimal) and a unit (poultry house, capacity 1000) | both saved |
| 2 | Create a cycle (poultry, start date, planned output 1400 kg, population 1000) | reference like `CYC-YYYYMMDD-0001`, `ACTIVE` |
| 3 | Buy feed into stock (an asset) | inventory up; **no batch expense yet** |
| 4 | Issue feed to the cycle | input stock down; the batch cost went up **once, by the valued amount** |
| 5 | Record labour, veterinary and utilities | each is a direct batch cost |
| 6 | Record mortality (a few birds with a reason) | recorded; **not abnormal** |
| 7 | Record mortality â‰¥ 25 at once | flagged **abnormal** with a vet/extension escalation message |
| 8 | Record an observation (average weight) | appears in the cycle's timeline |
| 9 | Allocate a shared cost across two cycles (e.g. animal count) | shares sum **exactly** to the pool; `unallocated 0.00` |
| 10 | Partial harvest (e.g. 500 of a planned 1000 kg) | cost assigned by planned yield; **not** the whole batch cost; remaining cost visible |
| 11 | Sell the harvested output | revenue once; COGS from the harvest cost layer; **unsold stock stays inventory** |
| 12 | Open **Costing & Profit** for the cycle | revenue, COGS, gross profit, cost in unsold output and cost still in the batch are all shown separately |
| 13 | Close the cycle (remaining quantity) | `CLOSING_REMAINDER` releases exactly what is left; status `CLOSED`; further activity is refused with `409 CYCLE_CLOSED` |

### 8.3 Platform checks

| # | Step | Expected |
|---|---|---|
| 1 | Install the web app (PWA prompt / "Add to Home Screen") | installs; the app shell loads offline |
| 2 | Build the APK, sideload it to a cheap Android phone | it launches and can talk to the API |
| 3 | Turn off the network on the phone | core actions still work; the offline banner shows |
| 4 | Ask a general AI question | an answer in the chosen language, with the mode badge (`fallback` if no provider) |
| 5 | Ask a **pesticide** question | curated official links, **clearly labelled as links, not search results**; no invented dose |
| 6 | Click every displayed source | each opens the page it claims to be |
| 7 | Sign in as the **cashier** and ask "what is my profit?" | the answer does **not** contain the owner's cost/profit figures |
| 8 | Ask the AI to "post a sale for 10 kg" | it refuses and tells you which screen to confirm it on; **no transaction is created** |

---

## 9. Reproducing any single test

```bash
# one file
npx vitest run test/accounting.test.ts              # inside packages/domain
npx vitest run test/api.test.ts                     # inside apps/api
npx vitest run test/outbox.test.ts                  # inside apps/web

# one test by name
npx vitest run -t "applies an outbox event exactly once"

# watch mode while developing
npx vitest                                          # inside a workspace
```

Every API test suite creates its **own** in-memory database and its own server on port `0`
(an OS-assigned free port), so suites never share state and can run in any order.
