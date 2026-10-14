-- =============================================================================
-- 0005_farming.sql
-- Ports SQLite `farms`, `farm_units`, `production_cycles`, `farming_events`,
-- `cost_sources`, `cost_allocations`, `harvests`, `observations`,
-- `mortality_losses` (db.ts v4) and adds `input_consumptions`,
-- `production_outputs` and `output_lots` as first-class tables (in the SQLite
-- build these were implied by farming_events + stock_movements; the shared
-- database makes them explicit) plus the `cycle_cost_ledger` reporting view.
--
-- Cost model (packages/domain/src/farming.ts): a `cost_source` is a cost
-- incurred for one cycle (shared = false) or for several (shared = true).
-- A shared cost is split by `cost_allocations` rows whose amounts MUST sum
-- exactly to the source amount; the deferrable constraint trigger in 0007
-- enforces that at commit.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- farms
-- -----------------------------------------------------------------------------
create table if not exists public.farms (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  name        text not null,
  location_id uuid references public.locations(id) on delete set null,
  address     text,
  area        numeric(20, 6),
  area_unit   text references public.units(code) on delete restrict,
  latitude    numeric(9, 6),
  longitude   numeric(9, 6),
  notes       text,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint farms_area_positive check (area is null or area > 0),
  constraint farms_latitude_range check (latitude is null or (latitude >= -90 and latitude <= 90)),
  constraint farms_longitude_range check (longitude is null or (longitude >= -180 and longitude <= 180)),
  constraint farms_area_unit_pair check ((area is null) = (area_unit is null))
);

-- -----------------------------------------------------------------------------
-- farm_units — sheds, plots, ponds, pens, ... inside a farm.
-- -----------------------------------------------------------------------------
create table if not exists public.farm_units (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null references public.businesses(id) on delete cascade,
  farm_id       uuid not null references public.farms(id) on delete cascade,
  kind          text not null,
  name          text not null,
  area          numeric(20, 6),
  area_unit     text references public.units(code) on delete restrict,
  capacity      numeric(20, 6),
  capacity_unit text references public.units(code) on delete restrict,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  constraint farm_units_kind_check check (kind in
    ('PLOT', 'FIELD', 'GREENHOUSE', 'BARN', 'PEN', 'POULTRY_HOUSE', 'POND', 'TANK', 'OTHER')),
  constraint farm_units_area_positive check (area is null or area > 0),
  constraint farm_units_capacity_positive check (capacity is null or capacity > 0)
);

-- -----------------------------------------------------------------------------
-- production_cycles — one batch / crop season / livestock cycle.
-- -----------------------------------------------------------------------------
create table if not exists public.production_cycles (
  id                    uuid primary key default gen_random_uuid(),
  business_id           uuid not null references public.businesses(id) on delete cascade,
  farm_id               uuid not null references public.farms(id) on delete cascade,
  unit_id               uuid not null references public.farm_units(id) on delete cascade,
  reference             text not null,
  farming_type          text not null,
  title                 text not null,
  crop_or_species       text,
  variety_or_breed      text,
  season                text,
  responsible_member_id uuid references public.business_members(id) on delete set null,
  start_date            date not null,
  expected_end_date     date,
  actual_end_date       date,
  planned_output        numeric(20, 6),
  planned_output_unit   text references public.units(code) on delete restrict,
  status                text not null default 'PLANNED',
  starting_population   numeric(20, 6),
  notes                 text,
  revision              integer not null default 1,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint production_cycles_business_reference_unique unique (business_id, reference),
  constraint production_cycles_farming_type_check check (farming_type in
    ('CROP', 'HORTICULTURE', 'LIVESTOCK', 'POULTRY', 'AQUACULTURE')),
  constraint production_cycles_status_check check (status in
    ('PLANNED', 'ACTIVE', 'HARVESTING', 'CLOSED', 'CANCELLED')),
  constraint production_cycles_revision_check check (revision >= 1),
  constraint production_cycles_dates_check check (expected_end_date is null or expected_end_date >= start_date),
  constraint production_cycles_actual_dates_check check (actual_end_date is null or actual_end_date >= start_date),
  constraint production_cycles_planned_output_positive check (planned_output is null or planned_output > 0),
  constraint production_cycles_population_non_negative check (starting_population is null or starting_population >= 0)
);

