-- =============================================================================
-- functions/0000_helpers.sql
-- Internal helpers shared by the transactional posting functions.
--
-- These are the ONLY functions besides the 0007 helpers that touch the ledger.
-- Apply this file AFTER the migrations in ../migrations/.
-- =============================================================================

-- Raise unless the current profile may perform `p_permission` in this business.
-- A NULL profile id means trusted server-side context (seed/migration/job).
create or replace function app.require_permission(p_business_id uuid, p_permission text)
returns void
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
begin
  if public.current_profile_id() is not null
     and not public.has_business_permission(p_business_id, p_permission) then
    raise exception 'Your role does not have permission: %', p_permission
      using errcode = 'insufficient_privilege';
  end if;
end;
$fn$;

-- The profile that owns the write. Falls back to the business creator for
-- trusted jobs, because actor columns are NOT NULL.
create or replace function app.effective_actor(p_business_id uuid)
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select coalesce(
    public.current_profile_id(),
    (select b.created_by from public.businesses b where b.id = p_business_id)
  );
$fn$;

-- Idempotency: return the stored result of a previously applied event.
create or replace function app.idempotent_result(p_idempotency_key text)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select r.result || jsonb_build_object('idempotent', true)
    from public.processed_events r
   where r.idempotency_key = p_idempotency_key;
$fn$;

-- Idempotency: remember that an event was applied. Replays are ignored.
create or replace function app.record_event(
  p_idempotency_key text,
  p_business_id uuid,
  p_event_id text,
  p_event_type text,
  p_aggregate_type text,
  p_aggregate_id text,
  p_payload jsonb,
  p_result jsonb
)
returns void
language sql
security definer
set search_path = public, pg_temp
as $fn$
  insert into public.processed_events
    (idempotency_key, business_id, event_id, event_type, aggregate_type, aggregate_id,
     payload_hash, server_revision, result)
  values
    (p_idempotency_key, p_business_id, p_event_id, p_event_type, p_aggregate_type, p_aggregate_id,
     encode(sha256(convert_to(coalesce(p_payload, '{}'::jsonb)::text, 'UTF8')), 'hex'),
     coalesce((select b.revision from public.businesses b where b.id = p_business_id), 0),
     coalesce(p_result, '{}'::jsonb))
  on conflict (idempotency_key) do nothing;
$fn$;

-- On-hand quantity for an item (optionally at one location). IN adds, OUT
-- subtracts; the quantity column itself is always positive.
create or replace function app.on_hand_qty(
  p_business_id uuid,
  p_item_id uuid,
  p_location_id uuid default null
)
returns numeric
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select coalesce(sum(case when m.direction = 'IN' then m.quantity else -m.quantity end), 0)
    from public.stock_movements m
   where m.business_id = p_business_id
     and m.item_id = p_item_id
     and (p_location_id is null or m.location_id = p_location_id);
$fn$;

-- Weighted average unit cost of an item from its movement history (the same
-- figure the domain `currentUnitCost` reports).
create or replace function app.item_unit_cost(p_business_id uuid, p_item_id uuid)
returns numeric
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select case when agg.qty > 0 then round(agg.value / agg.qty, 6) else 0 end
    from (
      select
        coalesce(sum(case when m.direction = 'IN' then m.quantity else -m.quantity end), 0) as qty,
        coalesce(sum(case when m.direction = 'IN'
                          then m.quantity * m.unit_cost
                          else -(m.quantity * m.unit_cost) end), 0) as value
        from public.stock_movements m
       where m.business_id = p_business_id
         and m.item_id = p_item_id
    ) agg;
$fn$;

-- Money as a fixed 2-decimal string, matching the API's Money.amount text.
create or replace function app.money_text(p_value numeric)
returns text
language sql
immutable
as $fn$
  select trim(to_char(round(coalesce(p_value, 0), 2), '999999999999999990.00'));
$fn$;

