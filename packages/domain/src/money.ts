import { Decimal, type RoundingMode, dec, sum } from './decimal.js';

export interface CurrencyDef {
  /** ISO 4217 code. */
  readonly code: string;
  /** Minor-unit digits (2 for BDT/USD, 0 for JPY). */
  readonly scale: number;
  readonly symbol: string;
  readonly name: string;
  readonly nameBn?: string;
  /** BDT and INR use the South-Asian lakh/crore grouping. */
  readonly grouping: 'western' | 'south-asian';
}

export const CURRENCIES: Readonly<Record<string, CurrencyDef>> = Object.freeze({
  BDT: { code: 'BDT', scale: 2, symbol: '৳', name: 'Bangladeshi Taka', nameBn: 'বাংলাদেশি টাকা', grouping: 'south-asian' },
  USD: { code: 'USD', scale: 2, symbol: '$', name: 'US Dollar', grouping: 'western' },
  EUR: { code: 'EUR', scale: 2, symbol: '€', name: 'Euro', grouping: 'western' },
  GBP: { code: 'GBP', scale: 2, symbol: '£', name: 'Pound Sterling', grouping: 'western' },
  INR: { code: 'INR', scale: 2, symbol: '₹', name: 'Indian Rupee', grouping: 'south-asian' },
  JPY: { code: 'JPY', scale: 0, symbol: '¥', name: 'Japanese Yen', grouping: 'western' },
});

export const DEFAULT_CURRENCY = 'BDT';

export class CurrencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CurrencyError';
  }
}

export function getCurrency(code: string): CurrencyDef {
  const found = CURRENCIES[code.toUpperCase()];
  if (!found) throw new CurrencyError(`Unknown currency: ${code}. Add it to CURRENCIES or use a supported code.`);
  return found;
}

export function currencyScale(code: string): number {
  return getCurrency(code).scale;
}

/** An exact monetary amount in a single currency. */
export interface Money {
  readonly amount: Decimal;
  readonly currency: string;
}

/** Build Money, rounding to the currency's minor unit. */
export function money(
  currency: string,
  amount: Decimal | string | number | bigint,
  mode: RoundingMode = 'HALF_UP',
): Money {
  const def = getCurrency(currency);
  return { amount: dec(amount).round(def.scale, mode), currency: def.code };
}

export function zeroMoney(currency: string): Money {
  return money(currency, 0);
}

export function addMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return { amount: a.amount.add(b.amount), currency: a.currency };
}

export function subMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return { amount: a.amount.sub(b.amount), currency: a.currency };
}

export function negMoney(a: Money): Money {
  return { amount: a.amount.neg(), currency: a.currency };
}

export function sumMoney(values: readonly Money[], currency: string): Money {
  if (values.length === 0) return zeroMoney(currency);
  return values.reduce((acc, v) => addMoney(acc, v), zeroMoney(currency));
}

/** Multiply by an exact factor, rounding back to the currency's minor unit. */
export function mulMoney(
  m: Money,
  factor: Decimal | string | number | bigint,
  mode: RoundingMode = 'HALF_UP',
): Money {
  const exact = m.amount.mul(dec(factor));
  return { amount: exact.round(currencyScale(m.currency), mode), currency: m.currency };
}

/** Divide by an exact divisor, rounding back to the currency's minor unit. */
export function divMoney(
  m: Money,
  divisor: Decimal | string | number | bigint,
  mode: RoundingMode = 'HALF_UP',
): Money {
  return { amount: m.amount.div(dec(divisor), currencyScale(m.currency), mode), currency: m.currency };
}

/** Percentage of an amount, e.g. `pctOf(m, '5')` = 5% of m. */
export function pctOf(m: Money, percent: Decimal | string | number, mode: RoundingMode = 'HALF_UP'): Money {
  return mulMoney(m, dec(percent).div(100, 8, mode), mode);
}

/** Split an amount into parts by ratios, losing no minor unit. */
export function allocateMoney(m: Money, ratios: readonly (Decimal | string | number | bigint)[]): Money[] {
  return m.amount.allocate(ratios).map((amount) => ({ amount, currency: m.currency }));
}

