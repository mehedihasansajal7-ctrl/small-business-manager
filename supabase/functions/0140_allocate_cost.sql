-- =============================================================================
-- functions/0140_allocate_cost.sql
--
-- Allocate one shared cost across several production cycles. The shares always
-- sum EXACTLY to the cost amount: every target is floored to the currency
-- minor unit and the last weighted target absorbs the rounding remainder
-- (largest-remainder style). The deferrable constraint trigger on
-- cost_allocations verifies the same invariant at commit.
-- Idempotent on the caller's idempotency key.
--
-- Mirrors Repository.allocateSharedCost() and allocateCost() in the domain.
-- =============================================================================
create or replace function public.allocate_cost(
  p_business_id uuid,
  p_payload jsonb,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_actor uuid;
  v_prior jsonb;
  v_currency text;
  v_amount numeric(20, 6);
  v_basis text := upper(coalesce(p_payload ->> 'basis', ''));
  v_incurred_on date := (p_payload ->> 'incurredOn')::date;
  v_note text := nullif(p_payload ->> 'note', '');
  v_event_id text := coalesce(nullif(p_payload ->> 'eventId', ''), gen_random_uuid()::text);
  v_cost_source_id uuid := gen_random_uuid();
  v_target jsonb;
  v_prepared jsonb := '[]'::jsonb;
  v_idx integer := 0;
  v_last_idx integer := 0;
  v_cycle_id uuid;
  v_weight numeric(20, 6);
  v_total_basis numeric(20, 6) := 0;
  v_weight_sum numeric(20, 12) := 0;
  v_ratio numeric(20, 12);
  v_share numeric(20, 6);
  v_allocated numeric(20, 6) := 0;
  v_shares jsonb := '[]'::jsonb;
  v_allocated_total numeric(20, 6);
  v_result jsonb;
begin
  perform app.require_permission(p_business_id, 'farming.setup');
  v_actor := app.effective_actor(p_business_id);

  v_prior := app.idempotent_result(p_idempotency_key);
  if v_prior is not null then
    return v_prior;
  end if;

  if v_basis not in ('ACTUAL_USAGE', 'AREA', 'TIME', 'OUTPUT_QTY', 'ANIMAL_COUNT', 'BIOMASS', 'MANUAL_PERCENT') then
    raise exception 'VALIDATION: unknown allocation basis %', v_basis
      using errcode = 'invalid_parameter_value';
  end if;

  v_currency := upper(coalesce(nullif(p_payload ->> 'currency', ''),
                               (select b.currency from public.businesses b where b.id = p_business_id)));
  v_amount := coalesce(nullif(p_payload ->> 'amount', '')::numeric(20, 6), 0);
  if v_amount <= 0 then
    raise exception 'VALIDATION: the shared cost amount must be greater than zero'
      using errcode = 'invalid_parameter_value';
  end if;

  if coalesce(jsonb_array_length(p_payload -> 'targets'), 0) = 0 then
    raise exception 'VALIDATION: targets must be a non-empty array'
      using errcode = 'invalid_parameter_value';
  end if;

  -- Pass 1: validate every target, total the weights, and remember the last
  -- target that carries a positive weight (it will absorb the remainder).
  for v_target in select value from jsonb_array_elements(p_payload -> 'targets') loop
    v_idx := v_idx + 1;
    v_cycle_id := nullif(v_target ->> 'cycleId', '')::uuid;
    if v_cycle_id is null or not exists (
      select 1 from public.production_cycles c where c.id = v_cycle_id and c.business_id = p_business_id
    ) then
      raise exception 'VALIDATION: production cycle % is not in this business', v_cycle_id
        using errcode = 'invalid_parameter_value';
    end if;

    if v_basis = 'MANUAL_PERCENT' then
      v_weight := coalesce(nullif(v_target ->> 'manualPercent', '')::numeric(20, 6), 0);
      if v_weight < 0 then
        raise exception 'VALIDATION: manualPercent cannot be negative'
          using errcode = 'invalid_parameter_value';
      end if;
      v_weight_sum := v_weight_sum + round(v_weight / 100, 12);
    else
      v_weight := coalesce(nullif(v_target ->> 'basisValue', '')::numeric(20, 6), 0);
      if v_weight < 0 then
        raise exception 'VALIDATION: basisValue cannot be negative'
          using errcode = 'invalid_parameter_value';
      end if;
      v_total_basis := v_total_basis + v_weight;
    end if;

    if v_weight > 0 then
      v_last_idx := v_idx;
    end if;
  end loop;

  if v_basis = 'MANUAL_PERCENT' then
    if abs(v_weight_sum - 1) > 0.000001 then
      raise exception 'VALIDATION: manual percentages must total 100, got %', v_weight_sum * 100
        using errcode = 'invalid_parameter_value';
    end if;
  elsif v_total_basis <= 0 then
    raise exception 'VALIDATION: the allocation basis has no positive weight'
      using errcode = 'invalid_parameter_value';
  end if;

  -- Pass 2: exact shares.
  v_idx := 0;
  for v_target in select value from jsonb_array_elements(p_payload -> 'targets') loop
    v_idx := v_idx + 1;
    v_cycle_id := (v_target ->> 'cycleId')::uuid;

    if v_basis = 'MANUAL_PERCENT' then
      v_weight := coalesce(nullif(v_target ->> 'manualPercent', '')::numeric(20, 6), 0);
      v_ratio := round(v_weight / 100, 12);
    else
      v_weight := coalesce(nullif(v_target ->> 'basisValue', '')::numeric(20, 6), 0);
      v_ratio := round(v_weight / v_total_basis, 12);
    end if;

    if v_idx = v_last_idx then
      -- Absorb the rounding remainder so the shares always sum exactly.
      v_share := v_amount - v_allocated;
    else
      v_share := floor(v_amount * v_ratio * 100) / 100;
    end if;
    v_allocated := v_allocated + v_share;

    v_prepared := v_prepared || jsonb_build_object(
      'cycleId', v_cycle_id,
      'basisValue', v_weight,
      'ratio', v_ratio,
      'amount', v_share
    );
  end loop;

  insert into public.cost_sources
    (id, business_id, cycle_id, kind, currency, amount, shared, incurred_on, source_type, source_id, note, revision)
  values
    (v_cost_source_id, p_business_id, null, 'OVERHEAD', v_currency, v_amount, true, v_incurred_on,
     'ALLOCATION', v_cost_source_id::text, v_note, 1);

  for v_target in select value from jsonb_array_elements(v_prepared) loop
    insert into public.cost_allocations
      (business_id, cost_source_id, cycle_id, basis, basis_value, share_ratio, currency, amount, created_by)
    values
      (p_business_id, v_cost_source_id, (v_target ->> 'cycleId')::uuid, v_basis,
       (v_target ->> 'basisValue')::numeric(20, 6),
       (v_target ->> 'ratio')::numeric(20, 12),
       v_currency, (v_target ->> 'amount')::numeric(20, 6), v_actor);

    v_shares := v_shares || jsonb_build_object(
      'cycleId', v_target ->> 'cycleId',
      'amount', app.money_text((v_target ->> 'amount')::numeric(20, 6)),
      'ratio', (v_target ->> 'ratio')::text
    );
  end loop;

  update public.cost_sources set allocated_at = now() where id = v_cost_source_id;

  select coalesce(sum(amount), 0) into v_allocated_total
    from public.cost_allocations where cost_source_id = v_cost_source_id;

  v_result := jsonb_build_object(
    'costSourceId', v_cost_source_id,
    'basis', v_basis,
    'currency', v_currency,
    'totalCost', app.money_text(v_amount),
    'shares', v_shares,
    'allocatedTotal', app.money_text(v_allocated_total),
    'unallocated', app.money_text(v_amount - v_allocated_total)
  );

  perform app.record_event(
    p_idempotency_key, p_business_id, v_event_id, 'cost.allocate', 'cost_source',
    v_cost_source_id::text, p_payload, v_result);

  return v_result;
end;
$fn$;

comment on function public.allocate_cost(uuid, jsonb, text) is
  'Atomic, permission-checked, idempotent shared-cost allocation. Shares sum exactly to the cost amount; verified by the deferrable cost_allocations trigger.';
