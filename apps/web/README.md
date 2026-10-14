# @sbm/web — Small Business Manager web app (offline-first PWA)

A mobile-first React + TypeScript + Vite client for the `@sbm/api` server. It is a
**real** client: every screen calls the documented HTTP API, and every local change
is written through the domain package's outbox so nothing is lost when the phone
loses signal.

Zero extra runtime dependencies — `react`, `react-dom` and the shared
`@sbm/domain` workspace package only. No router, no state library, no
IndexedDB wrapper, no service-worker toolkit.

---

## 1. Run it

```bash
# always from the monorepo root: small-business-manager/
npm run api:dev            # terminal 1 — API on http://127.0.0.1:8787
npm run web:dev -w @sbm/web # terminal 2 — app on http://localhost:5173
```

`vite.config.ts` proxies `/api` → `http://127.0.0.1:8787`, so the `sbm_session`
cookie stays **first-party** (same origin). Never point the app at the API
cross-origin: the session cookie would be blocked.

```bash
npm run typecheck -w @sbm/web   # tsc --noEmit (strict, noUncheckedIndexedAccess, verbatimModuleSyntax)
npm run build     -w @sbm/web   # tsc --noEmit && vite build  → apps/web/dist
npm test          -w @sbm/web   # vitest run (63 tests)
npm run preview   -w @sbm/web   # serve dist on :4173 with the same /api proxy
```

Register the first account in the app (or `POST /api/auth/register`). Registration
without a business name drops you into the **first-run setup wizard**
(business profile → currency/timezone → farming types → first stock location).

---

## 2. Layout

```
src/
  api/          client.ts (typed fetch, 401 handling) · endpoints*.ts · types.ts
                documentMath.ts (exact money previews) · permissions.ts (UI gating)
  offline/      db.ts        IndexedDB wrapper + versioned migration
                outbox.ts    event creation, batching, backoff, push-result folding
                sync.ts      SyncCoordinator: push → pull, online/interval/start
                merge.ts     pull → cache plan, draft-preserving overlay
                localStorage.ts  durable device queue (write before "Saved")
                normalize.ts snake_case pull rows → the screens' camelCase shape
                cachedList.ts    "network first, device second" list loader
  components/   ui.tsx, DataTable, States, Layout, SyncBanner, VoucherForm, …
  screens/      one file per screen (Dashboard, Sales, Purchases, Inventory,
                Finance, Catalog, Reports, Farming, CycleDetail, Team, Settings,
                AiAgent, SyncStatus, SignIn, Setup)
  state/        AppContext (session/business/permissions/locale/theme), router.ts
  i18n/         messages.core.ts + messages.screens.ts (bn + en), translate()
  theme/        light / dark / system, persisted
test/           pure-logic unit tests + integration/protocol.test.ts (real HTTP)
public/         manifest.webmanifest, sw.js (hand-written), icon.svg
```

Budget discipline: each file stays small and focused, and components never hold
business rules that belong in `@sbm/domain`.

---

## 3. Offline model (how it actually works)

**Two stores, one transaction.** `db.ts` opens `sbm-offline` (version 1) with one
object store per synced collection — `business, products, customers, suppliers,
locations, sales, purchases, stockMovements, cycles, harvests, journalEntries,
farms, inventory` — plus `outbox` and `meta`.
`enqueueMutation()` / `saveLocally()` put the optimistic record **and** its outbox
event in the *same* IndexedDB transaction, and only resolve once that transaction
**commits**. That is the must-not-lose guarantee: the UI shows
*“Saved on this device — waiting to share”* only after the commit.

**Outbox events.** Built with `createOutboxEvent` from `@sbm/domain`: the
`idempotencyKey` is `${businessId}:${aggregateType}:${eventId}`, the payload is
hashed with `canonicalJson` + `payloadHash` (sha256, sorted keys, so the hash is
reproducible), and high-risk types are marked `risk: 'HIGH'` so the UI never
presents them as posted.

**Sync coordinator** (`offline/sync.ts`) runs on app start, on the `online` event
and every 60 s:

1. **Push** — up to 50 due events per batch (`{ events: [...] }` → `POST /api/sync/push`),
   up to 5 rounds per pass.
2. Each result is folded back by `idempotencyKey`:
   - `SYNCED` → confirmed (server revision stored)
   - `CONFLICT` → surfaced as a decision, never auto-overwritten
   - `REJECTED` → permanent, no retry loop
   - `NEEDS_ATTENTION` → needs an online action (access/ownership changes)
   - no response (offline) → `retryDelayMs` exponential backoff **with jitter**,
     and after 12 attempts it becomes `NEEDS_ATTENTION`
3. **Pull** — `GET /api/sync/pull?since=<last serverTime>` and merge into the
   cache. `planMerge()` decides the writes; rows whose `id` is still a local
   draft are skipped so an unsent edit is never clobbered.
4. `purgeSyncedEvents()` drops confirmed events after 7 days.

The header strip shows Offline / Pending / Syncing / Synced / Needs attention /
Conflict at all times (`aria-live`), and `#/sync` shows the queue, the last
successful sync, per-event attempts/errors, **Retry**, and open conflicts with
*Keep mine* / *Keep server version* (`POST /api/sync/conflicts/:id/resolve`).

**What works offline:** sales, purchases, receipts, payments, transfers,
income/expenses, partner capital, farming events/harvest/cycle close, and master
data (product/customer/supplier). Lists render from the cache
(`cachedList()` = network first, device second) and locally created records carry
a *“Local proposal — not shared yet”* badge.

