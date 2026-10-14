-- =============================================================================
-- functions/0160_create_journal_entry.sql
--
-- Post a balanced double-entry journal entry directly (opening balances,
-- corrections, reversals, payroll, ...). The entry is refused if debit does not
-- equal credit, if a line has no single positive side, or if an account code is
-- not in the chart of accounts. Idempotent on the caller's idempotency key.
-- =============================================================================
create or replace function public.create_journal_entry(
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
  v_date date;
  v_reference text;
  v_event_id text;
  v_source_type text := upper(coalesce(nullif(p_payload ->> 'sourceType', ''), 'OTHER'));
  v_source_id text;
  v_lines jsonb := p_payload -> 'lines';
  v_line jsonb;
  v_debit numeric(20, 6) := 0;
  v_credit numeric(20, 6) := 0;
  v_line_debit numeric(20, 6);
  v_line_credit numeric(20, 6);
  v_entry_id uuid;
  v_result jsonb;
begin
  perform app.require_permission(p_business_id, 'finance.manage');
  v_actor := app.effective_actor(p_business_id);

  v_prior := app.idempotent_result(p_idempotency_key);
  if v_prior is not null then
    return v_prior;
  end if;

  if v_source_type not in (
    'SALE', 'PURCHASE', 'RECEIPT', 'PAYMENT', 'TRANSFER', 'INCOME_EXPENSE',
    'PARTNER_CONTRIBUTION', 'PARTNER_WITHDRAWAL', 'MORTALITY_LOSS', 'INVENTORY_ADJUSTMENT',
    'HARVEST', 'INPUT_ISSUE', 'DIRECT_BATCH_COST', 'REVERSAL',
    'OPENING_BALANCE', 'CYCLE_CLOSE', 'OTHER'
  ) then
    raise exception 'VALIDATION: unsupported sourceType %', v_source_type
      using errcode = 'invalid_parameter_value';
  end if;

  if coalesce(jsonb_array_length(v_lines), 0) = 0 then
    raise exception 'VALIDATION: at least one journal line is required'
      using errcode = 'invalid_parameter_value';
  end if;

  v_date := (p_payload ->> 'documentDate')::date;
  v_currency := upper(coalesce(nullif(p_payload ->> 'currency', ''),
                               (select b.currency from public.businesses b where b.id = p_business_id)));
  v_reference := coalesce(nullif(p_payload ->> 'reference', ''),
                          app.reference(p_business_id, 'journal', 'JRN', v_date));
  v_source_id := coalesce(nullif(p_payload ->> 'sourceId', ''), v_reference);
  v_event_id := coalesce(nullif(p_payload ->> 'eventId', ''), gen_random_uuid()::text);

  for v_line in select value from jsonb_array_elements(v_lines) loop
    if nullif(v_line ->> 'account', '') is null then
      raise exception 'VALIDATION: every journal line needs an account code'
        using errcode = 'invalid_parameter_value';
    end if;
    if not exists (select 1 from public.accounts a where a.code = v_line ->> 'account') then
      raise exception 'VALIDATION: unknown account code %', v_line ->> 'account'
        using errcode = 'invalid_parameter_value';
    end if;

    v_line_debit := coalesce(nullif(v_line ->> 'debit', '')::numeric(20, 6), 0);
    v_line_credit := coalesce(nullif(v_line ->> 'credit', '')::numeric(20, 6), 0);
    if v_line_debit < 0 or v_line_credit < 0 then
      raise exception 'VALIDATION: debit and credit cannot be negative'
        using errcode = 'invalid_parameter_value';
    end if;
    if (v_line_debit > 0) = (v_line_credit > 0) then
      raise exception 'VALIDATION: exactly one of debit or credit must be positive on each line'
        using errcode = 'invalid_parameter_value';
    end if;

    v_debit := v_debit + v_line_debit;
    v_credit := v_credit + v_line_credit;
  end loop;

  -- app.insert_journal_entry re-checks this; the deferrable constraint trigger
  -- on journal_lines checks the stored rows again at commit.
  if v_debit <> v_credit then
    raise exception 'UNBALANCED_ENTRY: debit % does not equal credit %', v_debit, v_credit
      using errcode = 'check_violation';
  end if;

  v_entry_id := app.insert_journal_entry(
    p_business_id, v_date, v_reference,
    coalesce(nullif(p_payload ->> 'description', ''), 'Journal entry ' || v_reference),
    v_source_type, v_source_id, v_currency, v_event_id, v_actor, v_lines,
    nullif(p_payload ->> 'reversalOf', '')::uuid);

  v_result := jsonb_build_object(
    'entryId', v_entry_id,
    'reference', v_reference,
    'debit', app.money_text(v_debit),
    'credit', app.money_text(v_credit),
    'lineCount', jsonb_array_length(v_lines),
    'currency', v_currency
  );

  perform app.record_event(
    p_idempotency_key, p_business_id, v_event_id, 'journal.post', 'journal_entry',
    v_entry_id::text, p_payload, v_result);

  return v_result;
end;
$fn$;

comment on function public.create_journal_entry(uuid, jsonb, text) is
  'Atomic, permission-checked, idempotent double-entry posting: refuses unbalanced entries, empty sides and unknown accounts.';