-- -----------------------------------------------------------------------------
-- farming_events — the operational diary of a cycle (feed issue, labour,
-- observation, mortality, ...).
-- -----------------------------------------------------------------------------
create table if not exists public.farming_events (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  cycle_id    uuid not null references public.production_cycles(id) on delete cascade,
  event_type  text not null,
  occurred_on date not null,
  quantity    numeric(20, 6),
  unit        text references public.units(code) on delete restrict,
  amount      numeric(20, 6),
  currency    text,
  account_code text references public.accounts(code) on delete restrict,
  product_id  uuid references public.products(id) on delete set null,
  notes       text,
  payload     jsonb not null default '{}'::jsonb,
  actor_id    uuid not null references public.profiles(id) on delete restrict,
  device_id   uuid references public.devices(id) on delete set null,
  event_id    text not null,
  reversal_of uuid references public.farming_events(id) on delete restrict,
  created_at  timestamptz not null default now(),
  constraint farming_events_event_id_unique unique (event_id),
  constraint farming_events_event_type_check check (event_type in (
    'INPUT_ISSUE', 'DIRECT_LABOUR', 'MACHINERY_FUEL', 'VETERINARY', 'UTILITIES',
    'PACKAGING', 'TRANSPORT', 'OVERHEAD', 'OBSERVATION', 'MORTALITY', 'INTERNAL_USE', 'WASTE'
  )),
  constraint farming_events_quantity_positive check (quantity is null or quantity > 0),
  constraint farming_events_amount_non_negative check (amount is null or amount >= 0),
  constraint farming_events_currency_shape check (currency is null or char_length(currency) between 3 and 8),
  constraint farming_events_payload_object check (jsonb_typeof(payload) = 'object'),
  constraint farming_events_reversal_not_self check (reversal_of is null or reversal_of <> id)
);

-- -----------------------------------------------------------------------------
-- input_consumptions — an issue of a stocked input to a cycle, with the stock
-- movement that reduced inventory (explicit link, so cost is never counted twice).
-- -----------------------------------------------------------------------------
create table if not exists public.input_consumptions (
  id                uuid primary key default gen_random_uuid(),
  business_id       uuid not null references public.businesses(id) on delete cascade,
  cycle_id          uuid not null references public.production_cycles(id) on delete cascade,
  product_id        uuid not null references public.products(id) on delete restrict,
  stock_movement_id uuid references public.stock_movements(id) on delete set null,
  quantity          numeric(20, 6) not null,
  unit              text not null references public.units(code) on delete restrict,
  unit_cost         numeric(20, 6) not null,
  total_cost        numeric(20, 6) not null,
  occurred_on       date not null,
  notes             text,
  recorded_by       uuid not null references public.profiles(id) on delete restrict,
  created_at        timestamptz not null default now(),
  constraint input_consumptions_quantity_positive check (quantity > 0),
  constraint input_consumptions_unit_cost_non_negative check (unit_cost >= 0),
  constraint input_consumptions_total_arithmetic check (total_cost = round(quantity * unit_cost, 6))
);

-- -----------------------------------------------------------------------------
-- production_outputs — any harvestable output (harvest, eggs, milk, weight gain).
-- -----------------------------------------------------------------------------
create table if not exists public.production_outputs (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  cycle_id    uuid not null references public.production_cycles(id) on delete cascade,
  output_kind text not null,
  occurred_on date not null,
  quantity    numeric(20, 6) not null,
  unit        text not null references public.units(code) on delete restrict,
  product_id  uuid references public.products(id) on delete set null,
  unit_cost   numeric(20, 6) not null default 0,
  total_cost  numeric(20, 6) not null default 0,
  currency    text not null,
  notes       text,
  created_by  uuid not null references public.profiles(id) on delete restrict,
  created_at  timestamptz not null default now(),
  constraint production_outputs_kind_check check (output_kind in
    ('HARVEST', 'MILK', 'EGG', 'WEIGHT_GAIN', 'BYPRODUCT', 'OTHER')),
  constraint production_outputs_quantity_positive check (quantity > 0),
  constraint production_outputs_unit_cost_non_negative check (unit_cost >= 0),
  constraint production_outputs_total_non_negative check (total_cost >= 0),
  constraint production_outputs_currency_shape check (char_length(currency) between 3 and 8)
);

