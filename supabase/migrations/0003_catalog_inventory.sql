-- =============================================================================
-- 0003_catalog_inventory.sql
-- Ports SQLite `locations`, `product_categories`, `products`,
-- `explicit_conversions`, `customers`, `suppliers`, `stock_lots`,
-- `stock_movements` (db.ts v2). Adds `units` (the static unit catalogue from
-- packages/domain/src/units.ts) and renames `explicit_conversions` to
-- `unit_conversions` (same columns, tenant-owned).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- units — the global unit catalogue (not tenant-owned). `factor` is the exact
-- multiplicative factor to the dimension's base unit (kg, litre, piece, sqm,
-- metre, hour). Values are numeric, never floating point.
-- -----------------------------------------------------------------------------
create table if not exists public.units (
  code         text primary key,
  name         text not null,
  name_bn      text,
  dimension    text not null,
  factor       numeric(30, 12) not null,
  integer_only boolean not null default false,
  created_at   timestamptz not null default now(),
  constraint units_dimension_check check (dimension in ('MASS', 'VOLUME', 'COUNT', 'AREA', 'LENGTH', 'TIME')),
  constraint units_factor_positive check (factor > 0)
);

insert into public.units (code, name, dimension, factor, integer_only) values
  ('mg', 'milligram', 'MASS', 0.000001, false),
  ('g', 'gram', 'MASS', 0.001, false),
  ('kg', 'kilogram', 'MASS', 1, false),
  ('quintal', 'quintal (100 kg)', 'MASS', 100, false),
  ('ton', 'metric ton', 'MASS', 1000, false),
  ('maund', 'maund (40 seer, BD standard)', 'MASS', 37.324200, false),
  ('seer', 'seer (BD standard)', 'MASS', 0.933105, false),
  ('ml', 'millilitre', 'VOLUME', 0.001, false),
  ('l', 'litre', 'VOLUME', 1, false),
  ('gallon_us', 'US gallon', 'VOLUME', 3.785411784, false),
  ('pcs', 'piece', 'COUNT', 1, true),
  ('pair', 'pair', 'COUNT', 2, true),
  ('dozen', 'dozen', 'COUNT', 12, true),
  ('hundred', 'hundred', 'COUNT', 100, true),
  ('thousand', 'thousand', 'COUNT', 1000, true),
  ('sqm', 'square metre', 'AREA', 1, false),
  ('sqft', 'square foot', 'AREA', 0.09290304, false),
  ('decimal', 'decimal / shotangsho (BD)', 'AREA', 40.468564224, false),
  ('katha', 'katha (BD standard, 720 sqft)', 'AREA', 66.8901888, false),
  ('bigha', 'bigha (BD standard, 20 katha)', 'AREA', 1337.803776, false),
  ('acre', 'acre', 'AREA', 4046.8564224, false),
  ('hectare', 'hectare', 'AREA', 10000, false),
  ('mm', 'millimetre', 'LENGTH', 0.001, false),
  ('cm', 'centimetre', 'LENGTH', 0.01, false),
  ('m', 'metre', 'LENGTH', 1, false),
  ('km', 'kilometre', 'LENGTH', 1000, false),
  ('inch', 'inch', 'LENGTH', 0.0254, false),
  ('ft', 'foot', 'LENGTH', 0.3048, false),
  ('minute', 'minute', 'TIME', 0.0166666666666667, false),
  ('hour', 'hour', 'TIME', 1, false),
  ('day', 'day', 'TIME', 24, false),
  ('month', 'month (30 day basis)', 'TIME', 720, false)
on conflict (code) do nothing;

-- -----------------------------------------------------------------------------
-- locations — stock locations. At most one default per business.
-- -----------------------------------------------------------------------------
create table if not exists public.locations (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  name        text not null,
  kind        text not null default 'STORE',
  address     text,
  is_default  boolean not null default false,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  constraint locations_kind_check check (kind in ('STORE', 'WAREHOUSE', 'SHOP', 'FARM', 'FIELD', 'POND', 'OTHER'))
);

create unique index if not exists locations_one_default_per_business
  on public.locations (business_id) where is_default;

-- -----------------------------------------------------------------------------
-- product_categories — flat or nested product categories.
-- -----------------------------------------------------------------------------
create table if not exists public.product_categories (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  name        text not null,
  parent_id   uuid references public.product_categories(id) on delete set null,
  created_at  timestamptz not null default now(),
  constraint product_categories_parent_not_self check (parent_id is null or parent_id <> id)
);

-- -----------------------------------------------------------------------------
-- products — items, services, farm inputs/outputs and livestock (db.ts `products`).
-- Every money/quantity column is numeric(20,6) (currency minor-unit precision
-- with headroom for rate math), never float/real/double precision.
-- -----------------------------------------------------------------------------
create table if not exists public.products (
  id             uuid primary key default gen_random_uuid(),
  business_id    uuid not null references public.businesses(id) on delete cascade,
  sku            text,
  name           text not null,
  name_bn        text,
  category_id    uuid references public.product_categories(id) on delete set null,
  kind           text not null default 'PRODUCT',
  unit           text not null references public.units(code) on delete restrict,
  sale_price     numeric(20, 6),
  purchase_price numeric(20, 6),
  tax_rate       numeric(9, 6),
  reorder_level  numeric(20, 6),
  track_lots     boolean not null default false,
  is_active      boolean not null default true,
  revision       integer not null default 1,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  deleted_at     timestamptz,
  constraint products_business_sku_unique unique (business_id, sku),
  constraint products_kind_check check (kind in ('PRODUCT', 'SERVICE', 'INPUT', 'OUTPUT', 'LIVESTOCK')),
  constraint products_revision_check check (revision >= 1),
  constraint products_sale_price_non_negative check (sale_price is null or sale_price >= 0),
  constraint products_purchase_price_non_negative check (purchase_price is null or purchase_price >= 0),
  constraint products_tax_rate_non_negative check (tax_rate is null or tax_rate >= 0),
  constraint products_reorder_level_non_negative check (reorder_level is null or reorder_level >= 0)
);

