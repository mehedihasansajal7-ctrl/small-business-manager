# SYNC_DESIGN.md — offline-first synchronisation

**What is implemented and tested:** the server side
(`apps/api/src/sync.ts`, `apps/api/src/db.ts` migration 5) and the shared pure primitives
(`packages/domain/src/sync.ts`, 20 tests in `packages/domain/test/sync.test.ts`, plus four
end-to-end sync tests in `apps/api/test/api.test.ts`).

**What is NOT verified yet:** the *client* side of the outbox — the durable local store
(SQLite in the Expo app, IndexedDB in the web app) and the sync worker that drains it. Those
apps were being written concurrently with this document; see `TASKS.md` for the exact
state. Everything below that is labelled "device" is a **specified contract** that the
server already honours, not a claim that a device has been observed doing it.

---

## 1. The rule that governs everything

> **Never assume one device knows another device's offline work.**

A partner's phone may hold three unsynced sales. A second partner's phone cannot know they
exist, and must not be shown them as if they were shared. Therefore:

- The UI must show a **pending count** for this device's unsynced changes
  (`pendingCount()`) and a banner that says *"Offline. 3 change(s) saved on this device and
  waiting to sync."* — never "saved" and never "posted" (see §9).
- A **high-risk** event (a sale, a payment, a stock move, a cost allocation, a role change)
  is labelled a **local proposal** until the server acknowledges it. `isConfirmed(event)`
  returns `true` **only** for `status === 'SYNCED'`.
- Shared reports only change **after** synchronisation. Nothing else is implied.

---

## 2. The outbox event

One durable row per user action, written **in the same local transaction** as the local
record change (that is the contract; the server cannot verify it, the client store must
honour it). Shape — `OutboxEvent<T>` in `packages/domain/src/sync.ts`:

| Field | Type | Purpose |
|---|---|---|
| `id` | string | local primary key (defaults to `eventId`) |
| `eventId` | string (UUID) | globally unique; becomes the server's idempotency key |
| `idempotencyKey` | string | `${businessId}:${aggregateType}:${eventId}` (§3) |
| `businessId` | string | the tenant the event belongs to |
| `actorId` | string | the user who performed it |
| `deviceId` | string | which device; carried into conflict reporting and audit |
| `aggregateType` | string | `sale`, `product`, `production_cycle`, `member`, … |
| `aggregateId` | string | the record being changed |
| `eventType` | string | `sale.post`, `farming.input_issue`, `product.upsert`, … (§7) |
| `schemaVersion` | number | currently `OUTBOX_SCHEMA_VERSION = 1` |
| `occurredAt` | ISO string | when the **user** did it (business time) — used for ordering |
| `createdAt` | ISO string | when the row was written |
| `baseRevision` | `number \| null` | the server revision the edit was based on (§5) |
| `payload` | T | the operation, the same shape the online API accepts |
| `payloadHash` | string | `sha256Hex(canonicalJson(payload))` (§4) |
| `status` | `SyncStatus` | PENDING/SYNCING/SYNCED/NEEDS_ATTENTION/CONFLICT/REJECTED |
| `risk` | `'LOW' \| 'HIGH'` | derived from `eventType` via `HIGH_RISK_EVENTS` |
| `attempts` | number | failed attempts so far |
| `lastError` | string \| null | last error message, for the user |
| `nextAttemptAt` | ISO string \| null | backoff schedule (§6) |
| `serverRevision` | number \| null | the revision the server reported back |

Created by `createOutboxEvent()`. It requires a Web Crypto `randomUUID()`; on a device
without it (older Hermes) the app installs a polyfill rather than silently losing a
transaction — an outbox event that cannot be created is a **lost sale**.

---

## 3. Idempotency key derivation

```
idempotencyKey = `${businessId}:${aggregateType}:${eventId}`
```

Three properties this buys:

1. **Business-scoped** — the same UUID accidentally generated in two tenants cannot collide,
   and a device cannot smuggle an event into another business (the server *also* rejects a
   mismatched `businessId` outright, §8).
