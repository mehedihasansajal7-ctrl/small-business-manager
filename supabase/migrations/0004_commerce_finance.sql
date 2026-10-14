-- =============================================================================
-- 0004_commerce_finance.sql
-- Ports SQLite `financial_accounts`, `purchases`, `purchase_lines`, `sales`,
-- `sale_lines`, `payments`, `account_transfers`, `income_expenses`,
-- `partner_capital`, `journal_entries`, `journal_lines` (db.ts v3) and
-- `attachments` (db.ts v5). Adds `accounts`, the global chart of accounts
-- seeded from packages/domain/src/accounting.ts (STANDARD_ACCOUNTS).
--
-- Exactness: every money column is numeric(20,6). Postgres numeric is exact
-- decimal arithmetic, so the double-entry totals used by the domain layer
-- (addMoney/subMoney) survive the round trip unchanged.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- accounts — the global chart of accounts (not tenant-owned). Contrarian
-- accounts carry `is_contra = true`; `is_cash` marks the cash/bank/MFS
-- accounts used by the cash-flow report.
-- -----------------------------------------------------------------------------
create table if not exists public.accounts (
  code      text primary key,
  name      text not null,
  type      text not null,
  normal    text not null,
  is_contra boolean not null default false,
  is_cash   boolean not null default false,
  constraint accounts_type_check check (type in ('ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE')),
  constraint accounts_normal_check check (normal in ('DEBIT', 'CREDIT'))
);

insert into public.accounts (code, name, type, normal, is_contra, is_cash) values
  ('1000', 'Cash in Hand',                  'ASSET',     'DEBIT',  false, true),
  ('1010', 'Bank Account',                  'ASSET',     'DEBIT',  false, true),
  ('1020', 'Mobile Financial Service',      'ASSET',     'DEBIT',  false, true),
  ('1100', 'Accounts Receivable',           'ASSET',     'DEBIT',  false, false),
  ('1200', 'Inventory - Inputs & Goods',    'ASSET',     'DEBIT',  false, false),
  ('1210', 'Inventory - Finished Output',   'ASSET',     'DEBIT',  false, false),
  ('1220', 'Livestock / Biological Assets', 'ASSET',     'DEBIT',  false, false),
  ('1300', 'Work in Progress - Batches',    'ASSET',     'DEBIT',  false, false),
  ('1400', 'Input Tax Receivable',          'ASSET',     'DEBIT',  false, false),
  ('1500', 'Fixed Assets',                  'ASSET',     'DEBIT',  false, false),
  ('1600', 'Accumulated Depreciation',      'ASSET',     'CREDIT', true,  false),
  ('2000', 'Accounts Payable',              'LIABILITY', 'CREDIT', false, false),
  ('2100', 'Loans Payable',                 'LIABILITY', 'CREDIT', false, false),
  ('2200', 'Tax Payable',                   'LIABILITY', 'CREDIT', false, false),
  ('2300', 'Accrued Expenses',              'LIABILITY', 'CREDIT', false, false),
  ('3000', 'Owner Capital',                 'EQUITY',    'CREDIT', false, false),
  ('3100', 'Partner Contributions',         'EQUITY',    'CREDIT', false, false),
  ('3200', 'Retained Earnings',             'EQUITY',    'CREDIT', false, false),
  ('3300', 'Partner Drawings',              'EQUITY',    'DEBIT',  true,  false),
  ('4000', 'Sales Revenue',                 'REVENUE',   'CREDIT', false, false),
  ('4100', 'Other Income',                  'REVENUE',   'CREDIT', false, false),
  ('4900', 'Sales Discounts',               'REVENUE',   'DEBIT',  true,  false),
  ('4910', 'Sales Returns',                 'REVENUE',   'DEBIT',  true,  false),
  ('5000', 'Cost of Goods Sold',            'EXPENSE',   'DEBIT',  false, false),
  ('5100', 'Operating Expenses',            'EXPENSE',   'DEBIT',  false, false),
  ('5110', 'Labour & Wages',                'EXPENSE',   'DEBIT',  false, false),
  ('5120', 'Utilities',                     'EXPENSE',   'DEBIT',  false, false),
  ('5130', 'Transport',                     'EXPENSE',   'DEBIT',  false, false),
  ('5140', 'Fuel & Machinery',              'EXPENSE',   'DEBIT',  false, false),
  ('5150', 'Veterinary & Medicine',         'EXPENSE',   'DEBIT',  false, false),
  ('5160', 'Repairs & Maintenance',         'EXPENSE',   'DEBIT',  false, false),
  ('5170', 'Rent',                          'EXPENSE',   'DEBIT',  false, false),
  ('5180', 'Packaging',                     'EXPENSE',   'DEBIT',  false, false),
  ('5300', 'Inventory Shrinkage & Adjust',  'EXPENSE',   'DEBIT',  false, false),
  ('5400', 'Mortality & Production Loss',   'EXPENSE',   'DEBIT',  false, false),
  ('5500', 'Bad Debt',                      'EXPENSE',   'DEBIT',  false, false),
  ('5600', 'Depreciation',                  'EXPENSE',   'DEBIT',  false, false),
  ('5700', 'Interest Expense',              'EXPENSE',   'DEBIT',  false, false)
