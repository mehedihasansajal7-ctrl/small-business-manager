-- =============================================================================
-- functions/0100_post_sale.sql
--
-- Post a sale: prices the lines, refuses negative stock (unless an approver
-- explicitly overrides with a reason), writes the sale + lines + stock OUT
-- movements + the double-entry posting, and records the event idempotently.
--
-- Mirrors Repository.createSale() in apps/api/src/repository.ts and
-- buildSalePosting() in packages/domain/src/accounting.ts.
-- =============================================================================
create or replace function public.post_sale(
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
  v_customer_id uuid;
  v_location_id uuid;
  v_reference text;
  v_allow_negative boolean := coalesce(nullif(p_payload ->> 'allowNegative', '')::boolean, false);
  v_negative_reason text := nullif(p_payload ->> 'negativeReason', '');
  v_cash_account text := coalesce(nullif(p_payload ->> 'accountCode', ''), '1000');
  v_device_id uuid := nullif(p_payload ->> 'deviceId', '')::uuid;
  v_event_id text := coalesce(nullif(p_payload ->> 'eventId', ''), gen_random_uuid()::text);
  v_sale_id uuid := gen_random_uuid();
  v_line jsonb;
  v_prepared jsonb := '[]'::jsonb;
  v_idx integer := 0;
  v_qty numeric(20, 6);
  v_unit_price numeric(20, 6);
  v_line_discount numeric(20, 6);
  v_line_tax numeric(20, 6);
  v_unit_cost numeric(20, 6);
  v_line_total numeric(20, 6);
  v_product_id uuid;
  v_product_kind text;
  v_unit text;
  v_stocked boolean;
  v_gross numeric(20, 6) := 0;
  v_discount numeric(20, 6) := 0;
  v_tax numeric(20, 6) := 0;
  v_cogs numeric(20, 6) := 0;
  v_net numeric(20, 6);
  v_cash_received numeric(20, 6);
  v_receivable numeric(20, 6);
  v_on_hand numeric(20, 6);
  v_journal_lines jsonb;
  v_result jsonb;
begin
  perform app.require_permission(p_business_id, 'sale.create');
  v_actor := app.effective_actor(p_business_id);

  v_prior := app.idempotent_result(p_idempotency_key);
  if v_prior is not null then
    return v_prior;
  end if;

  if coalesce(jsonb_array_length(p_payload -> 'lines'), 0) = 0 then
    raise exception 'VALIDATION: at least one sale line is required'
      using errcode = 'invalid_parameter_value';
  end if;

  v_currency := upper(coalesce(nullif(p_payload ->> 'currency', ''),
                               (select b.currency from public.businesses b where b.id = p_business_id)));
  v_document_date := (p_payload ->> 'documentDate')::date;
  v_customer_id := nullif(p_payload ->> 'customerId', '')::uuid;
  if v_customer_id is not null and not exists (
    select 1 from public.customers c where c.id = v_customer_id and c.business_id = p_business_id
  ) then
    raise exception 'VALIDATION: customer % is not in this business', v_customer_id
      using errcode = 'invalid_parameter_value';
  end if;
  v_location_id := coalesce(nullif(p_payload ->> 'locationId', '')::uuid, app.default_location(p_business_id));
  v_reference := coalesce(nullif(p_payload ->> 'reference', ''),
                          app.reference(p_business_id, 'sale', 'SAL', v_document_date));

  -- Pass 1: price the lines. The unit cost is taken BEFORE any OUT movement,
  -- exactly like itemUnitCost() in the API.
  for v_line in select value from jsonb_array_elements(p_payload -> 'lines') loop
    v_idx := v_idx + 1;
    v_qty := coalesce(nullif(v_line ->> 'quantity', '')::numeric(20, 6), 0);
    if v_qty <= 0 then
      raise exception 'VALIDATION: sale quantity must be greater than zero'
        using errcode = 'invalid_parameter_value';
    end if;
    v_unit := coalesce(nullif(v_line ->> 'unit', ''), 'pcs');
    v_unit_price := coalesce(nullif(v_line ->> 'unitPrice', '')::numeric(20, 6), 0);
    v_line_discount := coalesce(nullif(v_line ->> 'discount', '')::numeric(20, 6), 0);
    v_line_tax := coalesce(nullif(v_line ->> 'tax', '')::numeric(20, 6), 0);
    v_product_id := nullif(v_line ->> 'productId', '')::uuid;

    if v_product_id is not null then
      select p.kind into v_product_kind
        from public.products p
       where p.id = v_product_id and p.business_id = p_business_id;
      if not found then
        raise exception 'VALIDATION: product % is not in this business', v_product_id
          using errcode = 'invalid_parameter_value';
      end if;
      v_stocked := (v_product_kind <> 'SERVICE');
      v_unit_cost := case when v_stocked then app.item_unit_cost(p_business_id, v_product_id) else 0 end;
    else
      v_stocked := false;
      v_unit_cost := 0;
    end if;

    v_line_total := round(v_qty * v_unit_price - v_line_discount, 6);
    v_gross := v_gross + round(v_qty * v_unit_price, 6);
    v_discount := v_discount + v_line_discount;
    v_tax := v_tax + v_line_tax;
    v_cogs := v_cogs + round(v_qty * v_unit_cost, 6);

    v_prepared := v_prepared || jsonb_build_object(
      'productId', v_product_id,
      'description', nullif(v_line ->> 'description', ''),
      'quantity', v_qty,
      'unit', v_unit,
      'unitPrice', v_unit_price,
      'discount', v_line_discount,
      'tax', v_line_tax,
      'lineTotal', v_line_total,
      'unitCost', v_unit_cost,
      'stocked', v_stocked
    );
  end loop;

  v_discount := v_discount + coalesce(nullif(p_payload ->> 'discount', '')::numeric(20, 6), 0);
  if v_discount > 0 then
    perform app.require_permission(p_business_id, 'sale.discount.apply');
  end if;
  v_net := v_gross + v_tax - v_discount;
  v_cash_received := coalesce(nullif(p_payload ->> 'cashReceived', '')::numeric(20, 6), v_net);
  v_receivable := v_net - v_cash_received;

  insert into public.sales
    (id, business_id, reference, customer_id, document_date, currency, gross, discount, tax, net,
     cash_received, receivable, cogs, status, note, created_by, device_id, event_id)
  values
    (v_sale_id, p_business_id, v_reference, v_customer_id, v_document_date, v_currency, v_gross, v_discount,
     v_tax, v_net, v_cash_received, v_receivable, v_cogs, 'POSTED', nullif(p_payload ->> 'note', ''),
     v_actor, v_device_id, v_event_id);

  -- Pass 2: lines, the negative-stock guard, stock OUT movements.
  v_idx := 0;
  for v_line in select value from jsonb_array_elements(v_prepared) loop
    v_idx := v_idx + 1;
    v_qty := (v_line ->> 'quantity')::numeric(20, 6);
    v_unit := v_line ->> 'unit';
    v_unit_cost := (v_line ->> 'unitCost')::numeric(20, 6);
    v_product_id := nullif(v_line ->> 'productId', '')::uuid;

    insert into public.sale_lines
      (business_id, sale_id, product_id, description, quantity, unit, unit_price,
       discount, tax, line_total, unit_cost, location_id)
    values
      (p_business_id, v_sale_id, v_product_id, nullif(v_line ->> 'description', ''), v_qty, v_unit,
       (v_line ->> 'unitPrice')::numeric(20, 6),
       (v_line ->> 'discount')::numeric(20, 6),
       (v_line ->> 'tax')::numeric(20, 6),
       (v_line ->> 'lineTotal')::numeric(20, 6),
       v_unit_cost,
       v_location_id);

    if coalesce((v_line ->> 'stocked')::boolean, false) then
      v_on_hand := app.on_hand_qty(p_business_id, v_product_id, v_location_id);
      if v_on_hand - v_qty < 0 then
        if not v_allow_negative then
          raise exception 'STOCK_CONFLICT: cannot sell % but only % is on hand for item %',
            v_qty, v_on_hand, v_product_id using errcode = 'check_violation';
        end if;
        if v_negative_reason is null then
          raise exception 'VALIDATION: negativeReason is required when overriding negative stock'
            using errcode = 'invalid_parameter_value';
        end if;
        -- An override needs the approval permission, on top of sale.create.
        perform app.require_permission(p_business_id, 'inventory.adjust.approve');
      end if;

      insert into public.stock_movements
        (business_id, item_id, location_id, direction, quantity, unit, unit_cost, currency,
         source_type, source_id, actor_id, device_id, event_id, idempotency_key, reason, occurred_at)
      values
        (p_business_id, v_product_id, v_location_id, 'OUT', v_qty, v_unit, v_unit_cost, v_currency,
         'SALE', v_reference, v_actor, v_device_id,
         v_event_id || ':' || v_idx::text, p_idempotency_key || ':' || v_idx::text,
         case when v_allow_negative then 'Negative-stock override: ' || v_negative_reason else null end,
         v_document_date::timestamptz);
    end if;
  end loop;

  -- Double-entry posting (Dr cash / Dr receivable / Dr discount / Cr revenue /
  -- Cr tax payable / Dr COGS / Cr inventory).
  v_journal_lines := '[]'::jsonb;
  if v_cash_received > 0 then
    v_journal_lines := v_journal_lines || jsonb_build_object('account', v_cash_account, 'debit', v_cash_received, 'memo', 'Cash received');
  end if;
  if v_receivable > 0 then
    v_journal_lines := v_journal_lines || jsonb_build_object('account', '1100', 'debit', v_receivable, 'memo', 'On credit');
  end if;
  if v_receivable < 0 then
    v_journal_lines := v_journal_lines || jsonb_build_object('account', '1100', 'credit', abs(v_receivable), 'memo', 'Overpayment / advance');
  end if;
  if v_discount > 0 then
    v_journal_lines := v_journal_lines || jsonb_build_object('account', '4900', 'debit', v_discount, 'memo', 'Discount allowed');
  end if;
  v_journal_lines := v_journal_lines || jsonb_build_object('account', '4000', 'credit', v_gross, 'memo', 'Sales revenue');
  if v_tax > 0 then
    v_journal_lines := v_journal_lines || jsonb_build_object('account', '2200', 'credit', v_tax, 'memo', 'Tax payable');
  end if;
  if v_cogs > 0 then
    v_journal_lines := v_journal_lines || jsonb_build_object('account', '5000', 'debit', v_cogs, 'memo', 'Cost of goods sold');
    v_journal_lines := v_journal_lines || jsonb_build_object('account', '1200', 'credit', v_cogs, 'memo', 'Inventory released');
  end if;

  perform app.insert_journal_entry(
    p_business_id, v_document_date, v_reference, 'Sale ' || v_reference, 'SALE', v_reference,
    v_currency, v_event_id || ':journal', v_actor, v_journal_lines);

  v_result := jsonb_build_object(
    'id', v_sale_id,
    'reference', v_reference,
    'gross', app.money_text(v_gross),
    'discount', app.money_text(v_discount),
    'net', app.money_text(v_net),
    'cashReceived', app.money_text(v_cash_received),
    'receivable', app.money_text(v_receivable),
    'cogs', app.money_text(v_cogs),
    'currency', v_currency
  );

  perform app.record_event(
    p_idempotency_key, p_business_id, v_event_id, 'sale.post', 'sale', v_sale_id::text,
    p_payload, v_result);

  return v_result;
end;
$fn$;

comment on function public.post_sale(uuid, jsonb, text) is
  'Atomic, permission-checked, idempotent sale posting: header, lines, stock OUT movements (negative stock refused), double-entry journal and processed_events.';