2. **Deterministic** — derived, not random, so the same event rebuilt on retry yields the
   identical key. `eventId` is generated **once**, when the event is created, and is never
   regenerated on retry. Regenerating it would defeat the whole scheme.
3. **Stable across app restarts and re-uploads** — the key lives in the durable outbox row,
   so a crash-and-relaunch re-sends the *same* key.

Note the deliberate asymmetry with the online API: a direct `POST /api/sales` generates a
random `event_id` server-side and stamps the journal entry `${eventId}:journal`, so an
online posting and a synced posting are idempotent in the same way.

---

## 4. Payload hash

`payloadHash(payload) = sha256Hex(canonicalJson(payload))`, where `canonicalJson`:

- **sorts object keys** recursively, so key order can never change the hash;
- converts `bigint` → string and `Date` → ISO string;
- maps array `undefined` → `null` and drops `undefined` object properties;
- relies on `Decimal.toJSON()` returning a **string**, so `4500.00` hashes as `"4500.00"`,
  never as the float `4500`.

The hash exists to detect a **changed payload under the same key** (a bug or a tamper):
the server stores it in `processed_events.payload_hash`. Note honestly that the current
`applyOne()` compares the **key** and does not re-verify the hash of a replayed event — the
hash is recorded, not enforced. `sha256` is implemented by hand in
`packages/domain/src/hash.ts` with **no dependency**, so the identical hash is computed on
Node and in a browser/phone (verified against the NIST vectors in the tests).

---

## 5. Exactly-once server application

`SyncService.push(caller, events)` loops the batch and calls `applyOne()` per event.
`POST /api/sync/push` refuses more than **200 events** in one request.

`applyOne()` in order:

1. **Tenant check.** `event.businessId !== caller.business.id` → `403` for the whole
   request. A device can never push into a business it is not the active member of.
2. **Replay check.** `SELECT result, server_revision FROM processed_events WHERE
   idempotency_key = ?`. If found → return `SYNCED` with the stored result and the message
   *"Already applied earlier (idempotent replay)"*. **Nothing is applied a second time.**
3. **Online-only guard.** If `eventType` is in `ONLINE_ONLY_EVENTS`, record the key in
   `processed_events` with `server_revision = 0` and return `NEEDS_ATTENTION` with *"This
   action must be completed online because it changes access or ownership."* — the event is
   consumed and will not loop.
4. **Revision conflict check.** For the four revision-tracked aggregates (§5.1), compare
   `event.baseRevision` with the current server `revision`. On `CONFLICT`, insert a
   `sync_conflicts` row and return `CONFLICT` **without applying anything**.
5. **Apply, transactionally.** Inside `repo.db.transaction()`:
   - `applyEvent()` maps the event onto **the same repository method the online API uses**
     (`sale.post` → `repo.createSale`, etc.) — there is no second, weaker code path for
     offline data;
   - `nextRevision(businessId)` increments `businesses.revision` and returns the new value;
   - the `processed_events` row is written **in that same transaction**. If the posting
     throws, the transaction rolls back and **no** `processed_events` row survives — so a
     genuinely failed business operation is retryable, and a successful one is unrepeatable.
6. **Failure classification.** An `HttpError` with status 400–499 is **permanent**: the key
   is recorded (with `{rejected: message}`) so a retry cannot loop forever, and the result is
   `REJECTED`. Anything else (5xx, network, a `StockError`, an unknown throw) is
   **transient**: no `processed_events` row is written and the result is `NEEDS_ATTENTION`,
   which is retryable.

The `Database.transaction()` helper is **re-entrant**: a nested call joins the outer
transaction instead of issuing a second `BEGIN IMMEDIATE` (which SQLite would refuse). That
is exactly why a sync batch can reuse the posting services unchanged.

Tests that prove this: `'applies an outbox event exactly once, even when retried'` (same
event twice → one sale, stock still 50 kg, `results[0].message` matches `/idempotent/i`)
and `'refuses to apply access changes from an offline queue'` (`member.role_change` →
`NEEDS_ATTENTION`).