-- -----------------------------------------------------------------------------
-- unit_conversions — business-approved explicit conversions (db.ts
-- `explicit_conversions`): e.g. "1 bag = 50 kg" for one item or all items.
-- -----------------------------------------------------------------------------
create table if not exists public.unit_conversions (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  from_unit   text not null references public.units(code) on delete restrict,
  to_unit     text not null references public.units(code) on delete restrict,
  factor      numeric(30, 12) not null,
  note        text not null,
  item_id     uuid references public.products(id) on delete cascade,
  approved_by uuid not null references public.profiles(id) on delete restrict,
  created_at  timestamptz not null default now(),
  constraint unit_conversions_factor_positive check (factor > 0),
  constraint unit_conversions_distinct_units check (from_unit <> to_unit)
);

-- -----------------------------------------------------------------------------
-- customers
-- -----------------------------------------------------------------------------
create table if not exists public.customers (
  id              uuid primary key default gen_random_uuid(),
  business_id     uuid not null references public.businesses(id) on delete cascade,
  name            text not null,
  phone           text,
  email           text,
  address         text,
  opening_balance numeric(20, 6) not null default 0,
  credit_limit    numeric(20, 6),
  is_active       boolean not null default true,
  revision        integer not null default 1,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint customers_credit_limit_non_negative check (credit_limit is null or credit_limit >= 0),
  constraint customers_revision_check check (revision >= 1)
);

-- -----------------------------------------------------------------------------
-- suppliers
-- -----------------------------------------------------------------------------
create table if not exists public.suppliers (
  id              uuid primary key default gen_random_uuid(),
  business_id     uuid not null references public.businesses(id) on delete cascade,
  name            text not null,
  phone           text,
  email           text,
  address         text,
  opening_balance numeric(20, 6) not null default 0,
  is_active       boolean not null default true,
  revision        integer not null default 1,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint suppliers_revision_check check (revision >= 1)
);

-- -----------------------------------------------------------------------------
-- stock_lots — a received lot with its own cost (FIFO/FEFO planning).
-- -----------------------------------------------------------------------------
create table if not exists public.stock_lots (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  item_id     uuid not null references public.products(id) on delete cascade,
  location_id uuid not null references public.locations(id) on delete cascade,
  lot_no      text,
  unit_cost   numeric(20, 6) not null,
  currency    text not null,
  received_at timestamptz not null default now(),
  expiry_date date,
  created_at  timestamptz not null default now(),
  constraint stock_lots_unit_cost_non_negative check (unit_cost >= 0),
  constraint stock_lots_currency_shape check (char_length(currency) between 3 and 8)
  -- No unique on lot_no: the same lot name may legitimately arrive twice.
  -- Lookup is served by idx_stock_lots_item_lot (0007).
);

-- -----------------------------------------------------------------------------
-- stock_movements — the append-only stock ledger (single source of truth for
-- on-hand quantity and weighted-average cost).
--
--   * quantity is strictly positive; `direction` (IN/OUT) carries the sign.
--   * idempotency_key is UNIQUE  -> a retried offline event can never post twice.
--   * event_id is UNIQUE         -> the originating outbox event, once.
--   * UPDATE/DELETE have no policy in 0007: a mistake is corrected by posting a
--     REVERSAL movement (`reversal_of`), never by editing or deleting history.
-- -----------------------------------------------------------------------------
create table if not exists public.stock_movements (
  id              uuid primary key default gen_random_uuid(),
  business_id     uuid not null references public.businesses(id) on delete cascade,
  item_id         uuid not null references public.products(id) on delete cascade,
  location_id     uuid not null references public.locations(id) on delete cascade,
  direction       text not null,
  quantity        numeric(20, 6) not null,
  unit            text not null references public.units(code) on delete restrict,
  unit_cost       numeric(20, 6) not null,
  currency        text not null,
  lot_id          uuid references public.stock_lots(id) on delete set null,
  expiry_date     date,
  source_type     text not null,
  source_id       text not null,
  actor_id        uuid not null references public.profiles(id) on delete restrict,
  device_id       uuid references public.devices(id) on delete set null,
  event_id        text not null,
  idempotency_key text not null,
  reversal_of     uuid references public.stock_movements(id) on delete restrict,
  reason          text,
  occurred_at     timestamptz not null,
  created_at      timestamptz not null default now(),
  constraint stock_movements_direction_check check (direction in ('IN', 'OUT')),
  constraint stock_movements_quantity_positive check (quantity > 0),
  constraint stock_movements_unit_cost_non_negative check (unit_cost >= 0),
  constraint stock_movements_currency_shape check (char_length(currency) between 3 and 8),
  constraint stock_movements_source_type_check check (source_type in (
    'OPENING', 'PURCHASE', 'SALE', 'SALE_RETURN', 'PURCHASE_RETURN', 'TRANSFER_OUT', 'TRANSFER_IN',
    'ADJUSTMENT', 'COUNT_CORRECTION', 'INPUT_ISSUE', 'HARVEST', 'OUTPUT_SALE', 'MORTALITY_LOSS',
    'SPOILAGE', 'INTERNAL_USE', 'REVERSAL'
  )),
  constraint stock_movements_reversal_not_self check (reversal_of is null or reversal_of <> id),
  constraint stock_movements_event_id_unique unique (event_id),
  constraint stock_movements_idempotency_key_unique unique (idempotency_key)
);
