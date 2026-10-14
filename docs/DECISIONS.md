# ADR — Architecture decision record

Short, dated, and honest about trade-offs. Each entry says **what was decided**, **why**,
and **what it costs us**.

---

## ADR-001 · Decimals as `bigint`-scaled integers, not numbers

**Status:** accepted, implemented (`packages/domain/src/decimal.ts`), tested (13 tests).

**Context.** Money and quantities must add up exactly. JavaScript has no decimal type;
IEEE-754 doubles cannot represent `0.1` exactly, so `0.1 + 0.2 !== 0.3` and repeated
addition of poysha drifts. A welfare/sales app whose totals do not tie out is worthless, and
a shared database across partners makes any discrepancy permanent and visible.

**Decision.** `Decimal` is an immutable value holding `{ unscaled: bigint, scale: number }`,
i.e. `value = unscaled / 10^scale`. All arithmetic is integer arithmetic on `bigint`.
Rounding is never implicit: `div` **requires** an explicit scale and defaults to `HALF_UP`
("half away from zero", the commercial convention), and `scaleTo`/`round` take a
`RoundingMode` of `HALF_UP | HALF_EVEN | FLOOR | CEIL | TRUNC`. `Decimal.allocate()` splits an
amount by ratios with the **largest-remainder method**, so no minor unit is ever lost or
invented. Database storage is `TEXT` (§ADR-002). Postgres would be `numeric`, never
`double precision`.

**Alternatives rejected.**

- `number` + `toFixed()`: the drift above; plus `toFixed` rounds rather than representing.
- `decimal.js` / `big.js` / `bignumber.js`: a real dependency for something that fits in
  ~330 lines, and it would have to be shipped into the Android bundle and the browser. The
  domain package is deliberately dependency-free so it runs identically everywhere.
- Integer minor units only (poysha everywhere): breaks for quantities (`0.933105 kg`) and
  for currencies with different precision, and forces every caller to know the currency's
  scale. The `scale` field carries that knowledge instead.

**Cost.** `bigint` is not JSON-serialisable by default (solved: `Decimal.toJSON()` returns a
string and the HTTP layer stringifies any stray `bigint`). `MAX_SCALE` is 40. Ordering
magnitudes stay small in bigint terms, so there is no practical limit for retail/farm bookkeeping.

---

## ADR-002 · Money stored as `TEXT`, never `REAL`/`NUMERIC`

**Status:** accepted, implemented (all of `apps/api/src/db.ts`), tested indirectly by every
accounting test and asserted through the API (`netRevenue === '3300.00'`).

**Context.** SQLite is dynamically typed with *affinity* rules. `NUMERIC` affinity converts a
numeric-looking string to `INTEGER`/`REAL` on insert, which would silently defeat ADR-001 at
the storage boundary.

**Decision.** Every decimal column is `TEXT` affinity and holds the canonical decimal string.
Booleans are `INTEGER` 0/1. JSON is `TEXT`. Dates are ISO `TEXT`. This is the only affinity
that guarantees no coercion.

**Cost.** No SQL-side arithmetic on money (`SUM(amount)` would be lexicographic and wrong), so
every aggregate is computed in TypeScript with `Decimal`. That is slower at large scale and is
the real reason a Postgres port should use `numeric` (aggregates then stay in the database).
Indexes on money columns would sort as text — acceptable, since no money column is
range-queried.

---

## ADR-003 · `node:sqlite` (builtin) instead of an npm SQLite driver

**Status:** accepted, implemented (`apps/api/src/db.ts`), verified — server boots and
`/api/health` reports `schemaVersion: 6`.

**Context.** The zero-cost rule forbids paid services; the spirit of it also favours a
dependency-free footprint. `better-sqlite3` is a native module (build toolchain, prebuilt
binary mismatch, an install step that can fail on a phone-repair-shop laptop). `sql.js` is
WASM with no real file persistence.

**Decision.** Use the Node builtin `node:sqlite` (`DatabaseSync`), loaded through
`createRequire(import.meta.url)` so bundlers that do not know the specifier do not choke.
Requires **Node ≥ 22.5**, which is pinned in `package.json` `engines`.

**Cost.** Node 20/18 cannot run the API at all. The builtin is young, and its API surface is
smaller than `better-sqlite3`'s. `apps/api` has **zero** third-party runtime dependencies as a
result, which is worth more than the version floor.

---

## ADR-004 · An outbox, not last-write-wins or a CRDT

**Status:** accepted, implemented (`packages/domain/src/sync.ts`, `apps/api/src/sync.ts`),
tested (20 domain + 4 API tests).

