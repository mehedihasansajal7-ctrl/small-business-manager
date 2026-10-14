import {
  Decimal,
  balanceSheet,
  cashFlow,
  dec,
  money,
  profitAndLoss,
  stockBalance,
  weightedAverageValuation,
  type JournalEntry,
  type JournalLine,
  type StockMovement,
} from '@sbm/domain';

import type {
  CustomerView,
  IsoDate,
  LocationView,
  MovementRow,
  ProductView,
  PurchaseView,
  SaleView,
  StockRow,
  SupplierView,
  UnitView,
  CycleView,
  FarmView,
  FarmingEventView,
} from '../api/types';
import { META_KEYS, all, first, getMeta, withTransaction } from './db';
import { enqueueWithin, proposals, type ProposalRow } from './outbox';

/**
 * Offline-first data access.
 *
 * READ paths go to the local mirror first: every screen must render previously
 * synced data with no connection. The `…Online` variants in `api/endpoints.ts`
 * exist for the actions the server must arbitrate (auth, invites, settings,
 * reports the server computes) and for the delta refresh.
 *
 * WRITE paths are the important part. For each offline-capable action
 * (`recordSale`, `recordPurchase`, `recordExpense`, `recordInputIssue`,
 * `recordFarmingEvent`, `recordHarvest`, …) we:
 *
 *   1. normalise every money/quantity value through `@sbm/domain` (`money()` /
 *      `dec()`), so what leaves the device is an **exact decimal string**;
 *   2. build the outbox event with the event type the server's `SyncService`
 *      understands (`sale.post`, `expense.post`, `farming.input_issue`, …);
 *   3. write any local rows and the outbox row inside **one** SQLite
 *      transaction;
 *   4. return the event so the screen can show it as a *local proposal*.
 *
 * Nothing is written directly into the mirror tables by a user action: those
 * hold server-confirmed rows only (see the header of `db.ts`).
 */

export interface OfflineContext {
  readonly businessId: string;
  readonly actorId: string;
}

// ---------------------------------------------------------------------------
// Reads: business + catalog
// ---------------------------------------------------------------------------

export interface LocalBusiness {
  business_id: string;
  name: string;
  currency: string;
  timezone: string;
  locale: string;
  farming_types: string;
  revision: number;
  synced_at: string;
}

export async function localBusiness(): Promise<LocalBusiness | null> {
  return first<LocalBusiness>('SELECT * FROM local_business LIMIT 1');
}

export async function activeBusinessId(): Promise<string | null> {
  return getMeta(META_KEYS.activeBusinessId);
}

