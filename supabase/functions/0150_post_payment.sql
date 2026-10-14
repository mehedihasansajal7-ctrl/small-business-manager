-- =============================================================================
-- functions/0150_post_payment.sql
--
-- Post a customer receipt, supplier payment or other money movement, with the
-- matching double-entry posting. A receipt is NOT revenue and a payment is NOT
-- an expense — they clear receivable/payable. Idempotent.
--
-- Mirrors Repository.recordCustomerReceipt() / recordSupplierPayment() and
-- buildCustomerReceiptPosting() / buildSupplierPaymentPosting().
-- =============================================================================
create or replace function public.post_payment(
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
  v_kind text := upper(coalesce(p_payload ->> 'kind', 'CUSTOMER_RECEIPT'));
  v_party_type text;
  v_party_id uuid := nullif(p_payload ->> 'partyId', '')::uuid;
  v_document_date date := (p_payload ->> 'documentDate')::date;
  v_currency text;
  v_amount numeric(20, 6);
  v_account_code text := coalesce(nullif(p_payload ->> 'accountCode', ''), '1000');
  v_category_account text := coalesce(nullif(p_payload ->> 'categoryAccount', ''), '4100');
  v_reference text;
  v_event_id text := coalesce(nullif(p_payload ->> 'eventId', ''), gen_random_uuid()::text);
  v_device_id uuid := nullif(p_payload ->> 'deviceId', '')::uuid;
  v_payment_id uuid := gen_random_uuid();
  v_journal_lines jsonb;
  v_result jsonb;
begin
  perform app.require_permission(p_business_id, 'finance.manage');
  v_actor := app.effective_actor(p_business_id);

  v_prior := app.idempotent_result(p_idempotency_key);
  if v_prior is not null then
    return v_prior;
  end if;

  if v_kind not in ('CUSTOMER_RECEIPT', 'SUPPLIER_PAYMENT', 'INCOME_RECEIPT', 'EXPENSE_PAYMENT', 'OTHER') then
    raise exception 'VALIDATION: unsupported payment kind %', v_kind
      using errcode = 'invalid_parameter_value';
  end if;

  if v_kind = 'CUSTOMER_RECEIPT' then
    v_party_type := 'CUSTOMER';
  elsif v_kind = 'SUPPLIER_PAYMENT' then
    v_party_type := 'SUPPLIER';
  else
    v_party_type := upper(coalesce(nullif(p_payload ->> 'partyType', ''), 'OTHER'));
  end if;

  if v_kind = 'CUSTOMER_RECEIPT' then
    if v_party_id is not null and not exists (
      select 1 from public.customers c where c.id = v_party_id and c.business_id = p_business_id
    ) then
      raise exception 'VALIDATION: customer % is not in this business', v_party_id
        using errcode = 'invalid_parameter_value';
    end if;
  elsif v_kind = 'SUPPLIER_PAYMENT' then
    if v_party_id is not null and not exists (
      select 1 from public.suppliers s where s.id = v_party_id and s.business_id = p_business_id
    ) then
      raise exception 'VALIDATION: supplier % is not in this business', v_party_id
        using errcode = 'invalid_parameter_value';
    end if;
  end if;

  v_currency := upper(coalesce(nullif(p_payload ->> 'currency', ''),
                               (select b.currency from public.businesses b where b.id = p_business_id)));
  v_amount := coalesce(nullif(p_payload ->> 'amount', '')::numeric(20, 6), 0);
  if v_amount <= 0 then
    raise exception 'VALIDATION: payment amount must be greater than zero'
      using errcode = 'invalid_parameter_value';
  end if;

  v_reference := coalesce(nullif(p_payload ->> 'reference', ''),
                          app.reference(p_business_id,
                                        case when v_kind = 'CUSTOMER_RECEIPT' then 'receipt' else 'payment' end,
                                        case when v_kind = 'CUSTOMER_RECEIPT' then 'RCP' else 'PAY' end,
                                        v_document_date));

  insert into public.payments
    (id, business_id, kind, party_type, party_id, document_date, currency, amount, account_code,
     reference, note, created_by, device_id, event_id)
  values
    (v_payment_id, p_business_id, v_kind, v_party_type, v_party_id, v_document_date, v_currency,
     v_amount, v_account_code, v_reference, nullif(p_payload ->> 'note', ''), v_actor, v_device_id,
     v_event_id);

  if v_kind = 'CUSTOMER_RECEIPT' then
    -- Dr cash / Cr accounts receivable
    v_journal_lines := jsonb_build_array(
      jsonb_build_object('account', v_account_code, 'debit', v_amount, 'memo', 'Cash received'),
      jsonb_build_object('account', '1100', 'credit', v_amount, 'memo', 'Receivable cleared')
    );
  elsif v_kind = 'SUPPLIER_PAYMENT' then
    -- Dr accounts payable / Cr cash
    v_journal_lines := jsonb_build_array(
      jsonb_build_object('account', '2000', 'debit', v_amount, 'memo', 'Payable settled'),
      jsonb_build_object('account', v_account_code, 'credit', v_amount, 'memo', 'Cash paid')
    );
  elsif v_kind = 'INCOME_RECEIPT' then
    -- Dr cash / Cr income
    v_journal_lines := jsonb_build_array(
      jsonb_build_object('account', v_account_code, 'debit', v_amount, 'memo', 'Cash received'),
      jsonb_build_object('account', v_category_account, 'credit', v_amount, 'memo', 'Income')
    );
  else
    -- Dr expense / Cr cash
    v_journal_lines := jsonb_build_array(
      jsonb_build_object('account', v_category_account, 'debit', v_amount, 'memo', 'Expense'),
      jsonb_build_object('account', v_account_code, 'credit', v_amount, 'memo', 'Cash paid')
    );
  end if;

  perform app.insert_journal_entry(
    p_business_id, v_document_date, v_reference,
    case when v_kind = 'CUSTOMER_RECEIPT' then 'Customer receipt' else 'Payment' end,
    case when v_kind = 'CUSTOMER_RECEIPT' then 'RECEIPT' else 'PAYMENT' end,
    v_reference, v_currency, v_event_id || ':journal', v_actor, v_journal_lines);

  v_result := jsonb_build_object(
    'id', v_payment_id,
    'kind', v_kind,
    'reference', v_reference,
    'amount', app.money_text(v_amount),
    'currency', v_currency
  );

  perform app.record_event(
    p_idempotency_key, p_business_id, v_event_id, 'payment.post', 'payment', v_payment_id::text,
    p_payload, v_result);

  return v_result;
end;
$fn$;

comment on function public.post_payment(uuid, jsonb, text) is
  'Atomic, permission-checked, idempotent receipt/supplier payment with the matching double-entry posting (clears receivable/payable, never revenue/expense twice).';