**Context.** 2–5 partners on separate devices, in Bangladesh, with intermittent connectivity.
Concurrent edits are certain. The failure that must never happen is a **silently lost or
duplicated financial record** — a sale counted twice, or an inventory quantity quietly
overwritten.

**Decision.** Every local mutation writes a durable **outbox event** in the same local
transaction as the record change. Each event carries a globally unique `eventId` and a
derived, business-scoped `idempotencyKey`; the server applies each event **exactly once**
inside a transaction, keyed by `processed_events.idempotency_key` (a PRIMARY KEY). Editable
master data carries a `baseRevision`; a divergence becomes a **visible conflict** rather than
an overwrite. High-risk events are shown as a local proposal until `status === 'SYNCED'`.

**Alternatives rejected.**

- **Last-write-wins:** loses money. Two sales of the last 10 kg must not collapse to one.
- **CRDTs:** solve convergence, not *validity*. A CRDT cannot refuse a sale that would make
  stock negative, cannot keep a double-entry journal balanced, and cannot require a human
  decision on partner permissions. The master prompt forbids last-write-wins for exactly these
  fields.
- **Server-only writes (online-first):** fails the core requirement of working in a field with
  no signal.

**Cost.** Real complexity: a conflict UI, a device store, retry/backoff, and a rule that the
UI must never show an unsynced high-risk event as posted. Also, a conflict must be *resolved*
by a human — that is deliberate friction.

---

## ADR-005 · ES modules + npm workspaces (no Turborepo/Nx, no bundler for the API)

**Status:** accepted, implemented.

**Context.** Three artifacts (domain, api, two clients) share code. The master prompt says "use
a monorepo tool only if it materially improves builds and remains free/open source".

**Decision.** Plain **npm workspaces** (`packages/*`, `apps/api`, `apps/web`) with TypeScript
`NodeNext` ESM throughout. `apps/api` runs `tsc` output directly with `node`; dev mode uses
`node --watch --experimental-strip-types` — no bundler, no ts-node, no tsx. Root scripts fan
out with `-ws --if-present`.

**Cost.** No task-graph caching (Turborepo would be faster on large repos), no incremental
`--build` wiring between packages (each package compiles independently; the API resolves
`@sbm/domain` through `node_modules` and its `dist`). `apps/mobile` is deliberately **excluded**
from `workspaces` because the Expo dependency tree is huge and must be an explicit opt-in —
which means it does not get hoisting and must be installed separately. That is a knowing
trade-off (documented in `README.md`), not an oversight.

---

## ADR-006 · Curated official-source links as the AI fallback (not "no AI, sorry")

**Status:** accepted, implemented (`apps/api/src/ai.ts`), tested (2 API tests).

**Context.** The zero-cost rule means no mandatory paid AI or search API. Hosted free tiers
change, pause and disappear. But the master prompt also forbids pretending: *"never pretend
generative AI or live search ran when it did not"*.

**Decision.** Three tiers with honest labels — `local` (your own Ollama), `generative` (any
OpenAI-compatible endpoint you have free access to), and `fallback` (deterministic rules +
**curated official Bangladesh/FAO links**), with `none` as the default. Every answer carries
`mode`, `provider` and a `limitations` array; every curated link is labelled
`CURATED_LINK` with a note saying it is a link to open, not a search result. A retailer page is
classified `RETAILER` and is never treated as proof of approval or efficacy. Nothing is
fabricated: if the search provider fails, only curated links are shown, labelled as such.

**Alternatives rejected.**

- **Hard-fail when no provider is configured:** throws away the single most valuable part of the
  feature (a farmer gets nothing) in order to preserve purity.
- **Bundle a tiny local model in the APK:** an 8B model is ~5 GB; a phone cannot run it usefully,
  and it would blow the free-storage budget.
- **Ship a hosted free-tier key inside the app:** a bundled key is a published key; it would be
  scraped and rate-limited within days, and would violate the "never bundle secrets" rule.

**Cost.** The fallback is not conversational. Its value is a correct, honest answer plus the
right official links — which is genuinely useful in a field with no signal. The prompt rules
(dose/PHI/REI, IPM, escalation on mass mortality) are **influences on a model, not guarantees**;
the only structural guarantees are that the AI has no write capability and that a large
mortality event is flagged and escalated by the API itself.

---

## ADR-007 · Farm → Unit → Production cycle as the farming model (not per-species tables)

**Status:** accepted, implemented (migration 4 + `packages/domain/src/farming.ts`), tested.

**Context.** The master prompt requires crop, horticulture, livestock, poultry and aquaculture
"in the same app", with plots, greenhouses, barns, pens, poultry houses, ponds and tanks.

**Decision.** Model the **shape of the work**, not the species:

