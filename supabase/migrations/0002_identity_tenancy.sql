-- =============================================================================
-- 0002_identity_tenancy.sql
-- Ports SQLite `users` + `businesses` + `members` + `invites` + `devices` +
-- `audit_logs` (db.ts v1) and adds `role_permissions` (the role -> permission
-- map, seeded from packages/domain/src/permissions.ts) plus `business_settings`
-- and `number_sequences` (db.ts v6).
--
-- Identity split: authentication lives in Supabase `auth.users`; the applicaton
-- profile lives in `public.profiles` with the *same* uuid primary key.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- profiles — application profile for an authenticated user (SQLite `users`).
-- -----------------------------------------------------------------------------
create table if not exists public.profiles (
  id            uuid primary key default gen_random_uuid(),
  email         text not null,
  display_name  text not null,
  locale        text not null default 'bn-BD',
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  last_login_at timestamptz,
  constraint profiles_email_unique unique (email),
  constraint profiles_email_lowercase check (email = lower(email)),
  constraint profiles_email_shape check (position('@' in email) > 1)
);

-- On Supabase, tie the profile to the auth user. Guarded so the same migration
-- also applies to a plain PostgreSQL database (no `auth` schema).
do $do$
begin
  if exists (select 1 from information_schema.tables where table_schema = 'auth' and table_name = 'users') then
    if not exists (select 1 from pg_constraint where conname = 'profiles_id_fkey') then
      execute 'alter table public.profiles add constraint profiles_id_fkey foreign key (id) references auth.users(id) on delete cascade';
    end if;
  end if;
end
$do$;

-- -----------------------------------------------------------------------------
-- businesses — the tenant root.
-- -----------------------------------------------------------------------------
create table if not exists public.businesses (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  slug            text not null,
  currency        text not null default 'BDT',
  timezone        text not null default 'Asia/Dhaka',
  locale          text not null default 'bn-BD',
  country         text not null default 'BD',
  farming_types   jsonb not null default '[]'::jsonb,
  enabled_modules jsonb not null default '[]'::jsonb,
  settings        jsonb not null default '{}'::jsonb,
  plan            text not null default 'free',
  revision        integer not null default 1,
  created_at      timestamptz not null default now(),
  created_by      uuid not null references public.profiles(id) on delete restrict,
  constraint businesses_slug_unique unique (slug),
  constraint businesses_currency_shape check (char_length(currency) between 3 and 8),
  constraint businesses_plan_check check (plan in ('free', 'standard')),
  constraint businesses_revision_check check (revision >= 1),
  constraint businesses_farming_types_array check (jsonb_typeof(farming_types) = 'array'),
  constraint businesses_enabled_modules_array check (jsonb_typeof(enabled_modules) = 'array'),
  constraint businesses_settings_object check (jsonb_typeof(settings) = 'object')
);

-- -----------------------------------------------------------------------------
-- role_permissions — the role -> permission map. This table (not hard-coded
-- role names in policies) is what the RLS helper `has_business_permission`
-- reads, so adding a permission is a data change, not a policy rewrite.
-- Global (not tenant-owned); seeded at the bottom of this file.
-- -----------------------------------------------------------------------------
create table if not exists public.role_permissions (
  role       text not null,
  permission text not null,
  primary key (role, permission),
  constraint role_permissions_role_check check (role in
    ('owner', 'admin', 'manager', 'cashier', 'inventory_manager', 'farm_manager', 'viewer'))
);

-- -----------------------------------------------------------------------------
-- business_members — one row per (business, user) with a role (SQLite `members`).
-- -----------------------------------------------------------------------------
create table if not exists public.business_members (
  id             uuid primary key default gen_random_uuid(),
  business_id    uuid not null references public.businesses(id) on delete cascade,
  user_id        uuid not null references public.profiles(id) on delete cascade,
  email          text not null,
  display_name   text not null,
  role           text not null,
  status         text not null default 'active',
  grants         jsonb not null default '[]'::jsonb,
  denials        jsonb not null default '[]'::jsonb,
  joined_at      timestamptz not null default now(),
  invited_by     uuid references public.profiles(id) on delete set null,
  last_active_at timestamptz,
  constraint business_members_business_user_unique unique (business_id, user_id),
  constraint business_members_role_check check (role in
    ('owner', 'admin', 'manager', 'cashier', 'inventory_manager', 'farm_manager', 'viewer')),
  constraint business_members_status_check check (status in
    ('active', 'invited', 'suspended', 'removed')),
  constraint business_members_grants_array check (jsonb_typeof(grants) = 'array'),
  constraint business_members_denials_array check (jsonb_typeof(denials) = 'array'),
  constraint business_members_email_lowercase check (email = lower(email))
);