-- -----------------------------------------------------------------------------
-- harvests — a harvest of a cycle into finished stock, with its assigned cost.
-- -----------------------------------------------------------------------------
create table if not exists public.harvests (
  id             uuid primary key default gen_random_uuid(),
  business_id    uuid not null references public.businesses(id) on delete cascade,
  cycle_id       uuid not null references public.production_cycles(id) on delete cascade,
  occurred_on    date not null,
  quantity       numeric(20, 6) not null,
  unit           text not null references public.units(code) on delete restrict,
  product_id     uuid references public.products(id) on delete set null,
  location_id    uuid references public.locations(id) on delete set null,
  lot_no         text,
  costing_method text not null,
  cost_basis     numeric(20, 6) not null,
  unit_cost      numeric(20, 6) not null,
  currency       text not null,
  grade          text,
  notes          text,
  created_by     uuid not null references public.profiles(id) on delete restrict,
  device_id      uuid references public.devices(id) on delete set null,
  event_id       text not null,
  created_at     timestamptz not null default now(),
  constraint harvests_event_id_unique unique (event_id),
  constraint harvests_quantity_positive check (quantity > 0),
  constraint harvests_cost_basis_non_negative check (cost_basis >= 0),
  constraint harvests_unit_cost_non_negative check (unit_cost >= 0),
  constraint harvests_currency_shape check (char_length(currency) between 3 and 8),
  constraint harvests_costing_method_check check (costing_method in ('PLANNED_YIELD_PRORATA', 'CLOSING_REMAINDER'))
);

-- -----------------------------------------------------------------------------
-- mortality_losses — deaths / losses recorded against a cycle.
-- -----------------------------------------------------------------------------
create table if not exists public.mortality_losses (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  cycle_id    uuid not null references public.production_cycles(id) on delete cascade,
  occurred_on date not null,
  quantity    numeric(20, 6) not null,
  unit        text not null references public.units(code) on delete restrict,
  reason      text not null,
  book_value  numeric(20, 6),
  currency    text,
  abnormal    boolean not null default false,
  recorded_by uuid not null references public.profiles(id) on delete restrict,
  created_at  timestamptz not null default now(),
  constraint mortality_losses_quantity_positive check (quantity > 0),
  constraint mortality_losses_book_value_non_negative check (book_value is null or book_value >= 0),
  constraint mortality_losses_currency_shape check (currency is null or char_length(currency) between 3 and 8)
);

-- -----------------------------------------------------------------------------
-- cost_sources — a cost incurred for one cycle (shared = false) or for several
-- (shared = true, to be split by cost_allocations).
-- -----------------------------------------------------------------------------
create table if not exists public.cost_sources (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  cycle_id    uuid references public.production_cycles(id) on delete cascade,
  kind        text not null,
  currency    text not null,
  amount      numeric(20, 6) not null,
  shared      boolean not null default false,
  incurred_on date not null,
  source_type text not null,
  source_id   text not null,
  note        text,
  allocated_at timestamptz,
  revision    integer not null default 1,
  created_at  timestamptz not null default now(),
  constraint cost_sources_kind_check check (kind in (
    'INPUT_ISSUE', 'DIRECT_LABOUR', 'MACHINERY_FUEL', 'VETERINARY', 'UTILITIES',
    'PACKAGING', 'TRANSPORT', 'OVERHEAD', 'OTHER_DIRECT'
  )),
  constraint cost_sources_amount_non_negative check (amount >= 0),
  constraint cost_sources_currency_shape check (char_length(currency) between 3 and 8),
  constraint cost_sources_revision_check check (revision >= 1),
  -- A direct cost belongs to exactly one cycle; a shared cost belongs to none.
  constraint cost_sources_cycle_when_direct check ((shared) or (cycle_id is not null)),
  constraint cost_sources_source_check check (source_type in ('ALLOCATION', 'EVENT', 'PURCHASE', 'OPENING', 'MANUAL', 'OTHER'))
);

-- -----------------------------------------------------------------------------
-- cost_allocations — the shares of a shared cost across cycles. Amounts for one
-- cost_source must sum exactly to that source's amount (deferrable trigger).
-- -----------------------------------------------------------------------------
create table if not exists public.cost_allocations (
  id             uuid primary key default gen_random_uuid(),
  business_id    uuid not null references public.businesses(id) on delete cascade,
  cost_source_id uuid not null references public.cost_sources(id) on delete cascade,
  cycle_id       uuid not null references public.production_cycles(id) on delete cascade,
  basis          text not null,
  basis_value    numeric(20, 6) not null,
  share_ratio    numeric(20, 12) not null,
  currency       text not null,
  amount         numeric(20, 6) not null,
  created_by     uuid not null references public.profiles(id) on delete restrict,
  created_at     timestamptz not null default now(),
  constraint cost_allocations_source_cycle_unique unique (cost_source_id, cycle_id),
  constraint cost_allocations_basis_check check (basis in (
    'ACTUAL_USAGE', 'AREA', 'TIME', 'OUTPUT_QTY', 'ANIMAL_COUNT', 'BIOMASS', 'MANUAL_PERCENT'
  )),
  constraint cost_allocations_basis_value_non_negative check (basis_value >= 0),
  constraint cost_allocations_share_ratio_non_negative check (share_ratio >= 0 and share_ratio <= 1),
  constraint cost_allocations_amount_non_negative check (amount >= 0),
  constraint cost_allocations_currency_shape check (char_length(currency) between 3 and 8)
);

