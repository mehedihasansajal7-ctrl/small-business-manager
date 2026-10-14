import { Decimal, dec } from './decimal.js';
import { type Money, addMoney, mulMoney, subMoney, zeroMoney, divMoney } from './money.js';

/**
 * Inventory is an append-only ledger. Balances and valuations are always
 * DERIVED from movements - never stored as an editable number. This is what
 * makes the shared stock count trustworthy across several partners' devices.
 */

export type MovementDirection = 'IN' | 'OUT';

export type MovementSourceType =
  | 'OPENING'
  | 'PURCHASE'
  | 'SALE'
  | 'SALE_RETURN'
  | 'PURCHASE_RETURN'
  | 'TRANSFER_OUT'
  | 'TRANSFER_IN'
  | 'ADJUSTMENT'
  | 'COUNT_CORRECTION'
  | 'INPUT_ISSUE'
  | 'HARVEST'
  | 'OUTPUT_SALE'
  | 'MORTALITY_LOSS'
  | 'SPOILAGE'
  | 'INTERNAL_USE'
  | 'REVERSAL';

export interface StockMovement {
  readonly id: string;
  readonly businessId: string;
  readonly itemId: string;
  readonly locationId: string;
  readonly direction: MovementDirection;
  /** Always positive; the direction carries the sign. */
  readonly quantity: Decimal;
  readonly unit: string;
  /** Cost per unit at the time of the movement (snapshot, never recomputed). */
  readonly unitCost: Money;
  readonly lotId?: string | null;
  readonly expiryDate?: string | null;
  readonly sourceType: MovementSourceType;
  readonly sourceId: string;
  readonly actorId: string;
  readonly deviceId: string;
  readonly eventId: string;
  readonly idempotencyKey: string;
  readonly reversalOf?: string | null;
  readonly reason?: string | null;
  readonly occurredAt: string;
  readonly createdAt: string;
}

export interface StockBalance {
  readonly itemId: string;
  readonly locationId?: string;
  readonly quantity: Decimal;
  readonly unit: string;
}

export interface Valuation {
  readonly itemId: string;
  readonly quantity: Decimal;
  readonly unit: string;
  /** Total inventory value at the chosen valuation method. */
  readonly value: Money;
  /** value / quantity, or zero when quantity is zero. */
  readonly unitCost: Money;
}

export type ValuationMethod = 'WEIGHTED_AVERAGE';

export type StockErrorCode =
  | 'NEGATIVE_STOCK'
  | 'UNIT_MISMATCH'
  | 'NON_POSITIVE_QUANTITY'
  | 'UNKNOWN_MOVEMENT'
  | 'DUPLICATE_IDEMPOTENCY_KEY'
  | 'MIXED_CURRENCY';

export class StockError extends Error {
  readonly code: StockErrorCode;
  constructor(code: StockErrorCode, message: string) {
    super(message);
    this.name = 'StockError';
    this.code = code;
  }
}

/** Money value of a movement = quantity x snapshot unit cost. */
export function movementValue(mv: Pick<StockMovement, 'quantity' | 'unitCost'>): Money {
  return mulMoney(mv.unitCost, mv.quantity);
}

function assertPositiveQuantity(mv: Pick<StockMovement, 'quantity' | 'unit'>): void {
  if (!mv.quantity.isPositive()) {
    throw new StockError('NON_POSITIVE_QUANTITY', `Movement quantity must be greater than zero, got ${mv.quantity.toString()} ${mv.unit}`);
  }
}

/** Reject a movement that would double-post the same client event. */
export function assertNoDuplicateIdempotencyKey(movements: readonly StockMovement[], idempotencyKey: string): void {
  if (movements.some((m) => m.idempotencyKey === idempotencyKey)) {
    throw new StockError('DUPLICATE_IDEMPOTENCY_KEY', `Movement with idempotency key ${idempotencyKey} was already recorded`);
  }
}

function sortChronologically(movements: readonly StockMovement[]): StockMovement[] {
  return [...movements].sort((a, b) => {
    const byTime = a.occurredAt.localeCompare(b.occurredAt);
    if (byTime !== 0) return byTime;
    return a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
  });
}

export interface BalanceFilter {
  readonly itemId: string;
  readonly locationId?: string;
  readonly lotId?: string;
}

