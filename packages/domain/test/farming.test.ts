import { describe, expect, it } from 'vitest';
import { dec } from '../src/decimal.js';
import { money } from '../src/money.js';
import {
  FarmingError,
  allocateCost,
  assignHarvestCost,
  costKindLabel,
  cycleCostLedger,
  cycleProfit,
  feedConversionRatio,
  outputPerAnimal,
  sharedCostLedgerRow,
  summarizeMortality,
  yieldPerArea,
  type CostSource,
} from '../src/farming.js';

describe('shared cost allocation', () => {
  it('splits a shared cost by area, losing no poysha', () => {
    const result = allocateCost(money('BDT', '1000'), [
      { cycleId: 'c1', basisValue: dec('10') },
      { cycleId: 'c2', basisValue: dec('20') },
      { cycleId: 'c3', basisValue: dec('30') },
    ], 'AREA');

    expect(result.shares.map((s) => [s.cycleId, s.amount.amount.toString()])).toEqual([
      ['c1', '166.67'],
      ['c2', '333.33'],
      ['c3', '500.00'],
    ]);
    expect(result.allocatedTotal.amount.toString()).toBe('1000.00');
    expect(result.unallocated.amount.isZero()).toBe(true);
  });

  it('rounding residual is deterministic (largest weight, then lowest cycle id)', () => {
    const first = allocateCost(money('BDT', '100.00'), [
      { cycleId: 'c1', basisValue: dec('1') },
      { cycleId: 'c2', basisValue: dec('1') },
      { cycleId: 'c3', basisValue: dec('1') },
    ], 'ACTUAL_USAGE');
    const second = allocateCost(money('BDT', '100.00'), [
      { cycleId: 'c1', basisValue: dec('1') },
      { cycleId: 'c2', basisValue: dec('1') },
      { cycleId: 'c3', basisValue: dec('1') },
    ], 'ACTUAL_USAGE');
    expect(first.shares.map((s) => s.amount.amount.toString())).toEqual(second.shares.map((s) => s.amount.amount.toString()));
    expect(first.shares.reduce((acc, s) => acc + s.amount.amount.toNumber(), 0)).toBeCloseTo(100, 6);
  });

  it('supports manual percentages and leaves the remainder explicitly unallocated', () => {
    const full = allocateCost(money('BDT', '1000'), [
      { cycleId: 'c1', basisValue: dec('1'), manualPercent: dec('60') },
      { cycleId: 'c2', basisValue: dec('1'), manualPercent: dec('40') },
    ], 'MANUAL_PERCENT');
    expect(full.shares.map((s) => s.amount.amount.toString())).toEqual(['600.00', '400.00']);
    expect(full.unallocated.amount.toString()).toBe('0.00');

    const partial = allocateCost(money('BDT', '1000'), [
      { cycleId: 'c1', basisValue: dec('1'), manualPercent: dec('30') },
      { cycleId: 'c2', basisValue: dec('1'), manualPercent: dec('30') },
    ], 'MANUAL_PERCENT');
    expect(partial.shares.map((s) => s.amount.amount.toString())).toEqual(['300.00', '300.00']);
    expect(partial.unallocated.amount.toString()).toBe('400.00');
  });

  it('rejects invalid allocation inputs', () => {
    expect(() => allocateCost(money('BDT', '10'), [], 'AREA')).toThrow(/At least one allocation target/);
    expect(() => allocateCost(money('BDT', '10'), [{ cycleId: 'c1', basisValue: dec('0') }], 'AREA')).toThrow(/nothing to allocate against/);
    expect(() => allocateCost(money('BDT', '10'), [{ cycleId: 'c1', basisValue: dec('1'), manualPercent: dec('150') }], 'MANUAL_PERCENT')).toThrow(FarmingError);
    expect(() => allocateCost(money('BDT', '10'), [{ cycleId: 'c1', basisValue: dec('-1') }], 'AREA')).toThrow(/must not be negative/);
  });
});