### 5.1 Revision-tracked aggregates

`REVISION_TABLES` currently maps exactly four:

| `aggregateType` | table |
|---|---|
| `product` | `products` |
| `customer` | `customers` |
| `supplier` | `suppliers` |
| `production_cycle` | `production_cycles` |

`baseRevision === null` **skips** the check (treated as "no known base" — used for
append-only events, where there is nothing to conflict with). For everything else, a
divergence becomes a visible conflict, never a silent overwrite.

`classifyRevision(baseRevision, serverRevision)`:

| Condition | Verdict |
|---|---|
| `baseRevision === null` | `IN_SYNC` |
| `baseRevision === serverRevision` | `IN_SYNC` |
| `baseRevision < serverRevision` | **`CONFLICT`** |
| `baseRevision > serverRevision` | `LOCAL_IS_NEWER` |

A conflict writes a `sync_conflicts` row with `status='OPEN'`, the local and server
revisions, the device and actor, `differing_fields` (currently the literal `["unknown"]` —
the server does not diff fields, see §5.2) and `auto_mergeable = 0`.

### 5.2 Field-level conflict analysis is client-side only today

`analyseFieldConflict()` and `MERGEABLE_FIELDS` live in the shared domain package and are
used by the **client** to decide whether a conflict could be merged. The *server* does not
currently diff fields; it records `["unknown"]`. That is a real gap between the design and
the implementation and is stated here rather than papered over.

---

## 6. Retry, backoff and jitter

`retryDelayMs(attempt, options)` — `attempt` is **1-based**:

| Parameter | Default | Meaning |
|---|---|---|
| `baseDelayMs` | `1 000` | first delay |
| `maxDelayMs` | `900 000` (15 min) | hard ceiling |
| `jitterRatio` | `0.25` | ±25 % jitter |
| `random` | `Math.random` | injectable, so tests are deterministic |

```
raw    = min(maxDelayMs, baseDelayMs × 2^(attempt − 1))
jitter = raw × jitterRatio × (random() × 2 − 1)      // ±25 %
delay  = max(0, round(raw + jitter))
```

So attempt 1 ≈ 0.75–1.25 s, attempt 2 ≈ 1.5–2.5 s, attempt 5 ≈ 12–20 s, and everything is
capped at 15 min ± jitter. Tests: `'grows exponentially and is deterministic when the
randomness is injected'`, `'applies bounded jitter'`, `'caps at the maximum delay'`.

`shouldRetry(event, maxAttempts = 12)`: `false` for terminal `SYNCED`/`REJECTED`, otherwise
`attempts < 12`.

`statusAfterFailure(attempts, { maxAttempts, conflict, permanent })`:

| Condition | Status |
|---|---|
| `permanent` | `REJECTED` |
| `conflict` | `CONFLICT` |
| `attempts >= 12` | `NEEDS_ATTENTION` |
| otherwise | `PENDING` |

`NEEDS_ATTENTION` is the "we gave up; a human must look" state — it keeps an explicit
"Retry" action and a visible queue count, and never silently discards a business
transaction.

---

## 7. Event catalogue

`applyEvent()` supports exactly these `eventType`s (anything else →
`400 UNKNOWN_EVENT`):

| `eventType` | Repository method it calls |
|---|---|
| `sale.post` | `createSale` |
| `purchase.receive` | `createPurchase` |
| `receipt.post` | `recordCustomerReceipt` |
| `payment.post` | `recordSupplierPayment` |
| `income.post` | `recordIncomeExpense({kind:'INCOME'})` |
| `expense.post` | `recordIncomeExpense({kind:'EXPENSE'})` |
| `transfer.post` | `recordTransfer` |
| `capital.contribution` | `recordPartnerCapital({kind:'CONTRIBUTION'})` |
| `capital.withdrawal` | `recordPartnerCapital({kind:'WITHDRAWAL'})` |
| `farming.input_issue` | `recordFarmingEvent({eventType:'INPUT_ISSUE'})` |
| `farming.cost` | `recordFarmingEvent` (event type from the payload) |
| `farming.observe` | `recordFarmingEvent({eventType:'OBSERVATION'})` |
| `farming.mortality` | `recordFarmingEvent({eventType:'MORTALITY'})` |
| `harvest.post` | `recordHarvest` |
| `cycle.create` | `createCycle` |
| `cycle.close` | `closeCycle(payload.cycleId)`. |
| `cost.allocate` | `allocateSharedCost` |
| `product.upsert` | `updateProduct` if `payload.id` else `createProduct` |
| `customer.upsert` | `createCustomer` |
| `supplier.upsert` | `createSupplier` |