on conflict (code) do nothing;

-- -----------------------------------------------------------------------------
-- financial_accounts — the business's own cash/bank/MFS accounts (db.ts
-- `financial_accounts`). `account_code` maps onto the chart above.
-- -----------------------------------------------------------------------------
create table if not exists public.financial_accounts (
  id              uuid primary key default gen_random_uuid(),
  business_id     uuid not null references public.businesses(id) on delete cascade,
  code            text not null,
  name            text not null,
  name_bn         text,
  kind            text not null default 'CASH',
  account_code    text not null default '1000' references public.accounts(code) on delete restrict,
  identifier      text,
  opening_balance numeric(20, 6) not null default 0,
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  constraint financial_accounts_business_code_unique unique (business_id, code),
  constraint financial_accounts_kind_check check (kind in ('CASH', 'BANK', 'MFS'))
);

-- -----------------------------------------------------------------------------
-- purchases + purchase_lines
-- -----------------------------------------------------------------------------
create table if not exists public.purchases (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null references public.businesses(id) on delete cascade,
  reference     text not null,
  supplier_id   uuid references public.suppliers(id) on delete set null,
  document_date date not null,
  currency      text not null,
  subtotal      numeric(20, 6) not null,
  discount      numeric(20, 6) not null default 0,
  tax           numeric(20, 6) not null default 0,
  total         numeric(20, 6) not null,
  paid          numeric(20, 6) not null default 0,
  payable       numeric(20, 6) not null default 0,
  status        text not null default 'POSTED',
  note          text,
  revision      integer not null default 1,
  created_by    uuid not null references public.profiles(id) on delete restrict,
  device_id     uuid references public.devices(id) on delete set null,
  event_id      text not null,
  voided_at     timestamptz,
  voided_reason text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint purchases_business_reference_unique unique (business_id, reference),
  constraint purchases_event_id_unique unique (event_id),
  constraint purchases_currency_shape check (char_length(currency) between 3 and 8),
  constraint purchases_status_check check (status in ('DRAFT', 'POSTED', 'PARTIALLY_RETURNED', 'RETURNED', 'VOID')),
  constraint purchases_revision_check check (revision >= 1),
  constraint purchases_amounts_non_negative check (subtotal >= 0 and discount >= 0 and tax >= 0 and paid >= 0),
  -- Exact arithmetic: total = subtotal + tax - discount; payable = total - paid.
  constraint purchases_total_arithmetic check (total = subtotal + tax - discount),
  constraint purchases_payable_arithmetic check (payable = total - paid),
  constraint purchases_void_fields check ((status = 'VOID') = (voided_at is not null))
);

