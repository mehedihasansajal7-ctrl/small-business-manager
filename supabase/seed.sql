-- =============================================================================
-- seed.sql — OPTIONAL demo dataset.
--
-- One business with three members (owner / manager / farm manager), a small
-- catalog, one purchase, one sale, one farm with one broiler cycle, an input
-- issue and one harvest.
--
-- * Idempotent: it is wrapped in a guard that does nothing if the demo business
--   already exists, so it is safe to re-run.
-- * No real secrets and no real personal data: `*.example.com` emails (a
--   reserved domain), obviously fake names, and no passwords (profiles here
--   exist only so the demo rows have owners; create real sign-in accounts
--   through Supabase Auth).
-- * Intended to be applied by an administrator / service role, i.e. a role that
--   can bypass row level security (see README.md).
-- * Everything is deterministic (fixed uuids), so re-running never duplicates.
-- =============================================================================

do $seed$
declare
  v_business_id uuid := '11111111-1111-4111-8111-111111111111';
  v_owner uuid := 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
  v_manager uuid := 'aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa';
  v_farm_manager uuid := 'aaaaaaaa-3333-4333-8333-aaaaaaaaaaaa';
  v_location uuid := 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb';
  v_rice uuid := 'cccccccc-1111-4111-8111-cccccccccccc';
  v_feed uuid := 'cccccccc-2222-4222-8222-cccccccccccc';
  v_chicken uuid := 'cccccccc-3333-4333-8333-cccccccccccc';
  v_supplier uuid := 'dddddddd-1111-4111-8111-dddddddddddd';
  v_farm uuid := 'eeeeeeee-1111-4111-8111-eeeeeeeeeeee';
  v_unit uuid := 'eeeeeeee-2222-4222-8222-eeeeeeeeeeee';
  v_cycle uuid := 'eeeeeeee-3333-4333-8333-eeeeeeeeeeee';
  v_purchase uuid := 'ffffffff-1111-4111-8111-ffffffffffff';
  v_sale uuid := 'ffffffff-2222-4222-8222-ffffffffffff';
  v_feed_move uuid := 'ffffffff-3333-4333-8333-ffffffffffff';
  v_harvest uuid := 'ffffffff-4444-4444-8444-ffffffffffff';
  v_today date := current_date;
