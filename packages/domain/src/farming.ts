import { Decimal, dec } from './decimal.js';
import { type Money, addMoney, money, mulMoney, subMoney, zeroMoney, divMoney } from './money.js';

/**
 * Farming domain: production cycles, cost assignment, harvest cost basis and
 * batch profitability. Costs are never written down twice: an input that was
 * bought into stock becomes a batch cost only when it is ISSUED to the batch.
 */

export type FarmingType = 'CROP' | 'HORTICULTURE' | 'LIVESTOCK' | 'POULTRY' | 'AQUACULTURE';

export const FARMING_TYPES: readonly { readonly type: FarmingType; readonly name: string; readonly nameBn: string }[] = Object.freeze([
  { type: 'CROP', name: 'Crop farming', nameBn: 'ফসল চাষ' },
  { type: 'HORTICULTURE', name: 'Horticulture / greenhouse', nameBn: 'উদ্যান / গ্রিনহাউস' },
  { type: 'LIVESTOCK', name: 'Livestock', nameBn: 'পশুপালন' },
  { type: 'POULTRY', name: 'Poultry', nameBn: 'পোল্ট্রি' },
  { type: 'AQUACULTURE', name: 'Fish / aquaculture', nameBn: 'মাছ চাষ' },
]);

export type FarmUnitKind =
  | 'PLOT'
  | 'FIELD'
  | 'GREENHOUSE'
  | 'BARN'
  | 'PEN'
  | 'POULTRY_HOUSE'
  | 'POND'
  | 'TANK'
  | 'OTHER';

export const FARM_UNIT_KINDS: readonly { readonly kind: FarmUnitKind; readonly name: string; readonly nameBn: string }[] = Object.freeze([
  { kind: 'PLOT', name: 'Plot', nameBn: 'প্লট' },
  { kind: 'FIELD', name: 'Field', nameBn: 'জমি' },
  { kind: 'GREENHOUSE', name: 'Greenhouse', nameBn: 'গ্রিনহাউস' },
  { kind: 'BARN', name: 'Barn / shed', nameBn: 'গোয়ালঘর' },
  { kind: 'PEN', name: 'Pen', nameBn: 'খোঁয়াড়' },
  { kind: 'POULTRY_HOUSE', name: 'Poultry house', nameBn: 'মুরগিঘর' },
  { kind: 'POND', name: 'Pond', nameBn: 'পুকুর' },
  { kind: 'TANK', name: 'Tank / cage', nameBn: 'ট্যাংক' },
  { kind: 'OTHER', name: 'Other unit', nameBn: 'অন্যান্য' },
]);

export interface FarmUnit {
  readonly id: string;
  readonly businessId: string;
  readonly farmId: string;
  readonly kind: FarmUnitKind;
  readonly name: string;
  readonly area?: Decimal | null;
  readonly areaUnit?: string | null;
  readonly capacity?: Decimal | null;
  readonly capacityUnit?: string | null;
}

export type CycleStatus = 'PLANNED' | 'ACTIVE' | 'HARVESTING' | 'CLOSED' | 'CANCELLED';

