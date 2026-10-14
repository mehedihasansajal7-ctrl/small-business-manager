-- =============================================================================
-- functions/0130_post_harvest.sql
--
-- Post a harvest: assigns a share of the cycle's cost to the harvested output,
-- releases it from work-in-progress (1300) to finished stock (1210), adds the
-- output to inventory and (optionally) records an output lot. Idempotent.
--
-- Costing mirrors assignHarvestCost() in packages/domain/src/farming.ts:
--   * PLANNED_YIELD_PRORATA : costToDate * quantity / plannedOutput, capped at
--                             the cost not already assigned to earlier harvests
--   * CLOSING_REMAINDER     : everything not yet assigned
-- =============================================================================
create or replace function public.post_harvest(
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
  v_cycle_id uuid := nullif(p_payload ->> 'cycleId', '')::uuid;
  v_cycle_reference text;
  v_cycle_status text;
  v_planned_output numeric(20, 6);
  v_quantity numeric(20, 6);
  v_unit text;
  v_occurred_on date;
  v_currency text;
  v_method text := upper(coalesce(nullif(p_payload ->> 'method', ''), 'PLANNED_YIELD_PRORATA'));
  v_product_id uuid := nullif(p_payload ->> 'productId', '')::uuid;
  v_location_id uuid := nullif(p_payload ->> 'locationId', '')::uuid;
  v_lot_no text := nullif(p_payload ->> 'lotNo', '');
  v_device_id uuid := nullif(p_payload ->> 'deviceId', '')::uuid;
  v_event_id text := coalesce(nullif(p_payload ->> 'eventId', ''), gen_random_uuid()::text);
  v_harvest_id uuid := gen_random_uuid();
  v_cost_to_date numeric(20, 6);
  v_assigned numeric(20, 6);
  v_remaining numeric(20, 6);
  v_cost_basis numeric(20, 6);
  v_unit_cost numeric(20, 6);
  v_capped boolean := false;
  v_result jsonb;
begin
  perform app.require_permission(p_business_id, 'farming.harvest');
  v_actor := app.effective_actor(p_business_id);

  v_prior := app.idempotent_result(p_idempotency_key);
  if v_prior is not null then
    return v_prior;
  end if;

  select c.reference, c.status, c.planned_output
    into v_cycle_reference, v_cycle_status, v_planned_output
    from public.production_cycles c
   where c.id = v_cycle_id and c.business_id = p_business_id;
  if not found then
    raise exception 'VALIDATION: production cycle % is not in this business', v_cycle_id
      using errcode = 'invalid_parameter_value';
  end if;
  if v_cycle_status = 'CLOSED' then
    raise exception 'CYCLE_CLOSED: this cycle is closed'
      using errcode = 'check_violation';
  end if;

  v_quantity := coalesce(nullif(p_payload ->> 'quantity', '')::numeric(20, 6), 0);
  if v_quantity <= 0 then
    raise exception 'VALIDATION: harvest quantity must be greater than zero'
      using errcode = 'invalid_parameter_value';
  end if;

  v_unit := coalesce(nullif(p_payload ->> 'unit', ''), 'pcs');
  v_occurred_on := (p_payload ->> 'occurredOn')::date;
  v_currency := upper(coalesce(nullif(p_payload ->> 'currency', ''),
                               (select b.currency from public.businesses b where b.id = p_business_id)));
  if v_method not in ('PLANNED_YIELD_PRORATA', 'CLOSING_REMAINDER') then
    raise exception 'VALIDATION: method must be PLANNED_YIELD_PRORATA or CLOSING_REMAINDER'
      using errcode = 'invalid_parameter_value';
  end if;

  v_cost_to_date := app.cycle_cost_to_date(p_business_id, v_cycle_id);
  v_assigned := app.cycle_assigned_cost(p_business_id, v_cycle_id);
  v_remaining := v_cost_to_date - v_assigned;

  if v_method = 'PLANNED_YIELD_PRORATA' and v_planned_output is not null and v_planned_output > 0 then
    v_cost_basis := least(round(v_cost_to_date * v_quantity / v_planned_output, 6), v_remaining);
    v_capped := (round(v_cost_to_date * v_quantity / v_planned_output, 6) > v_remaining);
  else
    v_cost_basis := v_remaining;
  end if;
  if v_cost_basis < 0 then
    v_cost_basis := 0;
  end if;
  v_unit_cost := round(v_cost_basis / v_quantity, 6);

  insert into public.harvests
    (id, business_id, cycle_id, occurred_on, quantity, unit, product_id, location_id, lot_no,
     costing_method, cost_basis, unit_cost, currency, grade, notes, created_by, device_id, event_id)
  values
    (v_harvest_id, p_business_id, v_cycle_id, v_occurred_on, v_quantity, v_unit, v_product_id,
     v_location_id, v_lot_no, v_method, v_cost_basis, v_unit_cost, v_currency,
     nullif(p_payload ->> 'grade', ''), nullif(p_payload ->> 'notes', ''), v_actor, v_device_id, v_event_id);

  -- Release the assigned cost from work-in-progress to finished goods.
  if v_cost_basis > 0 then
    perform app.insert_journal_entry(
      p_business_id, v_occurred_on,
      v_cycle_reference || '-HARVEST-' || substr(v_harvest_id::text, 1, 6),
      'Harvest to finished stock', 'HARVEST', v_cycle_reference, v_currency, v_event_id || ':journal',
      v_actor,
      jsonb_build_array(
        jsonb_build_object('account', '1210', 'debit', v_cost_basis, 'memo', 'Finished output value'),
        jsonb_build_object('account', '1300', 'credit', v_cost_basis, 'memo', 'Batch cost released')
      ));
  end if;

  -- Finished output becomes sellable stock at the assigned cost per unit.
  if v_product_id is not null then
    insert into public.stock_movements
      (business_id, item_id, location_id, direction, quantity, unit, unit_cost, currency, lot_id,
       source_type, source_id, actor_id, device_id, event_id, idempotency_key, occurred_at)
    values
      (p_business_id, v_product_id, coalesce(v_location_id, app.default_location(p_business_id)), 'IN',
       v_quantity, v_unit, v_unit_cost, v_currency, null, 'HARVEST', v_cycle_reference, v_actor,
       v_device_id, v_event_id || ':stock', p_idempotency_key || ':stock', v_occurred_on::timestamptz);

    insert into public.output_lots
      (business_id, cycle_id, harvest_id, product_id, stock_lot_id, lot_no, quantity, unit, unit_cost,
       currency, produced_on)
    values
      (p_business_id, v_cycle_id, v_harvest_id, v_product_id, null,
       coalesce(v_lot_no, 'HARVEST-' || substr(v_harvest_id::text, 1, 8)), v_quantity, v_unit,
       v_unit_cost, v_currency, v_occurred_on);
  end if;

  v_result := jsonb_build_object(
    'harvestId', v_harvest_id,
    'quantity', v_quantity::text,
    'unitCost', app.money_text(v_unit_cost),
    'costBasis', app.money_text(v_cost_basis),
    'capped', v_capped,
    'costToDate', app.money_text(v_cost_to_date),
    'remainingCostInBatch', app.money_text(v_cost_to_date - v_assigned - v_cost_basis),
    'currency', v_currency
  );

  perform app.record_event(
    p_idempotency_key, p_business_id, v_event_id, 'harvest.post', 'harvest', v_harvest_id::text,
    p_payload, v_result);

  return v_result;
end;
$fn$;

comment on function public.post_harvest(uuid, jsonb, text) is
  'Atomic, permission-checked, idempotent harvest: assigns batch cost pro-rata (capped), releases WIP to finished stock, adds output inventory and records an output lot.';