- `farms` (location/address/area) →
- `farm_units` with a `kind` discriminator (`PLOT`/`FIELD`/`GREENHOUSE`/`BARN`/`PEN`/
  `POULTRY_HOUSE`/`POND`/`TANK`/`OTHER`) and area/capacity in real units →
- `production_cycles` with a `farming_type` (`CROP`/`HORTICULTURE`/`LIVESTOCK`/`POULTRY`/
  `AQUACULTURE`) plus free-text `crop_or_species` / `variety_or_breed`, and free-text
  observations →
- `farming_events`, `cost_sources`, `cost_allocations`, `harvests`, `mortality_losses`.

Species-specific detail lives in **observations** (typed `kind` + value + unit) rather than in
five schema branches.

**Alternatives rejected.**

- **A table per species** (`cattle`, `poultry_batch`, `pond_stock`, …): five near-identical
  schemas, five sets of endpoints, five costing paths — and adding a sixth (goats? ducks?
  shrimp?) requires a migration and a new UI. It also breaks the "one costing engine" guarantee.
- **A JSON blob per cycle:** no constraints, no queryable costs, no FK integrity.

**Cost.** Nothing stops a user from recording a `POND` unit inside a `CROP` cycle — the schema
does not enforce species/unit coherence. The UI must guide it. Genuinely species-specific
features (breeding cycles, lactation curves, IAS-41 biological-asset revaluation, egg-grade
accounting, water-quality parameters with safe ranges) are **not** modelled at all; adding them
means new typed child tables beside `observations`, which is a clean extension point.

---

## ADR-008 · One domain package instead of eight

