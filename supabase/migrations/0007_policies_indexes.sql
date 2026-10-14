-- =============================================================================
-- 0007_policies_and_indexes.sql
-- Row level security, the permission helpers, integrity guards, audit triggers
-- and indexes. This is the tenant boundary and the most important migration.
--
-- Design notes
-- ------------
-- * EVERY tenant table gets `enable row level security` AND `force row level
--   security`. There is no "trusted owner connection" shortcut on the API
--   path: PostgREST always connects as `authenticated` / `service_role`.
--
-- * The policies never hard-code a role name. They call two SECURITY DEFINER
--   helpers, `public.is_business_member(business_id)` and
--   `public.has_business_permission(business_id, permission)`, which read
--   `business_members` and the seeded `role_permissions` map. Adding a
--   permission is therefore a data change, not a policy rewrite.
--
-- * A SECURITY DEFINER helper that reads `business_members` must NOT itself be
--   subject to the `business_members` policies, or PostgreSQL raises
--   "infinite recursion detected in policy". That is why this migration
--   reassigns the helper functions to `supabase_admin` (a role with
--   BYPASSRLS) when it exists — the standard Supabase membership-check
--   pattern. On a plain PostgreSQL server, run these migrations as a
--   superuser (or a role with BYPASSRLS) for the same reason. See README.md.
--
-- * Posted accounting and stock rows are APPEND-ONLY: no UPDATE/DELETE policy
--   is created for `stock_movements`, `journal_entries`, `journal_lines`,
--   `processed_events`, `payments`, `income_expenses`, `account_transfers`,
--   `partner_capital`, `harvests`, `sale_lines`, `purchase_lines`,
--   `mortality_losses`, `observations` or `cost_allocations`. Row level
--   security denies those operations by default. A mistake is corrected by
--   posting a REVERSAL (a `reversal_of` row) or by voiding a document
--   (`status = 'VOID'`, `voided_at`), never by editing or deleting history.
--
-- * `audit_logs` is append-only: it has a SELECT and an INSERT policy and no
--   UPDATE/DELETE policy.
--
-- * Partner cost visibility: `has_business_permission` widens the read
--   permissions `financial_reports.view`, `purchase.cost.view`,
--   `farming.cost.view` and `partner_capital.view` for non-owner/admin members
--   when the owner sets `partnerCanSeeFinancialReports` /
--   `partnerCanSeeCosts` / `partnerCanSeeCapital` in `business_settings`,
--   exactly mirroring `permissionsFor()` in packages/domain.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Permission helpers (SECURITY DEFINER, search_path pinned)
-- -----------------------------------------------------------------------------