-- -----------------------------------------------------------------------------
-- business_invites — codes are NEVER stored. Only a SHA-256 hash of the
-- normalised code plus a short prefix for the owner to recognise it.
-- Redemption must go through public.redeem_invite() (0007) which validates
-- expiry, single-use and email scope atomically.
-- -----------------------------------------------------------------------------
create table if not exists public.business_invites (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  email       text,
  role        text not null,
  code_hash   text not null,
  code_prefix text not null,
  status      text not null default 'open',
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  created_by  uuid not null references public.profiles(id) on delete restrict,
  accepted_at timestamptz,
  accepted_by uuid references public.profiles(id) on delete set null,
  use_count   integer not null default 0,
  max_uses    integer not null default 1,
  constraint business_invites_code_hash_unique unique (code_hash),
  constraint business_invites_role_check check (role in
    ('admin', 'manager', 'cashier', 'inventory_manager', 'farm_manager', 'viewer')),
  constraint business_invites_never_owner check (role <> 'owner'),
  constraint business_invites_status_check check (status in
    ('open', 'accepted', 'expired', 'revoked')),
  constraint business_invites_uses_check check (use_count >= 0 and max_uses >= 1 and use_count <= max_uses),
  constraint business_invites_expiry_check check (expires_at > created_at),
  constraint business_invites_email_lowercase check (email is null or email = lower(email)),
  constraint business_invites_sha256_hex check (code_hash ~ '^[0-9a-f]{64}$')
);

-- -----------------------------------------------------------------------------
-- devices — a signed-in device/browser per (business, user).
-- `device_key` is the client-generated offline device id (mirrors the SQLite
-- `unique (business_id, user_id, id)`); it defaults to a random uuid for web
-- clients that do not keep one.
-- -----------------------------------------------------------------------------
create table if not exists public.devices (
  id           uuid primary key default gen_random_uuid(),
  business_id  uuid not null references public.businesses(id) on delete cascade,
  user_id      uuid not null references public.profiles(id) on delete cascade,
  name         text not null,
  platform     text not null default 'web',
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  device_key   text not null default gen_random_uuid()::text,
  constraint devices_scope_unique unique (business_id, user_id, device_key),
  constraint devices_platform_check check (platform in ('web', 'android', 'ios', 'desktop', 'server'))
);

-- -----------------------------------------------------------------------------
-- audit_logs — append-only. No update/delete policy is created in 0007, so
-- those operations are refused by row level security for everyone.
-- -----------------------------------------------------------------------------
create table if not exists public.audit_logs (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid references public.businesses(id) on delete cascade,
  actor_id    uuid references public.profiles(id) on delete set null,
  actor_email text,
  action      text not null,
  entity_type text not null,
  entity_id   text,
  detail      jsonb not null default '{}'::jsonb,
  device_id   uuid references public.devices(id) on delete set null,
  created_at  timestamptz not null default now(),
  constraint audit_logs_detail_object check (jsonb_typeof(detail) = 'object')
);

-- -----------------------------------------------------------------------------
-- business_settings — key/value settings (JSON), e.g. the partner visibility
-- switches partnerCanSeeFinancialReports / partnerCanSeeCosts /
-- partnerCanSeeCapital that 0007 echoes into the permission helper.
-- -----------------------------------------------------------------------------
create table if not exists public.business_settings (
  business_id uuid not null references public.businesses(id) on delete cascade,
  key         text not null,
  value       jsonb not null default 'null'::jsonb,
  updated_at  timestamptz not null default now(),
  primary key (business_id, key)
);

-- -----------------------------------------------------------------------------
-- number_sequences — atomic document numbering (SAL-20260501-0007, ...).
-- -----------------------------------------------------------------------------
create table if not exists public.number_sequences (
  business_id uuid not null references public.businesses(id) on delete cascade,
  kind        text not null,
  next_value  integer not null default 1,
  primary key (business_id, kind),
  constraint number_sequences_next_check check (next_value >= 1)
);

