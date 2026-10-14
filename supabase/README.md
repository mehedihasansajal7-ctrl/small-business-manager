# `@sbm/supabase` — shared-cloud database layer

The **shared-cloud** store for Small Business Manager: PostgreSQL / Supabase
migrations, row level security, the transactional posting functions, a demo seed
and a runnable test suite.

It is the same **domain model** as the embedded SQLite store the working API
uses (`apps/api/src/db.ts`, migrations v1..v6) and the same rules as
`packages/domain` — ported to PostgreSQL, not redesigned. Table and column names
match the SQLite names, with four deliberate upgrades:

| SQLite | PostgreSQL here | why |
|---|---|---|
| `TEXT` money/quantity | `numeric(20,6)` | exact decimal arithmetic, never `float`/`real`/`double precision` |
| `INTEGER` 0/1 flags | `boolean` | honest types |
| JSON-as-`TEXT` | `jsonb` | indexable, validated with `jsonb_typeof` checks |
| ISO date strings | `date` / `timestamptz` | range queries and real time semantics |
| `TEXT` uuid ids | `uuid` + `gen_random_uuid()` | smaller, validated |

```
supabase/
  migrations/   applied in order by Supabase (or psql)
    0001_extensions.sql           pgcrypto, the `app` schema, current_profile_id()
    0002_identity_tenancy.sql     profiles, businesses, business_members, invites, devices,
                                  audit_logs, business_settings, number_sequences,
                                  role_permissions (seeded from packages/domain)
    0003_catalog_inventory.sql    units, locations, product_categories, products,
                                  unit_conversions, customers, suppliers, stock_lots,
                                  stock_movements
    0004_commerce_finance.sql     accounts (chart of accounts), financial_accounts,
                                  purchases/lines, sales/lines, payments,
                                  account_transfers, income_expenses, partner_capital,
                                  journal_entries/lines, attachments
    0005_farming.sql              farms, farm_units, production_cycles, farming_events,
                                  input_consumptions, production_outputs, harvests,
                                  mortality_losses, cost_sources, cost_allocations,
                                  output_lots, observations, cycle_cost_ledger (view)
    0006_sync_ai_attachments.sql  sync_events, processed_events, sync_conflicts, ai_*
    0007_policies_indexes.sql     RLS helpers, policies, guards, audit triggers, privileges, indexes
  functions/    applied after the migrations (they call the 0007 helpers)
    0000_helpers.sql              permission/actor/idempotency/stock/cost helpers
    0100_post_sale.sql            post_sale(business, payload, idempotency_key)
    0110_receive_purchase.sql     receive_purchase(...)
    0120_move_stock.sql           move_stock(...)
    0130_post_harvest.sql         post_harvest(...)
    0140_allocate_cost.sql        allocate_cost(...)
    0150_post_payment.sql         post_payment(...)
    0160_create_journal_entry.sql create_journal_entry(...)
    0170_close_cycle.sql          close_cycle(...)
    0180_void_document.sql        void_document(...)   (void, never delete)
  seed.sql      optional, idempotent demo dataset (fake data, no secrets)
  tests/        schema.test.ts, policies.test.ts (read the SQL; need no database)
```

---

## 1. Create a free Supabase project

1. Sign in at <https://supabase.com> → **New project**. The **Free** plan is
   enough for a 2–5 partner business.
2. Pick a region near your users (e.g. `ap-southeast-1` / Singapore for
   Bangladesh), set a strong database password and wait ~2 minutes.
3. Copy from **Project Settings → API**: `Project URL`, `anon key`,
   `service_role key` (server-side only — never ship it to a browser).
4. Copy the connection string from **Project Settings → Database**
   (the `postgres://…` pooler URI) for `supabase db push` / `psql`.

Enable **Email** auth under **Authentication → Providers** (the dashboard SPA
uses email + password). Optionally add a profile trigger so a new
`auth.users` row also creates `public.profiles`:

```sql
-- runs as a Supabase "Database Webhook"/trigger; profiles.id = auth.users.id
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into public.profiles (id, email, display_name)
  values (new.id, lower(new.email), coalesce(new.raw_user_meta_data ->> 'display_name', new.email))
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();
```

> `0002` already adds the `profiles.id → auth.users(id)` foreign key when the
> `auth` schema exists, so the two stay consistent.

## 2. Apply the migrations

**Option A — Supabase CLI (recommended).**

```bash
supabase link --project-ref <your-project-ref>
supabase db push            # applies migrations/ in filename order
psql "$DATABASE_URL" -f functions/0000_helpers.sql   # and 0100..0180
psql "$DATABASE_URL" -f seed.sql                      # optional demo data
```

**Option B — the SQL editor.** Paste the files in order `0001 → 0007`, then
`functions/0000 → functions/0180`, then (optionally) `seed.sql`. Each file is
idempotent-ish: `create table if not exists`, `create index if not exists`,
`create or replace function/view`, `drop trigger if exists` before each
`create trigger`, and `0007` drops existing policies before recreating them, so
re-running a file by hand is safe.