create or replace function public.is_business_member(p_business_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select exists (
    select 1
      from public.business_members m
     where m.business_id = p_business_id
       and m.user_id = public.current_profile_id()
       and m.status = 'active'
  );
$fn$;

comment on function public.is_business_member(uuid) is
  'True when the current profile is an active member of the business. SECURITY DEFINER so it does not recurse into business_members policies.';

create or replace function public.is_business_owner(p_business_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select exists (
    select 1
      from public.business_members m
     where m.business_id = p_business_id
       and m.user_id = public.current_profile_id()
       and m.role = 'owner'
       and m.status = 'active'
  );
$fn$;

create or replace function public.business_setting_true(p_business_id uuid, p_key text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select coalesce(
    (select s.value from public.business_settings s
      where s.business_id = p_business_id and s.key = p_key) = 'true'::jsonb,
    false
  );
$fn$;

create or replace function public.can_see_profile(p_profile_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select exists (
    select 1
      from public.business_members me
      join public.business_members them on them.business_id = me.business_id
     where me.user_id = public.current_profile_id()
       and me.status = 'active'
       and them.user_id = p_profile_id
  );
$fn$;

-- True only for the very first member of a business: the profile that created
-- it, while it still has no members. This is what lets a signed-in user create
-- a business and immediately insert their own owner membership through the API
-- without needing `member.invite` yet. Wrapped in a SECURITY DEFINER function so
-- the membership policy that uses it does not read business_members recursively.
create or replace function public.can_bootstrap_business(p_business_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select exists (
    select 1
      from public.businesses b
     where b.id = p_business_id
       and b.created_by = public.current_profile_id()
       and not exists (select 1 from public.business_members m where m.business_id = p_business_id)
  );
$fn$;

-- The role -> permission check, with per-member grants/denials and the owner
-- controlled partner-visibility settings applied on top.
create or replace function public.has_business_permission(p_business_id uuid, p_permission text)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_member public.business_members;
  v_privileged boolean;
begin
  select * into v_member
    from public.business_members m
   where m.business_id = p_business_id
     and m.user_id = public.current_profile_id()
     and m.status = 'active';

  if not found then
    return false;
  end if;

  -- An explicit denial always wins: a de-scoped member cannot regain access
  -- through a role change or a stale grant.
  if v_member.denials ? p_permission then
    return false;
  end if;
  if v_member.grants ? p_permission then
    return true;
  end if;
  if exists (
    select 1 from public.role_permissions rp
     where rp.role = v_member.role and rp.permission = p_permission
  ) then
    return true;
  end if;

  -- Owner-controlled widening for non-owner/admin members.
  v_privileged := v_member.role in ('owner', 'admin');
  if not v_privileged then
    if p_permission in ('financial_reports.view', 'report.export')
       and public.business_setting_true(p_business_id, 'partnerCanSeeFinancialReports') then
      return true;
    end if;
    if p_permission in ('financial_reports.view', 'purchase.cost.view', 'farming.cost.view')
       and public.business_setting_true(p_business_id, 'partnerCanSeeCosts') then
      return true;
    end if;
    if p_permission = 'partner_capital.view'
       and public.business_setting_true(p_business_id, 'partnerCanSeeCapital') then
      return true;
    end if;
  end if;

  return false;
end;
$fn$;

comment on function public.has_business_permission(uuid, text) is
  'Permission check for the current profile within a business: role map + grants, minus denials, plus owner-controlled partner visibility.';

-- Atomic document numbering (SALE-20260501-0007, ...).
create or replace function public.next_reference(
  p_business_id uuid,
  p_kind text,
  p_prefix text,
  p_document_date date
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_compact text := to_char(p_document_date, 'YYYYMMDD');
  v_key text := p_kind || ':' || v_compact;
  v_next integer;
begin
  insert into public.number_sequences (business_id, kind, next_value)
  values (p_business_id, v_key, 1)
  on conflict (business_id, kind)
  do update set next_value = public.number_sequences.next_value + 1
  returning next_value into v_next;

  return p_prefix || '-' || v_compact || '-' || lpad(v_next::text, 4, '0');
end;
$fn$;

-- -----------------------------------------------------------------------------
-- 2. Invite redemption — the only way a code becomes a membership.
--
-- `business_invites` stores no plaintext code (only `code_hash`), so no policy
-- can leak one. This SECURITY DEFINER function computes the hash from the
-- caller-supplied code, locks the row, validates status/expiry/use-count and
-- email scope, then inserts or reactivates the membership in the SAME
-- transaction. It is therefore single-use and replay-proof by construction.
-- -----------------------------------------------------------------------------
create or replace function public.redeem_invite(p_code text)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_uid uuid := public.current_profile_id();
  v_email text;
  v_display_name text;
  v_normalized text;
  v_hash text;
  v_invite public.business_invites;
  v_existing public.business_members;
  v_now timestamptz := now();
begin
  if v_uid is null then
    raise exception 'You must be signed in to redeem an invitation'
      using errcode = 'insufficient_privilege';
  end if;

  select p.email, p.display_name into v_email, v_display_name
    from public.profiles p where p.id = v_uid;
  if not found then
    raise exception 'Your profile could not be found'
      using errcode = 'insufficient_privilege';
  end if;

  v_normalized := upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'));
  if v_normalized = '' then
    raise exception 'INVALID_INVITE: the code was empty'
      using errcode = 'invalid_parameter_value';
  end if;
  v_hash := encode(sha256(convert_to(v_normalized, 'UTF8')), 'hex');

  -- Lock the row so two simultaneous redemptions cannot both consume it.
  select * into v_invite
    from public.business_invites i
   where i.code_hash = v_hash
   for update;

  if not found then
    raise exception 'INVALID_INVITE: no such invitation'
      using errcode = 'invalid_parameter_value';
  end if;
  if v_invite.status = 'revoked' then
    raise exception 'INVALID_INVITE: this invitation was revoked'
      using errcode = 'invalid_parameter_value';
  end if;
  if v_invite.status = 'accepted' then
    raise exception 'INVALID_INVITE: this invitation was already used'
      using errcode = 'invalid_parameter_value';
  end if;
  if v_invite.expires_at <= v_now then
    raise exception 'INVALID_INVITE: this invitation has expired'
      using errcode = 'invalid_parameter_value';
  end if;
  if v_invite.use_count >= v_invite.max_uses then
    raise exception 'INVALID_INVITE: this invitation has no uses left'
      using errcode = 'invalid_parameter_value';
  end if;
  if v_invite.email is not null and lower(v_invite.email) <> lower(v_email) then
    raise exception 'INVALID_INVITE: this invitation is for a different email address'
      using errcode = 'invalid_parameter_value';
  end if;

  -- Tell the role-change guard that this membership write comes from a valid
  -- redemption (transaction-local; see app.guard_member_role_change).
  perform set_config('app.membership_change', 'invite_redemption', true);

  select * into v_existing
    from public.business_members m
   where m.business_id = v_invite.business_id and m.user_id = v_uid;

  if found then
    if v_existing.status <> 'active' then
      update public.business_members
         set status = 'active',
             role = v_invite.role,
             joined_at = v_now,
             invited_by = v_invite.created_by
       where id = v_existing.id;
    else
      update public.business_members
         set last_active_at = v_now
       where id = v_existing.id;
    end if;
  else
    insert into public.business_members
      (business_id, user_id, email, display_name, role, status, invited_by, joined_at)
    values
      (v_invite.business_id, v_uid, lower(v_email), v_display_name, v_invite.role, 'active', v_invite.created_by, v_now);
  end if;

  update public.business_invites
     set use_count = use_count + 1,
         status = case when use_count + 1 >= max_uses then 'accepted' else status end,
         accepted_at = v_now,
         accepted_by = v_uid
   where id = v_invite.id;

  return v_invite.business_id;
end;
$fn$;

comment on function public.redeem_invite(text) is
  'Atomically validates an invite code (hash, expiry, single-use, email scope) and creates/reactivates the membership. Returns the joined business id.';

-- -----------------------------------------------------------------------------
-- 3. Export logging (the one audit event that has no row of its own).
-- -----------------------------------------------------------------------------
create or replace function public.log_export(p_business_id uuid, p_entity text, p_note text default null)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_actor uuid := public.current_profile_id();
  v_id uuid;
begin
  if v_actor is not null
     and not (public.has_business_permission(p_business_id, 'report.export')
              or public.has_business_permission(p_business_id, 'report.view')) then
    raise exception 'Exporting requires the report.export permission'
      using errcode = 'insufficient_privilege';
  end if;

  insert into public.audit_logs (business_id, actor_id, action, entity_type, entity_id, detail)
  values (p_business_id, v_actor, 'report.export', 'export', p_entity,
          jsonb_build_object('entity', p_entity, 'note', p_note))
  returning id into v_id;

  return v_id;
end;
$fn$;

-- -----------------------------------------------------------------------------
-- 4. Integrity guards
-- -----------------------------------------------------------------------------

-- 4a. The last owner can never be demoted, deactivated or removed.
create or replace function app.protect_last_owner()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_business_id uuid;
  v_remaining integer;
  v_loses_ownership boolean := false;
begin
  if tg_op = 'DELETE' then
    v_business_id := old.business_id;
    v_loses_ownership := (old.role = 'owner' and old.status = 'active');
  else
    v_business_id := new.business_id;
    v_loses_ownership := (old.role = 'owner' and old.status = 'active'
                          and (new.role <> 'owner' or new.status <> 'active'));
  end if;

  if v_loses_ownership then
    select count(*) into v_remaining
      from public.business_members m
     where m.business_id = v_business_id
       and m.role = 'owner'
       and m.status = 'active'
       and m.id <> old.id;

    if v_remaining = 0 then
      raise exception 'Cannot demote, deactivate or remove the only owner of business %', v_business_id
        using errcode = 'raise_exception',
              hint = 'Transfer ownership to another member first.';
    end if;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$fn$;

drop trigger if exists business_members_protect_last_owner on public.business_members;
create trigger business_members_protect_last_owner
  before update or delete on public.business_members
  for each row execute function app.protect_last_owner();

-- 4b. A role change needs the right permission. Changing an owner role needs
-- `business.transfer_ownership`; any other role change needs `member.manage`.
create or replace function app.guard_member_role_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
begin
  if new.role is distinct from old.role then
    -- NULL profile id == trusted server-side/seed context (no JWT); see 0001.
    if public.current_profile_id() is null then
      return new;
    end if;

    -- A redemption legitimately sets the role the invite grants. The marker is
    -- transaction-local and can only be set by public.redeem_invite() (it is a
    -- SECURITY DEFINER function; PostgREST exposes no way for a client to set
    -- an `app.*` setting directly).
    if coalesce(current_setting('app.membership_change', true), '') = 'invite_redemption' then
      return new;
    end if;

    if new.role = 'owner' or old.role = 'owner' then
      if not public.has_business_permission(new.business_id, 'business.transfer_ownership') then
        raise exception 'Changing an owner role requires business.transfer_ownership'
          using errcode = 'insufficient_privilege';
      end if;
    elsif not public.has_business_permission(new.business_id, 'member.manage') then
      raise exception 'Changing a member role requires member.manage'
        using errcode = 'insufficient_privilege';
    end if;
  end if;

  return new;
end;
$fn$;

drop trigger if exists business_members_guard_role_change on public.business_members;
create trigger business_members_guard_role_change
  before update on public.business_members
  for each row execute function app.guard_member_role_change();

-- 4c. Double entry: every journal entry must balance at commit. Deferrable, so
-- it fires once at the end of the transaction after all lines are inserted.
create or replace function app.assert_entry_balanced()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_entry_id uuid;
  v_debit numeric(20, 6);
  v_credit numeric(20, 6);
begin
  if tg_op = 'DELETE' then
    v_entry_id := old.entry_id;
  else
    v_entry_id := new.entry_id;
  end if;

  select coalesce(sum(debit), 0), coalesce(sum(credit), 0)
    into v_debit, v_credit
    from public.journal_lines
   where entry_id = v_entry_id;

  if v_debit <> v_credit then
    raise exception 'Journal entry % is not balanced: debit %, credit %', v_entry_id, v_debit, v_credit
      using errcode = 'check_violation';
  end if;

  return null;
end;
$fn$;

drop trigger if exists journal_lines_balanced on public.journal_lines;
create constraint trigger journal_lines_balanced
  after insert or update or delete on public.journal_lines
  deferrable initially deferred
  for each row execute function app.assert_entry_balanced();

-- 4d. A shared cost must be allocated in full: the shares of one cost_source
-- must sum exactly to the source amount.
create or replace function app.assert_cost_allocation_balanced()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_source_id uuid;
  v_source_amount numeric(20, 6);
  v_allocated numeric(20, 6);
begin
  if tg_op = 'DELETE' then
    v_source_id := old.cost_source_id;
  else
    v_source_id := new.cost_source_id;
  end if;

  select amount into v_source_amount from public.cost_sources where id = v_source_id;
  if not found then
    return null;
  end if;

  select coalesce(sum(amount), 0) into v_allocated
    from public.cost_allocations
   where cost_source_id = v_source_id;

  if abs(v_allocated - v_source_amount) > 0.000001 then
    raise exception 'Cost source % allocated % but its amount is %', v_source_id, v_allocated, v_source_amount
      using errcode = 'check_violation';
  end if;

  return null;
end;
$fn$;

drop trigger if exists cost_allocations_balanced on public.cost_allocations;
create constraint trigger cost_allocations_balanced
  after insert or update or delete on public.cost_allocations
  deferrable initially deferred
  for each row execute function app.assert_cost_allocation_balanced();

-- 4e. Generic audit writer. Attached only to the events that matter (below).
create or replace function app.audit_row()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_business_id uuid;
  v_entity_id text;
  v_action text;
  v_detail jsonb;
begin
  if tg_op = 'DELETE' then
    v_business_id := old.business_id;
    v_entity_id := old.id::text;
    v_action := tg_table_name || '.delete';
    v_detail := jsonb_build_object('row', to_jsonb(old));
  elsif tg_op = 'INSERT' then
    v_business_id := new.business_id;
    v_entity_id := new.id::text;
    v_action := tg_table_name || '.create';
    v_detail := jsonb_build_object('row', to_jsonb(new));
  else
    v_business_id := new.business_id;
    v_entity_id := new.id::text;
    v_action := tg_table_name || '.update';
    v_detail := jsonb_build_object('before', to_jsonb(old), 'after', to_jsonb(new));
  end if;

  insert into public.audit_logs (business_id, actor_id, action, entity_type, entity_id, detail)
  values (v_business_id, public.current_profile_id(), v_action, tg_table_name, v_entity_id, v_detail);

  return null;
end;
$fn$;

-- member and role changes
drop trigger if exists audit_business_members on public.business_members;
create trigger audit_business_members
  after insert or update or delete on public.business_members
  for each row execute function app.audit_row();

-- invite lifecycle
drop trigger if exists audit_business_invites on public.business_invites;
create trigger audit_business_invites
  after insert or update or delete on public.business_invites
  for each row execute function app.audit_row();

-- opening balances (financial accounts, customers, suppliers)
drop trigger if exists audit_opening_balance_accounts on public.financial_accounts;
create trigger audit_opening_balance_accounts
  after update on public.financial_accounts
  for each row when (new.opening_balance is distinct from old.opening_balance)
  execute function app.audit_row();

drop trigger if exists audit_opening_balance_customers on public.customers;
create trigger audit_opening_balance_customers
  after update on public.customers
  for each row when (new.opening_balance is distinct from old.opening_balance)
  execute function app.audit_row();

drop trigger if exists audit_opening_balance_suppliers on public.suppliers;
create trigger audit_opening_balance_suppliers
  after update on public.suppliers
  for each row when (new.opening_balance is distinct from old.opening_balance)
  execute function app.audit_row();

-- stock adjustments and spoilage/write-offs
drop trigger if exists audit_stock_adjustments on public.stock_movements;
create trigger audit_stock_adjustments
  after insert on public.stock_movements
  for each row when (new.source_type in ('ADJUSTMENT', 'COUNT_CORRECTION', 'SPOILAGE', 'MORTALITY_LOSS', 'INTERNAL_USE'))
  execute function app.audit_row();

-- stock reversals
drop trigger if exists audit_stock_reversals on public.stock_movements;
create trigger audit_stock_reversals
  after insert on public.stock_movements
  for each row when (new.reversal_of is not null)
  execute function app.audit_row();

-- ledger reversals
drop trigger if exists audit_journal_reversals on public.journal_entries;
create trigger audit_journal_reversals
  after insert on public.journal_entries
  for each row when (new.reversal_of is not null)
  execute function app.audit_row();

-- cost-allocation approvals
drop trigger if exists audit_cost_allocations on public.cost_allocations;
create trigger audit_cost_allocations
  after insert on public.cost_allocations
  for each row execute function app.audit_row();

-- partner capital movements (equity)
drop trigger if exists audit_partner_capital on public.partner_capital;
create trigger audit_partner_capital
  after insert on public.partner_capital
  for each row execute function app.audit_row();

-- document voids
drop trigger if exists audit_document_voids_sales on public.sales;
create trigger audit_document_voids_sales
  after update on public.sales
  for each row when (new.voided_at is not null and old.voided_at is null)
  execute function app.audit_row();

drop trigger if exists audit_document_voids_purchases on public.purchases;
create trigger audit_document_voids_purchases
  after update on public.purchases
  for each row when (new.voided_at is not null and old.voided_at is null)
  execute function app.audit_row();

-- -----------------------------------------------------------------------------
-- 5. Helper ownership
--
-- A SECURITY DEFINER function that reads business_members is only exempt from
-- the business_members policies if its owner can bypass RLS. Supabase's
-- `postgres`/`supabase_admin` can; on another server this whole block is a
-- no-op and you must run the migrations as a superuser / BYPASSRLS role.
-- -----------------------------------------------------------------------------
do $do$
declare
  v_owner text;
begin
  select r.rolname into v_owner
    from pg_roles r
   where r.rolname in ('supabase_admin', 'postgres')
     and r.rolbypassrls
   order by (r.rolname = 'supabase_admin') desc
   limit 1;

  if v_owner is null then
    raise notice 'No BYPASSRLS role found; leaving RLS helpers owned by the migration role.';
    return;
  end if;

  begin
    execute format('alter function public.current_profile_id() owner to %I', v_owner);
    execute format('alter function public.is_business_member(uuid) owner to %I', v_owner);
    execute format('alter function public.is_business_owner(uuid) owner to %I', v_owner);
    execute format('alter function public.can_see_profile(uuid) owner to %I', v_owner);
    execute format('alter function public.can_bootstrap_business(uuid) owner to %I', v_owner);
    execute format('alter function public.business_setting_true(uuid, text) owner to %I', v_owner);
    execute format('alter function public.has_business_permission(uuid, text) owner to %I', v_owner);
    execute format('alter function public.next_reference(uuid, text, text, date) owner to %I', v_owner);
    execute format('alter function public.redeem_invite(text) owner to %I', v_owner);
    execute format('alter function public.log_export(uuid, text, text) owner to %I', v_owner);
    raise notice 'RLS helper functions reassigned to %', v_owner;
  exception when others then
    raise notice 'Could not reassign RLS helper ownership (%); run the migrations as a BYPASSRLS role.', sqlerrm;
  end;
end
$do$;

-- -----------------------------------------------------------------------------
-- 6. Enable + force row level security on every tenant table.
-- -----------------------------------------------------------------------------

alter table public.businesses         enable row level security;
alter table public.businesses         force row level security;
alter table public.business_members   enable row level security;
alter table public.business_members   force row level security;
alter table public.business_invites   enable row level security;
alter table public.business_invites   force row level security;
alter table public.devices            enable row level security;
alter table public.devices            force row level security;
alter table public.audit_logs         enable row level security;
alter table public.audit_logs         force row level security;
alter table public.business_settings  enable row level security;
alter table public.business_settings  force row level security;
alter table public.number_sequences   enable row level security;
alter table public.number_sequences   force row level security;
alter table public.locations            enable row level security;
alter table public.locations            force row level security;
alter table public.product_categories   enable row level security;
alter table public.product_categories   force row level security;
alter table public.products             enable row level security;
alter table public.products             force row level security;
alter table public.unit_conversions     enable row level security;
alter table public.unit_conversions     force row level security;
alter table public.customers            enable row level security;
alter table public.customers            force row level security;
alter table public.suppliers            enable row level security;
alter table public.suppliers            force row level security;
alter table public.stock_lots           enable row level security;
alter table public.stock_lots           force row level security;
alter table public.stock_movements      enable row level security;
alter table public.stock_movements      force row level security;
alter table public.financial_accounts   enable row level security;
alter table public.financial_accounts   force row level security;
alter table public.purchases            enable row level security;
alter table public.purchases            force row level security;
alter table public.purchase_lines       enable row level security;
alter table public.purchase_lines       force row level security;
alter table public.sales                enable row level security;
alter table public.sales                force row level security;
alter table public.sale_lines           enable row level security;
alter table public.sale_lines           force row level security;
alter table public.payments             enable row level security;
alter table public.payments             force row level security;
alter table public.account_transfers    enable row level security;
alter table public.account_transfers    force row level security;
alter table public.income_expenses      enable row level security;
alter table public.income_expenses      force row level security;
alter table public.partner_capital      enable row level security;
alter table public.partner_capital      force row level security;
alter table public.journal_entries      enable row level security;
alter table public.journal_entries      force row level security;
alter table public.journal_lines        enable row level security;
alter table public.journal_lines        force row level security;
alter table public.attachments          enable row level security;
alter table public.attachments          force row level security;
alter table public.farms                enable row level security;
alter table public.farms                force row level security;
alter table public.farm_units           enable row level security;
alter table public.farm_units           force row level security;
alter table public.production_cycles    enable row level security;
alter table public.production_cycles    force row level security;
alter table public.farming_events       enable row level security;
alter table public.farming_events       force row level security;
alter table public.input_consumptions   enable row level security;
alter table public.input_consumptions   force row level security;
alter table public.production_outputs   enable row level security;
alter table public.production_outputs   force row level security;
alter table public.harvests             enable row level security;
alter table public.harvests             force row level security;
alter table public.mortality_losses     enable row level security;
alter table public.mortality_losses     force row level security;
alter table public.cost_sources         enable row level security;
alter table public.cost_sources         force row level security;
alter table public.cost_allocations     enable row level security;
alter table public.cost_allocations     force row level security;
alter table public.output_lots          enable row level security;
alter table public.output_lots          force row level security;
alter table public.observations         enable row level security;
alter table public.observations         force row level security;
alter table public.sync_events          enable row level security;
alter table public.sync_events          force row level security;
alter table public.processed_events     enable row level security;
alter table public.processed_events     force row level security;
alter table public.sync_conflicts       enable row level security;
alter table public.sync_conflicts       force row level security;
alter table public.ai_conversations     enable row level security;
alter table public.ai_conversations     force row level security;
alter table public.ai_messages          enable row level security;
alter table public.ai_messages          force row level security;
alter table public.ai_saved_plans       enable row level security;
alter table public.ai_saved_plans       force row level security;
alter table public.ai_feedback          enable row level security;
alter table public.ai_feedback          force row level security;
alter table public.ai_research_cache    enable row level security;
alter table public.ai_research_cache    force row level security;
alter table public.ai_usage             enable row level security;
alter table public.ai_usage             force row level security;

-- Global reference tables are read-only to signed-in users.
alter table public.profiles          enable row level security;
alter table public.profiles          force row level security;
alter table public.role_permissions  enable row level security;
alter table public.role_permissions  force row level security;
alter table public.units             enable row level security;
alter table public.units             force row level security;
alter table public.accounts          enable row level security;
alter table public.accounts          force row level security;

-- -----------------------------------------------------------------------------
-- 7. Policies.
--
-- Dropped first (by enumerating pg_policies) so this migration can be re-run.
-- -----------------------------------------------------------------------------
do $do$
declare
  r record;
begin
  for r in select p.policyname, p.tablename from pg_policies p where p.schemaname = 'public' loop
    execute format('drop policy if exists %I on public.%I', r.policyname, r.tablename);
  end loop;
end
$do$;

-- profiles (global identity: read yourself and co-members of your businesses)
create policy profiles_select on public.profiles for select
  using (id = public.current_profile_id() or public.can_see_profile(id));
create policy profiles_insert on public.profiles for insert
  with check (id = public.current_profile_id());
create policy profiles_update on public.profiles for update
  using (id = public.current_profile_id())
  with check (id = public.current_profile_id());

-- global reference data (signed-in users only; `anon` has no privileges)
create policy role_permissions_select on public.role_permissions for select using (true);
create policy units_select on public.units for select using (true);
create policy accounts_select on public.accounts for select using (true);

-- businesses
create policy businesses_select on public.businesses for select
  using (public.is_business_member(id));
create policy businesses_insert on public.businesses for insert
  with check (created_by = public.current_profile_id());
create policy businesses_update on public.businesses for update
  using (public.has_business_permission(id, 'business.settings'))
  with check (public.has_business_permission(id, 'business.settings'));
create policy businesses_delete on public.businesses for delete
  using (public.has_business_permission(id, 'business.delete'));

-- business_members
create policy business_members_select on public.business_members for select
  using (user_id = public.current_profile_id() or public.is_business_member(business_id));
create policy business_members_insert on public.business_members for insert
  with check (public.has_business_permission(business_id, 'member.invite'));
-- Bootstrap: the profile that created a brand-new business may insert its own
-- owner membership (exactly once, while the business has no members yet).
create policy business_members_bootstrap_insert on public.business_members for insert
  with check (
    user_id = public.current_profile_id()
    and role = 'owner'
    and status = 'active'
    and public.can_bootstrap_business(business_id)
  );
create policy business_members_update on public.business_members for update
  using (public.has_business_permission(business_id, 'member.manage'))
  with check (public.has_business_permission(business_id, 'member.manage'));
create policy business_members_delete on public.business_members for delete
  using (public.has_business_permission(business_id, 'member.manage'));

-- business_invites (the code itself is never readable: only code_hash exists)
create policy business_invites_select on public.business_invites for select
  using (public.has_business_permission(business_id, 'member.invite'));
create policy business_invites_insert on public.business_invites for insert
  with check (public.has_business_permission(business_id, 'member.invite'));
create policy business_invites_update on public.business_invites for update
  using (public.has_business_permission(business_id, 'member.invite'))
  with check (public.has_business_permission(business_id, 'member.invite'));
create policy business_invites_delete on public.business_invites for delete
  using (public.has_business_permission(business_id, 'member.invite'));

-- devices
create policy devices_select on public.devices for select
  using (user_id = public.current_profile_id() or public.is_business_member(business_id));
create policy devices_insert on public.devices for insert
  with check (user_id = public.current_profile_id() and public.is_business_member(business_id));
create policy devices_update on public.devices for update
  using (user_id = public.current_profile_id())
  with check (user_id = public.current_profile_id());
create policy devices_delete on public.devices for delete
  using (user_id = public.current_profile_id());

-- audit_logs (APPEND-ONLY: select + insert, no update/delete policy)
create policy audit_logs_select on public.audit_logs for select
  using (public.has_business_permission(business_id, 'audit.view'));
create policy audit_logs_insert on public.audit_logs for insert
  with check (public.current_profile_id() is null or actor_id = public.current_profile_id());

-- business_settings
create policy business_settings_select on public.business_settings for select
  using (public.is_business_member(business_id));
create policy business_settings_insert on public.business_settings for insert
  with check (public.has_business_permission(business_id, 'business.settings'));
create policy business_settings_update on public.business_settings for update
  using (public.has_business_permission(business_id, 'business.settings'))
  with check (public.has_business_permission(business_id, 'business.settings'));
create policy business_settings_delete on public.business_settings for delete
  using (public.has_business_permission(business_id, 'business.settings'));

-- number_sequences
create policy number_sequences_select on public.number_sequences for select
  using (public.is_business_member(business_id));
create policy number_sequences_insert on public.number_sequences for insert
  with check (public.is_business_member(business_id));
create policy number_sequences_update on public.number_sequences for update
  using (public.is_business_member(business_id))
  with check (public.is_business_member(business_id));

-- locations
create policy locations_select on public.locations for select
  using (public.has_business_permission(business_id, 'inventory.view'));
create policy locations_insert on public.locations for insert
  with check (public.has_business_permission(business_id, 'location.manage'));
create policy locations_update on public.locations for update
  using (public.has_business_permission(business_id, 'location.manage'))
  with check (public.has_business_permission(business_id, 'location.manage'));
create policy locations_delete on public.locations for delete
  using (public.has_business_permission(business_id, 'location.manage'));

-- product_categories
create policy product_categories_select on public.product_categories for select
  using (public.has_business_permission(business_id, 'product.view'));
create policy product_categories_insert on public.product_categories for insert
  with check (public.has_business_permission(business_id, 'product.manage'));
create policy product_categories_update on public.product_categories for update
  using (public.has_business_permission(business_id, 'product.manage'))
  with check (public.has_business_permission(business_id, 'product.manage'));
create policy product_categories_delete on public.product_categories for delete
  using (public.has_business_permission(business_id, 'product.manage'));

-- products (costs are hidden from roles without purchase.cost.view)
create policy products_select on public.products for select
  using (public.has_business_permission(business_id, 'product.view'));
create policy products_insert on public.products for insert
  with check (public.has_business_permission(business_id, 'product.manage'));
create policy products_update on public.products for update
  using (public.has_business_permission(business_id, 'product.manage'))
  with check (public.has_business_permission(business_id, 'product.manage'));
create policy products_delete on public.products for delete
  using (public.has_business_permission(business_id, 'product.manage'));

-- unit_conversions (explicit conversions are an approval)
create policy unit_conversions_select on public.unit_conversions for select
  using (public.has_business_permission(business_id, 'inventory.view'));
create policy unit_conversions_insert on public.unit_conversions for insert
  with check (public.has_business_permission(business_id, 'inventory.adjust.approve'));
create policy unit_conversions_update on public.unit_conversions for update
  using (public.has_business_permission(business_id, 'inventory.adjust.approve'))
  with check (public.has_business_permission(business_id, 'inventory.adjust.approve'));
create policy unit_conversions_delete on public.unit_conversions for delete
  using (public.has_business_permission(business_id, 'inventory.adjust.approve'));

-- customers
create policy customers_select on public.customers for select
  using (public.has_business_permission(business_id, 'customer.view'));
create policy customers_insert on public.customers for insert
  with check (public.has_business_permission(business_id, 'customer.manage'));
create policy customers_update on public.customers for update
  using (public.has_business_permission(business_id, 'customer.manage'))
  with check (public.has_business_permission(business_id, 'customer.manage'));
create policy customers_delete on public.customers for delete
  using (public.has_business_permission(business_id, 'customer.manage'));

-- suppliers
create policy suppliers_select on public.suppliers for select
  using (public.has_business_permission(business_id, 'supplier.view'));
create policy suppliers_insert on public.suppliers for insert
  with check (public.has_business_permission(business_id, 'supplier.manage'));
create policy suppliers_update on public.suppliers for update
  using (public.has_business_permission(business_id, 'supplier.manage'))
  with check (public.has_business_permission(business_id, 'supplier.manage'));
create policy suppliers_delete on public.suppliers for delete
  using (public.has_business_permission(business_id, 'supplier.manage'));

-- stock_lots (immutable cost: insert only)
create policy stock_lots_select on public.stock_lots for select
  using (public.has_business_permission(business_id, 'inventory.view'));
create policy stock_lots_insert on public.stock_lots for insert
  with check (public.has_business_permission(business_id, 'inventory.manage'));

-- stock_movements (append-only ledger: insert only, never update/delete)
create policy stock_movements_select on public.stock_movements for select
  using (public.has_business_permission(business_id, 'inventory.view'));
create policy stock_movements_insert on public.stock_movements for insert
  with check (public.has_business_permission(business_id, 'inventory.manage'));

-- financial_accounts
create policy financial_accounts_select on public.financial_accounts for select
  using (public.has_business_permission(business_id, 'finance.view'));
create policy financial_accounts_insert on public.financial_accounts for insert
  with check (public.has_business_permission(business_id, 'finance.manage'));
create policy financial_accounts_update on public.financial_accounts for update
  using (public.has_business_permission(business_id, 'finance.manage'))
  with check (public.has_business_permission(business_id, 'finance.manage'));
create policy financial_accounts_delete on public.financial_accounts for delete
  using (public.has_business_permission(business_id, 'finance.manage'));

-- purchases (posted documents are voided, never deleted)
create policy purchases_select on public.purchases for select
  using (public.has_business_permission(business_id, 'purchase.view'));
create policy purchases_insert on public.purchases for insert
  with check (public.has_business_permission(business_id, 'purchase.manage'));
create policy purchases_update on public.purchases for update
  using (public.has_business_permission(business_id, 'purchase.manage'))
  with check (public.has_business_permission(business_id, 'purchase.manage'));

-- purchase_lines (immutable once posted)
create policy purchase_lines_select on public.purchase_lines for select
  using (public.has_business_permission(business_id, 'purchase.view'));
create policy purchase_lines_insert on public.purchase_lines for insert
  with check (public.has_business_permission(business_id, 'purchase.manage'));

-- sales
create policy sales_select on public.sales for select
  using (public.has_business_permission(business_id, 'sale.view'));
create policy sales_insert on public.sales for insert
  with check (public.has_business_permission(business_id, 'sale.create'));
create policy sales_update on public.sales for update
  using (public.has_business_permission(business_id, 'sale.void'))
  with check (public.has_business_permission(business_id, 'sale.void'));

-- sale_lines (immutable once posted)
create policy sale_lines_select on public.sale_lines for select
  using (public.has_business_permission(business_id, 'sale.view'));
create policy sale_lines_insert on public.sale_lines for insert
  with check (public.has_business_permission(business_id, 'sale.create'));

-- payments
create policy payments_select on public.payments for select
  using (public.has_business_permission(business_id, 'finance.view'));
create policy payments_insert on public.payments for insert
  with check (public.has_business_permission(business_id, 'finance.manage'));

-- account_transfers
create policy account_transfers_select on public.account_transfers for select
  using (public.has_business_permission(business_id, 'finance.view'));
create policy account_transfers_insert on public.account_transfers for insert
  with check (public.has_business_permission(business_id, 'finance.manage'));

-- income_expenses
create policy income_expenses_select on public.income_expenses for select
  using (public.has_business_permission(business_id, 'finance.view'));
create policy income_expenses_insert on public.income_expenses for insert
  with check (public.has_business_permission(business_id, 'finance.manage'));

-- partner_capital (widened by the partnerCanSeeCapital setting)
create policy partner_capital_select on public.partner_capital for select
  using (public.has_business_permission(business_id, 'partner_capital.view'));
create policy partner_capital_insert on public.partner_capital for insert
  with check (public.has_business_permission(business_id, 'partner_capital.manage'));

-- journal_entries / journal_lines (append-only; reversals are new entries)
create policy journal_entries_select on public.journal_entries for select
  using (public.has_business_permission(business_id, 'finance.view'));
create policy journal_entries_insert on public.journal_entries for insert
  with check (public.has_business_permission(business_id, 'finance.manage'));
create policy journal_lines_select on public.journal_lines for select
  using (public.has_business_permission(business_id, 'finance.view'));
create policy journal_lines_insert on public.journal_lines for insert
  with check (public.has_business_permission(business_id, 'finance.manage'));

-- attachments (the bytes live in Storage; these rows are the index)
create policy attachments_select on public.attachments for select
  using (public.is_business_member(business_id));
create policy attachments_insert on public.attachments for insert
  with check (public.has_business_permission(business_id, 'attachment.manage'));
create policy attachments_update on public.attachments for update
  using (public.has_business_permission(business_id, 'attachment.manage'))
  with check (public.has_business_permission(business_id, 'attachment.manage'));
create policy attachments_delete on public.attachments for delete
  using (public.has_business_permission(business_id, 'attachment.manage'));

-- farms / farm_units
create policy farms_select on public.farms for select
  using (public.has_business_permission(business_id, 'farming.view'));
create policy farms_insert on public.farms for insert
  with check (public.has_business_permission(business_id, 'farming.setup'));
create policy farms_update on public.farms for update
  using (public.has_business_permission(business_id, 'farming.setup'))
  with check (public.has_business_permission(business_id, 'farming.setup'));
create policy farms_delete on public.farms for delete
  using (public.has_business_permission(business_id, 'farming.setup'));
create policy farm_units_select on public.farm_units for select
  using (public.has_business_permission(business_id, 'farming.view'));
create policy farm_units_insert on public.farm_units for insert
  with check (public.has_business_permission(business_id, 'farming.setup'));
create policy farm_units_update on public.farm_units for update
  using (public.has_business_permission(business_id, 'farming.setup'))
  with check (public.has_business_permission(business_id, 'farming.setup'));
create policy farm_units_delete on public.farm_units for delete
  using (public.has_business_permission(business_id, 'farming.setup'));

-- production_cycles
create policy production_cycles_select on public.production_cycles for select
  using (public.has_business_permission(business_id, 'farming.view'));
create policy production_cycles_insert on public.production_cycles for insert
  with check (public.has_business_permission(business_id, 'farming.setup'));
create policy production_cycles_update on public.production_cycles for update
  using (public.has_business_permission(business_id, 'farming.setup'))
  with check (public.has_business_permission(business_id, 'farming.setup'));
create policy production_cycles_delete on public.production_cycles for delete
  using (public.has_business_permission(business_id, 'farming.setup'));

-- farming_events (immutable diary)
create policy farming_events_select on public.farming_events for select
  using (public.has_business_permission(business_id, 'farming.view'));
create policy farming_events_insert on public.farming_events for insert
  with check (public.has_business_permission(business_id, 'farming.operations'));

-- input_consumptions
create policy input_consumptions_select on public.input_consumptions for select
  using (public.has_business_permission(business_id, 'farming.view'));
create policy input_consumptions_insert on public.input_consumptions for insert
  with check (public.has_business_permission(business_id, 'farming.input_issue'));

-- production_outputs
create policy production_outputs_select on public.production_outputs for select
  using (public.has_business_permission(business_id, 'farming.view'));
create policy production_outputs_insert on public.production_outputs for insert
  with check (public.has_business_permission(business_id, 'farming.harvest'));

-- harvests
create policy harvests_select on public.harvests for select
  using (public.has_business_permission(business_id, 'farming.view'));
create policy harvests_insert on public.harvests for insert
  with check (public.has_business_permission(business_id, 'farming.harvest'));

-- mortality_losses
create policy mortality_losses_select on public.mortality_losses for select
  using (public.has_business_permission(business_id, 'farming.view'));
create policy mortality_losses_insert on public.mortality_losses for insert
  with check (public.has_business_permission(business_id, 'farming.operations'));

-- cost_sources (gated by the cost-visibility permission)
create policy cost_sources_select on public.cost_sources for select
  using (public.has_business_permission(business_id, 'farming.cost.view'));
create policy cost_sources_insert on public.cost_sources for insert
  with check (public.has_business_permission(business_id, 'farming.setup'));
create policy cost_sources_update on public.cost_sources for update
  using (public.has_business_permission(business_id, 'farming.setup'))
  with check (public.has_business_permission(business_id, 'farming.setup'));

-- cost_allocations (immutable shares: insert only)
create policy cost_allocations_select on public.cost_allocations for select
  using (public.has_business_permission(business_id, 'farming.cost.view'));
create policy cost_allocations_insert on public.cost_allocations for insert
  with check (public.has_business_permission(business_id, 'farming.setup'));

-- output_lots
create policy output_lots_select on public.output_lots for select
  using (public.has_business_permission(business_id, 'farming.view'));
create policy output_lots_insert on public.output_lots for insert
  with check (public.has_business_permission(business_id, 'farming.harvest'));

-- observations
create policy observations_select on public.observations for select
  using (public.has_business_permission(business_id, 'farming.view'));
create policy observations_insert on public.observations for insert
  with check (public.has_business_permission(business_id, 'farming.observation'));

-- sync_events (device queue mirror)
create policy sync_events_select on public.sync_events for select
  using (public.is_business_member(business_id));
create policy sync_events_insert on public.sync_events for insert
  with check (public.is_business_member(business_id));
create policy sync_events_update on public.sync_events for update
  using (public.is_business_member(business_id))
  with check (public.is_business_member(business_id));
create policy sync_events_delete on public.sync_events for delete
  using (public.is_business_member(business_id));

-- processed_events (idempotency ledger: append-only)
create policy processed_events_select on public.processed_events for select
  using (public.is_business_member(business_id));
create policy processed_events_insert on public.processed_events for insert
  with check (public.is_business_member(business_id));

-- sync_conflicts
create policy sync_conflicts_select on public.sync_conflicts for select
  using (public.is_business_member(business_id));
create policy sync_conflicts_insert on public.sync_conflicts for insert
  with check (public.is_business_member(business_id));
create policy sync_conflicts_update on public.sync_conflicts for update
  using (public.is_business_member(business_id))
  with check (public.is_business_member(business_id));

-- ai_conversations (private to their owner within the business)
create policy ai_conversations_select on public.ai_conversations for select
  using (public.has_business_permission(business_id, 'ai.use') and user_id = public.current_profile_id());
create policy ai_conversations_insert on public.ai_conversations for insert
  with check (public.has_business_permission(business_id, 'ai.use') and user_id = public.current_profile_id());
create policy ai_conversations_update on public.ai_conversations for update
  using (public.has_business_permission(business_id, 'ai.use') and user_id = public.current_profile_id())
  with check (public.has_business_permission(business_id, 'ai.use') and user_id = public.current_profile_id());
create policy ai_conversations_delete on public.ai_conversations for delete
  using (public.has_business_permission(business_id, 'ai.use') and user_id = public.current_profile_id());

-- ai_messages (immutable history)
create policy ai_messages_select on public.ai_messages for select
  using (public.has_business_permission(business_id, 'ai.use'));
create policy ai_messages_insert on public.ai_messages for insert
  with check (public.has_business_permission(business_id, 'ai.use'));

-- ai_saved_plans
create policy ai_saved_plans_select on public.ai_saved_plans for select
  using (public.has_business_permission(business_id, 'ai.use') and user_id = public.current_profile_id());
create policy ai_saved_plans_insert on public.ai_saved_plans for insert
  with check (public.has_business_permission(business_id, 'ai.use') and user_id = public.current_profile_id());
create policy ai_saved_plans_update on public.ai_saved_plans for update
  using (public.has_business_permission(business_id, 'ai.use') and user_id = public.current_profile_id())
  with check (public.has_business_permission(business_id, 'ai.use') and user_id = public.current_profile_id());
create policy ai_saved_plans_delete on public.ai_saved_plans for delete
  using (public.has_business_permission(business_id, 'ai.use') and user_id = public.current_profile_id());

-- ai_feedback (immutable)
create policy ai_feedback_select on public.ai_feedback for select
  using (public.has_business_permission(business_id, 'ai.use'));
create policy ai_feedback_insert on public.ai_feedback for insert
  with check (public.has_business_permission(business_id, 'ai.use') and user_id = public.current_profile_id());

-- ai_research_cache
create policy ai_research_cache_select on public.ai_research_cache for select
  using (public.has_business_permission(business_id, 'ai.use'));
create policy ai_research_cache_insert on public.ai_research_cache for insert
  with check (public.has_business_permission(business_id, 'ai.use'));
create policy ai_research_cache_update on public.ai_research_cache for update
  using (public.has_business_permission(business_id, 'ai.use'))
  with check (public.has_business_permission(business_id, 'ai.use'));
create policy ai_research_cache_delete on public.ai_research_cache for delete
  using (public.has_business_permission(business_id, 'ai.use'));

-- ai_usage (append-only metering)
create policy ai_usage_select on public.ai_usage for select
  using (public.has_business_permission(business_id, 'ai.use'));
create policy ai_usage_insert on public.ai_usage for insert
  with check (public.has_business_permission(business_id, 'ai.use'));

-- -----------------------------------------------------------------------------
-- 8. Privileges
--
-- `anon` (unauthenticated PostgREST) gets NOTHING: every policy expects a
-- signed-in profile, and the audit insert policy would otherwise be reachable
-- with a NULL profile id. `authenticated` gets the four table verbs (RLS then
-- narrows them); `service_role` bypasses RLS for trusted server jobs.
-- -----------------------------------------------------------------------------
do $do$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on all tables in schema public from anon';
    execute 'revoke all on all sequences in schema public from anon';
    execute 'revoke all on all functions in schema public from anon';
  end if;

  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant usage on schema public to authenticated';
    execute 'grant select, insert, update, delete on all tables in schema public to authenticated';
    execute 'grant execute on all functions in schema public to authenticated';
  end if;

  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant usage on schema public to service_role';
    execute 'grant all on all tables in schema public to service_role';
    execute 'grant all on all sequences in schema public to service_role';
    execute 'grant execute on all functions in schema public to service_role';
  end if;
end
$do$;

-- Views and tables are already covered by the grants above (PostgreSQL treats
-- views as tables for GRANT purposes).

-- -----------------------------------------------------------------------------
-- 9. Indexes (business_id first, then the column the app filters on)
-- -----------------------------------------------------------------------------
create index if not exists idx_business_members_business on public.business_members (business_id);
create index if not exists idx_business_members_user on public.business_members (user_id);
create index if not exists idx_business_invites_business on public.business_invites (business_id, status);
create index if not exists idx_devices_business_user on public.devices (business_id, user_id);
create index if not exists idx_audit_business_time on public.audit_logs (business_id, created_at desc);

create index if not exists idx_locations_business on public.locations (business_id, is_active);
create index if not exists idx_product_categories_business on public.product_categories (business_id);
create index if not exists idx_products_business_active on public.products (business_id, is_active);
create index if not exists idx_products_business_name on public.products (business_id, name);
create index if not exists idx_unit_conversions_business on public.unit_conversions (business_id, from_unit, to_unit);
create index if not exists idx_customers_business on public.customers (business_id, is_active);
create index if not exists idx_suppliers_business on public.suppliers (business_id, is_active);
create index if not exists idx_lots_item on public.stock_lots (business_id, item_id);
create index if not exists idx_stock_lots_item_lot on public.stock_lots (business_id, item_id, lot_no);
create index if not exists idx_stock_item on public.stock_movements (business_id, item_id, occurred_at);
create index if not exists idx_stock_source on public.stock_movements (business_id, source_type, source_id);

create index if not exists idx_financial_accounts_business on public.financial_accounts (business_id, is_active);
create index if not exists idx_purchases_date on public.purchases (business_id, document_date);
create index if not exists idx_purchases_status on public.purchases (business_id, status);
create index if not exists idx_purchase_lines on public.purchase_lines (purchase_id);
create index if not exists idx_sales_date on public.sales (business_id, document_date);
create index if not exists idx_sales_status on public.sales (business_id, status);
create index if not exists idx_sales_customer on public.sales (business_id, customer_id);
create index if not exists idx_sale_lines on public.sale_lines (sale_id);
create index if not exists idx_payments_date on public.payments (business_id, document_date);
create index if not exists idx_payments_party on public.payments (business_id, kind, party_id);
create index if not exists idx_account_transfers_date on public.account_transfers (business_id, document_date);
create index if not exists idx_income_expenses_date on public.income_expenses (business_id, document_date);
create index if not exists idx_income_expenses_kind on public.income_expenses (business_id, kind);
create index if not exists idx_partner_capital_member on public.partner_capital (business_id, member_id);
create index if not exists idx_journal_date on public.journal_entries (business_id, document_date);
create index if not exists idx_journal_source on public.journal_entries (business_id, source_type, source_id);
create index if not exists idx_journal_lines_entry on public.journal_lines (entry_id);
create index if not exists idx_journal_lines_account on public.journal_lines (business_id, account);
create index if not exists idx_attachments_entity on public.attachments (business_id, entity_type, entity_id);

create index if not exists idx_farms_business on public.farms (business_id, is_active);
create index if not exists idx_farm_units on public.farm_units (farm_id);
create index if not exists idx_farm_units_business on public.farm_units (business_id);
create index if not exists idx_cycles_business_status on public.production_cycles (business_id, status);
create index if not exists idx_cycles_farm on public.production_cycles (business_id, farm_id);
create index if not exists idx_farming_events on public.farming_events (business_id, cycle_id, occurred_on);
create index if not exists idx_input_consumptions on public.input_consumptions (business_id, cycle_id);
create index if not exists idx_production_outputs on public.production_outputs (business_id, cycle_id, occurred_on);
create index if not exists idx_harvests_cycle on public.harvests (business_id, cycle_id, occurred_on);
create index if not exists idx_mortality_losses on public.mortality_losses (business_id, cycle_id);
create index if not exists idx_cost_sources on public.cost_sources (business_id, cycle_id);
create index if not exists idx_cost_allocations_source on public.cost_allocations (cost_source_id);
create index if not exists idx_cost_allocations_cycle on public.cost_allocations (business_id, cycle_id);
create index if not exists idx_output_lots_cycle on public.output_lots (business_id, cycle_id);
create index if not exists idx_observations on public.observations (business_id, cycle_id, observed_on);

create index if not exists idx_sync_events_business_status on public.sync_events (business_id, status);
create index if not exists idx_processed_business on public.processed_events (business_id, processed_at);
create index if not exists idx_conflicts_business_status on public.sync_conflicts (business_id, status);
create index if not exists idx_ai_conversations on public.ai_conversations (business_id, user_id);
create index if not exists idx_ai_messages on public.ai_messages (conversation_id, created_at);
create index if not exists idx_ai_plans on public.ai_saved_plans (business_id, user_id);
create index if not exists idx_ai_feedback on public.ai_feedback (business_id, message_id);
create index if not exists idx_ai_research_cache on public.ai_research_cache (business_id, expires_at);
create index if not exists idx_ai_usage on public.ai_usage (business_id, created_at);

create index if not exists idx_role_permissions_permission on public.role_permissions (permission);
create index if not exists idx_units_dimension on public.units (dimension);
create index if not exists idx_accounts_type on public.accounts (type);