-- -----------------------------------------------------------------------------
-- output_lots — traceability for finished output: which harvest/lot produced
-- which stock lot.
-- -----------------------------------------------------------------------------
create table if not exists public.output_lots (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null references public.businesses(id) on delete cascade,
  cycle_id      uuid not null references public.production_cycles(id) on delete cascade,
  harvest_id    uuid references public.harvests(id) on delete set null,
  product_id    uuid references public.products(id) on delete set null,
  stock_lot_id  uuid references public.stock_lots(id) on delete set null,
  lot_no        text not null,
  quantity      numeric(20, 6) not null,
  unit          text not null references public.units(code) on delete restrict,
  unit_cost     numeric(20, 6) not null,
  currency      text not null,
  produced_on   date not null,
  created_at    timestamptz not null default now(),
  constraint output_lots_business_lot_unique unique (business_id, lot_no),
  constraint output_lots_quantity_positive check (quantity > 0),
  constraint output_lots_unit_cost_non_negative check (unit_cost >= 0),
  constraint output_lots_currency_shape check (char_length(currency) between 3 and 8)
);

-- -----------------------------------------------------------------------------
-- observations — lightweight field notes / measurements for a cycle.
-- `value` holds a numeric measurement; `value_text` keeps a non-numeric one.
-- -----------------------------------------------------------------------------
create table if not exists public.observations (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  cycle_id    uuid not null references public.production_cycles(id) on delete cascade,
  observed_on date not null,
  kind        text not null,
  value       numeric(20, 6),
  value_text  text,
  unit        text references public.units(code) on delete restrict,
  notes       text,
  recorded_by uuid not null references public.profiles(id) on delete restrict,
  created_at  timestamptz not null default now(),
  constraint observations_value_present check (value is not null or value_text is not null)
);

-- -----------------------------------------------------------------------------
-- cycle_cost_ledger — reporting view: every cost assigned to a cycle exactly
-- once (direct costs + allocated shares of shared overhead), grouped by kind,
-- with each kind's share of the cycle total. Matches the domain
-- `cycleCostLedger()` output (kind, label, amount, shareOfTotal).
--
-- security_invoker: the view does NOT bypass row level security, so the
-- partner-cost policies on cost_sources / cost_allocations still decide what a
-- given member may see. Requires PostgreSQL 15+ (Supabase is 15/17).
-- -----------------------------------------------------------------------------
create or replace view public.cycle_cost_ledger
with (security_invoker = true)
as
with lines as (
  select cs.business_id, cs.cycle_id, cs.kind, cs.amount, cs.currency
    from public.cost_sources cs
   where cs.shared = false
     and cs.cycle_id is not null
  union all
  select ca.business_id, ca.cycle_id, 'OVERHEAD'::text as kind, ca.amount, ca.currency
    from public.cost_allocations ca
),
totals as (
  select l.business_id, l.cycle_id, l.currency, sum(l.amount) as total_amount
    from lines l
   group by l.business_id, l.cycle_id, l.currency
)
select
  l.business_id,
  l.cycle_id,
  c.reference          as cycle_reference,
  c.status             as cycle_status,
  l.kind,
  l.currency,
  sum(l.amount)        as amount,
  t.total_amount,
  case
    when t.total_amount = 0 then 0::numeric
    else round(sum(l.amount) / t.total_amount, 8)
  end                  as share_of_total,
  count(*)             as source_count
from lines l
join public.production_cycles c on c.id = l.cycle_id
join totals t
  on t.business_id = l.business_id
 and t.cycle_id = l.cycle_id
 and t.currency = l.currency
group by l.business_id, l.cycle_id, c.reference, c.status, l.kind, l.currency, t.total_amount;

comment on view public.cycle_cost_ledger is
  'Per-cycle cost by kind, including allocated shared overhead. security_invoker = true so partner cost-visibility policies still apply.';