describe('partial harvest costing', () => {
  it('never assigns the whole batch cost to a partial harvest', () => {
    const state = {
      cycleId: 'c1',
      costToDate: money('BDT', '10000'),
      harvestedQuantityToDate: dec('0'),
      assignedCostToDate: money('BDT', '0'),
      outputUnit: 'kg',
    };
    const first = assignHarvestCost(state, dec('1000'), 'PLANNED_YIELD_PRORATA', { plannedOutput: dec('5000') });
    expect(first.assignedCost.amount.toString()).toBe('2000.00');
    expect(first.costPerUnit.amount.toString()).toBe('2.00');
    expect(first.capped).toBe(false);

    const second = assignHarvestCost(first.nextState, dec('1000'), 'PLANNED_YIELD_PRORATA', { plannedOutput: dec('5000') });
    expect(second.assignedCost.amount.toString()).toBe('2000.00');
    expect(second.nextState.assignedCostToDate.amount.toString()).toBe('4000.00');
    // Only 40% of the batch cost has been released after 40% of the planned output.
    expect(second.nextState.assignedCostToDate.amount.lt(state.costToDate.amount)).toBe(true);
  });

  it('caps the assignment at the remaining cost-to-date', () => {
    const state = {
      cycleId: 'c1',
      costToDate: money('BDT', '1000'),
      harvestedQuantityToDate: dec('0'),
      assignedCostToDate: money('BDT', '0'),
      outputUnit: 'kg',
    };
    // Planned output far smaller than the actual harvest, so the pro-rata share
    // would exceed the batch cost - it must be capped.
    const result = assignHarvestCost(state, dec('1000'), 'PLANNED_YIELD_PRORATA', { plannedOutput: dec('100') });
    expect(result.assignedCost.amount.toString()).toBe('1000.00');
    expect(result.capped).toBe(true);
    expect(result.nextState.assignedCostToDate.amount.toString()).toBe('1000.00');
  });

  it('closing remainder releases exactly what is left', () => {
    const state = {
      cycleId: 'c1',
      costToDate: money('BDT', '10000'),
      harvestedQuantityToDate: dec('4000'),
      assignedCostToDate: money('BDT', '8000'),
      outputUnit: 'kg',
    };
    const result = assignHarvestCost(state, dec('1000'), 'CLOSING_REMAINDER');
    expect(result.assignedCost.amount.toString()).toBe('2000.00');
    expect(result.nextState.assignedCostToDate.amount.toString()).toBe('10000.00');
  });

  it('requires a planned output and a positive harvest quantity', () => {
    const state = { cycleId: 'c1', costToDate: money('BDT', '100'), harvestedQuantityToDate: dec('0'), assignedCostToDate: money('BDT', '0'), outputUnit: 'kg' };
    expect(() => assignHarvestCost(state, dec('10'))).toThrow(/plannedOutput/);
    expect(() => assignHarvestCost(state, dec('0'), 'CLOSING_REMAINDER')).toThrow(/greater than zero/);
  });
});

describe('cycle profitability', () => {
  it('separates sold margin from cost tied up in unsold stock and the growing batch', () => {
    const profit = cycleProfit({
      cycleId: 'c1',
      currency: 'BDT',
      revenue: money('BDT', '30000'),
      soldCogs: money('BDT', '12000'),
      costToDate: money('BDT', '20000'),
      assignedCostToFinishedStock: money('BDT', '16000'),
      costReleasedWithSales: money('BDT', '12000'),
      harvestedQuantity: dec('800'),
      soldQuantity: dec('600'),
      outputUnit: 'kg',
    });

    expect(profit.grossProfit.amount.toString()).toBe('18000.00');
    expect(profit.costInUnsoldOutput.amount.toString()).toBe('4000.00');
    expect(profit.costRemainingInBatch.amount.toString()).toBe('4000.00');
    expect(profit.unsoldQuantity.toString()).toBe('200');
    expect(profit.marginPercent.toString()).toBe('60.00');
    // Profit is NOT revenue minus total batch cost.
    expect(profit.grossProfit.amount.eq(money('BDT', '30000').amount.sub(money('BDT', '20000').amount))).toBe(false);
  });

  it('handles a zero-revenue cycle without dividing by zero', () => {
    const profit = cycleProfit({
      cycleId: 'c1',
      currency: 'BDT',
      revenue: money('BDT', '0'),
      soldCogs: money('BDT', '0'),
      costToDate: money('BDT', '5000'),
      assignedCostToFinishedStock: money('BDT', '0'),
      costReleasedWithSales: money('BDT', '0'),
      harvestedQuantity: dec('0'),
      soldQuantity: dec('0'),
      outputUnit: 'kg',
    });
    expect(profit.marginPercent.isZero()).toBe(true);
    expect(profit.costRemainingInBatch.amount.toString()).toBe('5000.00');
  });
});

