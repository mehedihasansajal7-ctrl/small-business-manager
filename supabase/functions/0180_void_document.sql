-- =============================================================================
-- functions/0180_void_document.sql
--
-- Void a posted sale or purchase. Nothing is deleted: the document keeps its
-- identity (`status = 'VOID'`, `voided_at`, `voided_reason`) and a REVERSING
-- journal entry with swapped debit/credit is posted, so the ledger still
-- balances and the original entry remains visible forever. Idempotent.
-- =============================================================================
create or replace function public.void_document(
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
  v_kind text := upper(coalesce(p_payload ->> 'kind', ''));
  v_document_id uuid := nullif(p_payload ->> 'documentId', '')::uuid;
  v_reason text := coalesce(nullif(p_payload ->> 'reason', ''), 'Voided by an authorised user');
  v_reference text;
  v_status text;
  v_voided_at timestamptz;
  v_document_date date;
  v_currency text;
  v_original_entry uuid;
  v_reversal_entry uuid := null;
  v_event_id text := coalesce(nullif(p_payload ->> 'eventId', ''), gen_random_uuid()::text);
  v_reversing_lines jsonb;
  v_result jsonb;
begin
  v_actor := app.effective_actor(p_business_id);

  if v_kind = 'SALE' then
    perform app.require_permission(p_business_id, 'sale.void');
  elsif v_kind = 'PURCHASE' then
    perform app.require_permission(p_business_id, 'purchase.manage');
  else
    raise exception 'VALIDATION: kind must be SALE or PURCHASE'
      using errcode = 'invalid_parameter_value';
  end if;

  v_prior := app.idempotent_result(p_idempotency_key);
  if v_prior is not null then
    return v_prior;
  end if;

  if v_kind = 'SALE' then
    select reference, status, voided_at, document_date, currency
      into v_reference, v_status, v_voided_at, v_document_date, v_currency
      from public.sales
     where id = v_document_id and business_id = p_business_id;
  else
    select reference, status, voided_at, document_date, currency
      into v_reference, v_status, v_voided_at, v_document_date, v_currency
      from public.purchases
     where id = v_document_id and business_id = p_business_id;
  end if;
  if not found then
    raise exception 'NOT_FOUND: % % does not exist in this business', v_kind, v_document_id
      using errcode = 'no_data_found';
  end if;

  if v_status = 'VOID' then
    return jsonb_build_object(
      'kind', v_kind,
      'documentId', v_document_id,
      'reference', v_reference,
      'status', 'VOID',
      'reversalEntryId', null,
      'note', 'Already void'
    );
  end if;

  select je.id into v_original_entry
    from public.journal_entries je
   where je.business_id = p_business_id
     and je.source_type = v_kind
     and je.source_id = v_reference
   order by je.created_at
   limit 1;

  if v_original_entry is not null then
    select jsonb_agg(jsonb_build_object(
             'account', jl.account,
             'debit', jl.credit,
             'credit', jl.debit,
             'memo', 'Reversal of ' || v_reference
           ) order by jl.account, jl.id)
      into v_reversing_lines
      from public.journal_lines jl
     where jl.entry_id = v_original_entry;

    v_reversal_entry := app.insert_journal_entry(
      p_business_id, current_date, v_reference || '-REV',
      'Reversal of ' || v_kind || ' ' || v_reference, 'REVERSAL', v_reference, v_currency,
      v_event_id || ':reversal', v_actor, v_reversing_lines, v_original_entry);
  end if;

  if v_kind = 'SALE' then
    update public.sales
       set status = 'VOID', voided_at = now(), voided_reason = v_reason,
           revision = revision + 1, updated_at = now()
     where id = v_document_id and business_id = p_business_id;
  else
    update public.purchases
       set status = 'VOID', voided_at = now(), voided_reason = v_reason,
           revision = revision + 1, updated_at = now()
     where id = v_document_id and business_id = p_business_id;
  end if;

  v_result := jsonb_build_object(
    'kind', v_kind,
    'documentId', v_document_id,
    'reference', v_reference,
    'status', 'VOID',
    'reversalEntryId', v_reversal_entry,
    'note', 'Posted rows are never deleted; the reversal entry keeps the ledger balanced.'
  );

  perform app.record_event(
    p_idempotency_key, p_business_id, v_event_id, 'document.void',
    lower(v_kind), v_document_id::text, p_payload, v_result);

  return v_result;
end;
$fn$;

comment on function public.void_document(uuid, jsonb, text) is
  'Void (never delete) a posted sale/purchase: marks it VOID and posts a reversing journal entry. Idempotent.';