export interface ProductionCycle {
  readonly id: string;
  readonly businessId: string;
  readonly farmId: string;
  readonly unitId: string;
  readonly reference: string;
  readonly farmingType: FarmingType;
  readonly title: string;
  readonly cropOrSpecies?: string | null;
  readonly varietyOrBreed?: string | null;
  readonly season?: string | null;
  readonly responsibleMemberId?: string | null;
  readonly startDate: string;
  readonly expectedEndDate?: string | null;
  readonly actualEndDate?: string | null;
  readonly plannedOutput?: Decimal | null;
  readonly plannedOutputUnit?: string | null;
  readonly status: CycleStatus;
  /** Starting population for livestock/poultry/aquaculture. */
  readonly startingPopulation?: Decimal | null;
  readonly notes?: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type AllocationBasis = 'ACTUAL_USAGE' | 'AREA' | 'TIME' | 'OUTPUT_QTY' | 'ANIMAL_COUNT' | 'BIOMASS' | 'MANUAL_PERCENT';

export const ALLOCATION_BASES: readonly { readonly basis: AllocationBasis; readonly name: string; readonly description: string }[] = Object.freeze([
  { basis: 'ACTUAL_USAGE', name: 'Actual usage', description: 'Metered or weighed quantity actually consumed by the batch' },
  { basis: 'AREA', name: 'Area', description: 'Share of the cultivated area' },
  { basis: 'TIME', name: 'Time', description: 'Share of machine/labour hours or days' },
  { basis: 'OUTPUT_QTY', name: 'Output quantity', description: 'Share of the output produced' },
  { basis: 'ANIMAL_COUNT', name: 'Animal count', description: 'Head count or bird count' },
  { basis: 'BIOMASS', name: 'Biomass', description: 'Estimated live weight / biomass' },
  { basis: 'MANUAL_PERCENT', name: 'Manual percentage', description: 'Owner-approved percentages (must total 100%)' },
]);

export type CostKind =
  | 'INPUT_ISSUE'
  | 'DIRECT_LABOUR'
  | 'MACHINERY_FUEL'
  | 'VETERINARY'
  | 'UTILITIES'
  | 'PACKAGING'
  | 'TRANSPORT'
  | 'OVERHEAD'
  | 'OTHER_DIRECT';

export interface CostSource {
  readonly id: string;
  readonly businessId: string;
  readonly cycleId?: string | null;
  readonly kind: CostKind;
  readonly amount: Money;
  /** When true the cost is shared and must be allocated across cycles. */
  readonly shared: boolean;
  readonly incurredOn: string;
  /** Reference to the stock movement / expense that produced this cost. */
  readonly sourceType: string;
  readonly sourceId: string;
  readonly note?: string | null;
  /** Set once the cost has been allocated (or explicitly left unallocated). */
  readonly allocatedAt?: string | null;
}

export interface AllocationTarget {
  readonly cycleId: string;
  /** Value used for weighting (usage, area, hours, count, biomass). */
  readonly basisValue: Decimal;
  /** Only for MANUAL_PERCENT. Sum of all manualPercent must not exceed 100. */
  readonly manualPercent?: Decimal;
}

export interface CostAllocationShare {
  readonly cycleId: string;
  readonly basisValue: Decimal;
  readonly shareRatio: Decimal;
  readonly amount: Money;
}

export interface CostAllocationResult {
  readonly costSourceId: string;
  readonly basis: AllocationBasis;
  readonly currency: string;
  readonly totalCost: Money;
  readonly shares: readonly CostAllocationShare[];
  readonly allocatedTotal: Money;
  /** Cost that could not be allocated (e.g. MANUAL_PERCENT totalling < 100%). */
  readonly unallocated: Money;
}

export type FarmingErrorCode =
  | 'NO_TARGETS'
  | 'ZERO_BASIS'
  | 'INVALID_PERCENT'
  | 'INVALID_QUANTITY'
  | 'CURRENCY_MISMATCH'
  | 'COST_ALREADY_ALLOCATED'
  | 'OVER_ALLOCATION';

export class FarmingError extends Error {
  readonly code: FarmingErrorCode;
  constructor(code: FarmingErrorCode, message: string) {
    super(message);
    this.name = 'FarmingError';
    this.code = code;
  }
}

/**
 * Allocate one cost across cycles.
 *
 * - Shares are computed with exact decimals, then rounded to the currency's
 *   minor unit using the largest-remainder method, so the shares ALWAYS add up
 *   to the allocated total with no lost or invented poysha.
 * - Any rounding residual is deterministic: it goes to the target with the
 *   largest basis value (ties broken by lowest cycleId).
 * - `MANUAL_PERCENT` below 100% leaves the remainder explicitly UNALLOCATED so
 *   a cost can never disappear silently.
 */
export function allocateCost(
  amount: Money,
  targets: readonly AllocationTarget[],
  basis: AllocationBasis,
  options: { costSourceId?: string } = {},
): CostAllocationResult {
  if (targets.length === 0) throw new FarmingError('NO_TARGETS', 'At least one allocation target is required');

  const currency = amount.currency;
  const weighted = targets.map((t) => {
    if (basis === 'MANUAL_PERCENT') {
      const percent = dec(t.manualPercent ?? 0);
      if (percent.isNegative() || percent.gt(100)) throw new FarmingError('INVALID_PERCENT', `Manual percent for ${t.cycleId} must be between 0 and 100`);
      return { target: t, weight: percent };
    }
    if (t.basisValue.isNegative()) throw new FarmingError('INVALID_QUANTITY', `Basis value for ${t.cycleId} must not be negative`);
    return { target: t, weight: t.basisValue };
  });

  const totalWeight = weighted.reduce<Decimal>((acc, w) => acc.add(w.weight), Decimal.ZERO);
  if (totalWeight.isZero()) throw new FarmingError('ZERO_BASIS', `All ${basis} basis values are zero; nothing to allocate against`);

  const base = basis === 'MANUAL_PERCENT' ? mulMoney(amount, totalWeight.div(100, 10, 'HALF_UP')) : amount;
  const shares = base.amount.allocate(weighted.map((w) => w.weight));

  const rows: CostAllocationShare[] = weighted.map((w, index) => ({
    cycleId: w.target.cycleId,
    basisValue: basis === 'MANUAL_PERCENT' ? dec(w.target.manualPercent ?? 0) : w.target.basisValue,
    shareRatio: w.weight.div(totalWeight, 10, 'HALF_UP'),
    amount: money(currency, shares[index] as Decimal),
  }));

  // Deterministic residual handling: the largest weight absorbs the rounding
  // difference (already handled by `allocate`), but keep the ordering stable.
  rows.sort((a, b) => {
    const byWeight = b.basisValue.compare(a.basisValue);
    return byWeight !== 0 ? byWeight : a.cycleId.localeCompare(b.cycleId);
  });
  const ordered = [...rows].sort((a, b) => a.cycleId.localeCompare(b.cycleId));

  const allocatedTotal = ordered.reduce<Money>((acc, r) => addMoney(acc, r.amount), zeroMoney(currency));
  const unallocated = subMoney(amount, allocatedTotal);
  if (unallocated.amount.isNegative()) {
    throw new FarmingError('OVER_ALLOCATION', `Allocation exceeded the cost by ${unallocated.amount.abs().toString()} ${currency}`);
  }

  return {
    costSourceId: options.costSourceId ?? 'unassigned',
    basis,
    currency,
    totalCost: amount,
    shares: ordered,
    allocatedTotal,
    unallocated,
  };
}

export interface HarvestCostState {
  readonly cycleId: string;
  /** Cost accumulated on the batch so far (inputs issued, labour, overhead). */
  readonly costToDate: Money;
  /** Output already harvested in earlier events. */
  readonly harvestedQuantityToDate: Decimal;
  /** Cost already released to finished stock by earlier harvests. */
  readonly assignedCostToDate: Money;
  readonly outputUnit: string;
}

export type HarvestCostingMethod =
  /**
   * Cost per unit = cost-to-date / PLANNED total output. Use this while the
   * cycle is still producing: a partial harvest only ever releases its share,
   * so the whole batch cost can never land on one partial harvest.
   */
  | 'PLANNED_YIELD_PRORATA'
  /** Release everything still unassigned. Use for the final harvest / cycle close. */
  | 'CLOSING_REMAINDER';

export interface HarvestCostAssignment {
  readonly costPerUnit: Money;
  readonly assignedCost: Money;
  /** True when the assignment was capped by the remaining cost-to-date. */
  readonly capped: boolean;
  readonly nextState: HarvestCostState;
}

/**
 * Assign a share of batch cost to THIS harvest.
 *
 * Prevents the classic mistake of assigning the whole batch cost to every
 * partial harvest: the cost already released by earlier harvests is subtracted
 * first, and the remaining cost is spread over the planned output.
 */
export function assignHarvestCost(
  state: HarvestCostState,
  thisHarvestQuantity: Decimal,
  method: HarvestCostingMethod = 'PLANNED_YIELD_PRORATA',
  options: { plannedOutput?: Decimal } = {},
): HarvestCostAssignment {
  if (!thisHarvestQuantity.isPositive()) throw new FarmingError('INVALID_QUANTITY', 'Harvest quantity must be greater than zero');
  const currency = state.costToDate.currency;
  const remainingCost = subMoney(state.costToDate, state.assignedCostToDate);

  let assignedCost: Money;
  if (method === 'CLOSING_REMAINDER') {
    assignedCost = remainingCost;
  } else {
    const planned = options.plannedOutput;
    if (!planned || !planned.isPositive()) {
      throw new FarmingError('INVALID_QUANTITY', 'plannedOutput (greater than zero) is required for PLANNED_YIELD_PRORATA costing');
    }
    const costPerUnitForPlan = divMoney(state.costToDate, planned, 'HALF_UP');
    assignedCost = mulMoney(costPerUnitForPlan, thisHarvestQuantity);
  }

  let capped = false;
  if (assignedCost.amount.gt(remainingCost.amount)) {
    assignedCost = remainingCost;
    capped = true;
  }
  if (assignedCost.amount.isNegative()) {
    assignedCost = zeroMoney(currency);
    capped = true;
  }

  return {
    costPerUnit: assignedCost.amount.isZero() ? zeroMoney(currency) : divMoney(assignedCost, thisHarvestQuantity, 'HALF_UP'),
    assignedCost,
    capped,
    nextState: {
      ...state,
      harvestedQuantityToDate: state.harvestedQuantityToDate.add(thisHarvestQuantity),
      assignedCostToDate: addMoney(state.assignedCostToDate, assignedCost),
    },
  };
}

export interface CycleProfit {
  readonly cycleId: string;
  readonly currency: string;
  /** Revenue recognised from sales of this cycle's output. */
  readonly revenue: Money;
  /** Cost of the sold quantity. */
  readonly cogs: Money;
  readonly grossProfit: Money;
  /** Cost still sitting in unsold output stock + growing batch (WIP). */
  readonly costInUnsoldOutput: Money;
  readonly costRemainingInBatch: Money;
  readonly totalCostToDate: Money;
  readonly harvestedQuantity: Decimal;
  readonly soldQuantity: Decimal;
  readonly unsoldQuantity: Decimal;
  readonly outputUnit: string;
  /** Revenue - COGS. Not inflated by unsold stock. */
  readonly marginPercent: Decimal;
}

/**
 * Batch profitability. Distinguishes:
 *   - margin on what was actually SOLD (accrual profit), from
 *   - cost tied up in unsold output and in the still-growing batch.
 */
export function cycleProfit(input: {
  cycleId: string;
  currency: string;
  revenue: Money;
  soldCogs: Money;
  costToDate: Money;
  assignedCostToFinishedStock: Money;
  costReleasedWithSales: Money;
  harvestedQuantity: Decimal;
  soldQuantity: Decimal;
  outputUnit: string;
}): CycleProfit {
  const grossProfit = subMoney(input.revenue, input.soldCogs);
  const costInUnsoldOutput = subMoney(input.assignedCostToFinishedStock, input.costReleasedWithSales);
  const costRemainingInBatch = subMoney(input.costToDate, input.assignedCostToFinishedStock);
  const unsoldQuantity = input.harvestedQuantity.sub(input.soldQuantity);
  const marginPercent = input.revenue.amount.isZero()
    ? Decimal.ZERO
    : grossProfit.amount.div(input.revenue.amount, 6, 'HALF_UP').mul(100).round(2, 'HALF_UP');

  return {
    cycleId: input.cycleId,
    currency: input.currency,
    revenue: input.revenue,
    cogs: input.soldCogs,
    grossProfit,
    costInUnsoldOutput: costInUnsoldOutput.amount.isNegative() ? zeroMoney(input.currency) : costInUnsoldOutput,
    costRemainingInBatch: costRemainingInBatch.amount.isNegative() ? zeroMoney(input.currency) : costRemainingInBatch,
    totalCostToDate: input.costToDate,
    harvestedQuantity: input.harvestedQuantity,
    soldQuantity: input.soldQuantity,
    unsoldQuantity,
    outputUnit: input.outputUnit,
    marginPercent,
  };
}

export interface MortalityRecord {
  readonly cycleId: string;
  readonly occurredOn: string;
  readonly quantity: Decimal;
  readonly reason: string;
  /** Book value of what was lost, when known (feed/livestock cost). */
  readonly bookValue?: Money | null;
  /** True for a mass/abnormal event that must be escalated. */
  readonly abnormal?: boolean;
}

export interface MortalitySummary {
  readonly cycleId: string;
  readonly startingPopulation: Decimal;
  readonly totalLoss: Decimal;
  readonly livePopulation: Decimal;
  readonly mortalityPercent: Decimal;
  readonly lossValue: Money;
  readonly abnormalEvents: number;
  /** True when recorded loss exceeds the configured warning threshold. */
  readonly alert: boolean;
}

/** Mortality/loss accounting + the alert threshold used by the dashboard. */
export function summarizeMortality(
  startingPopulation: Decimal,
  records: readonly MortalityRecord[],
  currency: string,
  options: { warningPercent?: Decimal } = {},
): MortalitySummary {
  const warning = options.warningPercent ?? dec('10');
  const totalLoss = records.reduce<Decimal>((acc, r) => acc.add(r.quantity), Decimal.ZERO);
  const lossValue = records.reduce<Money>((acc, r) => (r.bookValue ? addMoney(acc, r.bookValue) : acc), zeroMoney(currency));
  const livePopulation = startingPopulation.sub(totalLoss);
  const mortalityPercent = startingPopulation.isZero() ? Decimal.ZERO : totalLoss.div(startingPopulation, 6, 'HALF_UP').mul(100).round(2, 'HALF_UP');
  return {
    cycleId: records[0]?.cycleId ?? '',
    startingPopulation,
    totalLoss,
    livePopulation,
    mortalityPercent,
    lossValue,
    abnormalEvents: records.filter((r) => r.abnormal).length,
    alert: mortalityPercent.gt(warning),
  };
}

/** Feed conversion ratio = feed consumed / weight gained (typical 1.4-2.0). */
export function feedConversionRatio(feedConsumed: Decimal, weightGained: Decimal): Decimal {
  if (!weightGained.isPositive()) throw new FarmingError('INVALID_QUANTITY', 'Weight gained must be greater than zero to compute FCR');
  return feedConsumed.div(weightGained, 2, 'HALF_UP');
}

/** Yield per unit area, e.g. kg per decimal / hectare. */
export function yieldPerArea(output: Decimal, area: Decimal): Decimal {
  if (!area.isPositive()) throw new FarmingError('INVALID_QUANTITY', 'Area must be greater than zero to compute yield');
  return output.div(area, 2, 'HALF_UP');
}

/** Output per live animal/bird/fish (e.g. eggs per bird, litres per cow per day). */
export function outputPerAnimal(output: Decimal, population: Decimal): Decimal {
  if (!population.isPositive()) throw new FarmingError('INVALID_QUANTITY', 'Population must be greater than zero');
  return output.div(population, 2, 'HALF_UP');
}

export interface CycleCostLedgerRow {
  readonly kind: CostKind;
  readonly label: string;
  readonly amount: Money;
  readonly shareOfTotal: Decimal;
}

/**
 * Batch cost ledger: groups every cost assigned to a cycle exactly once,
 * including allocated shared overhead, and returns per-kind subtotals with
 * each kind's share of the batch total.
 */
export function cycleCostLedger(
  costs: readonly CostSource[],
  currency: string,
  allocatedShared: readonly { readonly kind: CostKind; readonly amount: Money }[] = [],
): CycleCostLedgerRow[] {
  const rows = new Map<CostKind, Money>();
  const addTo = (kind: CostKind, amount: Money) => rows.set(kind, addMoney(rows.get(kind) ?? zeroMoney(currency), amount));

  for (const cost of costs) {
    if (cost.shared) continue;
    if (!cost.cycleId) continue;
    addTo(cost.kind, cost.amount);
  }
  for (const allocated of allocatedShared) addTo(allocated.kind, allocated.amount);

  const total = [...rows.values()].reduce<Money>((acc, v) => addMoney(acc, v), zeroMoney(currency));
  return [...rows.entries()]
    .map(([kind, amount]) => ({
      kind,
      label: costKindLabel(kind),
      amount,
      shareOfTotal: total.amount.isZero() ? Decimal.ZERO : amount.amount.div(total.amount, 6, 'HALF_UP').mul(100).round(2, 'HALF_UP'),
    }))
    .sort((a, b) => b.amount.amount.compare(a.amount.amount));
}

export function costKindLabel(kind: CostKind): string {
  return kind.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
}

/** Ledger for a single shared cost split across cycles. */
export function sharedCostLedgerRow(kind: CostKind, share: CostAllocationShare): CycleCostLedgerRow {
  return {
    kind,
    label: `${costKindLabel(kind)} (allocated)`,
    amount: share.amount,
    shareOfTotal: share.shareRatio.mul(100).round(2, 'HALF_UP'),
  };
}

/** Aggregates the dashboard "active cycles" summary. */
export interface FarmingSummary {
  readonly activeCycles: number;
  readonly totalCostToDate: Money;
  readonly expectedOutputValue: Money;
  readonly mortalityAlerts: number;
  readonly upcomingHarvests: number;
}

export function farmingSummary(input: {
  cycles: readonly ProductionCycle[];
  totalCostToDate: Money;
  expectedOutputValue: Money;
  mortalityAlerts?: number;
  upcomingHarvests?: number;
}): FarmingSummary {
  return {
    activeCycles: input.cycles.filter((c) => c.status === 'ACTIVE' || c.status === 'HARVESTING').length,
    totalCostToDate: input.totalCostToDate,
    expectedOutputValue: input.expectedOutputValue,
    mortalityAlerts: input.mortalityAlerts ?? 0,
    upcomingHarvests: input.upcomingHarvests ?? 0,
  };
}