create table if not exists public.purchase_lines (
  id           uuid primary key default gen_random_uuid(),
  business_id  uuid not null references public.businesses(id) on delete cascade,
  purchase_id  uuid not null references public.purchases(id) on delete cascade,
  product_id   uuid references public.products(id) on delete set null,
  description  text,
  quantity     numeric(20, 6) not null,
  unit         text not null references public.units(code) on delete restrict,
  unit_cost    numeric(20, 6) not null,
  discount     numeric(20, 6) not null default 0,
  tax          numeric(20, 6) not null default 0,
  line_total   numeric(20, 6) not null,
  location_id  uuid references public.locations(id) on delete set null,
  lot_no       text,
  expiry_date  date,
  constraint purchase_lines_quantity_positive check (quantity > 0),
  constraint purchase_lines_unit_cost_non_negative check (unit_cost >= 0),
  constraint purchase_lines_discount_non_negative check (discount >= 0),
  constraint purchase_lines_tax_non_negative check (tax >= 0),
  constraint purchase_lines_total_arithmetic check (line_total = round(quantity * unit_cost - discount, 6))
);

-- -----------------------------------------------------------------------------
-- sales + sale_lines
-- -----------------------------------------------------------------------------
create table if not exists public.sales (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null references public.businesses(id) on delete cascade,
  reference     text not null,
  customer_id   uuid references public.customers(id) on delete set null,
  document_date date not null,
  currency      text not null,
  gross         numeric(20, 6) not null,
  discount      numeric(20, 6) not null default 0,
  tax           numeric(20, 6) not null default 0,
  net           numeric(20, 6) not null,
  cash_received numeric(20, 6) not null default 0,
  receivable    numeric(20, 6) not null default 0,
  cogs          numeric(20, 6) not null default 0,
  status        text not null default 'POSTED',
  note          text,
  revision      integer not null default 1,
  created_by    uuid not null references public.profiles(id) on delete restrict,
  device_id     uuid references public.devices(id) on delete set null,
  event_id      text not null,
  voided_at     timestamptz,
  voided_reason text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint sales_business_reference_unique unique (business_id, reference),
  constraint sales_event_id_unique unique (event_id),
  constraint sales_currency_shape check (char_length(currency) between 3 and 8),
  constraint sales_status_check check (status in ('DRAFT', 'POSTED', 'PARTIALLY_RETURNED', 'RETURNED', 'VOID')),
  constraint sales_revision_check check (revision >= 1),
  constraint sales_amounts_non_negative check (gross >= 0 and discount >= 0 and tax >= 0 and cash_received >= 0 and cogs >= 0),
  -- Exact arithmetic: net = gross + tax - discount; receivable = net - cash_received.
  constraint sales_net_arithmetic check (net = gross + tax - discount),
  constraint sales_receivable_arithmetic check (receivable = net - cash_received),
  constraint sales_void_fields check ((status = 'VOID') = (voided_at is not null))
);

create table if not exists public.sale_lines (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  sale_id     uuid not null references public.sales(id) on delete cascade,
  product_id  uuid references public.products(id) on delete set null,
  description text,
  quantity    numeric(20, 6) not null,
  unit        text not null references public.units(code) on delete restrict,
  unit_price  numeric(20, 6) not null,
  discount    numeric(20, 6) not null default 0,
  tax         numeric(20, 6) not null default 0,
  line_total  numeric(20, 6) not null,
  unit_cost   numeric(20, 6) not null default 0,
  location_id uuid references public.locations(id) on delete set null,
  lot_id      uuid references public.stock_lots(id) on delete set null,
  constraint sale_lines_quantity_positive check (quantity > 0),
  constraint sale_lines_unit_price_non_negative check (unit_price >= 0),
  constraint sale_lines_unit_cost_non_negative check (unit_cost >= 0),
  constraint sale_lines_discount_non_negative check (discount >= 0),
  constraint sale_lines_tax_non_negative check (tax >= 0),
  constraint sale_lines_total_arithmetic check (line_total = round(quantity * unit_price - discount, 6))
);