> **Run as a role that can bypass RLS** (`postgres` / `supabase_admin` in
> Supabase, or a superuser on plain PostgreSQL). `0007` deliberately uses
> `force row level security`, and the `security definer` helpers read
> `business_members`; if their owner cannot bypass RLS you get
> `infinite recursion detected in policy for relation "business_members"`.
> `0007` reassigns those helpers to `supabase_admin` when that role exists; on
> other servers either run the migrations as a superuser or reassign the
> functions yourself:
>
> ```sql
> alter function public.is_business_member(uuid) owner to <bypass_role>;
> -- ...same for is_business_owner, can_see_profile, can_bootstrap_business,
> -- business_setting_true, has_business_permission, next_reference,
> -- redeem_invite, log_export, current_profile_id
> ```

## 3. Verify RLS

```sql
-- every table must appear twice (enable + force), 52 rows each
select c.relname,
       c.relrowsecurity   as rls_enabled,
       c.relforcerowsecurity as rls_forced
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind = 'r'
 order by c.relname;

-- each tenant table needs at least one select policy
select t.tablename, count(*) filter (where p.cmd = 'SELECT') as select_policies
  from pg_tables t
  left join pg_policies p on p.schemaname = t.schemaname and p.tablename = t.tablename
 where t.schemaname = 'public'
 group by t.tablename
having count(*) filter (where p.cmd = 'SELECT') = 0;   -- must be empty (global tables use USING (true))
```

Then prove isolation with a real request: sign in as user A and select from
`public.sales` while a second business owned by user B has rows — A must see
nothing of B. Useful smoke test:

```sql
set local role authenticated;
select set_config('request.jwt.claim.sub', '<user-a-uuid>', true);
select count(*) from public.sales;         -- only A's rows
select public.is_business_member('<business-b-uuid>');  -- false
```

## 4. Seed data (optional)

`seed.sql` inserts **one** business (`demo-rahim-agro`) with three members
(owner / manager / farm manager), three products, one purchase, one sale, one
farm + broiler cycle + feed issue + harvest, plus a couple of bookkeeping rows.
It is guarded by `if the business already exists → do nothing`, and every insert
uses a fixed uuid or `on conflict do nothing`, so it is safe to re-run. It uses
only `*.example.com` addresses, fake names and **no passwords or secrets**.