-- The business default active location.
create or replace function app.default_location(p_business_id uuid)
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select l.id
    from public.locations l
   where l.business_id = p_business_id
     and l.is_active
   order by l.is_default desc, l.created_at
   limit 1;
$fn$;

-- A document reference: SAL-20260501-0007.
create or replace function app.reference(p_business_id uuid, p_kind text, p_prefix text, p_date date)
returns text
language sql
security definer
set search_path = public, pg_temp
as $fn$
  select public.next_reference(p_business_id, p_kind, p_prefix, p_date);
$fn$;

-- Insert a balanced double-entry posting and its lines in one statement.
-- Refuses an unbalanced or empty entry (the deferrable trigger in 0007 is a
-- second, independent guard that fires at commit).
create or replace function app.insert_journal_entry(
  p_business_id uuid,
  p_date date,
  p_reference text,
  p_description text,
  p_source_type text,
  p_source_id text,
  p_currency text,
  p_event_id text,
  p_posted_by uuid,
  p_lines jsonb,
  p_reversal_of uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_entry_id uuid := gen_random_uuid();
  v_line jsonb;
  v_debit numeric(20, 6) := 0;
  v_credit numeric(20, 6) := 0;
begin
  if p_lines is null or jsonb_array_length(p_lines) = 0 then
    raise exception 'UNBALANCED_ENTRY: a journal entry needs at least one line'
      using errcode = 'check_violation';
  end if;

  for v_line in select value from jsonb_array_elements(p_lines) loop
    v_debit := v_debit + coalesce(nullif(v_line ->> 'debit', '')::numeric(20, 6), 0);
    v_credit := v_credit + coalesce(nullif(v_line ->> 'credit', '')::numeric(20, 6), 0);
  end loop;

  if v_debit <> v_credit then
    raise exception 'UNBALANCED_ENTRY: debit % does not equal credit %', v_debit, v_credit
      using errcode = 'check_violation';
  end if;
  if v_debit <= 0 then
    raise exception 'UNBALANCED_ENTRY: the entry has no positive amount'
      using errcode = 'check_violation';
  end if;

  insert into public.journal_entries
    (id, business_id, document_date, reference, description, source_type, source_id,
     currency, posted_by, event_id, reversal_of)
  values
    (v_entry_id, p_business_id, p_date, p_reference, p_description, p_source_type, p_source_id,
     p_currency, p_posted_by, p_event_id, p_reversal_of);

  for v_line in select value from jsonb_array_elements(p_lines) loop
    insert into public.journal_lines
      (business_id, entry_id, account, debit, credit, currency, memo, partner_id, cost_center)
    values
      (p_business_id,
       v_entry_id,
       v_line ->> 'account',
       coalesce(nullif(v_line ->> 'debit', '')::numeric(20, 6), 0),
       coalesce(nullif(v_line ->> 'credit', '')::numeric(20, 6), 0),
       p_currency,
       nullif(v_line ->> 'memo', ''),
       nullif(v_line ->> 'partnerId', '')::uuid,
       nullif(v_line ->> 'costCenter', ''));
  end loop;

  return v_entry_id;
end;
$fn$;

-- Cost incurred by a cycle so far: direct costs plus allocated shared overhead.
create or replace function app.cycle_cost_to_date(p_business_id uuid, p_cycle_id uuid)
returns numeric
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select
    coalesce((select sum(cs.amount) from public.cost_sources cs
               where cs.business_id = p_business_id and cs.cycle_id = p_cycle_id and cs.shared = false), 0)
    + coalesce((select sum(ca.amount) from public.cost_allocations ca
                 where ca.business_id = p_business_id and ca.cycle_id = p_cycle_id), 0);
$fn$;

-- Cost already released to finished stock by earlier harvests of the cycle.
create or replace function app.cycle_assigned_cost(p_business_id uuid, p_cycle_id uuid)
returns numeric
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select coalesce(sum(h.cost_basis), 0)
    from public.harvests h
   where h.business_id = p_business_id
     and h.cycle_id = p_cycle_id;
$fn$;
