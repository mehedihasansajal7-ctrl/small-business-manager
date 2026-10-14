import { describe, expect, it } from 'vitest';
import {
  addMoney,
  allocateMoney,
  convertMoney,
  formatMoney,
  getCurrency,
  money,
  mulMoney,
  parseMoney,
  pctOf,
  subMoney,
  sumMoney,
  toBanglaDigits,
  zeroMoney,
} from '../src/money.js';

describe('Money', () => {
  it('rounds to the currency minor unit on creation', () => {
    expect(money('BDT', '10.005').amount.toString()).toBe('10.01');
    expect(money('JPY', '10.5').amount.toString()).toBe('11');
    expect(money('BDT', '0.004').amount.toString()).toBe('0.00');
  });

  it('knows the currency metadata', () => {
    expect(getCurrency('BDT').symbol).toBe('৳');
    expect(getCurrency('bdt').scale).toBe(2);
    expect(() => getCurrency('XYZ')).toThrow(/Unknown currency/);
  });

  it('refuses to mix currencies', () => {
    expect(() => addMoney(money('BDT', 100), money('USD', 100))).toThrow(/Currency mismatch/);
    expect(subMoney(money('BDT', 100), money('BDT', 40)).amount.toString()).toBe('60.00');
  });

  it('multiplies, divides and takes percentages with explicit rounding', () => {
    expect(mulMoney(money('BDT', '100'), '3.5').amount.toString()).toBe('350.00');
    expect(pctOf(money('BDT', 1234.56), '5').amount.toString()).toBe('61.73');
    expect(pctOf(money('BDT', 100), '7.5').amount.toString()).toBe('7.50');
  });

  it('allocates money without losing a poysha', () => {
    const shares = allocateMoney(money('BDT', '1000.00'), ['33.333', '33.333', '33.334']);
    expect(shares.map((s) => s.amount.toString())).toEqual(['333.33', '333.33', '333.34']);
    expect(sumMoney(shares, 'BDT').amount.toString()).toBe('1000.00');
    expect(shares.every((s) => s.currency === 'BDT')).toBe(true);
  });

  it('formats using South-Asian and Western grouping', () => {
    expect(formatMoney(money('BDT', '1234567.89'))).toBe('৳12,34,567.89');
    expect(formatMoney(money('USD', '1234567.89'))).toBe('$1,234,567.89');
    expect(formatMoney(money('BDT', '1234567.89'), { grouping: 'western' })).toBe('৳1,234,567.89');
    expect(formatMoney(money('BDT', '-500'), { accountingNegative: true })).toBe('(৳500.00)');
    expect(formatMoney(money('BDT', '1500'), { useCode: true })).toBe('BDT 1,500.00');
    expect(formatMoney(money('BDT', '1500'), { symbol: false })).toBe('1,500.00');
    expect(formatMoney(money('BDT', '1500'), { signed: true })).toBe('+৳1,500.00');
  });

  it('renders Bangla digits and currency name for the Bangla UI', () => {
    expect(toBanglaDigits('৳1,234.50')).toBe('৳১,২৩৪.৫০');
    expect(formatMoney(money('BDT', '1234.5'), { banglaDigits: true })).toBe('৳১,২৩৪.৫০');
    expect(getCurrency('BDT').nameBn).toBe('বাংলাদেশি টাকা');
  });

  it('parses messy user input', () => {
    expect(parseMoney('৳ 1,23,456.78', 'BDT').amount.toString()).toBe('123456.78');
    expect(parseMoney(' BDT 500 ', 'BDT').amount.toString()).toBe('500.00');
    expect(parseMoney('১২৩৪.৫০', 'BDT').amount.toString()).toBe('1234.50');
    expect(() => parseMoney('', 'BDT')).toThrow();
  });

  it('converts currencies only at an explicit rate', () => {
    expect(convertMoney(money('USD', 100), 'BDT', '120.50').amount.toString()).toBe('12050.00');
    expect(convertMoney(money('BDT', 100), 'BDT', '999').amount.toString()).toBe('100.00');
  });

  it('uses a zero of the right currency', () => {
    expect(zeroMoney('BDT').amount.isZero()).toBe(true);
    expect(zeroMoney('BDT').currency).toBe('BDT');
  });
});