**What needs a connection (and says so instead of silently dropping work):**
stock locations, member/role changes and invites, stock adjustments, units and
conversions, activity attachments, AI answers, CSV/backup exports. A
locally-created record also cannot be referenced by a new document until it has
synced (the server has not issued its id yet) — those rows are labelled in the
picker.

---

## 4. Permissions, money and correctness

* The permission list from `GET /api/businesses/current` drives the UI
  (`api/permissions.ts`). Cost columns (`purchase.cost.view`), financial reports
  (`financial_reports.view`), partner capital and farm cost are hidden **and**
  redacted from cached rows, so a stale copy cannot leak them either. The server
  enforces the same rules — the UI is only a courtesy.
* Discount UI appears only with `sale.discount.apply`; a negative-stock override
  needs `inventory.adjust.approve` plus a written reason, and a 409
  `STOCK_CONFLICT` is shown as a plain-language explanation of what to do next.
* **Every money/quantity value stays a string.** Arithmetic uses
  `Decimal`/`Money` from `@sbm/domain` (`api/documentMath.ts` mirrors the
  server's sale/purchase maths line by line, as a preview only — the server's
  numbers always win). `Number()` is never used for money.
* BDT renders as `৳12,34,567.89` (south-asian grouping) and dates as
  `১৪ অক্টোবর ২০২৬` in Bangla mode via `formatMoney`/`formatDateBn`/`toBanglaDigits`.

## 5. i18n, theme, accessibility

Bangla (default) and English for every string, switchable from the top bar and
persisted (`sbm.locale`). Light/dark/system theme persisted (`sbm.theme`),
honouring `prefers-color-scheme`, applied before first paint by a tiny inline
script in `index.html`. Every input has a label, all controls are keyboard
operable with visible focus rings, `prefers-reduced-motion` is respected and
sync/status messages are announced through `aria-live` regions.

## 6. AI agent

`POST /api/ai/ask` plus conversations, plans, feedback and `POST /api/ai/research`.
The screen always shows which tier answered — **generative / local / fallback** —
reusing the `mode` in the answer, together with the provider name. Answers render
their `limitations`, their `factsUsed` (the authorised subset), and **source
cards** with an `open source` link and a `kind` badge (OFFICIAL / RESEARCH /
RETAILER / USER_REVIEW / CURATED_LINK / WARNING). RETAILER sources trigger a
prominent warning that a listing is not proof of approval or efficacy, and the
screen states that AI output is a suggestion that can never post a transaction.

Known API limitation: `/api/ai/ask` returns no per-message id, so **Helpful /
Not helpful** is recorded against the conversation id. The server stores it as
`ai_feedback.message_id`.

## 7. PWA

* `public/manifest.webmanifest` — standalone, Bangla-first, `theme_color`
  `#0f766e`, two icon entries (`icon.svg`, `any` + `maskable`).
* `public/sw.js` — hand-written: precaches the shell (`/`, `/index.html`,
  manifest, icon) at install, serves the cached shell for offline navigations and
  refreshes hashed assets cache-first. **`/api/*` is never cached** — offline data
  belongs to the app's own IndexedDB cache, and caching API responses here would
  hide staleness.
* The switch is registered from `src/main.tsx` in production builds only.
* A dismissible **Add to Home Screen** panel shows the real
  `beforeinstallprompt` button where Chrome/Edge provide it, and
  Share → Add to Home Screen instructions on iOS.

**Install**
1. Open the app over **https** (or `localhost`) in Chrome/Edge/Android → the
   install panel appears → **Install**, or ⋮ → *Add to Home screen*.
2. iPhone/iPad (Safari): **Share** → **Add to Home Screen**.
3. Open it from the home screen; sign in once — the session cookie and the local
   cache then survive restarts, and queued work syncs when data returns.

**সংক্ষেপে (বাংলা):** এই অ্যাপটি ইন্টারনেট ছাড়াও চলে — প্রতিটি পরিবর্তন প্রথমে
ডিভাইসের ভেতরে (IndexedDB) নিরাপদে সংরক্ষিত হয়, তারপর সিঙ্ক হয়, তাই কোনো এন্ট্রি
হারায় না। ইনস্টল করতে Chrome-এ ⋮ → “Add to Home screen”, আইফোনে Share →
“Add to Home Screen”। বাংলা/ইংরেজি ভাষা ও উজ্জ্বল/অন্ধকার থিম উপরের বার থেকে বদলানো যায়।
যা অফলাইনে করা যায় না (যেমন নতুন স্টক লোকেশন, সদস্যের ভূমিকা পরিবর্তন, CSV/ব্যাকআপ)
সেগুলো করতে অ্যাপ স্পষ্টভাবে ইন্টারনেট চাইবে।

---

## 8. Tests

```bash
npm test -w @sbm/web
# 6 files, 63 tests: outbox, backoff/jitter, merge + draft preservation,
# normalize, permission redaction, document maths,
# and integration/protocol.test.ts — the REAL client modules against the REAL
# API server (in-memory SQLite): register, permissions, purchase+sale numbers,
# 409 STOCK_CONFLICT, outbox push → idempotent replay → incremental pull, AI modes.
```

`vitest.config.ts` uses `environment: 'node'` on purpose: only pure logic is unit
tested. IndexedDB, the service worker and React rendering are **not** covered by
automated tests (no DOM environment was added, per the dependency budget) — they
are exercised by running the app.