describe('mortality and productivity metrics', () => {
  it('summarises mortality and raises an alert above the threshold', () => {
    const summary = summarizeMortality(dec('500'), [
      { cycleId: 'c1', occurredOn: '2026-02-01', quantity: dec('5'), reason: 'normal', bookValue: money('BDT', '500') },
      { cycleId: 'c1', occurredOn: '2026-02-03', quantity: dec('30'), reason: 'heat stress', bookValue: money('BDT', '3000'), abnormal: true },
    ], 'BDT', { warningPercent: dec('5') });

    expect(summary.totalLoss.toString()).toBe('35');
    expect(summary.livePopulation.toString()).toBe('465');
    expect(summary.mortalityPercent.toString()).toBe('7.00');
    expect(summary.lossValue.amount.toString()).toBe('3500.00');
    expect(summary.abnormalEvents).toBe(1);
    expect(summary.alert).toBe(true);
  });

  it('computes FCR, yield per area and output per animal', () => {
    expect(feedConversionRatio(dec('1800'), dec('1000')).toString()).toBe('1.80');
    expect(() => feedConversionRatio(dec('10'), dec('0'))).toThrow(FarmingError);
    expect(yieldPerArea(dec('1500'), dec('50')).toString()).toBe('30.00');
    expect(outputPerAnimal(dec('900'), dec('300')).toString()).toBe('3.00');
    expect(() => yieldPerArea(dec('1'), dec('0'))).toThrow(FarmingError);
  });
});

describe('cycle cost ledger', () => {
  it('groups every cost once, including allocated shared overhead', () => {
    const costs: CostSource[] = [
      { id: 'x1', businessId: 'b', cycleId: 'c1', kind: 'INPUT_ISSUE', amount: money('BDT', '12000'), shared: false, incurredOn: '2026-02-01', sourceType: 'INPUT_ISSUE', sourceId: 'i1' },
      { id: 'x2', businessId: 'b', cycleId: 'c1', kind: 'DIRECT_LABOUR', amount: money('BDT', '3000'), shared: false, incurredOn: '2026-02-02', sourceType: 'EXPENSE', sourceId: 'e1' },
      { id: 'x3', businessId: 'b', cycleId: null, kind: 'OVERHEAD', amount: money('BDT', '1000'), shared: true, incurredOn: '2026-02-03', sourceType: 'EXPENSE', sourceId: 'e2' },
    ];
    const allocation = allocateCost(costs[2]!.amount, [
      { cycleId: 'c1', basisValue: dec('1') },
      { cycleId: 'c2', basisValue: dec('1') },
    ], 'AREA');

    const ledger = cycleCostLedger(costs, 'BDT', [{ kind: 'OVERHEAD', amount: allocation.shares[0]!.amount }]);
    expect(ledger.map((r) => [r.kind, r.amount.amount.toString()])).toEqual([
      ['INPUT_ISSUE', '12000.00'],
      ['DIRECT_LABOUR', '3000.00'],
      ['OVERHEAD', '500.00'],
    ]);
    const totalShares = ledger.reduce((acc, r) => acc + Number(r.shareOfTotal.toString()), 0);
    expect(totalShares).toBeCloseTo(100, 2);
    expect(costKindLabel('DIRECT_LABOUR')).toBe('Direct labour');
    expect(sharedCostLedgerRow('OVERHEAD', allocation.shares[0]!).amount.amount.toString()).toBe('500.00');
  });
});
