import { describe, expect, it } from 'vitest';
import { dec } from '../src/decimal.js';
import { money } from '../src/money.js';
import {
  StockError,
  assertNoDuplicateIdempotencyKey,
  balanceByLocation,
  checkStockImpact,
  currentUnitCost,
  inventoryValuation,
  itemsBelowReorderLevel,
  movementValue,
  planLotIssue,
  reversalMovements,
  stockBalance,
  weightedAverageValuation,
  type StockLot,
  type StockMovement,
} from '../src/inventory.js';

let seq = 0;

function movement(overrides: Partial<StockMovement> & Pick<StockMovement, 'direction' | 'quantity'>): StockMovement {
  seq += 1;
  const id = `mv-${seq}`;
  return {
    id,
    businessId: 'biz-1',
    itemId: 'item-rice',
    locationId: 'loc-main',
    unit: 'kg',
    unitCost: money('BDT', '10'),
    sourceType: 'PURCHASE',
    sourceId: `doc-${seq}`,
    actorId: 'user-1',
    deviceId: 'dev-1',
    eventId: `evt-${seq}`,
    idempotencyKey: `idem-${seq}`,
    occurredAt: `2026-01-${String(seq).padStart(2, '0')}T00:00:00.000Z`,
    createdAt: `2026-01-${String(seq).padStart(2, '0')}T00:00:00.000Z`,
    ...overrides,
  };
}

describe('stock ledger balances', () => {
  it('derives the balance from movements only', () => {
    const movements = [
      movement({ direction: 'IN', quantity: dec('100'), unitCost: money('BDT', '10') }),
      movement({ direction: 'OUT', quantity: dec('30'), sourceType: 'SALE' }),
    ];
    expect(stockBalance(movements, { itemId: 'item-rice' }).quantity.toString()).toBe('70');
  });

  it('summarises per location', () => {
    const movements = [
      movement({ direction: 'IN', quantity: dec('10'), locationId: 'loc-a' }),
      movement({ direction: 'IN', quantity: dec('5'), locationId: 'loc-b' }),
      movement({ direction: 'OUT', quantity: dec('4'), locationId: 'loc-a' }),
    ];
    const byLocation = balanceByLocation(movements, 'item-rice');
    expect(byLocation.map((b) => [b.locationId, b.quantity.toString()])).toEqual([
      ['loc-a', '6'],
      ['loc-b', '5'],
    ]);
  });

  it('refuses a movement that would make stock negative', () => {
    const movements = [movement({ direction: 'IN', quantity: dec('10') })];
    const candidate = { itemId: 'item-rice', locationId: 'loc-main', direction: 'OUT' as const, quantity: dec('20'), unit: 'kg' };
    const check = checkStockImpact(movements, candidate);
    expect(check.ok).toBe(false);
    expect(check.code).toBe('NEGATIVE_STOCK');
    expect(check.message).toMatch(/Insufficient stock/);

    expect(() => weightedAverageValuation([...movements, movement({ direction: 'OUT', quantity: dec('20') })], { itemId: 'item-rice', currency: 'BDT' })).toThrow(StockError);
  });

  it('flags a unit mismatch rather than mixing units', () => {
    const movements = [movement({ direction: 'IN', quantity: dec('10'), unit: 'kg' })];
    const check = checkStockImpact(movements, { itemId: 'item-rice', locationId: 'loc-main', direction: 'OUT', quantity: dec('1'), unit: 'l' });
    expect(check.ok).toBe(false);
    expect(check.code).toBe('UNIT_MISMATCH');
    expect(() => stockBalance([...movements, movement({ direction: 'IN', quantity: dec('1'), unit: 'l' })], { itemId: 'item-rice' })).toThrow(/both kg and l/);
  });

  it('rejects non-positive quantities', () => {
    expect(() => weightedAverageValuation([movement({ direction: 'IN', quantity: dec('0') })], { itemId: 'item-rice', currency: 'BDT' })).toThrow(/greater than zero/);
  });

  it('detects idempotency key reuse', () => {
    const movements = [movement({ direction: 'IN', quantity: dec('5') })];
    const key = movements[0]!.idempotencyKey;
    expect(() => assertNoDuplicateIdempotencyKey(movements, key)).toThrow(/already recorded/);
    expect(() => assertNoDuplicateIdempotencyKey(movements, 'fresh-key')).not.toThrow();
  });
});

