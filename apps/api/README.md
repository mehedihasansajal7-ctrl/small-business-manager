# @sbm/api — Small Business Manager API

A **zero-runtime-dependency** Node HTTP API: the embedded database is the built-in
`node:sqlite`, authentication uses `node:crypto` scrypt + an HMAC-signed cookie,
and all business/accounting/farming rules come from the shared `@sbm/domain`
package. Nothing here needs an account, a credit card or an external service.

## Run it

```powershell
# from the monorepo root
npm install                 # once
npm run api                 # builds @sbm/domain, then starts the API on http://127.0.0.1:8787

# or, from this folder
npm run build
node dist/server.js
```

Environment is optional in `local` mode. Copy the repo `.env.example` to `.env`
to change the port, data directory, timezone, session secret or AI providers.

**Requires Node ≥ 22.5** (`node:sqlite`). Developed and tested on Node 24.

### Load the demo data

```powershell
node dist/seed.js --memory    # throw-away in-memory demo, prints a summary
node dist/seed.js             # writes to the configured DATA_DIR
```

Demo sign-in (dev only): `owner@demo.sbm` / `demo1234`
(partners: `partner@demo.sbm`, `farm@demo.sbm`).

## Layout

| File | Responsibility |
|---|---|
| `src/config.ts` | Environment loading + validation, `local` vs `shared` mode |
| `src/http.ts` | Dependency-free router, JSON body reader, cookies, rate limiter, validators, errors |
| `src/db.ts` | Embedded SQLite, versioned migrations v1..v6, transactions, human-readable references |
| `src/auth.ts` | scrypt password hashing, HMAC-signed `HttpOnly`/`Secure` session cookies |
| `src/repository.ts` | Tenant-scoped data access + all posting services and reports |
| `src/sync.ts` | Offline-first push/pull with exactly-once application and conflict detection |
| `src/ai.ts` | Provider-neutral AI agent (local model / OpenAI-compatible / offline rules) + research |
| `src/routes.ts` | The HTTP surface: every endpoint, permission-checked |
| `src/server.ts` | Wiring, request lifecycle, error→status mapping, background jobs |
| `src/seed.ts` | Demo business: 3 partners, a shop and a full broiler cycle |

## Design rules worth knowing before you change anything

1. **Money and quantities are exact.** They are `Decimal` (bigint + scale) from
   `@sbm/domain` and are stored in SQLite as `TEXT`. Never introduce a float, and
   never do money arithmetic with `Number()`.
2. **The ledger is the truth.** Balances, profit, receivables and stock values are
   *derived*; no table stores an editable balance.
3. **Posted documents are never edited.** Corrections are an audited reversal
   (`POST /api/sales/:id/void`, `POST /api/purchases/:id/void`).
4. **The server enforces permissions.** The UI may hide things, but every route
   calls `repo.assertPermission(...)` via `requireCaller()`.
5. **Every tenant table carries `business_id`** and every query is filtered by the
   caller's business. Passing another business's id returns `403`.
6. **Sync is idempotent.** Each outbox event is applied once, keyed by its
   `idempotencyKey`, inside a single transaction, and recorded in `processed_events`.
7. **Negative stock is refused for everybody**; an override needs the approval
   permission plus a written reason, and it is audited.
8. **Nothing is claimed that was not verified.** See `../TESTING.md`.

## Error shape

```json
{ "error": { "code": "STOCK_CONFLICT", "message": "Insufficient stock: 0.0000 kg on hand, 10 required" } }
```

| Status | Meaning |
|---|---|
| 400 | Validation / bad request (`VALIDATION`, `INVALID_JSON`, `UNBALANCED_ENTRY`) |
| 401 | No or expired session (`UNAUTHORIZED`) |
| 403 | Not a member, or the role lacks the permission (`FORBIDDEN`) |
| 404 | Unknown route or record (`NOT_FOUND`) |
| 409 | Conflict: negative stock, duplicate document, stale revision (`STOCK_CONFLICT`, `LAST_OWNER`, `ALREADY_VOID`) |
| 413 | Body larger than 1 MB (`PAYLOAD_TOO_LARGE`) |
| 429 | Rate limited (`RATE_LIMITED`) |
| 500 | Unexpected (`INTERNAL`) — check the server log |

## Endpoint map