-- -----------------------------------------------------------------------------
-- payments — customer receipts and supplier payments (immutable once posted).
-- -----------------------------------------------------------------------------
create table if not exists public.payments (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null references public.businesses(id) on delete cascade,
  kind          text not null,
  party_type    text not null,
  party_id      uuid,
  document_date date not null,
  currency      text not null,
  amount        numeric(20, 6) not null,
  account_code  text not null default '1000' references public.accounts(code) on delete restrict,
  reference     text not null,
  note          text,
  created_by    uuid not null references public.profiles(id) on delete restrict,
  device_id     uuid references public.devices(id) on delete set null,
  event_id      text not null,
  created_at    timestamptz not null default now(),
  constraint payments_event_id_unique unique (event_id),
  constraint payments_kind_check check (kind in (
    'CUSTOMER_RECEIPT', 'SUPPLIER_PAYMENT', 'EXPENSE_PAYMENT', 'INCOME_RECEIPT',
    'PARTNER_CONTRIBUTION', 'PARTNER_WITHDRAWAL', 'OTHER'
  )),
  constraint payments_party_type_check check (party_type in ('CUSTOMER', 'SUPPLIER', 'MEMBER', 'OTHER')),
  constraint payments_amount_positive check (amount > 0),
  constraint payments_currency_shape check (char_length(currency) between 3 and 8)
);

-- -----------------------------------------------------------------------------
-- account_transfers — money moved between the business's own accounts.
-- -----------------------------------------------------------------------------
create table if not exists public.account_transfers (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null references public.businesses(id) on delete cascade,
  document_date date not null,
  currency      text not null,
  amount        numeric(20, 6) not null,
  from_account  text not null references public.accounts(code) on delete restrict,
  to_account    text not null references public.accounts(code) on delete restrict,
  reference     text not null,
  note          text,
  created_by    uuid not null references public.profiles(id) on delete restrict,
  event_id      text not null,
  created_at    timestamptz not null default now(),
  constraint account_transfers_event_id_unique unique (event_id),
  constraint account_transfers_amount_positive check (amount > 0),
  constraint account_transfers_currency_shape check (char_length(currency) between 3 and 8),
  constraint account_transfers_distinct_accounts check (from_account <> to_account)
);

-- -----------------------------------------------------------------------------
-- income_expenses
-- -----------------------------------------------------------------------------
create table if not exists public.income_expenses (
  id               uuid primary key default gen_random_uuid(),
  business_id      uuid not null references public.businesses(id) on delete cascade,
  kind             text not null,
  category_account text not null references public.accounts(code) on delete restrict,
  document_date    date not null,
  currency         text not null,
  amount           numeric(20, 6) not null,
  account_code     text not null default '1000' references public.accounts(code) on delete restrict,
  paid             boolean not null default true,
  reference        text not null,
  note             text,
  created_by       uuid not null references public.profiles(id) on delete restrict,
  event_id         text not null,
  created_at       timestamptz not null default now(),
  constraint income_expenses_event_id_unique unique (event_id),
  constraint income_expenses_kind_check check (kind in ('INCOME', 'EXPENSE')),
  constraint income_expenses_amount_positive check (amount > 0),
  constraint income_expenses_currency_shape check (char_length(currency) between 3 and 8)
);

-- -----------------------------------------------------------------------------
-- partner_capital — contributions and drawings (equity, never revenue).
-- -----------------------------------------------------------------------------
create table if not exists public.partner_capital (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null references public.businesses(id) on delete cascade,
  member_id     uuid not null references public.business_members(id) on delete cascade,
  kind          text not null,
  document_date date not null,
  currency      text not null,
  amount        numeric(20, 6) not null,
  account_code  text not null default '1000' references public.accounts(code) on delete restrict,
  reference     text not null,
  note          text,
  created_by    uuid not null references public.profiles(id) on delete restrict,
  event_id      text not null,
  created_at    timestamptz not null default now(),
  constraint partner_capital_event_id_unique unique (event_id),
  constraint partner_capital_kind_check check (kind in ('CONTRIBUTION', 'WITHDRAWAL')),
  constraint partner_capital_amount_positive check (amount > 0),
  constraint partner_capital_currency_shape check (char_length(currency) between 3 and 8)
);