/** Current on-hand quantity, derived from the ledger. */
export function stockBalance(movements: readonly StockMovement[], filter: BalanceFilter): StockBalance {
  let quantity = Decimal.ZERO;
  let unit = '';
  for (const mv of movements) {
    if (mv.itemId !== filter.itemId) continue;
    if (filter.locationId && mv.locationId !== filter.locationId) continue;
    if (filter.lotId && mv.lotId !== filter.lotId) continue;
    if (unit === '') unit = mv.unit;
    else if (unit !== mv.unit) throw new StockError('UNIT_MISMATCH', `Item ${filter.itemId} has movements in both ${unit} and ${mv.unit}`);
    quantity = mv.direction === 'IN' ? quantity.add(mv.quantity) : quantity.sub(mv.quantity);
  }
  return { itemId: filter.itemId, quantity, unit, ...(filter.locationId ? { locationId: filter.locationId } : {}) };
}

/** All locations for one item, with their derived balances. */
export function balanceByLocation(movements: readonly StockMovement[], itemId: string): StockBalance[] {
  const locations = new Set<string>();
  for (const mv of movements) if (mv.itemId === itemId) locations.add(mv.locationId);
  return [...locations].sort().map((locationId) => stockBalance(movements, { itemId, locationId }));
}

/**
 * Weighted-average valuation. Inbound movements set the new average; outbound
 * movements are valued at the average in force at that moment, so historical
 * COGS never silently changes when a later purchase is more expensive.
 */
export function weightedAverageValuation(
  movements: readonly StockMovement[],
  filter: { itemId: string; locationId?: string; currency: string },
): Valuation {
  const relevant = sortChronologically(movements).filter(
    (mv) => mv.itemId === filter.itemId && (!filter.locationId || mv.locationId === filter.locationId),
  );
  let quantity = Decimal.ZERO;
  let value = zeroMoney(filter.currency);
  let unit = '';

  for (const mv of relevant) {
    assertPositiveQuantity(mv);
    if (mv.unitCost.currency !== filter.currency) {
      throw new StockError('MIXED_CURRENCY', `Item ${filter.itemId} has movements in ${mv.unitCost.currency} and ${filter.currency}`);
    }
    if (unit === '') unit = mv.unit;
    else if (unit !== mv.unit) throw new StockError('UNIT_MISMATCH', `Item ${filter.itemId} has movements in both ${unit} and ${mv.unit}`);

    if (mv.direction === 'IN') {
      quantity = quantity.add(mv.quantity);
      value = addMoney(value, movementValue(mv));
    } else {
      const onHandBefore = quantity;
      if (mv.quantity.gt(onHandBefore)) {
        throw new StockError(
          'NEGATIVE_STOCK',
          `Movement ${mv.id} would drive item ${filter.itemId} negative (${onHandBefore.toString()} on hand, ${mv.quantity.toString()} out)`,
        );
      }
      const average = onHandBefore.isZero() ? zeroMoney(filter.currency) : divMoney(value, onHandBefore, 'HALF_UP');
      quantity = quantity.sub(mv.quantity);
      value = subMoney(value, mulMoney(average, mv.quantity));
    }
  }

  const unitCost = quantity.isZero() ? zeroMoney(filter.currency) : divMoney(value, quantity, 'HALF_UP');
  return { itemId: filter.itemId, quantity, unit, value, unitCost };
}

/** Which average unit cost would be used to issue `quantity` right now. */
export function currentUnitCost(
  movements: readonly StockMovement[],
  filter: { itemId: string; locationId?: string; currency: string },
): Money {
  return weightedAverageValuation(movements, filter).unitCost;
}

export interface NegativeStockCheck {
  readonly ok: boolean;
  readonly code?: StockErrorCode;
  readonly message?: string;
  readonly resultingQuantity?: Decimal;
}

/**
 * Pre-flight check used by the API and the sync worker. Negative stock is
 * refused by default; an override requires an explicit permission + reason,
 * which the caller records in the audit log.
 */
export function checkStockImpact(
  movements: readonly StockMovement[],
  candidate: Pick<StockMovement, 'itemId' | 'locationId' | 'direction' | 'quantity' | 'unit'>,
  options: { allowNegative?: boolean } = {},
): NegativeStockCheck {
  const current = stockBalance(movements, { itemId: candidate.itemId, locationId: candidate.locationId });
  if (current.unit && current.unit !== candidate.unit) {
    return { ok: false, code: 'UNIT_MISMATCH', message: `Item is tracked in ${current.unit}, movement is in ${candidate.unit}` };
  }
  const resulting = candidate.direction === 'IN' ? current.quantity.add(candidate.quantity) : current.quantity.sub(candidate.quantity);
  if (resulting.isNegative() && !options.allowNegative) {
    return {
      ok: false,
      code: 'NEGATIVE_STOCK',
      message: `Insufficient stock: ${current.quantity.toString()} ${candidate.unit} on hand, ${candidate.quantity.toString()} required`,
      resultingQuantity: resulting,
    };
  }
  return { ok: true, resultingQuantity: resulting };
}