The seeded profiles exist so the demo rows have owners; **create real sign-in
accounts through Supabase Auth** (then the `handle_new_user` trigger or an
`insert into public.profiles` with the auth user's id links them).

## 5. Free-tier limits and pause risk

| Limit | Free plan | Notes for this app |
|---|---|---|
| Database size | 500 MB | fine for thousands of small-business documents; `attachments` stores only metadata |
| Pause on inactivity | project pauses after ~1 week with no activity | **a paused project is unreachable until you un-pause it in the dashboard**; the offline-first client keeps working, but server sync stops |
| Egress / API requests | limited monthly quota | the SPA plus the hourly sync should stay far below it |
| Storage | 1 GB | attachments; the database stores `stored_path` and a checksum, never bytes |
| Daily backups | 7 days retention on paid; free has none | keep taking `pg_dump` snapshots (the welfare/dashboard backup scripts already do this pattern) |
| Connection pool | small direct pool | use the pooler URI for serverless/edge clients |
| Realtime / Edge Functions / Logs | limited | not used here |

Mitigations: keep the desktop sync job running (it refreshes the app at least
weekly so the project does not idle out), take periodic `pg_dump` snapshots, and
keep the embedded SQLite build as a zero-cost fallback for single-device use.

## 6. Moving between providers without touching domain logic

Everything provider-specific sits in this folder, and the wiring seam is a
handful of SQL functions and policies:

* **Domain rules stay in `@sbm/domain`** — money, units, inventory valuation,
  double entry, farming costing, roles/permissions. Nothing here re-implements
  them; the database only *guards* the same invariants (checks, triggers).
* **The API surface is 9 RPCs** — `post_sale`, `receive_purchase`, `move_stock`,
  `post_harvest`, `allocate_cost`, `post_payment`, `create_journal_entry`,
  `close_cycle`, `void_document`, plus `redeem_invite` and `next_reference`.
  A client that talks to these (by name and by the `jsonb` payload shape) does
  not care whether they run on Supabase, Neon, RDS or a self-hosted Postgres.
* **Tenant isolation is `business_id` + policies.** Any Postgres that supports
  RLS (`>= 9.5`; the view uses `security_invoker`, so `>= 15` for
  `cycle_cost_ledger`) can host the same files.
* Moving: `pg_dump --schema-only` / `--data-only` between providers, then
  re-apply `functions/*.sql` and re-verify RLS with the queries in section 3.
  Point the app's connection string at the new host — no domain code changes.
* Supabase-specific bits are clearly isolated: `auth.uid()` (behind
  `public.current_profile_id()`), the guarded `auth.users` FK, `anon` /
  `authenticated` / `service_role` grants, and Storage paths in `attachments`.
  On plain PostgreSQL, `current_profile_id()` simply returns what you put in
  `request.jwt.claim.sub`, and the grant block is a no-op.

## 7. Running the tests

```bash
cd small-business-manager/supabase
npx vitest run          # verified working from this folder
```

`npm test -w @sbm/supabase` works **only after** `"supabase"` is added to the
root `workspaces` array in `small-business-manager/package.json`
(`["packages/*", "apps/api", "apps/web", "supabase"]`) so npm links the
workspace; the folder is intentionally self-contained today (`package.json` +
`vitest.config.ts` + `tsconfig.json`), so `npx vitest run` from inside
`supabase/` is the supported way to run it without touching the root manifest.

**What the tests do and do not do.** There is **no PostgreSQL server in this
environment**, so the migrations are **not executed against a live database**
anywhere in this repository. `tests/schema.test.ts` and `tests/policies.test.ts`
read the SQL and assert real invariants: one `enable`/`force row level security`
per created table, a `business_id` on every tenant table, no
`float`/`real`/`double precision` anywhere, only `code_hash` on
`business_invites`, `unique` idempotency keys on `stock_movements` /
`processed_events` / `sync_events`, `debit`/`credit` one-sidedness, exact
header arithmetic, complete foreign keys, a `select` policy for every tenant
table, no policy satisfiable without a membership helper, append-only accounting
and stock tables, `security definer` with a pinned `search_path` on every
privileged function, and the presence/atomicity markers of the nine RPCs. They
are a static proof, not a substitute for running the migrations once against a
real Supabase project.

### Design decisions worth knowing

* **No plaintext invite code ever exists in the database.** `business_invites`
  stores only `code_hash` (a SHA-256 of the normalised code) plus `code_prefix`;
  `public.redeem_invite(code)` hashes the caller's code, locks the row
  (`for update`), validates status/expiry/use-count/email scope and inserts or
  reactivates the membership in the same transaction.
* **Posted rows are never updated or deleted.** `stock_movements`,
  `journal_entries`, `journal_lines`, `processed_events`, `payments`,
  `income_expenses`, `account_transfers`, `partner_capital`, `harvests`,
  `sale_lines`, `purchase_lines`, `mortality_losses`, `observations` and
  `cost_allocations` have **no UPDATE/DELETE policy**, and `audit_logs` is
  append-only (SELECT + INSERT only). Correct with a `reversal_of` row, or void
  a document (`status = 'VOID'`, `voided_at`) — see `void_document`.
* **Two independent double-entry guards.** `app.insert_journal_entry` refuses an
  unbalanced entry, and a deferrable constraint trigger
  (`journal_lines_balanced`) re-checks every entry at commit.
* **Shared costs must add up.** `app.assert_cost_allocation_balanced` is a
  deferrable constraint trigger proving `sum(cost_allocations.amount) =
  cost_sources.amount`; `allocate_cost` floors each share to the currency minor
  unit and gives the rounding remainder to the last weighted target so the sum
  is exact (the 10:20 split of 1,000 → 333.33 / 666.67).
* **Owner protection.** A `before update or delete` trigger refuses to demote,
  deactivate or remove the last owner, and a second trigger requires
  `business.transfer_ownership` for any change touching an owner role.
* **Partner cost visibility.** `has_business_permission` reads
  `role_permissions` (seeded from `packages/domain`) and then widens
  `financial_reports.view`, `purchase.cost.view`, `farming.cost.view` and
  `partner_capital.view` for non-owner/admin members according to
  `business_settings`: `partnerCanSeeFinancialReports`, `partnerCanSeeCosts`,
  `partnerCanSeeCapital`. `cycle_cost_ledger` is a `security_invoker` view, so
  those policies still apply to reports.
* **`anon` gets nothing.** Grants are revoked from `anon`, granted to
  `authenticated` (RLS narrows them) and to `service_role` (trusted jobs). This
  closes the one place where a NULL profile could satisfy a policy
  (`audit_logs` INSERT).

### Known gaps / things to review before production

* A shared `cost_sources` row inserted **without** any `cost_allocations` is not
  flagged (the trigger only fires when an allocation row exists). `allocate_cost`
  always writes both; a manual `INSERT` of a shared cost should go through it.
* Business creation is expected to follow: insert `businesses` → insert your own
  `business_members` row (allowed once by the `business_members_bootstrap_insert`
  policy) → insert a default `locations` row. A single `create_business()` RPC
  would be nicer; `apps/api/src/repository.ts` does the same three steps today.
* `attachments` metadata is covered by RLS, but **Storage bucket policies** are
  a separate thing — configure them in the Supabase dashboard (one folder per
  `business_id`, `authenticated` only).
* Expired invites stay `'open'` until someone tries to redeem them (the
  redemption then fails with `EXPIRED`); a scheduled job could sweep
  `status = 'expired'`.
* Realtime is not used; the sync design is an explicit outbox (`sync_events` /
  `processed_events`), not `supabase-js` realtime channels.