| Group | Endpoints |
|---|---|
| Health / meta | `GET /api/health`, `GET /api/status`, `GET /api/meta` |
| Auth | `POST /api/auth/register`, `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me` |
| Business | `POST /api/businesses`, `GET/PATCH /api/businesses/current`, `POST /api/businesses/switch`, `GET/PUT /api/businesses/settings` |
| Team | `GET /api/members`, `POST/GET /api/members/invites`, `DELETE /api/members/invites/:id`, `PATCH /api/members/:id`, `POST /api/invites/accept`, `GET /api/audit` |
| Catalog | `GET /api/units`, `POST /api/units/conversions`, `GET/POST /api/locations`, `GET/POST/PATCH /api/products`, `GET/POST/PATCH /api/customers`, `GET/POST/PATCH /api/suppliers` |
| Inventory | `GET /api/inventory`, `GET /api/inventory/movements`, `POST /api/inventory/adjust` |
| Commerce | `GET/POST /api/purchases`, `GET/POST /api/sales`, `POST /api/sales/:id/void`, `POST /api/purchases/:id/void`, `POST /api/receipts`, `POST /api/payments` |
| Finance | `POST /api/transfers`, `POST /api/income-expenses`, `POST /api/partner-capital`, `GET /api/accounts` |
| Farming | `GET/POST /api/farming/farms`, `POST /api/farming/units`, `GET/POST /api/farming/cycles`, `POST /api/farming/cycles/:id/events`, `POST /api/farming/cycles/:id/harvest`, `POST /api/farming/cycles/:id/close`, `GET /api/farming/cycles/:id/profit`, `POST /api/farming/allocations`, `GET /api/farming/dashboard`, `GET /api/farming/events` |
| Reports | `GET /api/reports/dashboard`, `/profit-loss`, `/balance-sheet`, `/trial-balance`, `/cash-flow`, `/stock-valuation`, `/receivables`, `/payables`, `/export/:table`, `/backup` |
| Sync | `POST /api/sync/push`, `GET /api/sync/pull`, `GET /api/sync/conflicts`, `POST /api/sync/conflicts/:id/resolve` |
| AI | `GET /api/ai/status`, `POST /api/ai/ask`, `GET/DELETE /api/ai/conversations[/:id]`, `POST/GET /api/ai/plans`, `POST /api/ai/feedback`, `POST /api/ai/research` |
| Attachments | `POST/GET /api/attachments/:entityType/:entityId` |

## Quick start with curl

```powershell
# register (creates the account AND the first business workspace)
curl.exe -i -c cookies.txt -X POST http://127.0.0.1:8787/api/auth/register `
  -H "content-type: application/json" `
  -d '{\"email\":\"owner@shop.test\",\"password\":\"password123\",\"displayName\":\"Owner\",\"businessName\":\"My Shop\"}'

# buy stock, then sell it
curl.exe -b cookies.txt -X POST http://127.0.0.1:8787/api/purchases -H "content-type: application/json" `
  -d '{\"documentDate\":\"2026-10-01\",\"paid\":\"5800\",\"lines\":[{\"productId\":\"<id>\",\"quantity\":\"100\",\"unit\":\"kg\",\"unitCost\":\"58\"}]}'

# the books must tie out
curl.exe -b cookies.txt "http://127.0.0.1:8787/api/reports/trial-balance?from=2026-10-01&to=2026-10-31"
```

## Tests

```powershell
npm test            # from this folder: 68 tests across api / security / http suites
```

The suites start the real HTTP server on an ephemeral port against an in-memory
database and drive it with `fetch`, so they cover routing, cookies, permissions,
tenant isolation, the accounting result of every posting service, offline-sync
idempotency, conflicts, the AI fallback mode and the audit log.

## Background jobs

`server.ts` prunes expired sessions hourly and writes a dated snapshot to
`<DATA_DIR>/backups/sbm-YYYY-MM-DD.json` once a day. Neither is a substitute for
the owner's own export routine — see `../docs/` and `GET /api/reports/backup`.

## Not done here (be aware)

- `shared` mode expects Supabase credentials and the Postgres port in
  `../supabase/`; nothing in shared mode was exercised against a live project.
- Attachment storage is the local filesystem. A partner who is offline cannot see
  a photo until they sync, and the API says so in its response.
- The AI agent has **no** mandatory paid provider: with nothing configured it
  returns honest rule-based guidance plus curated official links.
