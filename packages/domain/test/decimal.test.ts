import { describe, expect, it } from 'vitest';
import { Decimal, dec, pow10, roundDiv, sum } from '../src/decimal.js';

describe('Decimal construction', () => {
  it('parses plain, signed, fractional and exponent notation', () => {
    expect(Decimal.fromString('123').toString()).toBe('123');
    expect(Decimal.fromString('-0.50').toString()).toBe('-0.50');
    expect(Decimal.fromString('.5').toString()).toBe('0.5');
    expect(Decimal.fromString('1e3').toString()).toBe('1000');
    expect(Decimal.fromString('2.5E-2').toString()).toBe('0.025');
    expect(Decimal.fromString('000123.4500').toString()).toBe('123.4500');
  });

  it('rejects invalid input instead of silently returning NaN', () => {
    for (const bad of ['', 'abc', '1,000', 'NaN', 'Infinity', '1.2.3', '--1']) {
      expect(() => Decimal.fromString(bad)).toThrow();
    }
    expect(() => Decimal.fromNumber(Number.NaN)).toThrow();
  });

  it('never uses binary floating point', () => {
    expect(dec('0.1').add('0.2').toString()).toBe('0.3');
    const total = Array.from({ length: 10 }, () => dec('0.1')).reduce((acc, v) => acc.add(v), Decimal.ZERO);
    expect(total.toString()).toBe('1.0');
    // The equivalent float sum is famously not exactly 1
    expect([...Array(10).keys()].reduce((a) => a + 0.1, 0)).not.toBe(1);
  });

  it('exposes helpers for powers of ten and integer division', () => {
    expect(pow10(0)).toBe(1n);
    expect(pow10(6)).toBe(1_000_000n);
    expect(() => pow10(-1)).toThrow();
    expect(roundDiv(10n, 4n, 'FLOOR')).toBe(2n);
    expect(roundDiv(10n, 4n, 'CEIL')).toBe(3n);
    expect(roundDiv(-10n, 4n, 'HALF_UP')).toBe(-3n);
    expect(roundDiv(10n, 4n, 'HALF_EVEN')).toBe(2n);
  });
});

describe('Decimal arithmetic and rounding', () => {
  it('adds, subtracts and multiplies exactly', () => {
    expect(dec('1.005').add('0.995').toString()).toBe('2.000');
    expect(dec('100').sub('33.33').toString()).toBe('66.67');
    expect(dec('0.1').mul('0.2').toString()).toBe('0.02');
    expect(dec('1250.50').mul(3).toString()).toBe('3751.50');
  });

  it('divides only with an explicit scale', () => {
    expect(() => dec('1').div('3')).toThrow(/not exact/);
    expect(dec('12').div('4').toString()).toBe('3');
    expect(dec('1').div('3', 4).toString()).toBe('0.3333');
    expect(dec('2').div('3', 4, 'HALF_UP').toString()).toBe('0.6667');
  });

  it('applies each rounding mode predictably', () => {
    expect(dec('2.5').round(0, 'HALF_UP').toString()).toBe('3');
    expect(dec('-2.5').round(0, 'HALF_UP').toString()).toBe('-3');
    expect(dec('2.5').round(0, 'HALF_EVEN').toString()).toBe('2');
    expect(dec('3.5').round(0, 'HALF_EVEN').toString()).toBe('4');
    expect(dec('2.9').round(0, 'FLOOR').toString()).toBe('2');
    expect(dec('-2.9').round(0, 'FLOOR').toString()).toBe('-3');
    expect(dec('2.1').round(0, 'CEIL').toString()).toBe('3');
    expect(dec('-2.1').round(0, 'TRUNC').toString()).toBe('-2');
  });

  it('compares across different scales', () => {
    expect(dec('1.10').eq('1.1')).toBe(true);
    expect(dec('1.10').compare('1.1001')).toBe(-1);
    expect(dec('0.5').gt('0.499999')).toBe(true);
    expect(dec('-2').lt('-1.9')).toBe(true);
  });

  it('sums a list with the shared helper', () => {
    expect(sum(['1.11', '2.22', '3.33']).toString()).toBe('6.66');
    expect(sum([]).toString()).toBe('0');
  });
});

describe('Decimal.allocate', () => {
  it('splits an amount without losing or inventing a single poysha', () => {
    const parts = dec('100.00').allocate([1, 1, 1]);
    expect(parts.map(String)).toEqual(['33.34', '33.33', '33.33']);
    expect(sum(parts).toString()).toBe('100.00');
  });

  it('respects weights and keeps the total for awkward ratios', () => {
    const parts = dec('1000').allocate(['33.333', '33.333', '33.334']);
    expect(sum(parts).toString()).toBe('1000');
    expect(parts.map(String)).toEqual(['333', '333', '334']);
  });

  it('handles percentages that do not sum to 100 deterministically', () => {
    const parts = dec('777.77').allocate([30, 30, 30]);
    expect(sum(parts).toString()).toBe('777.77');
    expect(parts.map(String)).toEqual(['259.26', '259.26', '259.25']);
  });

  it('rejects impossible allocations', () => {
    expect(() => dec('10').allocate([])).toThrow();
    expect(() => dec('10').allocate([0, 0])).toThrow(/total zero/);
    expect(() => dec('10').allocate([-1, 2])).toThrow(/negative/);
  });
});