describe('weighted-average valuation', () => {
  it('recomputes the average on each inbound movement', () => {
    const movements = [
      movement({ direction: 'IN', quantity: dec('100'), unitCost: money('BDT', '10'), occurredAt: '2026-01-01T00:00:00.000Z' }),
      movement({ direction: 'IN', quantity: dec('100'), unitCost: money('BDT', '14'), occurredAt: '2026-01-02T00:00:00.000Z' }),
    ];
    const valuation = weightedAverageValuation(movements, { itemId: 'item-rice', currency: 'BDT' });
    expect(valuation.quantity.toString()).toBe('200');
    expect(valuation.value.amount.toString()).toBe('2400.00');
    expect(valuation.unitCost.amount.toString()).toBe('12.00');
  });

  it('values an issue at the average in force at that moment, and never changes history', () => {
    const movements = [
      movement({ direction: 'IN', quantity: dec('100'), unitCost: money('BDT', '10'), occurredAt: '2026-01-01T00:00:00.000Z' }),
      movement({ direction: 'OUT', quantity: dec('50'), sourceType: 'SALE', occurredAt: '2026-01-02T00:00:00.000Z' }),
      movement({ direction: 'IN', quantity: dec('100'), unitCost: money('BDT', '20'), occurredAt: '2026-01-03T00:00:00.000Z' }),
    ];
    // After issuing 50 @ 10 (value 500) and buying 100 @ 20 (value 2000):
    // quantity 150, value 1000 - 500 + 2000 = 2500, average 16.666...
    const valuation = weightedAverageValuation(movements, { itemId: 'item-rice', currency: 'BDT' });
    expect(valuation.quantity.toString()).toBe('150');
    expect(valuation.value.amount.toString()).toBe('2500.00');
    expect(valuation.unitCost.amount.toString()).toBe('16.67');

    // Asking for the cost "as of" before the second purchase still shows 10.
    const earlier = weightedAverageValuation(movements.slice(0, 2), { itemId: 'item-rice', currency: 'BDT' });
    expect(earlier.unitCost.amount.toString()).toBe('10.00');
    expect(earlier.quantity.toString()).toBe('50');
  });

  it('values movements and totals an inventory', () => {
    const mv = movement({ direction: 'IN', quantity: dec('3.5'), unitCost: money('BDT', '12.50') });
    expect(movementValue(mv).amount.toString()).toBe('43.75');

    const movements = [
      mv,
      movement({ direction: 'IN', quantity: dec('2'), unitCost: money('BDT', '100'), itemId: 'item-feed' }),
    ];
    expect(inventoryValuation(movements, ['item-rice', 'item-feed'], 'BDT').amount.toString()).toBe('243.75');
  });

  it('rejects a currency mix on the same item', () => {
    const movements = [
      movement({ direction: 'IN', quantity: dec('1'), unitCost: money('BDT', '10') }),
      movement({ direction: 'IN', quantity: dec('1'), unitCost: money('USD', '10') }),
    ];
    expect(() => weightedAverageValuation(movements, { itemId: 'item-rice', currency: 'BDT' })).toThrow(/MIXED_CURRENCY|movements in/);
  });
});

