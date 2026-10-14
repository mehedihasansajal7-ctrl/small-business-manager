-- =============================================================================
-- functions/0170_close_cycle.sql
--
-- Close a production cycle. Optionally posts a final harvest for the remaining
-- output so the whole remaining batch cost moves from work-in-progress (1300)
-- to finished stock (1210); then marks the cycle CLOSED. Idempotent.
--
-- Mirrors Repository.closeCycle().
-- =============================================================================
create or replace function public.close_cycle(
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
  v_closed_on date := coalesce(nullif(p_payload ->> 'closedOn', '')::date, current_date);
  v_harvest_remainder boolean := coalesce(nullif(p_payload ->> 'harvestRemainingCost', '')::boolean, true);
  v_remaining_quantity numeric(20, 6) := nullif(p_payload ->> 'remainingQuantity', '')::numeric(20, 6);
  v_unit text;
  v_event_id text := coalesce(nullif(p_payload ->> 'eventId', ''), gen_random_uuid()::text);
  v_harvest_result jsonb := null;
  v_released numeric(20, 6) := 0;
  v_result jsonb;
begin
  perform app.require_permission(p_business_id, 'farming.close_cycle');
  v_actor := app.effective_actor(p_business_id);

  v_prior := app.idempotent_result(p_idempotency_key);
  if v_prior is not null then
    return v_prior;
  end if;

  select c.reference into v_cycle_reference
    from public.production_cycles c
   where c.id = v_cycle_id and c.business_id = p_business_id;
  if not found then
    raise exception 'VALIDATION: production cycle % is not in this business', v_cycle_id
      using errcode = 'invalid_parameter_value';
  end if;

  if v_harvest_remainder and v_remaining_quantity is not null and v_remaining_quantity > 0 then
    select coalesce(nullif(p_payload ->> 'remainingUnit', ''), c.planned_output_unit, 'unit')
      into v_unit
      from public.production_cycles c
     where c.id = v_cycle_id;

    v_harvest_result := public.post_harvest(
      p_business_id,
      jsonb_build_object(
        'cycleId', v_cycle_id,
        'occurredOn', v_closed_on,
        'quantity', v_remaining_quantity,
        'unit', v_unit,
        'method', 'CLOSING_REMAINDER',
        'notes', 'Final harvest on cycle close'
      ),
      p_idempotency_key || ':remainder');

    v_released := coalesce((v_harvest_result ->> 'costBasis')::numeric(20, 6), 0);
  end if;

  update public.production_cycles
     set status = 'CLOSED',
         actual_end_date = v_closed_on,
         revision = revision + 1,
         updated_at = now()
   where id = v_cycle_id and business_id = p_business_id;

  v_result := jsonb_build_object(
    'cycleId', v_cycle_id,
    'reference', v_cycle_reference,
    'status', 'CLOSED',
    'closedOn', v_closed_on,
    'releasedToFinishedStock', app.money_text(v_released)
  );

  perform app.record_event(
    p_idempotency_key, p_business_id, v_event_id, 'cycle.close', 'production_cycle',
    v_cycle_id::text, p_payload, v_result);

  return v_result;
end;
$fn$;

comment on function public.close_cycle(uuid, jsonb, text) is
  'Atomic, permission-checked, idempotent cycle close: optional final harvest of the remaining cost, then status CLOSED.';