**Status:** accepted (deviation from the master prompt's suggested layout).

**Context.** The master prompt sketches `packages/{domain,ui,data,offline,accounting,farming,config}`.

**Decision.** Ship **`packages/domain`** only (plus `apps/*`). Accounting needs money and
inventory; farming needs money, inventory and accounting; offline needs money and hash. Those
five "packages" would have been mutually dependent, producing a dependency cycle that npm
workspaces do not handle cleanly, and the only thing the split buys is a folder boundary.

**Cost.** `packages/domain` is bigger than a single-purpose package should be, and `index.ts`
re-exports everything (a barrel), which means nothing can be tree-shaken by package boundary
alone — the client bundles must rely on the bundler for dead-code elimination. `packages/ui`
does not exist, so there is **no shared design-token/component package** between web and
mobile: each client styles itself. `packages/config` does not exist either; shared lint/format
config is absent (there is no linter configured in this repo).

---

## ADR-009 · Application-level tenant isolation now, RLS later

**Status:** accepted as a **temporary** state — and flagged as a risk.

**Context.** The master prompt requires *server-enforced database policies* and states that
"UI-only access restrictions are not security". The only free database available for the
delivered build is embedded SQLite, which has **no** row-level security.

**Decision.** Enforce isolation in the one place every query passes through — `Repository`,
via a resolved `Caller` whose membership is checked on every request — and make that explicit
in `SECURITY.md` §3 and §11.3 rather than describing the product as if RLS existed. Add RLS as
part of building shared mode (R2 in `IMPLEMENTATION_PLAN.md`).

**Update (2026-10-14).** The RLS half has since been **written**: `supabase/migrations/0007`
contains 148 `CREATE POLICY` statements with `enable` **and** `force row level security` on
every tenant table, plus `security definer` helpers with a pinned `search_path`, append-only
table policies and two double-entry guards. So RLS now exists as SQL — but it has **never been
executed** (no PostgreSQL server here), and `apps/api` still writes to SQLite. The running
system therefore still depends entirely on the application layer. See ADR-012.

**Cost.** If the SQLite file is ever shared, or the Postgres port is wired up without proving
RLS, tenant isolation rests entirely on the API code path. The two findings in `SECURITY.md`
§11.1–11.2 (cost leakage through sync pull / CSV export; admin self-granting
`business.transfer_ownership`) show that relying on a single enforcement layer has already
produced real gaps. **This ADR should be superseded, not cited as a permanent design.**

---

## ADR-010 · Bilingual by construction: `nameBn` columns and Bangla-first defaults

**Status:** accepted, implemented and tested.

**Context.** Real users are Bangla-speaking partners and shopkeepers. A translation layer bolted
on afterwards leaks English into the places that matter most (account names, unit names, role
names, status labels, money formatting).

**Decision.** Put Bangla beside English **in the data model and the domain constants**: every
account has `nameBn`, every unit has `nameBn`, `products.name_bn`, `farming_types` and
`farm_units.kind` carry Bangla names, `SYNC_STATUS_LABEL` and `syncBanner()` return `{en, bn}`,
`formatMoney` supports `banglaDigits` (০-৯) and **South-Asian grouping** (`৳12,34,567.89`) for
BDT/INR, `formatDateBn` renders Bangla months, and Bangla digits are parsed on input
(`normalizeDecimalInput`, `parseMoney`). Defaults are `DEFAULT_CURRENCY=BDT`,
`DEFAULT_LOCALE=bn-BD`, `DEFAULT_TIMEZONE=Asia/Dhaka`.

**Cost.** Bangla strings live in TypeScript constants, so there is no external translation file
and no way to add a fourth language without code changes. Only two languages are supported end
to end. Bangla **digit grouping and number-to-words** (e.g. "বারো লক্ষ") is not implemented; and
the `bn` units are in the domain package, but there is no automated check that every new user-
facing string has a Bangla counterpart.

---

## ADR-011 · Asia/Dhaka business dates, never the device clock or UTC

**Status:** accepted, implemented, tested (`validation.test.ts`).

**Context.** "Today", "this month", "overdue" and the year embedded in a document reference must
agree for every partner. A phone set to UTC, or travelling, would otherwise produce a different
business day — and for a business that closes after 6pm in Dhaka, the UTC date is *yesterday*.

**Decision.** All date logic goes through helpers that take an explicit IANA timezone
(`localDateString`, `localTimeString`, `monthStart`, `currentMonth`, `addDays`,
`daysBetween`, `formatDateBn`), using `Intl.DateTimeFormat` with `en-CA`/`en-GB` so the parts
come out ISO-ordered. The business's `timezone` (default `Asia/Dhaka`) is passed in from the
business row. References embed the **business-local** date
(`SAL-20260405-0001`).

**Cost.** Every caller must supply the timezone; a missed argument silently falls back to
`Asia/Dhaka`, which is right for this product but wrong for a business in another country (the
setting exists and is honoured wherever a business row is available). Timestamps remain UTC
ISO — only *business dates* are localised, which is the correct split but means a reader must
know which of the two they are looking at.

---

## ADR-012 · Postgres as a full SQL/RPC layer beside the app, not an ORM underneath it

**Status:** implemented as SQL (7 migrations, 148 policies, 10 function files); **never
executed**. RLS is unproven and `apps/api` has no adapter.

**Context.** The master prompt's central promise is that 2–5 partners share one business from
different devices and places. That needs a hosted database, and it needs *server-enforced*
access control — "UI-only access restrictions are not security". Two shapes were possible:

1. an ORM/adapter inside `apps/api` against a hosted Postgres; or
2. a self-contained Postgres layer (`supabase/`) that owns the schema, RLS policies and the
   transactional operations, which the API (or any client) calls.

**Decision.** Option 2, deliberately:

- Every rule that must survive a buggy or hostile client is enforced **in the database**:
  `enable` + `force row level security` on every tenant table, append-only tables with **no**
  UPDATE/DELETE policy, a `business_id` on every tenant row, a deferrable trigger proving
  `sum(cost_allocations.amount) = cost_sources.amount`, and two independent double-entry
  guards (a function check **and** a constraint trigger at commit).
- Money is `numeric(20,6)`, asserted by a test — never `float`/`real`/`double precision`.
- The nine posting operations are **RPCs** (`post_sale`, `receive_purchase`, `move_stock`,
  `post_harvest`, `allocate_cost`, `post_payment`, `create_journal_entry`, `close_cycle`,
  `void_document`) plus helpers (`redeem_invite`, `next_reference`). A client that speaks to
  those by name and `jsonb` payload shape does not care whether they run on Supabase, Neon or
  a self-hosted Postgres — provider independence is an interface, not a promise.
- The migrations are **files in the repo** (`supabase/migrations/0001…0007`), not a schema
  generated at runtime, so the tenant boundary is reviewable in a pull request.

**Cost / why this is not finished.**

- **It has never run.** There is no PostgreSQL server in this environment, so 38 tests read the
  SQL and assert structure. A policy can be syntactically perfect and semantically wrong; only a
  live second-tenant query proves isolation. **Do not treat RLS as verified.**
- **`apps/api` cannot use it yet.** There is no adapter, so `SBM_MODE=shared` is cosmetic and
  the running system is still SQLite with application-level isolation (ADR-009).
- Duplication is real: the same domain rules now exist as TypeScript (`packages/domain`) and as
  SQL constraints/triggers. That is intentional (defence in depth) but it means a rule change
  must be made twice, and the SQL side is only exercised when a real database is present.
- It also means two permission layers that can **disagree**: the SQLite app applies per-member
  `grants`/`denials`; the Postgres `has_business_permission()` reads a seeded `role_permissions`
  table plus business settings. `SECURITY.md` §11.2 notes this. Unify them before shipping
  shared mode.