Because every one of these is the *same* function the online route calls, an offline sale
and an online sale produce byte-identical postings — there is no "offline mode" variant of
the accounting.

### 7.1 High-risk events (local proposal until confirmed)

`HIGH_RISK_EVENTS` in the domain package:

`sale.post`, `purchase.receive`, `stock.move`, `stock.adjust`, `harvest.post`,
`cost.allocate`, `payment.post`, `journal.post`, `member.role_change`,
`opening_balance.set`.

`risk = 'HIGH'` for these, `'LOW'` otherwise. A high-risk event gets `risk: 'HIGH'` in the
outbox and must be rendered as **"saved on this device, not yet shared"** until
`status === 'SYNCED'`. Note that `stock.move` and `journal.post` are in the risk set but are
**not** in the `applyEvent` catalogue — a device that queued one would get
`UNKNOWN_EVENT` (`REJECTED`). That is a real mismatch to fix, listed in TASKS.md.

### 7.2 Events that must be done online

`ONLINE_ONLY_EVENTS` on the server: `member.role_change`, `member.invite`,
`business.transfer_ownership`, `opening_balance.set`. These change **access or ownership**,
so they are never applied from an offline queue; they return `NEEDS_ATTENTION` with an
explanatory message and are recorded so they do not retry.

---

## 8. Pull

`GET /api/sync/pull?since=<ISO>` → `SyncService.pull(caller, since)`. It returns only the
caller's own business rows and only those changed after `since`:

`business` (+`businessRevision`), `products`, `customers`, `suppliers`, `locations`,
`sales`, `saleLines`, `purchases`, `purchaseLines`, `stockMovements`, `journalEntries`,
`journalLines`, `farms`, `farmUnits`, `cycles`, `farmingEvents`, `harvests`,
`costAllocations`, plus **all `OPEN` conflicts** and `serverTime`/`serverTimeIso`.

- Child rows (`saleLines`, `purchaseLines`, `journalLines`) are selected by joining their
  parent and filtering on the **parent's** `updated_at`, so a device never receives an
  orphan line.
- Deletes are **not** propagated — consistent with the append-only policy (append-only
  records are never deleted). A soft-deleted product would need an explicit tombstone
  strategy, which is not implemented.
- Test `'pulls only the caller own business changes'` asserts business A sees its own
  product, business B does not, and each response carries its own `business.id`.
- `since` defaults to `1970-01-01T00:00:00.000Z` (a full pull) when omitted.

---

## 9. Status state machine

`SyncStatus` and its bilingual labels (`SYNC_STATUS_LABEL`):

| Status | EN | বাংলা | Meaning |
|---|---|---|---|
| `PENDING` | Pending | অপেক্ষমাণ | queued, will be sent (a `nextAttemptAt` backoff may apply) |
| `SYNCING` | Syncing | সিঙ্ক হচ্ছে | in flight |
| `SYNCED` | Synced | সিঙ্ক হয়েছে | **server confirmed** — the only state that may be shown as posted |
| `NEEDS_ATTENTION` | Needs attention | মনোযোগ প্রয়োজন | transient failure, retries exhausted, or an online-only event |
| `CONFLICT` | Conflict | সংঘাত | another partner changed the record; a human decision is required |
| `REJECTED` | Rejected | বাতিল | permanent failure (4xx); will not be retried |

