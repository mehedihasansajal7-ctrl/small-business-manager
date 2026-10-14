-- =============================================================================
-- functions/0110_receive_purchase.sql
--
-- Receive a purchase: writes the purchase + lines, optional lots, stock IN
-- movements and the double-entry posting (inventory is an asset, not an
-- immediate expense). Idempotent on the caller's idempotency key.
--
-- Mirrors Repository.createPurchase() and buildPurchasePosting().
-- =============================================================================
create or replace function public.receive_purchase(
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
  v_document_date date;
  v_supplier_id uuid;
  v_location_id uuid;
  v_reference text;
  v_cash_account text := coalesce(nullif(p_payload ->> 'accountCode', ''), '1000');
  v_device_id uuid := nullif(p_payload ->> 'deviceId', '')::uuid;
  v_event_id text := coalesce(nullif(p_payload ->> 'eventId', ''), gen_random_uuid()::text);
  v_purchase_id uuid := gen_random_uuid();
  v_line jsonb;
  v_prepared jsonb := '[]'::jsonb;
  v_idx integer := 0;
  v_qty numeric(20, 6);
  v_unit_cost numeric(20, 6);
  v_line_tax numeric(20, 6);
  v_line_total numeric(20, 6);
  v_product_id uuid;
  v_product_name text;
  v_track_lots boolean;
  v_unit text;
  v_lot_no text;
  v_expiry date;
  v_inventory numeric(20, 6) := 0;
  v_tax numeric(20, 6) := 0;
  v_paid numeric(20, 6);
  v_total numeric(20, 6);
  v_payable numeric(20, 6);
  v_lot_id uuid;
  v_journal_lines jsonb := '[]'::jsonb;
  v_result jsonb;
begin
  perform app.require_permission(p_business_id, 'purchase.manage');
  v_actor := app.effective_actor(p_business_id);

  v_prior := app.idempotent_result(p_idempotency_key);
  if v_prior is not null then
    return v_prior;
  end if;

  if coalesce(jsonb_array_length(p_payload -> 'lines'), 0) = 0 then
    raise exception 'VALIDATION: at least one purchase line is required'
      using errcode = 'invalid_parameter_value';
  end if;

  v_currency := upper(coalesce(nullif(p_payload ->> 'currency', ''),
                               (select b.currency from public.businesses b where b.id = p_business_id)));
  v_document_date := (p_payload ->> 'documentDate')::date;
  v_supplier_id := nullif(p_payload ->> 'supplierId', '')::uuid;
  if v_supplier_id is not null and not exists (
    select 1 from public.suppliers s where s.id = v_supplier_id and s.business_id = p_business_id
  ) then
    raise exception 'VALIDATION: supplier % is not in this business', v_supplier_id
      using errcode = 'invalid_parameter_value';
  end if;
  v_location_id := coalesce(nullif(p_payload ->> 'locationId', '')::uuid, app.default_location(p_business_id));
  v_reference := coalesce(nullif(p_payload ->> 'reference', ''),
                          app.reference(p_business_id, 'purchase', 'PUR', v_document_date));

  for v_line in select value from jsonb_array_elements(p_payload -> 'lines') loop
    v_idx := v_idx + 1;
    v_qty := coalesce(nullif(v_line ->> 'quantity', '')::numeric(20, 6), 0);
    if v_qty <= 0 then
      raise exception 'VALIDATION: purchase quantity must be greater than zero'
        using errcode = 'invalid_parameter_value';
    end if;
    v_product_id := nullif(v_line ->> 'productId', '')::uuid;
    if v_product_id is null then
      raise exception 'VALIDATION: each purchase line needs a productId in this build'
        using errcode = 'invalid_parameter_value';
    end if;
    select p.name, p.track_lots into v_product_name, v_track_lots
      from public.products p
     where p.id = v_product_id and p.business_id = p_business_id;
    if not found then
      raise exception 'VALIDATION: product % is not in this business', v_product_id
        using errcode = 'invalid_parameter_value';
    end if;

    v_unit := coalesce(nullif(v_line ->> 'unit', ''), 'pcs');
    v_unit_cost := coalesce(nullif(v_line ->> 'unitCost', '')::numeric(20, 6), 0);
    v_line_tax := coalesce(nullif(v_line ->> 'tax', '')::numeric(20, 6), 0);
    v_line_total := round(v_qty * v_unit_cost, 6);
    v_inventory := v_inventory + v_line_total;
    v_tax := v_tax + v_line_tax;

    v_prepared := v_prepared || jsonb_build_object(
      'productId', v_product_id,
      'description', coalesce(nullif(v_line ->> 'description', ''), v_product_name),
      'quantity', v_qty,
      'unit', v_unit,
      'unitCost', v_unit_cost,
      'tax', v_line_tax,
      'lineTotal', v_line_total,
      'lotNo', nullif(v_line ->> 'lotNo', ''),
      'expiryDate', nullif(v_line ->> 'expiryDate', ''),
      'trackLots', v_track_lots
    );
  end loop;

  v_paid := coalesce(nullif(p_payload ->> 'paid', '')::numeric(20, 6), 0);
  v_total := v_inventory + v_tax;
  v_payable := v_total - v_paid;

  insert into public.purchases
    (id, business_id, reference, supplier_id, document_date, currency, subtotal, discount, tax, total,
     paid, payable, status, note, created_by, device_id, event_id)
  values
    (v_purchase_id, p_business_id, v_reference, v_supplier_id, v_document_date, v_currency, v_inventory, 0,
     v_tax, v_total, v_paid, v_payable, 'POSTED', nullif(p_payload ->> 'note', ''), v_actor, v_device_id,
     v_event_id);

  v_idx := 0;
  for v_line in select value from jsonb_array_elements(v_prepared) loop
    v_idx := v_idx + 1;
    v_product_id := (v_line ->> 'productId')::uuid;
    v_qty := (v_line ->> 'quantity')::numeric(20, 6);
    v_unit := v_line ->> 'unit';
    v_unit_cost := (v_line ->> 'unitCost')::numeric(20, 6);
    v_lot_no := nullif(v_line ->> 'lotNo', '');
    v_expiry := nullif(v_line ->> 'expiryDate', '')::date;
    v_lot_id := null;

    insert into public.purchase_lines
      (business_id, purchase_id, product_id, description, quantity, unit, unit_cost, discount, tax,
       line_total, location_id, lot_no, expiry_date)
    values
      (p_business_id, v_purchase_id, v_product_id, nullif(v_line ->> 'description', ''), v_qty, v_unit,
       v_unit_cost, 0, (v_line ->> 'tax')::numeric(20, 6), (v_line ->> 'lineTotal')::numeric(20, 6),
       v_location_id, v_lot_no, v_expiry);

    if coalesce((v_line ->> 'trackLots')::boolean, false) and v_lot_no is not null then
      v_lot_id := gen_random_uuid();
      insert into public.stock_lots
        (id, business_id, item_id, location_id, lot_no, unit_cost, currency, received_at, expiry_date)
      values
        (v_lot_id, p_business_id, v_product_id, v_location_id, v_lot_no, v_unit_cost, v_currency,
         v_document_date::timestamptz, v_expiry);
    end if;

    insert into public.stock_movements
      (business_id, item_id, location_id, direction, quantity, unit, unit_cost, currency, lot_id,
       expiry_date, source_type, source_id, actor_id, device_id, event_id, idempotency_key, occurred_at)
    values
      (p_business_id, v_product_id, v_location_id, 'IN', v_qty, v_unit, v_unit_cost, v_currency, v_lot_id,
       v_expiry, 'PURCHASE', v_reference, v_actor, v_device_id,
       v_event_id || ':' || v_idx::text, p_idempotency_key || ':' || v_idx::text,
       v_document_date::timestamptz);
  end loop;

  v_journal_lines := v_journal_lines
    || jsonb_build_object('account', '1200', 'debit', v_inventory, 'memo', 'Inventory received');
  if v_tax > 0 then
    v_journal_lines := v_journal_lines
      || jsonb_build_object('account', '1400', 'debit', v_tax, 'memo', 'Input tax');
  end if;
  if v_paid > 0 then
    v_journal_lines := v_journal_lines
      || jsonb_build_object('account', v_cash_account, 'credit', v_paid, 'memo', 'Paid');
  end if;
  if v_payable > 0 then
    v_journal_lines := v_journal_lines
      || jsonb_build_object('account', '2000', 'credit', v_payable, 'memo', 'Supplier payable');
  end if;
  if v_payable < 0 then
    v_journal_lines := v_journal_lines
      || jsonb_build_object('account', '2000', 'debit', abs(v_payable), 'memo', 'Advance to supplier');
  end if;

  perform app.insert_journal_entry(
    p_business_id, v_document_date, v_reference, 'Purchase ' || v_reference, 'PURCHASE', v_reference,
    v_currency, v_event_id || ':journal', v_actor, v_journal_lines);

  v_result := jsonb_build_object(
    'id', v_purchase_id,
    'reference', v_reference,
    'total', app.money_text(v_total),
    'payable', app.money_text(v_payable),
    'paid', app.money_text(v_paid),
    'currency', v_currency
  );

  perform app.record_event(
    p_idempotency_key, p_business_id, v_event_id, 'purchase.receive', 'purchase', v_purchase_id::text,
    p_payload, v_result);

  return v_result;
end;
$fn$;

comment on function public.receive_purchase(uuid, jsonb, text) is
  'Atomic, permission-checked, idempotent purchase receipt: header, lines, lots, stock IN movements, double-entry posting and processed_events.';