describe('lot selection (FIFO / FEFO)', () => {
  const lots: StockLot[] = [
    { id: 'lot-late', itemId: 'item-feed', locationId: 'loc-main', quantity: dec('100'), unit: 'kg', unitCost: money('BDT', '30'), receivedAt: '2026-03-01', expiryDate: '2026-12-31' },
    { id: 'lot-early-expiry', itemId: 'item-feed', locationId: 'loc-main', quantity: dec('40'), unit: 'kg', unitCost: money('BDT', '28'), receivedAt: '2026-02-01', expiryDate: '2026-06-30' },
    { id: 'lot-soonest-expiry', itemId: 'item-feed', locationId: 'loc-main', quantity: dec('10'), unit: 'kg', unitCost: money('BDT', '32'), receivedAt: '2026-04-01', expiryDate: '2026-05-01' },
  ];

  it('FEFO consumes the earliest expiry first', () => {
    const plan = planLotIssue(lots, dec('25'), 'BDT', 'FEFO');
    expect(plan.issues.map((i) => [i.lotId, i.quantity.toString()])).toEqual([
      ['lot-soonest-expiry', '10'],
      ['lot-early-expiry', '15'],
    ]);
    expect(plan.totalCost.amount.toString()).toBe('740.00'); // 10*32 + 15*28
    expect(plan.shortfall.isZero()).toBe(true);
  });

  it('FIFO consumes the earliest receipt first', () => {
    const plan = planLotIssue(lots, dec('150'), 'BDT', 'FIFO');
    expect(plan.issues.map((i) => i.lotId)).toEqual(['lot-early-expiry', 'lot-late', 'lot-soonest-expiry']);
    expect(plan.totalCost.amount.toString()).toBe('4440.00'); // 40*28 + 100*30 + 10*32
    expect(plan.shortfall.isZero()).toBe(true);
  });

  it('reports a shortfall instead of over-issuing', () => {
    const plan = planLotIssue(lots, dec('200'), 'BDT', 'FIFO');
    expect(plan.shortfall.toString()).toBe('50');
  });

  it('ignores empty lots', () => {
    const plan = planLotIssue([...lots, { ...lots[0]!, id: 'lot-empty', quantity: dec('0') }], dec('1'), 'BDT');
    expect(plan.issues.some((i) => i.lotId === 'lot-empty')).toBe(false);
  });
});

describe('reversal', () => {
  it('creates the exact opposite movement and links back to the original', () => {
    const original = movement({ direction: 'OUT', quantity: dec('30'), sourceType: 'SALE' });
    const reversal = reversalMovements(original, {
      id: 'mv-rev-1',
      eventId: 'evt-rev-1',
      idempotencyKey: 'idem-rev-1',
      actorId: 'user-2',
      deviceId: 'dev-2',
      occurredAt: '2026-02-01T00:00:00.000Z',
      reason: 'Wrong item sold',
    });
    expect(reversal.direction).toBe('IN');
    expect(reversal.sourceType).toBe('REVERSAL');
    expect(reversal.reversalOf).toBe(original.id);
    expect(reversal.reason).toBe('Wrong item sold');
    expect(stockBalance([original, reversal], { itemId: 'item-rice' }).quantity.isZero()).toBe(true);
  });

  it('refuses to reverse a reversal', () => {
    const original = movement({ direction: 'OUT', quantity: dec('1') });
    const reversal = reversalMovements(original, { id: 'r', eventId: 'e', idempotencyKey: 'i', actorId: 'a', deviceId: 'd', occurredAt: '2026-02-01T00:00:00.000Z', reason: 'x' });
    expect(() => reversalMovements(reversal, { id: 'r2', eventId: 'e2', idempotencyKey: 'i2', actorId: 'a', deviceId: 'd', occurredAt: '2026-02-02T00:00:00.000Z', reason: 'y' })).toThrow(/Cannot reverse a reversal/);
  });
});

describe('low stock alerts', () => {
  it('lists items at or below their reorder level', () => {
    const movements = [
      movement({ direction: 'IN', quantity: dec('5'), itemId: 'item-urea' }),
      movement({ direction: 'IN', quantity: dec('50'), itemId: 'item-feed' }),
    ];
    const alerts = itemsBelowReorderLevel(movements, [
      { id: 'item-urea', reorderLevel: dec('10'), unit: 'kg' },
      { id: 'item-feed', reorderLevel: dec('20'), unit: 'kg' },
      { id: 'item-no-level' },
    ]);
    expect(alerts.map((a) => a.itemId)).toEqual(['item-urea']);
    expect(alerts[0]!.onHand.toString()).toBe('5');
  });

  it('exposes the current unit cost of an item', () => {
    const movements = [movement({ direction: 'IN', quantity: dec('10'), unitCost: money('BDT', '7.25') })];
    expect(currentUnitCost(movements, { itemId: 'item-rice', currency: 'BDT' }).amount.toString()).toBe('7.25');
  });
});