-- =============================================================================
-- Seed the role -> permission map (packages/domain/src/permissions.ts).
-- The owner may do everything; admin is everything except ownership transfer
-- and business deletion; the rest are least-privilege by design.
-- =============================================================================
with perms(role, permission) as (
  select 'owner', unnest(array[
    'business.view','business.settings','business.transfer_ownership','business.delete',
    'member.view','member.invite','member.manage','audit.view',
    'product.view','product.manage','inventory.view','inventory.manage','inventory.adjust',
    'inventory.adjust.approve','stock_count.create','stock_count.approve','location.manage',
    'customer.view','customer.manage','sale.view','sale.create','sale.discount.apply','sale.void','sale.return',
    'supplier.view','supplier.manage','purchase.view','purchase.manage','purchase.return','purchase.cost.view',
    'finance.view','finance.manage','finance.opening_balance','financial_reports.view',
    'partner_capital.view','partner_capital.manage','payroll.view','payroll.manage',
    'farming.view','farming.setup','farming.operations','farming.input_issue','farming.observation',
    'farming.harvest','farming.sale','farming.cost.view','farming.close_cycle',
    'report.view','report.export','attachment.manage','backup.manage','personal_data.view','ai.use'
  ])
  union all
  select 'admin', unnest(array[
    'business.view','business.settings',
    'member.view','member.invite','member.manage','audit.view',
    'product.view','product.manage','inventory.view','inventory.manage','inventory.adjust',
    'inventory.adjust.approve','stock_count.create','stock_count.approve','location.manage',
    'customer.view','customer.manage','sale.view','sale.create','sale.discount.apply','sale.void','sale.return',
    'supplier.view','supplier.manage','purchase.view','purchase.manage','purchase.return','purchase.cost.view',
    'finance.view','finance.manage','finance.opening_balance','financial_reports.view',
    'partner_capital.view','partner_capital.manage','payroll.view','payroll.manage',
    'farming.view','farming.setup','farming.operations','farming.input_issue','farming.observation',
    'farming.harvest','farming.sale','farming.cost.view','farming.close_cycle',
    'report.view','report.export','attachment.manage','backup.manage','personal_data.view','ai.use'
  ])
  union all
  select 'manager', unnest(array[
    'business.view','member.view','audit.view',
    'product.view','product.manage','inventory.view','inventory.manage','inventory.adjust',
    'stock_count.create','location.manage',
    'customer.view','customer.manage','sale.view','sale.create','sale.discount.apply','sale.return',
    'supplier.view','supplier.manage','purchase.view','purchase.manage','purchase.return','purchase.cost.view',
    'finance.view','finance.manage',
    'farming.view','farming.setup','farming.operations','farming.input_issue','farming.observation',
    'farming.harvest','farming.sale','farming.cost.view',
    'report.view','report.export','attachment.manage','ai.use'
  ])
  union all
  select 'cashier', unnest(array[
    'business.view','product.view','inventory.view',
    'customer.view','customer.manage','sale.view','sale.create','sale.return',
    'finance.view','finance.manage','report.view','attachment.manage','ai.use'
  ])
  union all
  select 'inventory_manager', unnest(array[
    'business.view','product.view','product.manage','inventory.view','inventory.manage',
    'inventory.adjust','stock_count.create','location.manage',
    'supplier.view','purchase.view','purchase.manage','purchase.return','purchase.cost.view',
    'farming.view','farming.input_issue','farming.observation',
    'report.view','report.export','attachment.manage','ai.use'
  ])
  union all
  select 'farm_manager', unnest(array[
    'business.view','product.view','inventory.view','inventory.manage','location.manage',
    'farming.view','farming.setup','farming.operations','farming.input_issue','farming.observation',
    'farming.harvest','farming.sale','farming.cost.view','farming.close_cycle',
    'sale.view','sale.create','report.view','attachment.manage','ai.use'
  ])
  union all
  select 'viewer', unnest(array[
    'business.view','product.view','inventory.view','customer.view','supplier.view',
    'sale.view','purchase.view','farming.view','report.view'
  ])
)
insert into public.role_permissions (role, permission)
select role, permission from perms
on conflict (role, permission) do nothing;

-- Indexes for the tenancy tables are created together in 0007.