begin
  if exists (select 1 from public.businesses b where b.slug = 'demo-rahim-agro') then
    raise notice 'Demo business already seeded - nothing to do.';
    return;
  end if;

  -- Profiles (demo only; create real accounts through Supabase Auth).
  insert into public.profiles (id, email, display_name, locale)
  values
    (v_owner, 'owner@demo.example.com', 'Demo Owner', 'bn-BD'),
    (v_manager, 'manager@demo.example.com', 'Demo Manager', 'bn-BD'),
    (v_farm_manager, 'farm@demo.example.com', 'Demo Farm Manager', 'bn-BD')
  on conflict (id) do nothing;

  insert into public.businesses
    (id, name, slug, currency, timezone, locale, country, farming_types, enabled_modules, plan, revision, created_by)
  values
    (v_business_id, 'Demo Agro & General Store', 'demo-rahim-agro', 'BDT', 'Asia/Dhaka', 'bn-BD', 'BD',
     '["POULTRY"]'::jsonb,
     '["dashboard","sales","purchases","inventory","customers","suppliers","finance","farming","reports","team","settings","ai"]'::jsonb,
     'free', 1, v_owner)
  on conflict (id) do nothing;

  insert into public.business_members (business_id, user_id, email, display_name, role, status, joined_at)
  values
    (v_business_id, v_owner, 'owner@demo.example.com', 'Demo Owner', 'owner', 'active', now()),
    (v_business_id, v_manager, 'manager@demo.example.com', 'Demo Manager', 'manager', 'active', now()),
    (v_business_id, v_farm_manager, 'farm@demo.example.com', 'Demo Farm Manager', 'farm_manager', 'active', now())
  on conflict (business_id, user_id) do nothing;

  -- Partner visibility: the owner lets partners see costs and reports.
  insert into public.business_settings (business_id, key, value)
  values
    (v_business_id, 'partnerCanSeeCosts', 'true'::jsonb),
    (v_business_id, 'partnerCanSeeFinancialReports', 'true'::jsonb)
  on conflict (business_id, key) do nothing;

  insert into public.locations (id, business_id, name, kind, is_default, is_active)
  values (v_location, v_business_id, 'Main Store', 'STORE', true, true)
  on conflict (id) do nothing;

  insert into public.products (id, business_id, sku, name, name_bn, kind, unit, sale_price, purchase_price, reorder_level, is_active)
  values
    (v_rice, v_business_id, 'RICE-01', 'Miniket Rice', 'মিনিকেট চাল', 'PRODUCT', 'kg', 68, 58, 20, true),
    (v_feed, v_business_id, 'FEED-01', 'Poultry Starter Feed', 'পোল্ট্রি স্টার্টার ফিড', 'INPUT', 'kg', null, 62, 50, true),
    (v_chicken, v_business_id, 'BROILER-01', 'Live Broiler Chicken', 'জীবিত ব্রয়লার', 'OUTPUT', 'kg', 175, null, null, true)
  on conflict (id) do nothing;

  insert into public.suppliers (id, business_id, name, phone, opening_balance, is_active)
  values (v_supplier, v_business_id, 'Demo Agro Inputs', '01000000000', 0, true)
  on conflict (id) do nothing;

  -- --- Purchase: 100 kg rice @ 58 = 5,800 (paid in full) -----------------
  insert into public.purchases
    (id, business_id, reference, supplier_id, document_date, currency, subtotal, discount, tax, total,
     paid, payable, status, created_by, event_id)
  values
    (v_purchase, v_business_id, 'PUR-DEMO-0001', v_supplier, v_today, 'BDT', 5800, 0, 0, 5800, 5800, 0,
     'POSTED', v_owner, 'seed-purchase-0001')
  on conflict (id) do nothing;

  insert into public.purchase_lines
    (business_id, purchase_id, product_id, description, quantity, unit, unit_cost, discount, tax,
     line_total, location_id)
  values
    (v_business_id, v_purchase, v_rice, 'Miniket Rice', 100, 'kg', 58, 0, 0, 5800, v_location)
  on conflict do nothing;

  insert into public.stock_movements
    (business_id, item_id, location_id, direction, quantity, unit, unit_cost, currency, source_type,
     source_id, actor_id, event_id, idempotency_key, occurred_at)
  values
    (v_business_id, v_rice, v_location, 'IN', 100, 'kg', 58, 'BDT', 'PURCHASE', 'PUR-DEMO-0001',
     v_owner, 'seed-move-0001', 'seed:move:0001', v_today::timestamptz)
  on conflict do nothing;

  insert into public.journal_entries
    (business_id, document_date, reference, description, source_type, source_id, currency, posted_by, event_id)
  values
    (v_business_id, v_today, 'PUR-DEMO-0001', 'Purchase PUR-DEMO-0001', 'PURCHASE', 'PUR-DEMO-0001', 'BDT', v_owner, 'seed-purchase-0001:journal')
  on conflict do nothing;

  insert into public.journal_lines (business_id, entry_id, account, debit, credit, currency, memo)
  select v_business_id, e.id, x.account, x.debit, x.credit, 'BDT', x.memo
    from public.journal_entries e,
         (values
           ('1200', 5800::numeric, 0::numeric, 'Inventory received'),
           ('1000', 0::numeric, 5800::numeric, 'Paid')
         ) as x(account, debit, credit, memo)
   where e.business_id = v_business_id and e.event_id = 'seed-purchase-0001:journal'
     and not exists (select 1 from public.journal_lines jl where jl.entry_id = e.id);

  -- --- Sale: 20 kg rice @ 68 = 1,360 cash; COGS 20 * 58 = 1,160 -----------
  insert into public.sales
    (id, business_id, reference, document_date, currency, gross, discount, tax, net, cash_received,
     receivable, cogs, status, created_by, event_id)
  values
    (v_sale, v_business_id, 'SAL-DEMO-0001', v_today, 'BDT', 1360, 0, 0, 1360, 1360, 0, 1160,
     'POSTED', v_owner, 'seed-sale-0001')
  on conflict (id) do nothing;

  insert into public.sale_lines
    (business_id, sale_id, product_id, description, quantity, unit, unit_price, discount, tax,
     line_total, unit_cost, location_id)
  values
    (v_business_id, v_sale, v_rice, 'Miniket Rice', 20, 'kg', 68, 0, 0, 1360, 58, v_location)
  on conflict do nothing;

  insert into public.stock_movements
    (business_id, item_id, location_id, direction, quantity, unit, unit_cost, currency, source_type,
     source_id, actor_id, event_id, idempotency_key, occurred_at)
  values
    (v_business_id, v_rice, v_location, 'OUT', 20, 'kg', 58, 'BDT', 'SALE', 'SAL-DEMO-0001',
     v_owner, 'seed-move-0002', 'seed:move:0002', v_today::timestamptz)
  on conflict do nothing;

  insert into public.journal_entries
    (business_id, document_date, reference, description, source_type, source_id, currency, posted_by, event_id)
  values
    (v_business_id, v_today, 'SAL-DEMO-0001', 'Sale SAL-DEMO-0001', 'SALE', 'SAL-DEMO-0001', 'BDT', v_owner, 'seed-sale-0001:journal')
  on conflict do nothing;

  insert into public.journal_lines (business_id, entry_id, account, debit, credit, currency, memo)
  select v_business_id, e.id, x.account, x.debit, x.credit, 'BDT', x.memo
    from public.journal_entries e,
         (values
           ('1000', 1360::numeric, 0::numeric, 'Cash received'),
           ('4000', 0::numeric, 1360::numeric, 'Sales revenue'),
           ('5000', 1160::numeric, 0::numeric, 'Cost of goods sold'),
           ('1200', 0::numeric, 1160::numeric, 'Inventory released')
         ) as x(account, debit, credit, memo)
   where e.business_id = v_business_id and e.event_id = 'seed-sale-0001:journal'
     and not exists (select 1 from public.journal_lines jl where jl.entry_id = e.id);

  -- --- Farming: farm + shed + broiler cycle, feed issue, harvest ----------
  insert into public.farms (id, business_id, name, location_id, area, area_unit, is_active)
  values (v_farm, v_business_id, 'Demo Poultry Farm', v_location, 12, 'decimal', true)
  on conflict (id) do nothing;

  insert into public.farm_units (id, business_id, farm_id, kind, name, capacity, capacity_unit, is_active)
  values (v_unit, v_business_id, v_farm, 'POULTRY_HOUSE', 'Shed 1', 2000, 'pcs', true)
  on conflict (id) do nothing;

  insert into public.production_cycles
    (id, business_id, farm_id, unit_id, reference, farming_type, title, crop_or_species, variety_or_breed,
     season, start_date, expected_end_date, planned_output, planned_output_unit, status, starting_population, revision)
  values
    (v_cycle, v_business_id, v_farm, v_unit, 'CYC-DEMO-0001', 'POULTRY', 'Broiler batch 1', 'Broiler chicken',
     'Cobb 500', 'Winter', v_today, v_today + 32, 500, 'kg', 'ACTIVE', 1000, 1)
  on conflict (id) do nothing;

  -- Buy feed into stock (an asset, not yet a batch cost).
  insert into public.stock_movements
    (business_id, item_id, location_id, direction, quantity, unit, unit_cost, currency, source_type,
     source_id, actor_id, event_id, idempotency_key, occurred_at)
  values
    (v_business_id, v_feed, v_location, 'IN', 200, 'kg', 62, 'BDT', 'PURCHASE', 'PUR-DEMO-0002',
     v_owner, 'seed-move-0003', 'seed:move:0003', v_today::timestamptz)
  on conflict do nothing;

  -- Issue 50 kg feed to the cycle: stock OUT + batch cost 3,100.
  insert into public.stock_movements
    (id, business_id, item_id, location_id, direction, quantity, unit, unit_cost, currency, source_type,
     source_id, actor_id, event_id, idempotency_key, occurred_at)
  values
    (v_feed_move, v_business_id, v_feed, v_location, 'OUT', 50, 'kg', 62, 'BDT', 'INPUT_ISSUE',
     'CYC-DEMO-0001', v_owner, 'seed-move-0004', 'seed:move:0004', v_today::timestamptz)
  on conflict (id) do nothing;

  insert into public.input_consumptions
    (business_id, cycle_id, product_id, stock_movement_id, quantity, unit, unit_cost, total_cost,
     occurred_on, notes, recorded_by)
  values
    (v_business_id, v_cycle, v_feed, v_feed_move, 50, 'kg', 62, 3100, v_today,
     'Starter feed issued', v_owner)
  on conflict do nothing;

  insert into public.cost_sources
    (business_id, cycle_id, kind, currency, amount, shared, incurred_on, source_type, source_id, note, revision)
  values
    (v_business_id, v_cycle, 'INPUT_ISSUE', 'BDT', 3100, false, v_today, 'EVENT', v_feed_move::text,
     'Starter feed issued', 1)
  on conflict do nothing;

  insert into public.farming_events
    (business_id, cycle_id, event_type, occurred_on, quantity, unit, product_id, notes, payload, actor_id, event_id)
  values
    (v_business_id, v_cycle, 'INPUT_ISSUE', v_today, 50, 'kg', v_feed, 'Starter feed issued',
     jsonb_build_object('inputConsumptionId', v_feed_move), v_owner, 'seed-farm-event-0001')
  on conflict do nothing;

  insert into public.journal_entries
    (business_id, document_date, reference, description, source_type, source_id, currency, posted_by, event_id)
  values
    (v_business_id, v_today, 'CYC-DEMO-0001-INPUT', 'Input issued to batch CYC-DEMO-0001', 'INPUT_ISSUE',
     'CYC-DEMO-0001', 'BDT', v_owner, 'seed-input-0001:journal')
  on conflict do nothing;

  insert into public.journal_lines (business_id, entry_id, account, debit, credit, currency, memo)
  select v_business_id, e.id, x.account, x.debit, x.credit, 'BDT', x.memo
    from public.journal_entries e,
         (values
           ('1300', 3100::numeric, 0::numeric, 'Batch input cost'),
           ('1200', 0::numeric, 3100::numeric, 'Input stock released')
         ) as x(account, debit, credit, memo)
   where e.business_id = v_business_id and e.event_id = 'seed-input-0001:journal'
     and not exists (select 1 from public.journal_lines jl where jl.entry_id = e.id);

  -- Harvest 300 kg of a planned 500 kg: 3,100 * 300/500 = 1,860 cost basis.
  insert into public.harvests
    (id, business_id, cycle_id, occurred_on, quantity, unit, product_id, location_id, lot_no,
     costing_method, cost_basis, unit_cost, currency, notes, created_by, event_id)
  values
    (v_harvest, v_business_id, v_cycle, v_today, 300, 'kg', v_chicken, v_location, 'BROILER-DEMO-01',
     'PLANNED_YIELD_PRORATA', 1860, 6.2, 'BDT', 'First partial harvest', v_owner, 'seed-harvest-0001')
  on conflict (id) do nothing;

  insert into public.stock_movements
    (business_id, item_id, location_id, direction, quantity, unit, unit_cost, currency, source_type,
     source_id, actor_id, event_id, idempotency_key, occurred_at)
  values
    (v_business_id, v_chicken, v_location, 'IN', 300, 'kg', 6.2, 'BDT', 'HARVEST', 'CYC-DEMO-0001',
     v_owner, 'seed-move-0005', 'seed:move:0005', v_today::timestamptz)
  on conflict do nothing;

  insert into public.output_lots
    (business_id, cycle_id, harvest_id, product_id, lot_no, quantity, unit, unit_cost, currency, produced_on)
  values
    (v_business_id, v_cycle, v_harvest, v_chicken, 'BROILER-DEMO-01', 300, 'kg', 6.2, 'BDT', v_today)
  on conflict do nothing;

  insert into public.journal_entries
    (business_id, document_date, reference, description, source_type, source_id, currency, posted_by, event_id)
  values
    (v_business_id, v_today, 'CYC-DEMO-0001-HARVEST', 'Harvest to finished stock', 'HARVEST',
     'CYC-DEMO-0001', 'BDT', v_owner, 'seed-harvest-0001:journal')
  on conflict do nothing;

  insert into public.journal_lines (business_id, entry_id, account, debit, credit, currency, memo)
  select v_business_id, e.id, x.account, x.debit, x.credit, 'BDT', x.memo
    from public.journal_entries e,
         (values
           ('1210', 1860::numeric, 0::numeric, 'Finished output value'),
           ('1300', 0::numeric, 1860::numeric, 'Batch cost released')
         ) as x(account, debit, credit, memo)
   where e.business_id = v_business_id and e.event_id = 'seed-harvest-0001:journal'
     and not exists (select 1 from public.journal_lines jl where jl.entry_id = e.id);

  -- Bookkeeping for the offline sync layer (demonstration rows).
  insert into public.processed_events
    (idempotency_key, business_id, event_id, event_type, aggregate_type, aggregate_id, payload_hash, server_revision, result)
  values
    ('seed:sale:0001', v_business_id, 'seed-sale-0001', 'sale.post', 'sale', v_sale::text,
     encode(sha256(convert_to('{"seed":true}', 'UTF8')), 'hex'), 1,
     jsonb_build_object('reference', 'SAL-DEMO-0001'))
  on conflict (idempotency_key) do nothing;

  raise notice 'Demo dataset seeded: business %, members 3, products 3, 1 purchase, 1 sale, 1 cycle with a harvest.',
    v_business_id;
end
$seed$;
