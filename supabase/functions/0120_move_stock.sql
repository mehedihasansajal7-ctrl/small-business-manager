-- =============================================================================
-- functions/0120_move_stock.sql
--
-- Post a single stock movement (adjustment, count correction, transfer, input
-- issue, spoilage, reversal, ...). Refuses a movement that would take stock
-- negative unless an approver explicitly allows it with a reason.
-- Idempotent on the caller's idempotency key.
-- =============================================================================
create or replace function public.move_stock(
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
  v_item_id uuid;
  v_location_id uuid;
  v_direction text := upper(coalesce(p_payload ->> 'direction', ''));
  v_quantity numeric(20, 6);
  v_unit text;
  v_unit_cost numeric(20, 6);
  v_currency text;
  v_source_type text;
  v_source_id text;
  v_lot_id uuid := nullif(p_payload ->> 'lotId', '')::uuid;
  v_expiry date := nullif(p_payload ->> 'expiryDate', '')::date;
  v_reason text := nullif(p_payload ->> 'reason', '');
  v_allow_negative boolean := coalesce(nullif(p_payload ->> 'allowNegative', '')::boolean, false);
  v_device_id uuid := nullif(p_payload ->> 'deviceId', '')::uuid;
  v_event_id text := coalesce(nullif(p_payload ->> 'eventId', ''), gen_random_uuid()::text);
  v_occurred_at timestamptz := coalesce(nullif(p_payload ->> 'occurredAt', '')::timestamptz, now());
  v_movement_id uuid := gen_random_uuid();
  v_on_hand numeric(20, 6);
  v_result jsonb;
begin
  perform app.require_permission(p_business_id, 'inventory.manage');
  v_actor := app.effective_actor(p_business_id);

  v_prior := app.idempotent_result(p_idempotency_key);
  if v_prior is not null then
    return v_prior;
  end if;

  if v_direction not in ('IN', 'OUT') then
    raise exception 'VALIDATION: direction must be IN or OUT'
      using errcode = 'invalid_parameter_value';
  end if;

  v_item_id := nullif(p_payload ->> 'itemId', '')::uuid;
  if v_item_id is null or not exists (
    select 1 from public.products p where p.id = v_item_id and p.business_id = p_business_id
  ) then
    raise exception 'VALIDATION: item % is not in this business', v_item_id
      using errcode = 'invalid_parameter_value';
  end if;

  v_quantity := coalesce(nullif(p_payload ->> 'quantity', '')::numeric(20, 6), 0);
  if v_quantity <= 0 then
    raise exception 'VALIDATION: quantity must be greater than zero'
      using errcode = 'invalid_parameter_value';
  end if;

  v_location_id := coalesce(nullif(p_payload ->> 'locationId', '')::uuid, app.default_location(p_business_id));
  if v_location_id is null then
    raise exception 'NO_LOCATION: create a stock location first'
      using errcode = 'invalid_parameter_value';
  end if;

  select p.unit into v_unit from public.products p where p.id = v_item_id;
  v_unit := coalesce(nullif(p_payload ->> 'unit', ''), v_unit, 'pcs');
  v_currency := upper(coalesce(nullif(p_payload ->> 'currency', ''),
                               (select b.currency from public.businesses b where b.id = p_business_id)));
  -- For IN without an explicit cost, fall back to the item's current weighted
  -- average (the same default the API uses for derived movements).
  v_unit_cost := coalesce(nullif(p_payload ->> 'unitCost', '')::numeric(20, 6),
                          app.item_unit_cost(p_business_id, v_item_id));
  v_source_type := upper(coalesce(nullif(p_payload ->> 'sourceType', ''), 'ADJUSTMENT'));
  v_source_id := coalesce(nullif(p_payload ->> 'sourceId', ''), v_movement_id::text);

  if v_direction = 'OUT' then
    v_on_hand := app.on_hand_qty(p_business_id, v_item_id, v_location_id);
    if v_on_hand - v_quantity < 0 then
      if not v_allow_negative then
        raise exception 'STOCK_CONFLICT: cannot remove % but only % is on hand for item %',
          v_quantity, v_on_hand, v_item_id using errcode = 'check_violation';
      end if;
      if v_reason is null then
        raise exception 'VALIDATION: a reason is required to override negative stock'
          using errcode = 'invalid_parameter_value';
      end if;
      perform app.require_permission(p_business_id, 'inventory.adjust.approve');
    end if;
  end if;

  insert into public.stock_movements
    (id, business_id, item_id, location_id, direction, quantity, unit, unit_cost, currency, lot_id,
     expiry_date, source_type, source_id, actor_id, device_id, event_id, idempotency_key, reversal_of,
     reason, occurred_at)
  values
    (v_movement_id, p_business_id, v_item_id, v_location_id, v_direction, v_quantity, v_unit, v_unit_cost,
     v_currency, v_lot_id, v_expiry, v_source_type, v_source_id, v_actor, v_device_id, v_event_id,
     p_idempotency_key, nullif(p_payload ->> 'reversalOf', '')::uuid, v_reason, v_occurred_at);

  v_result := jsonb_build_object(
    'movementId', v_movement_id,
    'itemId', v_item_id,
    'direction', v_direction,
    'quantity', v_quantity::text,
    'unit', v_unit,
    'onHand', app.on_hand_qty(p_business_id, v_item_id, v_location_id)::text
  );

  perform app.record_event(
    p_idempotency_key, p_business_id, v_event_id, 'stock.move', 'stock_movement', v_movement_id::text,
    p_payload, v_result);

  return v_result;
end;
$fn$;

comment on function public.move_stock(uuid, jsonb, text) is
  'Atomic, permission-checked, idempotent stock movement; refuses negative stock unless an approver overrides it with a reason.';