export interface StockLot {
  readonly id: string;
  readonly itemId: string;
  readonly locationId: string;
  readonly quantity: Decimal;
  readonly unit: string;
  readonly unitCost: Money;
  readonly receivedAt: string;
  readonly expiryDate?: string | null;
}

export type LotStrategy = 'FIFO' | 'FEFO';

export interface LotIssue {
  readonly lotId: string;
  readonly quantity: Decimal;
  readonly unitCost: Money;
  readonly expiryDate?: string | null;
}

export interface LotIssuePlan {
  readonly issues: readonly LotIssue[];
  readonly totalCost: Money;
  readonly shortfall: Decimal;
}

/**
 * Choose which lots to consume. FEFO (first-expiry-first-out) is the default for
 * feed, medicine and food; FIFO for everything else.
 */
export function planLotIssue(lots: readonly StockLot[], quantity: Decimal, currency: string, strategy: LotStrategy = 'FIFO'): LotIssuePlan {
  const ordered = [...lots]
    .filter((l) => l.quantity.isPositive())
    .sort((a, b) => {
      if (strategy === 'FEFO') {
        const aExp = a.expiryDate ?? '9999-12-31';
        const bExp = b.expiryDate ?? '9999-12-31';
        if (aExp !== bExp) return aExp.localeCompare(bExp);
      }
      return a.receivedAt.localeCompare(b.receivedAt) || a.id.localeCompare(b.id);
    });

  const issues: LotIssue[] = [];
  let remaining = quantity;
  let totalCost = zeroMoney(currency);

  for (const lot of ordered) {
    if (!remaining.isPositive()) break;
    if (lot.unitCost.currency !== currency) throw new StockError('MIXED_CURRENCY', `Lot ${lot.id} is in ${lot.unitCost.currency}`);
    const take = remaining.lte(lot.quantity) ? remaining : lot.quantity;
    const issue: LotIssue = {
      lotId: lot.id,
      quantity: take,
      unitCost: lot.unitCost,
      ...(lot.expiryDate ? { expiryDate: lot.expiryDate } : {}),
    };
    issues.push(issue);
    totalCost = addMoney(totalCost, mulMoney(lot.unitCost, take));
    remaining = remaining.sub(take);
  }

  return { issues, totalCost, shortfall: remaining };
}

/** Total value of all stock for a currency, by weighted average. */
export function inventoryValuation(movements: readonly StockMovement[], itemIds: readonly string[], currency: string): Money {
  return itemIds.reduce<Money>((acc, itemId) => {
    const valuation = weightedAverageValuation(movements, { itemId, currency });
    return addMoney(acc, valuation.value);
  }, zeroMoney(currency));
}

/** Items at or below their reorder level, for the low-stock alert list. */
export function itemsBelowReorderLevel(
  movements: readonly StockMovement[],
  items: readonly { readonly id: string; readonly reorderLevel?: Decimal | null; readonly unit?: string }[],
): { itemId: string; onHand: Decimal; reorderLevel: Decimal; unit: string }[] {
  const result: { itemId: string; onHand: Decimal; reorderLevel: Decimal; unit: string }[] = [];
  for (const item of items) {
    if (!item.reorderLevel) continue;
    const balance = stockBalance(movements, { itemId: item.id });
    if (balance.quantity.lte(dec(item.reorderLevel))) {
      result.push({ itemId: item.id, onHand: balance.quantity, reorderLevel: dec(item.reorderLevel), unit: balance.unit || item.unit || '' });
    }
  }
  return result;
}

/** Build the pair of movements that undo a previously posted movement. */
export function reversalMovements(original: StockMovement, context: { id: string; eventId: string; idempotencyKey: string; actorId: string; deviceId: string; occurredAt: string; reason: string }): StockMovement {
  if (original.sourceType === 'REVERSAL') throw new StockError('UNKNOWN_MOVEMENT', 'Cannot reverse a reversal');
  return {
    ...original,
    id: context.id,
    direction: original.direction === 'IN' ? 'OUT' : 'IN',
    sourceType: 'REVERSAL',
    sourceId: original.id,
    reversalOf: original.id,
    reason: context.reason,
    actorId: context.actorId,
    deviceId: context.deviceId,
    eventId: context.eventId,
    idempotencyKey: context.idempotencyKey,
    occurredAt: context.occurredAt,
    createdAt: context.occurredAt,
  };
}
