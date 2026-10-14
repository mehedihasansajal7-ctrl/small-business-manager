import type { CacheStore } from './db';

/**
 * Raw rows from `GET /api/sync/pull` are SQLite rows (snake_case, 0/1 booleans).
 * The cache stores the SAME camelCase shape the live list endpoints return, so a
 * screen never has to care whether its data came from the network or the device.
 *
 * Anything without a normaliser is cached as-is (it is only used for counts).
 */

export type RawRow = Record<string, unknown>;
export type Normalizer = (raw: RawRow) => RawRow;

function str(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

function bool(value: unknown): boolean {
  return value === 1 || value === true || value === '1';
}

function num(value: unknown): number {
  return typeof value === 'number' ? value : Number(value ?? 0) || 0;
}

const product: Normalizer = (raw) => ({
  id: String(raw.id),
  sku: str(raw.sku),
  name: str(raw.name) ?? '',
  nameBn: str(raw.name_bn),
  kind: str(raw.kind) ?? 'PRODUCT',
  unit: str(raw.unit) ?? 'pcs',
  categoryId: str(raw.category_id),
  isActive: bool(raw.is_active),
  trackLots: bool(raw.track_lots),
  revision: num(raw.revision),
  salePrice: str(raw.sale_price),
  purchasePrice: str(raw.purchase_price),
  taxRate: str(raw.tax_rate),
  reorderLevel: str(raw.reorder_level),
  onHand: str(raw.on_hand) ?? '0',
  onHandUnit: str(raw.unit) ?? 'pcs',
  ...(raw.__pending ? { __pending: true, __eventId: raw.__eventId } : {}),
});

const customer: Normalizer = (raw) => ({
  id: String(raw.id),
  name: str(raw.name) ?? '',
  phone: str(raw.phone),
  email: str(raw.email),
  receivable: str(raw.receivable) ?? str(raw.opening_balance) ?? '0',
  ...(raw.__pending ? { __pending: true, __eventId: raw.__eventId } : {}),
});

const supplier: Normalizer = (raw) => ({
  id: String(raw.id),
  name: str(raw.name) ?? '',
  phone: str(raw.phone),
  payable: str(raw.payable) ?? str(raw.opening_balance) ?? '0',
  ...(raw.__pending ? { __pending: true, __eventId: raw.__eventId } : {}),
});

const location: Normalizer = (raw) => ({
  id: String(raw.id),
  name: str(raw.name) ?? '',
  kind: str(raw.kind) ?? 'STORE',
  address: str(raw.address),
  isDefault: bool(raw.is_default),
  isActive: raw.is_active === undefined ? true : bool(raw.is_active),
});

const sale: Normalizer = (raw) => ({
  id: String(raw.id),
  reference: str(raw.reference) ?? '',
  customerId: str(raw.customer_id),
  documentDate: str(raw.document_date) ?? '',
  currency: str(raw.currency) ?? 'BDT',
  gross: str(raw.gross) ?? '0',
  discount: str(raw.discount) ?? '0',
  net: str(raw.net) ?? '0',
  cashReceived: str(raw.cash_received) ?? '0',
  receivable: str(raw.receivable) ?? '0',
  cogs: str(raw.cogs) ?? undefined,
  lines: Array.isArray(raw.lines) ? raw.lines : [],
  ...(raw.__pending ? { __pending: true, __eventId: raw.__eventId } : {}),
});

const purchase: Normalizer = (raw) => ({
  id: String(raw.id),
  reference: str(raw.reference) ?? '',
  supplierId: str(raw.supplier_id),
  documentDate: str(raw.document_date) ?? '',
  currency: str(raw.currency) ?? 'BDT',
  subtotal: str(raw.subtotal) ?? undefined,
  tax: str(raw.tax) ?? undefined,
  total: str(raw.total) ?? '0',
  paid: str(raw.paid) ?? '0',
  payable: str(raw.payable) ?? '0',
  lines: Array.isArray(raw.lines) ? raw.lines : [],
  ...(raw.__pending ? { __pending: true, __eventId: raw.__eventId } : {}),
});

const cycle: Normalizer = (raw) => ({
  id: String(raw.id),
  reference: str(raw.reference) ?? '',
  farmingType: str(raw.farming_type) ?? 'CROP',
  title: str(raw.title) ?? '',
  cropOrSpecies: str(raw.crop_or_species),
  varietyOrBreed: str(raw.variety_or_breed),
  status: str(raw.status) ?? 'ACTIVE',
  farmId: str(raw.farm_id) ?? '',
  unitId: str(raw.unit_id) ?? '',
  startDate: str(raw.start_date) ?? '',
  expectedEndDate: str(raw.expected_end_date),
  plannedOutput: str(raw.planned_output),
  plannedOutputUnit: str(raw.planned_output_unit),
  startingPopulation: str(raw.starting_population),
  harvestedQuantity: str(raw.harvested_quantity) ?? '0',
  costToDate: str(raw.cost_to_date) ?? undefined,
  revenue: str(raw.revenue) ?? undefined,
  cogs: str(raw.cogs) ?? undefined,
  grossProfit: str(raw.gross_profit) ?? undefined,
});

const farm: Normalizer = (raw) => ({
  id: String(raw.id),
  name: str(raw.name) ?? '',
  address: str(raw.address),
  area: str(raw.area),
  areaUnit: str(raw.area_unit),
  units: Array.isArray(raw.units) ? raw.units : [],
});

const inventory: Normalizer = (raw) => ({
  itemId: String(raw.itemId ?? raw.item_id),
  name: str(raw.name) ?? '',
  unit: str(raw.unit) ?? 'pcs',
  onHand: str(raw.onHand ?? raw.on_hand) ?? '0',
  reorderLevel: str(raw.reorderLevel ?? raw.reorder_level),
  belowReorder: raw.belowReorder === undefined ? false : raw.belowReorder === true,
  unitCost: str(raw.unitCost ?? raw.unit_cost) ?? undefined,
  value: str(raw.value) ?? undefined,
});

export const NORMALIZERS: Partial<Record<CacheStore, Normalizer>> = Object.freeze({
  products: product,
  customers: customer,
  suppliers: supplier,
  locations: location,
  sales: sale,
  purchases: purchase,
  cycles: cycle,
  farms: farm,
  inventory,
});

/** Normalise rows for a store (identity when there is no normaliser). */
export function normalizeRows(store: CacheStore, rows: readonly RawRow[]): RawRow[] {
  const normalizer = NORMALIZERS[store];
  return rows.map((row) => {
    try {
      return normalizer ? normalizer(row) : row;
    } catch {
      return row;
    }
  });
}