export function compareMoney(a: Money, b: Money): -1 | 0 | 1 {
  assertSameCurrency(a, b);
  return a.amount.compare(b.amount);
}

export function isZeroMoney(m: Money): boolean {
  return m.amount.isZero();
}

export function isNegativeMoney(m: Money): boolean {
  return m.amount.isNegative();
}

export function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new CurrencyError(`Currency mismatch: ${a.currency} vs ${b.currency}. Convert explicitly before combining.`);
  }
}

export type Grouping = 'western' | 'south-asian' | 'auto';

function groupDigits(integerDigits: string, grouping: 'western' | 'south-asian'): string {
  if (grouping === 'western') {
    return integerDigits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }
  // South-Asian: last 3 digits, then groups of 2 (12,34,56,789).
  if (integerDigits.length <= 3) return integerDigits;
  const head = integerDigits.slice(0, integerDigits.length - 3);
  const tail = integerDigits.slice(integerDigits.length - 3);
  return `${head.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${tail}`;
}

const BN_DIGITS = ['০', '১', '২', '৩', '৪', '৫', '৬', '৭', '৮', '৯'];

export function toBanglaDigits(text: string): string {
  return text.replace(/\d/g, (d) => BN_DIGITS[Number(d)] as string);
}

export interface FormatMoneyOptions {
  /** Show the currency symbol (default true). */
  symbol?: boolean;
  /** Use the ISO code instead of the symbol (default false). */
  useCode?: boolean;
  /** Bangla digits (default false). */
  banglaDigits?: boolean;
  /** Override grouping; default comes from the currency definition. */
  grouping?: Grouping;
  /** Always show the sign, e.g. `+৳1,000.00`. */
  signed?: boolean;
  /** Render negative values in parentheses (accounting style). */
  accountingNegative?: boolean;
}

/** Human-readable money, e.g. `৳12,34,567.89` or `-৳ 500.00`. */
export function formatMoney(m: Money, options: FormatMoneyOptions = {}): string {
  const def = getCurrency(m.currency);
  const grouping = options.grouping && options.grouping !== 'auto' ? options.grouping : def.grouping;
  const negative = m.amount.isNegative();
  const fixed = m.amount.abs().toFixed(def.scale);
  const [intPart = '0', fracPart = ''] = fixed.split('.');
  const grouped = groupDigits(intPart, grouping);
  const body = fracPart ? `${grouped}.${fracPart}` : grouped;
  const prefix = options.useCode ? `${def.code} ` : options.symbol === false ? '' : def.symbol;

  let text: string;
  if (negative && options.accountingNegative) {
    text = `(${prefix}${body})`;
  } else {
    const sign = negative ? '-' : options.signed && !m.amount.isZero() ? '+' : '';
    text = `${sign}${prefix}${body}`;
  }
  return options.banglaDigits ? toBanglaDigits(text) : text;
}

/** Parse user input into Money. Accepts `1,23,456.78`, `৳ 500`, `-1200`. */
export function parseMoney(input: string, currency: string): Money {
  const def = getCurrency(currency);
  const cleaned = input
    .replace(new RegExp(`[${def.symbol}${def.code}]`, 'gi'), '')
    .replace(/[,\s\u00a0]/g, '')
    .replace(/[০-৯]/g, (d) => String(BN_DIGITS.indexOf(d)));
  if (cleaned === '' || cleaned === '-' || cleaned === '+') throw new CurrencyError(`parseMoney: no amount in ${JSON.stringify(input)}`);
  return money(currency, cleaned);
}

/** Convert between currencies at an explicitly supplied rate (1 from = rate to). */
export function convertMoney(m: Money, toCurrency: string, rate: Decimal | string | number, mode: RoundingMode = 'HALF_UP'): Money {
  if (m.currency === toCurrency.toUpperCase()) return money(toCurrency, m.amount, mode);
  return money(toCurrency, m.amount.mul(dec(rate)), mode);
}

/** Total of Money values in the same currency (alias of sumMoney for readability). */
export function total(values: readonly Money[], currency: string): Money {
  return sumMoney(values, currency);
}

export { sum as sumDecimals };