export async function setActiveBusinessId(businessId: string): Promise<void> {
  await withTransaction(async (tx) => {
    await tx.runAsync(
      `INSERT INTO local_meta (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [META_KEYS.activeBusinessId, businessId, new Date().toISOString()],
    );
  });
}

const UNIT_ROWS: readonly UnitView[] = [
  { code: 'kg', name: 'Kilogram', nameBn: 'কেজি', dimension: 'MASS', factor: '1', integerOnly: false },
  { code: 'g', name: 'Gram', nameBn: 'গ্রাম', dimension: 'MASS', factor: '0.001', integerOnly: false },
  { code: 'ton', name: 'Metric ton', nameBn: 'মেট্রিক টন', dimension: 'MASS', factor: '1000', integerOnly: false },
  { code: 'maund', name: 'Maund (40kg)', nameBn: 'মণ', dimension: 'MASS', factor: '40', integerOnly: false },
  { code: 'litre', name: 'Litre', nameBn: 'লিটার', dimension: 'VOLUME', factor: '1', integerOnly: false },
  { code: 'ml', name: 'Millilitre', nameBn: 'মিলিলিটার', dimension: 'VOLUME', factor: '0.001', integerOnly: false },
  { code: 'pcs', name: 'Pieces', nameBn: 'পিস', dimension: 'COUNT', factor: '1', integerOnly: true },
  { code: 'bag', name: 'Bag', nameBn: 'বস্তা', dimension: 'COUNT', factor: '1', integerOnly: true },
  { code: 'dozen', name: 'Dozen', nameBn: 'ডজন', dimension: 'COUNT', factor: '1', integerOnly: true },
  { code: 'decimal', name: 'Decimal (land)', nameBn: 'শতক', dimension: 'AREA', factor: '1', integerOnly: false },
  { code: 'acre', name: 'Acre', nameBn: 'একর', dimension: 'AREA', factor: '1', integerOnly: false },
  { code: 'hour', name: 'Hour', nameBn: 'ঘণ্টা', dimension: 'TIME', factor: '1', integerOnly: false },
  { code: 'day', name: 'Day', nameBn: 'দিন', dimension: 'TIME', factor: '1', integerOnly: false },
];

/**
 * Units are static reference data that lives in the shared domain package, so
 * they are always available offline — no round trip needed for a unit picker.
 */
export function localUnits(dimension?: string): readonly UnitView[] {
  return dimension ? UNIT_ROWS.filter((unit) => unit.dimension === dimension) : UNIT_ROWS;
}

export async function localLocations(): Promise<LocationView[]> {
  const rows = await all<{ id: string; name: string; kind: string; address: string | null; is_default: number; is_active: number }>(
    'SELECT id, name, kind, address, is_default, is_active FROM locations ORDER BY is_default DESC, name',
  );
  return rows.map((row) => ({ id: row.id, name: row.name, kind: row.kind, address: row.address, isDefault: row.is_default === 1, isActive: row.is_active === 1 }));
}

export async function localProducts(options: { search?: string; kind?: string } = {}): Promise<ProductView[]> {
  const clauses = ['deleted_at IS NULL'];
  const params: (string | number)[] = [];
  if (options.search) {
    clauses.push('(name LIKE ? OR name_bn LIKE ? OR sku LIKE ?)');
    const like = `%${options.search}%`;
    params.push(like, like, like);
  }
  if (options.kind) {
    clauses.push('kind = ?');
    params.push(options.kind);
  }
  const rows = await all<Record<string, unknown>>(`SELECT * FROM products WHERE ${clauses.join(' AND ')} ORDER BY name LIMIT 500`, params);
  return Promise.all(rows.map((row) => toProductView(row)));
}

async function toProductView(row: Record<string, unknown>): Promise<ProductView> {
  const id = String(row.id);
  const balance = await localStockBalance(id);
  return {
    id,
    sku: (row.sku as string) ?? null,
    name: String(row.name),
    nameBn: (row.name_bn as string) ?? null,
    kind: (row.kind as ProductView['kind']) ?? 'PRODUCT',
    unit: String(row.unit),
    categoryId: (row.category_id as string) ?? null,
    isActive: row.is_active === 1,
    trackLots: row.track_lots === 1,
    revision: Number(row.revision ?? 1),
    salePrice: (row.sale_price as string) ?? null,
    reorderLevel: (row.reorder_level as string) ?? null,
    purchasePrice: (row.purchase_price as string) ?? null,
    taxRate: (row.tax_rate as string) ?? null,
    onHand: balance.quantity.toString(),
    onHandUnit: balance.unit || String(row.unit),
  };
}

export async function localCustomers(search?: string): Promise<CustomerView[]> {
  const like = `%${search ?? ''}%`;
  const rows = await all<{ id: string; name: string; phone: string | null; email: string | null }>(
    'SELECT id, name, phone, email FROM customers WHERE is_active = 1 AND (name LIKE ? OR phone LIKE ?) ORDER BY name LIMIT 500',
    [like, like],
  );
  const business = await localBusiness();
  const currency = business?.currency ?? 'BDT';
  return Promise.all(
    rows.map(async (row) => ({
      id: row.id,
      name: row.name,
      phone: row.phone,
      email: row.email,
      receivable: (await localReceivable(row.id, currency)).toString(),
    })),
  );
}

export async function localSuppliers(search?: string): Promise<SupplierView[]> {
  const like = `%${search ?? ''}%`;
  const rows = await all<{ id: string; name: string; phone: string | null }>(
    'SELECT id, name, phone FROM suppliers WHERE is_active = 1 AND name LIKE ? ORDER BY name LIMIT 500',
    [like],
  );
  const business = await localBusiness();
  const currency = business?.currency ?? 'BDT';
  return Promise.all(
    rows.map(async (row) => ({ id: row.id, name: row.name, phone: row.phone, payable: (await localPayable(row.id, currency)).toString() })),
  );
}

// ---------------------------------------------------------------------------
// Reads: commerce + stock
// ---------------------------------------------------------------------------

async function movementRows(itemId?: string): Promise<Record<string, unknown>[]> {
  return itemId
    ? all<Record<string, unknown>>('SELECT * FROM stock_movements WHERE item_id = ? ORDER BY occurred_at, created_at', [itemId])
    : all<Record<string, unknown>>('SELECT * FROM stock_movements ORDER BY occurred_at, created_at');
}

/** Minimal domain movements: `stockBalance`/`weightedAverageValuation` only need these fields. */
function toDomainMovements(rows: readonly Record<string, unknown>[]): StockMovement[] {
  return rows.map((row) => ({
    id: String(row.id),
    businessId: String(row.business_id),
    itemId: String(row.item_id),
    locationId: String(row.location_id ?? ''),
    direction: (row.direction as 'IN' | 'OUT') ?? 'IN',
    quantity: dec(String(row.quantity ?? '0')),
    unit: String(row.unit ?? ''),
    unitCost: money(String(row.currency ?? 'BDT'), String(row.unit_cost ?? '0')),
    sourceType: (row.source_type as StockMovement['sourceType']) ?? 'ADJUSTMENT',
    sourceId: String(row.source_id ?? ''),
    actorId: String(row.actor_id ?? ''),
    deviceId: String(row.device_id ?? ''),
    eventId: String(row.event_id ?? ''),
    idempotencyKey: String(row.id ?? ''),
    occurredAt: String(row.occurred_at ?? ''),
    createdAt: String(row.created_at ?? ''),
  }));
}

export async function localStockBalance(itemId: string): Promise<{ quantity: Decimal; unit: string }> {
  const rows = await movementRows(itemId);
  if (rows.length === 0) return { quantity: Decimal.ZERO, unit: '' };
  const balance = stockBalance(toDomainMovements(rows), { itemId });
  return { quantity: balance.quantity, unit: balance.unit };
}

export async function localStock(): Promise<StockRow[]> {
  const business = await localBusiness();
  const currency = business?.currency ?? 'BDT';
  const products = await all<Record<string, unknown>>(`SELECT * FROM products WHERE is_active = 1 AND kind != 'SERVICE' ORDER BY name`);
  const movements = toDomainMovements(await movementRows());

  return products.map((product) => {
    const itemId = String(product.id);
    const balance = stockBalance(movements, { itemId });
    const valuation = movements.some((mv) => mv.itemId === itemId) ? weightedAverageValuation(movements, { itemId, currency }) : null;
    const reorderLevel = (product.reorder_level as string) ?? null;
    return {
      itemId,
      name: String(product.name),
      unit: String(product.unit),
      onHand: balance.quantity.toString(),
      reorderLevel,
      belowReorder: reorderLevel ? balance.quantity.lte(dec(reorderLevel)) : false,
      unitCost: valuation ? valuation.unitCost.amount.toString() : '0.00',
      value: valuation ? valuation.value.amount.toString() : '0.00',
    };
  });
}

export async function localMovements(itemId?: string): Promise<MovementRow[]> {
  const rows = await movementRows(itemId);
  return rows
    .slice(-500)
    .reverse()
    .map((row) => ({
      id: String(row.id),
      itemId: String(row.item_id),
      locationId: (row.location_id as string) ?? null,
      direction: (row.direction as 'IN' | 'OUT') ?? 'IN',
      quantity: String(row.quantity ?? '0'),
      unit: String(row.unit ?? ''),
      sourceType: String(row.source_type ?? ''),
      sourceId: (row.source_id as string) ?? null,
      reason: (row.reason as string) ?? null,
      occurredAt: String(row.occurred_at ?? ''),
    }));
}

export async function localSales(from?: IsoDate, to?: IsoDate): Promise<SaleView[]> {
  const rows = await all<Record<string, unknown>>(
    `SELECT * FROM sales WHERE document_date >= ? AND document_date <= ? ORDER BY document_date DESC LIMIT 500`,
    [from ?? '1970-01-01', to ?? '2999-12-31'],
  );
  return Promise.all(
    rows.map(async (row) => {
      const lines = await all<Record<string, unknown>>(
        'SELECT product_id, description, quantity, unit, unit_price, line_total FROM sale_lines WHERE sale_id = ?',
        [String(row.id)],
      );
      const net = dec(String(row.net ?? '0'));
      const cogs = dec(String(row.cogs ?? '0'));
      return {
        id: String(row.id),
        reference: String(row.reference ?? ''),
        customerId: (row.customer_id as string) ?? null,
        documentDate: String(row.document_date ?? ''),
        currency: String(row.currency ?? 'BDT'),
        gross: String(row.gross ?? '0'),
        discount: String(row.discount ?? '0'),
        net: net.toString(),
        cashReceived: String(row.cash_received ?? '0'),
        receivable: String(row.receivable ?? '0'),
        cogs: cogs.toString(),
        grossProfit: net.sub(cogs).toString(),
        lines: lines.map((line) => ({
          productId: (line.product_id as string) ?? null,
          description: String(line.description ?? ''),
          quantity: String(line.quantity ?? '0'),
          unit: String(line.unit ?? ''),
          unitPrice: String(line.unit_price ?? '0'),
          lineTotal: String(line.line_total ?? '0'),
        })),
      } satisfies SaleView;
    }),
  );
}

export async function localPurchases(from?: IsoDate, to?: IsoDate): Promise<PurchaseView[]> {
  const rows = await all<Record<string, unknown>>(
    `SELECT * FROM purchases WHERE document_date >= ? AND document_date <= ? ORDER BY document_date DESC LIMIT 500`,
    [from ?? '1970-01-01', to ?? '2999-12-31'],
  );
  return Promise.all(
    rows.map(async (row) => {
      const lines = await all<Record<string, unknown>>(
        'SELECT product_id, quantity, unit, unit_cost, line_total FROM purchase_lines WHERE purchase_id = ?',
        [String(row.id)],
      );
      return {
        id: String(row.id),
        reference: String(row.reference ?? ''),
        supplierId: (row.supplier_id as string) ?? null,
        documentDate: String(row.document_date ?? ''),
        currency: String(row.currency ?? 'BDT'),
        total: String(row.total ?? '0'),
        paid: String(row.paid ?? '0'),
        payable: String(row.payable ?? '0'),
        subtotal: String(row.subtotal ?? '0'),
        tax: String(row.tax ?? '0'),
        lines: lines.map((line) => ({
          productId: (line.product_id as string) ?? null,
          quantity: String(line.quantity ?? '0'),
          unit: String(line.unit ?? ''),
          unitCost: String(line.unit_cost ?? '0'),
          lineTotal: String(line.line_total ?? '0'),
        })),
      } satisfies PurchaseView;
    }),
  );
}

export async function localReceivable(customerId: string, currency: string): Promise<Decimal> {
  void currency;
  // What the mirror can prove: unpaid invoice balances. Customer receipts are not
  // part of the sync pull (they are posted as journal/payment rows server-side),
  // so a receipt recorded after the last pull is not yet reflected here. Every
  // screen that shows this value labels it "as of last sync" for that reason.
  const sales = await all<{ net: string; cash_received: string }>('SELECT net, cash_received FROM sales WHERE customer_id = ?', [customerId]);
  return sales.reduce((acc, row) => acc.add(dec(row.net).sub(dec(row.cash_received))), Decimal.ZERO);
}

export async function localPayable(supplierId: string, currency: string): Promise<Decimal> {
  const bills = await all<{ payable: string }>('SELECT payable FROM purchases WHERE supplier_id = ?', [supplierId]);
  void currency;
  return bills.reduce((acc, row) => acc.add(dec(row.payable)), Decimal.ZERO);
}

// ---------------------------------------------------------------------------
// Reads: journal-derived reports (work offline from the mirrored ledger)
// ---------------------------------------------------------------------------

async function localJournalEntries(): Promise<JournalEntry[]> {
  const entries = await all<Record<string, unknown>>('SELECT * FROM journal_entries ORDER BY document_date');
  const lines = await all<Record<string, unknown>>('SELECT * FROM journal_lines');
  const grouped = new Map<string, JournalLine[]>();
  for (const line of lines) {
    const entryId = String(line.entry_id);
    const currency = String(line.currency ?? 'BDT');
    const bucket = grouped.get(entryId) ?? [];
    bucket.push({
      account: String(line.account),
      debit: money(currency, String(line.debit ?? '0')),
      credit: money(currency, String(line.credit ?? '0')),
      ...(line.memo ? { memo: String(line.memo) } : {}),
      ...(line.cost_center ? { costCenter: String(line.cost_center) } : {}),
    });
    grouped.set(entryId, bucket);
  }
  return entries.map((entry) => ({
    id: String(entry.id),
    businessId: String(entry.business_id),
    date: String(entry.document_date),
    reference: String(entry.reference ?? ''),
    description: String(entry.description ?? ''),
    sourceType: String(entry.source_type ?? ''),
    sourceId: String(entry.source_id ?? ''),
    lines: grouped.get(String(entry.id)) ?? [],
    currency: String(entry.currency ?? 'BDT'),
    postedBy: String(entry.posted_by ?? ''),
    createdAt: String(entry.created_at ?? ''),
  }));
}

export interface LocalProfitAndLoss {
  readonly revenue: string;
  readonly netRevenue: string;
  readonly costOfGoodsSold: string;
  readonly grossProfit: string;
  readonly operatingExpenses: string;
  readonly netProfit: string;
  readonly expensesByAccount: readonly { readonly account: string; readonly name: string; readonly amount: string }[];
  readonly currency: string;
}

export async function localProfitAndLoss(range: { from: IsoDate; to: IsoDate }, currency: string): Promise<LocalProfitAndLoss> {
  const entries = await localJournalEntries();
  const report = profitAndLoss(entries, { from: range.from, to: range.to, currency });
  return {
    revenue: report.revenue.amount.toString(),
    netRevenue: report.netRevenue.amount.toString(),
    costOfGoodsSold: report.costOfGoodsSold.amount.toString(),
    grossProfit: report.grossProfit.amount.toString(),
    operatingExpenses: report.operatingExpenses.amount.toString(),
    netProfit: report.netProfit.amount.toString(),
    expensesByAccount: report.expensesByAccount.map((row) => ({ account: row.account, name: row.name, amount: row.amount.amount.toString() })),
    currency,
  };
}

export interface LocalBalanceSheet {
  readonly assets: readonly { readonly account: string; readonly name: string; readonly amount: string }[];
  readonly liabilities: readonly { readonly account: string; readonly name: string; readonly amount: string }[];
  readonly equity: readonly { readonly account: string; readonly name: string; readonly amount: string }[];
  readonly totalAssets: string;
  readonly totalLiabilities: string;
  readonly totalEquity: string;
  readonly balanced: boolean;
  readonly currency: string;
}

export async function localBalanceSheet(asOf: IsoDate, currency: string): Promise<LocalBalanceSheet> {
  const entries = await localJournalEntries();
  const sheet = balanceSheet(entries, { asOf, currency });
  return {
    assets: sheet.assets.map((row) => ({ account: row.account, name: row.name, amount: row.debit.amount.sub(row.credit.amount).toString() })),
    liabilities: sheet.liabilities.map((row) => ({ account: row.account, name: row.name, amount: row.credit.amount.sub(row.debit.amount).toString() })),
    equity: sheet.equity.map((row) => ({ account: row.account, name: row.name, amount: row.credit.amount.sub(row.debit.amount).toString() })),
    totalAssets: sheet.totalAssets.amount.toString(),
    totalLiabilities: sheet.totalLiabilities.amount.toString(),
    totalEquity: sheet.totalEquity.amount.toString(),
    balanced: sheet.balanced,
    currency,
  };
}

export async function localCashFlow(range: { from: IsoDate; to: IsoDate }, currency: string): Promise<Record<string, string>> {
  const entries = await localJournalEntries();
  const flow = cashFlow(entries, { from: range.from, to: range.to, currency });
  return {
    opening: flow.opening.amount.toString(),
    inflows: flow.inflows.amount.toString(),
    outflows: flow.outflows.amount.toString(),
    netChange: flow.netChange.amount.toString(),
    closing: flow.closing.amount.toString(),
  };
}

export async function localAccountBalances(currency: string): Promise<Map<string, Decimal>> {
  const entries = await localJournalEntries();
  const balances = new Map<string, Decimal>();
  for (const entry of entries) {
    for (const line of entry.lines) {
      balances.set(line.account, (balances.get(line.account) ?? Decimal.ZERO).add(line.debit.amount).sub(line.credit.amount));
    }
  }
  void currency;
  return balances;
}

// ---------------------------------------------------------------------------
// Reads: farming
// ---------------------------------------------------------------------------

export async function localFarms(): Promise<FarmView[]> {
  const farms = await all<Record<string, unknown>>('SELECT * FROM farms WHERE is_active = 1 ORDER BY name');
  return Promise.all(
    farms.map(async (farm) => {
      const units = await all<Record<string, unknown>>('SELECT * FROM farm_units WHERE farm_id = ? AND is_active = 1', [String(farm.id)]);
      return {
        id: String(farm.id),
        name: String(farm.name),
        address: (farm.address as string) ?? null,
        area: (farm.area as string) ?? null,
        areaUnit: (farm.area_unit as string) ?? null,
        units: units.map((unit) => ({
          id: String(unit.id),
          kind: String(unit.kind),
          name: String(unit.name),
          area: (unit.area as string) ?? null,
          areaUnit: (unit.area_unit as string) ?? null,
          capacity: (unit.capacity as string) ?? null,
          capacityUnit: (unit.capacity_unit as string) ?? null,
        })),
      } satisfies FarmView;
    }),
  );
}

export async function localCycles(status?: string): Promise<CycleView[]> {
  const rows = await all<Record<string, unknown>>(
    status ? 'SELECT * FROM production_cycles WHERE status = ? ORDER BY start_date DESC' : 'SELECT * FROM production_cycles ORDER BY start_date DESC',
    status ? [status] : [],
  );
  const business = await localBusiness();
  const currency = business?.currency ?? 'BDT';
  return Promise.all(
    rows.map(async (row) => {
      const harvested = await all<{ quantity: string }>('SELECT quantity FROM harvests WHERE cycle_id = ?', [String(row.id)]);
      const total = harvested.reduce((acc, item) => acc.add(dec(item.quantity)), Decimal.ZERO);
      // Offline cost-to-date = direct farming-event costs + allocated shared cost.
      // (The server computes the same total from `cost_sources` + `cost_allocations`;
      // both of those are derived from exactly these two mirrored sources.)
      const directCosts = await all<{ amount: string }>(`SELECT amount FROM farming_events WHERE cycle_id = ? AND amount IS NOT NULL`, [String(row.id)]);
      const allocations = await all<{ amount: string }>('SELECT amount FROM cost_allocations WHERE cycle_id = ?', [String(row.id)]);
      const costToDate = directCosts
        .reduce((acc, item) => acc.add(dec(item.amount)), Decimal.ZERO)
        .add(allocations.reduce((acc, item) => acc.add(dec(item.amount)), Decimal.ZERO));
      const revenue = await localCycleRevenue(String(row.id), currency);
      return {
        id: String(row.id),
        reference: String(row.reference ?? ''),
        farmingType: String(row.farming_type),
        title: String(row.title),
        cropOrSpecies: (row.crop_or_species as string) ?? null,
        varietyOrBreed: (row.variety_or_breed as string) ?? null,
        status: (row.status as CycleView['status']) ?? 'ACTIVE',
        farmId: String(row.farm_id),
        unitId: String(row.unit_id),
        startDate: String(row.start_date),
        expectedEndDate: (row.expected_end_date as string) ?? null,
        plannedOutput: (row.planned_output as string) ?? null,
        plannedOutputUnit: (row.planned_output_unit as string) ?? null,
        startingPopulation: (row.starting_population as string) ?? null,
        harvestedQuantity: total.toString(),
        revenue: revenue.toString(),
        costToDate: costToDate.round(2, 'HALF_UP').toString(),
      } satisfies CycleView;
    }),
  );
}

/** Revenue attributed to a cycle through the harvested products that were sold. */
async function localCycleRevenue(cycleId: string, currency: string): Promise<Decimal> {
  const products = await all<{ product_id: string }>('SELECT DISTINCT product_id FROM harvests WHERE cycle_id = ? AND product_id IS NOT NULL', [cycleId]);
  if (products.length === 0) return Decimal.ZERO;
  const ids = products.map((row) => row.product_id);
  const placeholders = ids.map(() => '?').join(', ');
  const lines = await all<{ line_total: string }>(`SELECT line_total FROM sale_lines WHERE product_id IN (${placeholders})`, ids);
  return lines.reduce((acc, line) => acc.add(dec(line.line_total)), Decimal.ZERO).round(2, 'HALF_UP');
}

export async function localFarmingEvents(cycleId?: string): Promise<FarmingEventView[]> {
  const rows = cycleId
    ? await all<Record<string, unknown>>(
        `SELECT e.*, c.reference AS cycle_reference FROM farming_events e JOIN production_cycles c ON c.id = e.cycle_id WHERE e.cycle_id = ? ORDER BY e.occurred_on DESC LIMIT 500`,
        [cycleId],
      )
    : await all<Record<string, unknown>>(
        `SELECT e.*, c.reference AS cycle_reference FROM farming_events e JOIN production_cycles c ON c.id = e.cycle_id ORDER BY e.occurred_on DESC LIMIT 500`,
      );
  return rows.map((row) => ({
    id: String(row.id),
    cycleId: String(row.cycle_id),
    cycleReference: String(row.cycle_reference ?? ''),
    eventType: String(row.event_type),
    occurredOn: String(row.occurred_on),
    quantity: (row.quantity as string) ?? null,
    unit: (row.unit as string) ?? null,
    amount: (row.amount as string) ?? null,
    currency: (row.currency as string) ?? null,
    notes: (row.notes as string) ?? null,
  }));
}

export interface LocalHarvest {
  readonly id: string;
  readonly cycleId: string;
  readonly occurredOn: string;
  readonly quantity: string;
  readonly unit: string;
  readonly costBasis: string;
  readonly unitCost: string;
  readonly currency: string;
  readonly grade: string | null;
  readonly notes: string | null;
}

export async function localHarvests(cycleId: string): Promise<LocalHarvest[]> {
  const rows = await all<Record<string, unknown>>('SELECT * FROM harvests WHERE cycle_id = ? ORDER BY occurred_on, created_at', [cycleId]);
  return rows.map((row) => ({
    id: String(row.id),
    cycleId: String(row.cycle_id),
    occurredOn: String(row.occurred_on),
    quantity: String(row.quantity ?? '0'),
    unit: String(row.unit ?? ''),
    costBasis: String(row.cost_basis ?? '0'),
    unitCost: String(row.unit_cost ?? '0'),
    currency: String(row.currency ?? 'BDT'),
    grade: (row.grade as string) ?? null,
    notes: (row.notes as string) ?? null,
  }));
}

export interface LocalCostAllocation {
  readonly id: string;
  readonly cycleId: string;
  readonly basis: string;
  readonly amount: string;
  readonly currency: string;
  readonly createdAt: string;
}

export async function localCostAllocations(cycleId?: string): Promise<LocalCostAllocation[]> {
  const rows = cycleId
    ? await all<Record<string, unknown>>('SELECT * FROM cost_allocations WHERE cycle_id = ? ORDER BY created_at DESC', [cycleId])
    : await all<Record<string, unknown>>('SELECT * FROM cost_allocations ORDER BY created_at DESC LIMIT 500');
  return rows.map((row) => ({
    id: String(row.id),
    cycleId: String(row.cycle_id),
    basis: String(row.basis),
    amount: String(row.amount ?? '0'),
    currency: String(row.currency ?? 'BDT'),
    createdAt: String(row.created_at ?? ''),
  }));
}

export interface LocalMortalityAlert {
  readonly cycleId: string;
  readonly cycleReference: string;
  readonly records: number;
  readonly totalQuantity: string;
  readonly lastOccurredOn: string;
  /** A single loss of 25 units or more is the server-side escalation threshold. */
  readonly abnormal: boolean;
}

/**
 * Offline mortality view. The server escalates a single loss of >= 25 units (and
 * the domain's `summarizeMortality` applies the same idea), so the app must show
 * the warning even with no connection — a disease outbreak is exactly when the
 * network is least likely to be available.
 */
export async function localMortalityAlerts(): Promise<LocalMortalityAlert[]> {
  const rows = await all<Record<string, unknown>>(
    `SELECT e.cycle_id AS cycle_id, c.reference AS cycle_reference, e.quantity AS quantity, e.occurred_on AS occurred_on
       FROM farming_events e JOIN production_cycles c ON c.id = e.cycle_id
      WHERE e.event_type = 'MORTALITY' ORDER BY e.occurred_on DESC`,
  );
  const grouped = new Map<string, LocalMortalityAlert>();
  for (const row of rows) {
    const cycleId = String(row.cycle_id);
    const quantity = dec(String(row.quantity ?? '0'));
    const existing = grouped.get(cycleId);
    grouped.set(cycleId, {
      cycleId,
      cycleReference: String(row.cycle_reference ?? ''),
      records: (existing?.records ?? 0) + 1,
      totalQuantity: (existing ? dec(existing.totalQuantity) : Decimal.ZERO).add(quantity).toString(),
      lastOccurredOn: existing?.lastOccurredOn ?? String(row.occurred_on ?? ''),
      abnormal: (existing?.abnormal ?? false) || quantity.gte(dec('25')),
    });
  }
  return [...grouped.values()];
}

// ---------------------------------------------------------------------------
// Writes: offline-capable business actions
// ---------------------------------------------------------------------------

/** Who is acting, resolved by the auth context. */
export interface Actor {
  readonly businessId: string;
  readonly actorId: string;
}

function normalizeMoneyInput(currency: string, value: string | undefined, fallback = '0'): string {
  return money(currency, value === undefined || value === '' ? fallback : value).amount.toString();
}

function normalizeQuantity(value: string | undefined): string {
  return dec(value === undefined || value === '' ? '0' : value).toString();
}

export interface OfflineSaleLine {
  readonly productId?: string;
  readonly description?: string;
  readonly quantity: string;
  readonly unit: string;
  readonly unitPrice: string;
  readonly discount?: string;
  readonly tax?: string;
}

export interface OfflineSaleInput {
  readonly documentDate: IsoDate;
  readonly currency: string;
  readonly customerId?: string;
  readonly locationId?: string;
  readonly accountCode?: string;
  readonly discount?: string;
  readonly cashReceived?: string;
  readonly note?: string;
  /**
   * Client id for the new sale. Generated up front by the POS screen so a photo
   * can be attached to the same id before the record has synced (attachments are
   * queued separately and must never block the transaction).
   */
  readonly aggregateId?: string;
  readonly lines: readonly OfflineSaleLine[];
}

/**
 * Queue a sale. Payload field names match `Repository.createSale` exactly,
 * because the server passes this object straight into it.
 */
export async function recordSale(actor: Actor, input: OfflineSaleInput) {
  const currency = input.currency.toUpperCase();
  const payload = {
    documentDate: input.documentDate,
    currency,
    ...(input.customerId ? { customerId: input.customerId } : {}),
    ...(input.locationId ? { locationId: input.locationId } : {}),
    ...(input.accountCode ? { accountCode: input.accountCode } : {}),
    discount: normalizeMoneyInput(currency, input.discount),
    ...(input.cashReceived !== undefined ? { cashReceived: normalizeMoneyInput(currency, input.cashReceived) } : {}),
    ...(input.note ? { note: input.note } : {}),
    lines: input.lines.map((line) => ({
      ...(line.productId ? { productId: line.productId } : {}),
      ...(line.description ? { description: line.description } : {}),
      quantity: normalizeQuantity(line.quantity),
      unit: line.unit,
      unitPrice: normalizeMoneyInput(currency, line.unitPrice),
      discount: normalizeMoneyInput(currency, line.discount),
      tax: normalizeMoneyInput(currency, line.tax),
    })),
  };

  const net = input.lines.reduce((acc, line) => {
    const gross = dec(normalizeQuantity(line.quantity)).mul(dec(normalizeMoneyInput(currency, line.unitPrice)));
    return acc.add(gross).sub(dec(normalizeMoneyInput(currency, line.discount)));
  }, Decimal.ZERO);

  return withTransaction((tx) =>
    enqueueWithin(
      tx,
      {
        businessId: actor.businessId,
        actorId: actor.actorId,
        aggregateType: 'sale',
        aggregateId: input.aggregateId ?? globalThis.crypto.randomUUID(),
        eventType: 'sale.post',
        payload,
      },
      {
        title: `${input.lines.length} item(s)`,
        subtitle: input.customerId ? 'Customer sale' : 'Counter sale',
        amount: net.round(2, 'HALF_UP').toString(),
        currency,
        documentDate: input.documentDate,
      },
    ),
  );
}

export interface OfflinePurchaseLine {
  readonly productId: string;
  readonly quantity: string;
  readonly unit: string;
  readonly unitCost: string;
  readonly tax?: string;
}

export interface OfflinePurchaseInput {
  readonly documentDate: IsoDate;
  readonly currency: string;
  readonly supplierId?: string;
  readonly locationId?: string;
  readonly accountCode?: string;
  readonly paid?: string;
  readonly note?: string;
  /** Client id, so an invoice photo can be attached before the record syncs. */
  readonly aggregateId?: string;
  readonly lines: readonly OfflinePurchaseLine[];
}

export async function recordPurchase(actor: Actor, input: OfflinePurchaseInput) {
  const currency = input.currency.toUpperCase();
  const payload = {
    documentDate: input.documentDate,
    currency,
    ...(input.supplierId ? { supplierId: input.supplierId } : {}),
    ...(input.locationId ? { locationId: input.locationId } : {}),
    ...(input.accountCode ? { accountCode: input.accountCode } : {}),
    paid: normalizeMoneyInput(currency, input.paid),
    ...(input.note ? { note: input.note } : {}),
    lines: input.lines.map((line) => ({
      productId: line.productId,
      quantity: normalizeQuantity(line.quantity),
      unit: line.unit,
      unitCost: normalizeMoneyInput(currency, line.unitCost),
      tax: normalizeMoneyInput(currency, line.tax),
    })),
  };

  const total = input.lines.reduce(
    (acc, line) => acc.add(dec(normalizeQuantity(line.quantity)).mul(dec(normalizeMoneyInput(currency, line.unitCost)))).add(dec(normalizeMoneyInput(currency, line.tax))),
    Decimal.ZERO,
  );

  return withTransaction((tx) =>
    enqueueWithin(
      tx,
      {
        businessId: actor.businessId,
        actorId: actor.actorId,
        aggregateType: 'purchase',
        aggregateId: input.aggregateId ?? globalThis.crypto.randomUUID(),
        eventType: 'purchase.receive',
        payload,
      },
      { title: `${input.lines.length} item(s)`, subtitle: input.supplierId ? 'Supplier purchase' : 'Cash purchase', amount: total.round(2, 'HALF_UP').toString(), currency, documentDate: input.documentDate },
    ),
  );
}

export async function recordExpense(
  actor: Actor,
  input: { documentDate: IsoDate; currency: string; amount: string; categoryAccount: string; accountCode?: string; paid?: boolean; note?: string; reference?: string },
) {
  return recordIncomeExpense(actor, 'EXPENSE', input);
}

export async function recordIncome(
  actor: Actor,
  input: { documentDate: IsoDate; currency: string; amount: string; categoryAccount: string; accountCode?: string; paid?: boolean; note?: string; reference?: string },
) {
  return recordIncomeExpense(actor, 'INCOME', input);
}

async function recordIncomeExpense(
  actor: Actor,
  kind: 'INCOME' | 'EXPENSE',
  input: { documentDate: IsoDate; currency: string; amount: string; categoryAccount: string; accountCode?: string; paid?: boolean; note?: string; reference?: string },
) {
  const currency = input.currency.toUpperCase();
  const amount = normalizeMoneyInput(currency, input.amount);
  const payload = {
    kind,
    categoryAccount: input.categoryAccount,
    documentDate: input.documentDate,
    currency,
    amount,
    ...(input.accountCode ? { accountCode: input.accountCode } : {}),
    ...(input.paid === undefined ? {} : { paid: input.paid }),
    ...(input.note ? { note: input.note } : {}),
    ...(input.reference ? { reference: input.reference } : {}),
  };
  return withTransaction((tx) =>
    enqueueWithin(
      tx,
      {
        businessId: actor.businessId,
        actorId: actor.actorId,
        aggregateType: 'income_expense',
        aggregateId: globalThis.crypto.randomUUID(),
        eventType: kind === 'INCOME' ? 'income.post' : 'expense.post',
        payload,
      },
      { title: kind === 'INCOME' ? 'Income' : 'Expense', subtitle: input.categoryAccount, amount, currency, documentDate: input.documentDate },
    ),
  );
}

export async function recordCustomerReceipt(
  actor: Actor,
  input: { documentDate: IsoDate; currency: string; amount: string; customerId?: string; accountCode?: string; note?: string },
) {
  const currency = input.currency.toUpperCase();
  const amount = normalizeMoneyInput(currency, input.amount);
  return withTransaction((tx) =>
    enqueueWithin(
      tx,
      {
        businessId: actor.businessId,
        actorId: actor.actorId,
        aggregateType: 'payment',
        aggregateId: globalThis.crypto.randomUUID(),
        eventType: 'receipt.post',
        payload: {
          documentDate: input.documentDate,
          currency,
          amount,
          ...(input.customerId ? { customerId: input.customerId } : {}),
          ...(input.accountCode ? { accountCode: input.accountCode } : {}),
          ...(input.note ? { note: input.note } : {}),
        },
      },
      { title: 'Customer receipt', amount, currency, documentDate: input.documentDate },
    ),
  );
}

export async function recordSupplierPayment(
  actor: Actor,
  input: { documentDate: IsoDate; currency: string; amount: string; supplierId?: string; accountCode?: string; note?: string },
) {
  const currency = input.currency.toUpperCase();
  const amount = normalizeMoneyInput(currency, input.amount);
  return withTransaction((tx) =>
    enqueueWithin(
      tx,
      {
        businessId: actor.businessId,
        actorId: actor.actorId,
        aggregateType: 'payment',
        aggregateId: globalThis.crypto.randomUUID(),
        eventType: 'payment.post',
        payload: {
          documentDate: input.documentDate,
          currency,
          amount,
          ...(input.supplierId ? { supplierId: input.supplierId } : {}),
          ...(input.accountCode ? { accountCode: input.accountCode } : {}),
          ...(input.note ? { note: input.note } : {}),
        },
      },
      { title: 'Supplier payment', amount, currency, documentDate: input.documentDate },
    ),
  );
}

export async function recordTransfer(
  actor: Actor,
  input: { documentDate: IsoDate; currency: string; amount: string; fromAccount: string; toAccount: string; note?: string },
) {
  const currency = input.currency.toUpperCase();
  const amount = normalizeMoneyInput(currency, input.amount);
  return withTransaction((tx) =>
    enqueueWithin(
      tx,
      {
        businessId: actor.businessId,
        actorId: actor.actorId,
        aggregateType: 'transfer',
        aggregateId: globalThis.crypto.randomUUID(),
        eventType: 'transfer.post',
        payload: {
          documentDate: input.documentDate,
          currency,
          amount,
          fromAccount: input.fromAccount,
          toAccount: input.toAccount,
          ...(input.note ? { note: input.note } : {}),
        },
      },
      { title: `${input.fromAccount} → ${input.toAccount}`, amount, currency, documentDate: input.documentDate },
    ),
  );
}

export async function recordPartnerCapital(
  actor: Actor,
  input: { memberId: string; kind: 'CONTRIBUTION' | 'WITHDRAWAL'; documentDate: IsoDate; currency: string; amount: string; accountCode?: string; note?: string },
) {
  const currency = input.currency.toUpperCase();
  const amount = normalizeMoneyInput(currency, input.amount);
  return withTransaction((tx) =>
    enqueueWithin(
      tx,
      {
        businessId: actor.businessId,
        actorId: actor.actorId,
        aggregateType: 'partner_capital',
        aggregateId: globalThis.crypto.randomUUID(),
        eventType: input.kind === 'CONTRIBUTION' ? 'capital.contribution' : 'capital.withdrawal',
        payload: {
          memberId: input.memberId,
          kind: input.kind,
          documentDate: input.documentDate,
          currency,
          amount,
          ...(input.accountCode ? { accountCode: input.accountCode } : {}),
          ...(input.note ? { note: input.note } : {}),
        },
      },
      { title: input.kind === 'CONTRIBUTION' ? 'Partner contribution' : 'Partner withdrawal', amount, currency, documentDate: input.documentDate },
    ),
  );
}

/**
 * Stock adjustment is **not** offered as an offline write, and that is a deliberate
 * contract decision rather than a gap.
 *
 * `SyncService.applyEvent` in `apps/api/src/sync.ts` handles `sale.post`,
 * `purchase.receive`, the finance events, the farming events, `harvest.post`,
 * `cycle.*`, `cost.allocate` and the three master-data upserts. It has **no**
 * `stock.adjust` case, so queueing an adjustment would come back as
 * `REJECTED / UNKNOWN_EVENT` — a confusing failure for something that can simply
 * be done online through `POST /api/inventory/adjust` (which is exactly what
 * `StockAdjustScreen` calls, and which asserts `inventory.adjust` plus
 * `inventory.adjust.approve` for a negative-stock override).
 *
 * If offline adjustments are ever wanted, add the event type to the server's
 * switch first, then restore a queueing helper here.
 */

// --- farming ---------------------------------------------------------------

export async function recordInputIssue(
  actor: Actor,
  input: { cycleId: string; occurredOn: IsoDate; productId: string; quantity: string; unit?: string; notes?: string; currency: string },
) {
  const payload = {
    cycleId: input.cycleId,
    eventType: 'INPUT_ISSUE',
    occurredOn: input.occurredOn,
    productId: input.productId,
    quantity: normalizeQuantity(input.quantity),
    ...(input.unit ? { unit: input.unit } : {}),
    ...(input.notes ? { notes: input.notes } : {}),
    currency: input.currency.toUpperCase(),
  };
  return withTransaction((tx) =>
    enqueueWithin(
      tx,
      {
        businessId: actor.businessId,
        actorId: actor.actorId,
        aggregateType: 'farming_event',
        aggregateId: globalThis.crypto.randomUUID(),
        eventType: 'farming.input_issue',
        payload,
      },
      { title: 'Input issue', subtitle: input.productId, amount: normalizeQuantity(input.quantity), documentDate: input.occurredOn },
    ),
  );
}

export async function recordFarmingCost(
  actor: Actor,
  input: {
    cycleId: string;
    eventType: string;
    occurredOn: IsoDate;
    currency: string;
    amount?: string;
    accountCode?: string;
    paymentAccount?: string;
    paid?: boolean;
    quantity?: string;
    unit?: string;
    notes?: string;
  },
) {
  const currency = input.currency.toUpperCase();
  return withTransaction((tx) =>
    enqueueWithin(
      tx,
      {
        businessId: actor.businessId,
        actorId: actor.actorId,
        aggregateType: 'farming_event',
        aggregateId: globalThis.crypto.randomUUID(),
        eventType: 'farming.cost',
        payload: {
          cycleId: input.cycleId,
          eventType: input.eventType,
          occurredOn: input.occurredOn,
          currency,
          ...(input.amount ? { amount: normalizeMoneyInput(currency, input.amount) } : {}),
          ...(input.accountCode ? { accountCode: input.accountCode } : {}),
          ...(input.paymentAccount ? { paymentAccount: input.paymentAccount } : {}),
          ...(input.paid === undefined ? {} : { paid: input.paid }),
          ...(input.quantity ? { quantity: normalizeQuantity(input.quantity) } : {}),
          ...(input.unit ? { unit: input.unit } : {}),
          ...(input.notes ? { notes: input.notes } : {}),
        },
      },
      {
        title: input.eventType.replace(/_/g, ' '),
        subtitle: input.notes,
        amount: input.amount ? normalizeMoneyInput(currency, input.amount) : undefined,
        currency,
        documentDate: input.occurredOn,
      },
    ),
  );
}

export async function recordObservation(
  actor: Actor,
  input: { cycleId: string; occurredOn: IsoDate; kind: string; value?: string; unit?: string; notes?: string },
) {
  return withTransaction((tx) =>
    enqueueWithin(
      tx,
      {
        businessId: actor.businessId,
        actorId: actor.actorId,
        aggregateType: 'farming_event',
        aggregateId: globalThis.crypto.randomUUID(),
        eventType: 'farming.observe',
        payload: {
          cycleId: input.cycleId,
          occurredOn: input.occurredOn,
          kind: input.kind,
          ...(input.value ? { value: input.value } : {}),
          ...(input.unit ? { unit: input.unit } : {}),
          ...(input.notes ? { notes: input.notes } : {}),
        },
      },
      { title: 'Observation', subtitle: input.kind, documentDate: input.occurredOn },
    ),
  );
}

export async function recordMortality(
  actor: Actor,
  input: { cycleId: string; occurredOn: IsoDate; currency: string; quantity: string; unit: string; reason: string; bookValue?: string; notes?: string },
) {
  const currency = input.currency.toUpperCase();
  const quantity = normalizeQuantity(input.quantity);
  // Mirror the server's escalation rule locally so the warning appears even
  // offline (the server re-checks and is the authority).
  const abnormal = dec(quantity).gte(dec('25'));
  return withTransaction((tx) =>
    enqueueWithin(
      tx,
      {
        businessId: actor.businessId,
        actorId: actor.actorId,
        aggregateType: 'farming_event',
        aggregateId: globalThis.crypto.randomUUID(),
        eventType: 'farming.mortality',
        payload: {
          cycleId: input.cycleId,
          occurredOn: input.occurredOn,
          currency,
          quantity,
          unit: input.unit,
          reason: input.reason,
          ...(input.bookValue ? { bookValue: normalizeMoneyInput(currency, input.bookValue) } : {}),
          ...(input.notes ? { notes: input.notes } : {}),
        },
      },
      {
        title: abnormal ? 'Mortality (large loss)' : 'Mortality',
        subtitle: input.reason,
        amount: quantity,
        documentDate: input.occurredOn,
      },
    ),
  );
}

export async function recordHarvest(
  actor: Actor,
  input: {
    cycleId: string;
    occurredOn: IsoDate;
    quantity: string;
    unit: string;
    method?: 'PLANNED_YIELD_PRORATA' | 'CLOSING_REMAINDER';
    productId?: string;
    locationId?: string;
    grade?: string;
    notes?: string;
    /** Client id, so a harvest photo can be attached before the record syncs. */
    aggregateId?: string;
  },
) {
  const quantity = normalizeQuantity(input.quantity);
  return withTransaction((tx) =>
    enqueueWithin(
      tx,
      {
        businessId: actor.businessId,
        actorId: actor.actorId,
        aggregateType: 'harvest',
        aggregateId: input.aggregateId ?? globalThis.crypto.randomUUID(),
        eventType: 'harvest.post',
        payload: {
          cycleId: input.cycleId,
          occurredOn: input.occurredOn,
          quantity,
          unit: input.unit,
          ...(input.method ? { method: input.method } : {}),
          ...(input.productId ? { productId: input.productId } : {}),
          ...(input.locationId ? { locationId: input.locationId } : {}),
          ...(input.grade ? { grade: input.grade } : {}),
          ...(input.notes ? { notes: input.notes } : {}),
        },
      },
      { title: 'Harvest', subtitle: input.grade, amount: quantity, documentDate: input.occurredOn },
    ),
  );
}

export async function createCycle(
  actor: Actor,
  input: {
    farmId: string;
    unitId: string;
    farmingType: string;
    title: string;
    startDate: IsoDate;
    cropOrSpecies?: string;
    varietyOrBreed?: string;
    season?: string;
    expectedEndDate?: IsoDate;
    plannedOutput?: string;
    plannedOutputUnit?: string;
    startingPopulation?: string;
    notes?: string;
  },
) {
  return withTransaction((tx) =>
    enqueueWithin(
      tx,
      {
        businessId: actor.businessId,
        actorId: actor.actorId,
        aggregateType: 'production_cycle',
        aggregateId: globalThis.crypto.randomUUID(),
        eventType: 'cycle.create',
        payload: {
          farmId: input.farmId,
          unitId: input.unitId,
          farmingType: input.farmingType,
          title: input.title,
          startDate: input.startDate,
          ...(input.cropOrSpecies ? { cropOrSpecies: input.cropOrSpecies } : {}),
          ...(input.varietyOrBreed ? { varietyOrBreed: input.varietyOrBreed } : {}),
          ...(input.season ? { season: input.season } : {}),
          ...(input.expectedEndDate ? { expectedEndDate: input.expectedEndDate } : {}),
          ...(input.plannedOutput ? { plannedOutput: normalizeQuantity(input.plannedOutput) } : {}),
          ...(input.plannedOutputUnit ? { plannedOutputUnit: input.plannedOutputUnit } : {}),
          ...(input.startingPopulation ? { startingPopulation: normalizeQuantity(input.startingPopulation) } : {}),
          ...(input.notes ? { notes: input.notes } : {}),
        },
      },
      { title: input.title, subtitle: input.farmingType, documentDate: input.startDate },
    ),
  );
}

export async function closeCycleOffline(actor: Actor, input: { cycleId: string; closedOn?: IsoDate; harvestRemainingCost?: boolean; remainingQuantity?: string }) {
  return withTransaction((tx) =>
    enqueueWithin(
      tx,
      {
        businessId: actor.businessId,
        actorId: actor.actorId,
        aggregateType: 'production_cycle',
        aggregateId: input.cycleId,
        eventType: 'cycle.close',
        payload: {
          cycleId: input.cycleId,
          ...(input.closedOn ? { closedOn: input.closedOn } : {}),
          ...(input.harvestRemainingCost === undefined ? {} : { harvestRemainingCost: input.harvestRemainingCost }),
          ...(input.remainingQuantity ? { remainingQuantity: normalizeQuantity(input.remainingQuantity) } : {}),
        },
      },
      { title: 'Close cycle', documentDate: input.closedOn },
    ),
  );
}

export async function allocateCostOffline(
  actor: Actor,
  input: { currency: string; amount: string; basis: string; incurredOn: IsoDate; note?: string; targets: readonly { cycleId: string; basisValue: string; manualPercent?: string }[] },
) {
  const currency = input.currency.toUpperCase();
  const amount = normalizeMoneyInput(currency, input.amount);
  return withTransaction((tx) =>
    enqueueWithin(
      tx,
      {
        businessId: actor.businessId,
        actorId: actor.actorId,
        aggregateType: 'cost_allocation',
        aggregateId: globalThis.crypto.randomUUID(),
        eventType: 'cost.allocate',
        payload: {
          currency,
          amount,
          basis: input.basis,
          incurredOn: input.incurredOn,
          ...(input.note ? { note: input.note } : {}),
          targets: input.targets.map((target) => ({
            cycleId: target.cycleId,
            basisValue: normalizeQuantity(target.basisValue),
            ...(target.manualPercent ? { manualPercent: normalizeQuantity(target.manualPercent) } : {}),
          })),
        },
      },
      { title: `Shared cost (${input.basis})`, amount, currency, documentDate: input.incurredOn },
    ),
  );
}

// --- master data (revision-checked on the server) ---------------------------

export async function upsertProduct(
  actor: Actor,
  input: {
    id?: string;
    baseRevision?: number | null;
    name: string;
    unit: string;
    kind?: string;
    sku?: string;
    nameBn?: string;
    salePrice?: string;
    purchasePrice?: string;
    reorderLevel?: string;
    trackLots?: boolean;
  },
) {
  return withTransaction((tx) =>
    enqueueWithin(
      tx,
      {
        businessId: actor.businessId,
        actorId: actor.actorId,
        aggregateType: 'product',
        aggregateId: input.id ?? globalThis.crypto.randomUUID(),
        eventType: 'product.upsert',
        baseRevision: input.baseRevision ?? null,
        payload: {
          ...(input.id ? { id: input.id } : {}),
          name: input.name,
          unit: input.unit,
          ...(input.kind ? { kind: input.kind } : {}),
          ...(input.sku ? { sku: input.sku } : {}),
          ...(input.nameBn ? { nameBn: input.nameBn } : {}),
          ...(input.salePrice ? { salePrice: normalizeQuantity(input.salePrice) } : {}),
          ...(input.purchasePrice ? { purchasePrice: normalizeQuantity(input.purchasePrice) } : {}),
          ...(input.reorderLevel ? { reorderLevel: normalizeQuantity(input.reorderLevel) } : {}),
          ...(input.trackLots === undefined ? {} : { trackLots: input.trackLots }),
        },
      },
      { title: input.name, subtitle: 'Product' },
    ),
  );
}

export async function upsertCustomer(
  actor: Actor,
  input: { id?: string; baseRevision?: number | null; name: string; phone?: string; email?: string; address?: string },
) {
  return withTransaction((tx) =>
    enqueueWithin(
      tx,
      {
        businessId: actor.businessId,
        actorId: actor.actorId,
        aggregateType: 'customer',
        aggregateId: input.id ?? globalThis.crypto.randomUUID(),
        eventType: 'customer.upsert',
        baseRevision: input.baseRevision ?? null,
        payload: {
          ...(input.id ? { id: input.id } : {}),
          name: input.name,
          ...(input.phone ? { phone: input.phone } : {}),
          ...(input.email ? { email: input.email } : {}),
          ...(input.address ? { address: input.address } : {}),
        },
      },
      { title: input.name, subtitle: 'Customer' },
    ),
  );
}

export async function upsertSupplier(
  actor: Actor,
  input: { id?: string; baseRevision?: number | null; name: string; phone?: string; email?: string; address?: string },
) {
  return withTransaction((tx) =>
    enqueueWithin(
      tx,
      {
        businessId: actor.businessId,
        actorId: actor.actorId,
        aggregateType: 'supplier',
        aggregateId: input.id ?? globalThis.crypto.randomUUID(),
        eventType: 'supplier.upsert',
        baseRevision: input.baseRevision ?? null,
        payload: {
          ...(input.id ? { id: input.id } : {}),
          name: input.name,
          ...(input.phone ? { phone: input.phone } : {}),
          ...(input.email ? { email: input.email } : {}),
          ...(input.address ? { address: input.address } : {}),
        },
      },
      { title: input.name, subtitle: 'Supplier' },
    ),
  );
}

// ---------------------------------------------------------------------------
// Local proposals for list screens
// ---------------------------------------------------------------------------

export interface ProposalsFor {
  readonly sales: ProposalRow[];
  readonly purchases: ProposalRow[];
  readonly expenses: ProposalRow[];
  readonly farming: ProposalRow[];
  readonly harvests: ProposalRow[];
  readonly cycles: ProposalRow[];
}

export async function localProposals(businessId: string): Promise<ProposalsFor> {
  const [sales, purchases, expenses, farming, harvests, cycles] = await Promise.all([
    proposals(businessId, 'sale'),
    proposals(businessId, 'purchase'),
    proposals(businessId, 'income_expense'),
    proposals(businessId, 'farming_event'),
    proposals(businessId, 'harvest'),
    proposals(businessId, 'production_cycle'),
  ]);
  return { sales, purchases, expenses, farming, harvests, cycles };
}

/** Kept for symmetry with the server's "unsold harvest stays inventory" note. */
export const HARVEST_NOTE = 'Unsold harvest stays in finished-goods inventory; profit is recognised only when sold.';

export interface LocalCycleProfit {
  readonly cycleId: string;
  readonly reference: string;
  readonly title: string;
  readonly farmingType: string;
  readonly currency: string;
  readonly costToDate: string;
  readonly costBreakdown: readonly { readonly kind: string; readonly amount: string }[];
  readonly harvestedQuantity: string;
  readonly outputUnit: string;
  readonly assignedToFinishedStock: string;
  readonly costRemainingInBatch: string;
  readonly revenue: string;
  readonly cogs: string;
  readonly grossProfit: string;
  readonly costInUnsoldOutput: string;
}

/**
 * Offline cycle profit.
 *
 * Mirrors `Repository.cycleProfitReport` line for line, from the mirror only:
 *  - cost = farming-event costs + allocated shared cost,
 *  - revenue/COGS are attributed through **real traceability** — the products
 *    that were actually harvested from this cycle and then sold (the server does
 *    exactly the same join, which is why the numbers agree),
 *  - unsold output stays inventory at its assigned cost.
 */
export async function localCycleProfit(cycleId: string, currency: string): Promise<LocalCycleProfit | null> {
  const cycle = await first<Record<string, unknown>>('SELECT * FROM production_cycles WHERE id = ?', [cycleId]);
  if (!cycle) return null;

  const eventCosts = await all<{ event_type: string; amount: string }>('SELECT event_type, amount FROM farming_events WHERE cycle_id = ? AND amount IS NOT NULL', [cycleId]);
  const allocations = await all<{ amount: string }>('SELECT amount FROM cost_allocations WHERE cycle_id = ?', [cycleId]);
  const harvests = await all<{ quantity: string; unit: string; cost_basis: string }>('SELECT quantity, unit, cost_basis FROM harvests WHERE cycle_id = ?', [cycleId]);

  const byKind = new Map<string, Decimal>();
  for (const row of eventCosts) byKind.set(row.event_type, (byKind.get(row.event_type) ?? Decimal.ZERO).add(dec(row.amount)));
  const allocated = allocations.reduce((acc, row) => acc.add(dec(row.amount)), Decimal.ZERO);
  if (!allocated.isZero()) byKind.set('OVERHEAD (allocated)', allocated);

  const directTotal = [...byKind.entries()].reduce((acc, [, amount]) => acc.add(amount), Decimal.ZERO);
  const costToDate = directTotal;

  const harvestedQuantity = harvests.reduce((acc, row) => acc.add(dec(row.quantity)), Decimal.ZERO);
  const assignedCost = harvests.reduce((acc, row) => acc.add(dec(row.cost_basis)), Decimal.ZERO);
  const outputUnit = harvests[0]?.unit ?? (cycle.planned_output_unit as string) ?? 'unit';

  const productIds = await all<{ product_id: string }>('SELECT DISTINCT product_id FROM harvests WHERE cycle_id = ? AND product_id IS NOT NULL', [cycleId]);
  let revenue = Decimal.ZERO;
  let cogs = Decimal.ZERO;
  if (productIds.length > 0) {
    const ids = productIds.map((row) => row.product_id);
    const placeholders = ids.map(() => '?').join(', ');
    const lines = await all<{ quantity: string; line_total: string; unit_cost: string; currency: string }>(
      `SELECT quantity, line_total, unit_cost, currency FROM sale_lines WHERE product_id IN (${placeholders})`,
      ids,
    );
    revenue = lines.reduce((acc, line) => acc.add(dec(line.line_total)), Decimal.ZERO);
    cogs = lines.reduce((acc, line) => acc.add(dec(line.unit_cost).mul(dec(line.quantity))), Decimal.ZERO);
  }

  return {
    cycleId,
    reference: String(cycle.reference ?? ''),
    title: String(cycle.title ?? ''),
    farmingType: String(cycle.farming_type ?? ''),
    currency,
    costToDate: costToDate.round(2, 'HALF_UP').toString(),
    costBreakdown: [...byKind.entries()]
      .map(([kind, amount]) => ({ kind, amount: amount.round(2, 'HALF_UP').toString() }))
      .sort((a, b) => dec(b.amount).compare(dec(a.amount))),
    harvestedQuantity: harvestedQuantity.toString(),
    outputUnit,
    assignedToFinishedStock: assignedCost.round(2, 'HALF_UP').toString(),
    costRemainingInBatch: costToDate.sub(assignedCost).round(2, 'HALF_UP').toString(),
    revenue: revenue.round(2, 'HALF_UP').toString(),
    cogs: cogs.round(2, 'HALF_UP').toString(),
    grossProfit: revenue.sub(cogs).round(2, 'HALF_UP').toString(),
    costInUnsoldOutput: assignedCost.sub(cogs).round(2, 'HALF_UP').toString(),
  };
}
