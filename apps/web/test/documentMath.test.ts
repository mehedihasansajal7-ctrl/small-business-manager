import { describe, expect, it } from 'vitest';
import { money } from '@sbm/domain';
import { computePurchaseTotals, computeSaleTotals, purchasePayload, salePayload } from '../src/api/documentMath';

/**
 * The numbers here are the same ones the API test suite asserts server-side
 * (apps/api/test/api.test.ts), so the client preview cannot drift from the
 * server's posting.
 */
describe('sale totals (exact decimals, matching the server)', () => {
  it('reproduces the API example: 50 kg at 68 with a 100 discount and 3000 cash', () => {
    const totals = computeSaleTotals({
      currency: 'BDT',
      lines: [{ productId: 'p1', quantity: '50', unit: 'kg', unitPrice: '68', discount: '100' }],
      cashReceived: '3000',
    });
    expect(totals.gross.amount.toString()).toBe('3400.00');
    expect(totals.discount.amount.toString()).toBe('100.00');
    expect(totals.net.amount.toString()).toBe('3300.00');
    expect(totals.cashReceived.amount.toString()).toBe('3000.00');
    expect(totals.receivable.amount.toString()).toBe('300.00');
  });

  it('defaults the cash received to the net total', () => {
    const totals = computeSaleTotals({ currency: 'BDT', lines: [{ productId: 'p1', quantity: '3', unit: 'kg', unitPrice: '10' }] });
    expect(totals.net.amount.toString()).toBe('30.00');
    expect(totals.receivable.amount.toString()).toBe('0.00');
  });

  it('adds tax before discounting, like the server', () => {
    const totals = computeSaleTotals({
      currency: 'BDT',
      lines: [{ productId: 'p1', quantity: '10', unit: 'kg', unitPrice: '100', tax: '50' }],
      headerDiscount: '25',
    });
    expect(totals.gross.amount.toString()).toBe('1000.00');
    expect(totals.tax.amount.toString()).toBe('50.00');
    expect(totals.discount.amount.toString()).toBe('25.00');
    expect(totals.net.amount.toString()).toBe('1025.00');
  });

  it('never introduces floating-point drift across lines', () => {
    const totals = computeSaleTotals({
      currency: 'BDT',
      lines: [
        { productId: 'p1', quantity: '0.1', unit: 'kg', unitPrice: '1' },
        { productId: 'p1', quantity: '0.2', unit: 'kg', unitPrice: '1' },
      ],
    });
    // `Number(0.1) + Number(0.2)` is 0.30000000000000004; money amounts are
    // always normalised at the currency's minor unit instead.
    expect(totals.gross.amount.toString()).toBe('0.30');
    expect(totals.net.amount.toString()).toBe('0.30');
  });

  it('rounds half-up exactly, where floating point would round down', () => {
    // Number(0.335) is really 0.33499999…, so `toFixed(2)` would give 0.33.
    const totals = computeSaleTotals({ currency: 'BDT', lines: [{ productId: 'p1', quantity: '1', unit: 'kg', unitPrice: '0.335' }] });
    expect(totals.net.amount.toString()).toBe('0.34');
  });

  it('rounds each line to the currency’s minor unit, exactly like the server', () => {
    const totals = computeSaleTotals({ currency: 'BDT', lines: [{ productId: 'p1', quantity: '3', unit: 'kg', unitPrice: '0.335' }] });
    // 0.335 rounds to 0.34 at the BDT minor unit before multiplication -> 1.02.
    expect(totals.net.amount.toString()).toBe('1.02');
  });

  it('sums many lines without losing a poysha', () => {
    const totals = computeSaleTotals({
      currency: 'BDT',
      lines: Array.from({ length: 7 }, () => ({ productId: 'p1', quantity: '1', unit: 'kg', unitPrice: '0.01' })),
    });
    expect(totals.net.amount.toString()).toBe('0.07');
  });
});

describe('purchase totals', () => {
  it('matches the API example: 100 kg at 58, paid 2000', () => {
    const totals = computePurchaseTotals({ currency: 'BDT', lines: [{ productId: 'p1', quantity: '100', unit: 'kg', unitCost: '58' }], paid: '2000' });
    expect(totals.total.amount.toString()).toBe('5800.00');
    expect(totals.payable.amount.toString()).toBe('3800.00');
  });

  it('treats an omitted payment as fully unpaid', () => {
    const totals = computePurchaseTotals({ currency: 'BDT', lines: [{ productId: 'p1', quantity: '2', unit: 'kg', unitCost: '10' }] });
    expect(totals.payable.amount.toString()).toBe('20.00');
  });
});

describe('payload builders', () => {
  it('drops empty optional fields so the server sees a clean body', () => {
    const payload = salePayload({
      documentDate: '2026-04-05',
      currency: 'BDT',
      lines: [{ productId: 'p1', quantity: '1', unit: 'kg', unitPrice: '10' }],
      headerDiscount: '',
      cashReceived: '',
      note: '',
    });
    expect(payload).toEqual({
      documentDate: '2026-04-05',
      currency: 'BDT',
      lines: [{ productId: 'p1', quantity: '1', unit: 'kg', unitPrice: '10' }],
    });
  });

  it('includes the negative-stock override only when it was explicitly asked for', () => {
    const payload = salePayload({
      documentDate: '2026-04-05',
      currency: 'BDT',
      allowNegative: true,
      negativeReason: 'Physical count pending',
      lines: [{ productId: 'p1', quantity: '1', unit: 'kg', unitPrice: '10' }],
    });
    expect(payload.allowNegative).toBe(true);
    expect(payload.negativeReason).toBe('Physical count pending');
  });

  it('keeps every quantity and price as a string', () => {
    const payload = purchasePayload({ documentDate: '2026-04-01', currency: 'BDT', paid: '0', lines: [{ productId: 'p1', quantity: '2', unit: 'kg', unitCost: '10' }] });
    const lines = payload.lines as readonly Record<string, unknown>[];
    expect(typeof lines[0]?.quantity).toBe('string');
    expect(typeof lines[0]?.unitCost).toBe('string');
    expect(money('BDT', lines[0]?.unitCost as string).amount.toString()).toBe('10.00');
  });
});