-- -----------------------------------------------------------------------------
-- journal_entries + journal_lines — the double-entry ledger.
--
-- Append-only: no UPDATE/DELETE policy exists in 0007. A wrong entry is
-- corrected by posting a reversal (`reversal_of`) — never by editing history.
-- The deferrable constraint trigger in 0007 refuses any entry whose lines do
-- not balance at commit.
-- -----------------------------------------------------------------------------
create table if not exists public.journal_entries (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null references public.businesses(id) on delete cascade,
  document_date date not null,
  reference     text not null,
  description   text not null,
  source_type   text not null,
  source_id     text not null,
  currency      text not null,
  posted_by     uuid not null references public.profiles(id) on delete restrict,
  device_id     uuid references public.devices(id) on delete set null,
  event_id      text not null,
  reversal_of   uuid references public.journal_entries(id) on delete restrict,
  created_at    timestamptz not null default now(),
  constraint journal_entries_event_id_unique unique (event_id),
  constraint journal_entries_currency_shape check (char_length(currency) between 3 and 8),
  constraint journal_entries_source_type_check check (source_type in (
    'SALE', 'PURCHASE', 'RECEIPT', 'PAYMENT', 'TRANSFER', 'INCOME_EXPENSE',
    'PARTNER_CONTRIBUTION', 'PARTNER_WITHDRAWAL', 'MORTALITY_LOSS', 'INVENTORY_ADJUSTMENT',
    'HARVEST', 'INPUT_ISSUE', 'DIRECT_BATCH_COST', 'REVERSAL',
    'OPENING_BALANCE', 'CYCLE_CLOSE', 'OTHER'
  )),
  constraint journal_entries_reversal_not_self check (reversal_of is null or reversal_of <> id)
);

create table if not exists public.journal_lines (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  entry_id    uuid not null references public.journal_entries(id) on delete cascade,
  account     text not null references public.accounts(code) on delete restrict,
  debit       numeric(20, 6) not null default 0,
  credit      numeric(20, 6) not null default 0,
  currency    text not null,
  memo        text,
  partner_id  uuid references public.business_members(id) on delete set null,
  cost_center text,
  constraint journal_lines_debit_non_negative check (debit >= 0),
  constraint journal_lines_credit_non_negative check (credit >= 0),
  -- Exactly one of debit/credit is positive: no both-zero "empty" line and no
  -- line that is positive on both sides.
  constraint journal_lines_one_side_positive check ((debit > 0) <> (credit > 0)),
  constraint journal_lines_currency_shape check (char_length(currency) between 3 and 8)
);

-- -----------------------------------------------------------------------------
-- attachments — metadata for files kept in Supabase Storage (or any object
-- store). The bytes are never stored in the database.
-- -----------------------------------------------------------------------------
create table if not exists public.attachments (
  id           uuid primary key default gen_random_uuid(),
  business_id  uuid not null references public.businesses(id) on delete cascade,
  entity_type  text not null,
  entity_id    text not null,
  file_name    text not null,
  mime         text not null,
  size_bytes   bigint not null,
  stored_path  text not null,
  checksum     text not null,
  created_by   uuid not null references public.profiles(id) on delete restrict,
  created_at   timestamptz not null default now(),
  constraint attachments_size_bytes_check check (size_bytes >= 0 and size_bytes <= 52428800),
  constraint attachments_mime_not_blank check (mime <> ''),
  -- No path traversal in an object-store key.
  constraint attachments_path_safe check (stored_path not like '%..%' and stored_path not like '/%'),
  constraint attachments_checksum_not_blank check (checksum <> '')
);