```
             ┌─────────────► SYNCED            (server acknowledged)
             │
PENDING ─► SYNCING ─┬──► NEEDS_ATTENTION ──► PENDING   (retry after backoff)
   ▲                │                    └──► REJECTED  (permanent)
   │                ├──► CONFLICT ──► resolve (LOCAL_WINS | SERVER_WINS)
   └────────────────┴──► REJECTED
```

Client-side counters: `outboxCounts(events)` returns a count per status;
`pendingCount(events)` counts `PENDING + SYNCING + NEEDS_ATTENTION`; `syncBanner({online,
pending, conflicts, lastSyncedAt})` returns the header message, **conflicts first**, then
offline, then pending, then success — with an explicit test that it never claims success
while offline with pending changes.

`isConfirmed(event)` = `status === 'SYNCED'`. There is no other "confirmed".

---

## 10. Conflict resolution

- `GET /api/sync/conflicts` → all conflicts for the business, newest first, limit 200.
- `POST /api/sync/conflicts/:id/resolve` with `{resolution: 'LOCAL_WINS' | 'SERVER_WINS'}`
  updates the row's `status`, `resolved_at`, `resolved_by` and is **audited**
  (`conflict.resolve`). It refuses (`404`) if the conflict is not open or not in the
  caller's business.
- What "LOCAL_WINS"/"SERVER_WINS" *means* is the client's job: the server records the
  decision; the client then re-submits (with a fresh `baseRevision`) or discards. The server
  itself does not replay the payload on resolve. Be aware of this when building the UI.

**Fields that may auto-merge** (`MERGEABLE_FIELDS`, used by `analyseFieldConflict` →
`autoMergeable`, and by `mergeDraftFields`):

`notes`, `description`, `attachmentIds`, `tags`, `phone`, `address`, `contactPerson`.

Everything else — amounts, quantities, prices, dates, statuses, revisions, permissions — is
**non-mergeable**. `autoMergeable` is true only when the differing fields are non-empty and
**every** differing field is in that set. `mergeDraftFields(local, server, acceptLocalFor)`
starts from the server object and takes the accepted local fields, i.e. the server wins by
default on anything not explicitly accepted.

Money, stock and posted production events are never last-write-wins. That is the point of
the whole revision mechanism: a lost update on an inventory quantity is a wrong stock count
that silently propagates to every partner.

---

## 11. Offline-capable actions

The master prompt's offline contract: *draft create/edit, sale, purchase, expense, input
issue, farming event, harvest, view previously synced records*. Every one of those has a
server-side `eventType` in §7 — **except** `stock.move`/`journal.post`, which are in
`HIGH_RISK_EVENTS` but have no `applyEvent` branch (see §7.1). Authentication and initial
invitation **require internet** (a session cookie and the invite redemption are online
operations), which must be explained in the UI, not hidden.

## 12. Honest gaps

| Gap | Consequence |
|---|---|
| Client outbox store + worker not verified in this pass | the contract in §2 is honoured by the server; device behaviour is unproven |
| `stock.move` / `journal.post` in `HIGH_RISK_EVENTS` but absent from `applyEvent` | queuing one yields `REJECTED: Unsupported sync event type` |
| Server does not diff fields; `differing_fields = ["unknown"]` | the conflict screen cannot show "what differed" from server data alone |
| `payload_hash` recorded but not enforced on replay | a payload changed under the same key is not detected server-side |
| No delete/tombstone propagation in `pull` | a soft-deleted record would linger on a device |
| `resolved` conflicts do not replay the payload | the client must re-submit; a "LOCAL_WINS" click alone does not change data |
| No `devices` registration endpoint | `deviceId` is whatever the client sends; it is not authenticated |
| `baseRevision` is only checked for 4 aggregate types | edits to other aggregates (e.g. `harvest`) are append-only by design, but any future editable aggregate needs adding to `REVISION_TABLES` |
| Sync has no per-event rate limit | a device can push up to 200 events per request; other rate limits (login/register/invite) do not cover sync |
