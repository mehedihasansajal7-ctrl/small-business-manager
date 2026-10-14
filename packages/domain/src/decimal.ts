/**
 * Decimal arithmetic on top of bigint.
 *
 * Money and quantities are NEVER stored or calculated as IEEE-754 floats in this
 * codebase. A value is `unscaled / 10^scale` where `unscaled` is a bigint, so
 * 0.1 + 0.2 === 0.3 exactly and rounding is always explicit.
 */

export type RoundingMode = 'HALF_UP' | 'HALF_EVEN' | 'FLOOR' | 'CEIL' | 'TRUNC';

const POW10: bigint[] = [1n];
const MAX_SCALE = 40;

/** 10^n as bigint, cached. n must be a non-negative safe integer. */
export function pow10(n: number): bigint {
  if (!Number.isInteger(n) || n < 0) throw new RangeError(`pow10: invalid exponent ${n}`);
  if (n > MAX_SCALE) throw new RangeError(`pow10: exponent ${n} exceeds supported maximum ${MAX_SCALE}`);
  while (POW10.length <= n) POW10.push((POW10[POW10.length - 1] as bigint) * 10n);
  return POW10[n] as bigint;
}

/**
 * Integer division with an explicit rounding mode.
 * `HALF_UP` here means "half away from zero" (the common commercial convention).
 */
export function roundDiv(numerator: bigint, denominator: bigint, mode: RoundingMode = 'HALF_UP'): bigint {
  if (denominator === 0n) throw new RangeError('roundDiv: division by zero');
  const negative = (numerator < 0n) !== (denominator < 0n);
  const a = numerator < 0n ? -numerator : numerator;
  const b = denominator < 0n ? -denominator : denominator;
  let quotient = a / b;
  const remainder = a % b;
  if (remainder !== 0n) {
    switch (mode) {
      case 'TRUNC':
        break;
      case 'FLOOR':
        if (negative) quotient += 1n;
        break;
      case 'CEIL':
        if (!negative) quotient += 1n;
        break;
      case 'HALF_UP':
        if (remainder * 2n >= b) quotient += 1n;
        break;
      case 'HALF_EVEN': {
        const twice = remainder * 2n;
        if (twice > b || (twice === b && (quotient & 1n) === 1n)) quotient += 1n;
        break;
      }
      default: {
        const never: never = mode;
        throw new RangeError(`roundDiv: unknown rounding mode ${String(never)}`);
      }
    }
  }
  return negative ? -quotient : quotient;
}

const DECIMAL_RE = /^([+-])?(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/;

/** Immutable exact decimal number. */
export class Decimal {
  /** Value as an integer scaled by 10^scale. */
  readonly unscaled: bigint;
  /** Number of fractional digits (always >= 0). */
  readonly scale: number;

  private constructor(unscaled: bigint, scale: number) {
    if (!Number.isInteger(scale) || scale < 0) throw new RangeError(`Decimal: invalid scale ${scale}`);
    if (scale > MAX_SCALE) throw new RangeError(`Decimal: scale ${scale} exceeds ${MAX_SCALE}`);
    this.unscaled = unscaled;
    this.scale = scale;
    Object.freeze(this);
  }

  /** Build from already-scaled minor units: value = unscaled / 10^scale. */
  static fromMinorUnits(unscaled: bigint, scale: number): Decimal {
    return new Decimal(unscaled, scale);
  }

  /** Build from a JS bigint (scale 0). */
  static fromBigInt(value: bigint): Decimal {
    return new Decimal(value, 0);
  }

  /**
   * Parse a decimal string. Accepts `1`, `-0.5`, `.5`, `1.`, `1e3`, `2.5E-2`.
   * Throws on anything else (including `NaN`, `Infinity`, `1,000`, `12abc`).
   */
  static fromString(input: string): Decimal {
    if (typeof input !== 'string') throw new TypeError('Decimal.fromString: expected a string');
    const text = input.trim();
    const match = DECIMAL_RE.exec(text);
    if (!match) throw new SyntaxError(`Decimal.fromString: not a valid decimal: ${JSON.stringify(input)}`);
    const signPart = match[1];
    const intPart = match[2] ?? '';
    const fracPart = match[3] ?? '';
    const expPart = match[4];
    if (intPart === '' && fracPart === '') throw new SyntaxError(`Decimal.fromString: not a valid decimal: ${JSON.stringify(input)}`);
    const exponent = expPart ? Number(expPart) : 0;
    if (!Number.isSafeInteger(exponent)) throw new RangeError(`Decimal.fromString: exponent out of range: ${String(expPart)}`);

    let digits = `${intPart}${fracPart}`.replace(/^0+(?=\d)/, '');
    if (digits === '') digits = '0';
    let unscaled = BigInt(digits);
    if (signPart === '-') unscaled = -unscaled;

    let scale = fracPart.length - exponent;
    if (scale < 0) {
      unscaled *= pow10(-scale);
      scale = 0;
    }
    return new Decimal(unscaled, scale);
  }

  /**
   * Build from a JS number. Only meant for literals and config; prefer
   * `fromString` for anything that came from user input or persistence.
   */
  static fromNumber(value: number): Decimal {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new TypeError(`Decimal.fromNumber: expected a finite number, got ${String(value)}`);
    }
    if (Number.isInteger(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER) {
      return new Decimal(BigInt(value), 0);
    }
    return Decimal.fromString(value.toString());
  }

  /** Coerce Decimal | string | number | bigint into a Decimal. */
  static of(value: Decimal | string | number | bigint): Decimal {
    if (value instanceof Decimal) return value;
    if (typeof value === 'bigint') return Decimal.fromBigInt(value);
    if (typeof value === 'number') return Decimal.fromNumber(value);
    return Decimal.fromString(value);
  }

  static readonly ZERO: Decimal = Decimal.fromBigInt(0n);
  static readonly ONE: Decimal = Decimal.fromBigInt(1n);

  private static align(a: Decimal, b: Decimal): { a: bigint; b: bigint; scale: number } {
    if (a.scale === b.scale) return { a: a.unscaled, b: b.unscaled, scale: a.scale };
    const scale = Math.max(a.scale, b.scale);
    return {
      a: a.unscaled * pow10(scale - a.scale),
      b: b.unscaled * pow10(scale - b.scale),
      scale,
    };
  }

  /** Re-express at a different scale, rounding if the scale shrinks. */
  scaleTo(scale: number, mode: RoundingMode = 'HALF_UP'): Decimal {
    if (scale === this.scale) return this;
    if (scale > this.scale) return new Decimal(this.unscaled * pow10(scale - this.scale), scale);
    const divisor = pow10(this.scale - scale);
    return new Decimal(roundDiv(this.unscaled, divisor, mode), scale);
  }

  /** Round to `scale` fractional digits. */
  round(scale: number, mode: RoundingMode = 'HALF_UP'): Decimal {
    return this.scaleTo(scale, mode);
  }

  /** Drop the fractional part (toward zero). */
  trunc(): Decimal {
    return this.round(0, 'TRUNC');
  }

  add(other: Decimal | string | number | bigint): Decimal {
    const o = Decimal.of(other);
    const { a, b, scale } = Decimal.align(this, o);
    return new Decimal(a + b, scale);
  }

  sub(other: Decimal | string | number | bigint): Decimal {
    const o = Decimal.of(other);
    const { a, b, scale } = Decimal.align(this, o);
    return new Decimal(a - b, scale);
  }

  /** Exact product (scale = a.scale + b.scale). */
  mul(other: Decimal | string | number | bigint): Decimal {
    const o = Decimal.of(other);
    return new Decimal(this.unscaled * o.unscaled, this.scale + o.scale);
  }

  /** Exact integer quotient, or a rounded one when `scale` is given. */
  div(other: Decimal | string | number | bigint, scale?: number, mode: RoundingMode = 'HALF_UP'): Decimal {
    const o = Decimal.of(other);
    if (o.unscaled === 0n) throw new RangeError('Decimal.div: division by zero');
    if (scale === undefined) {
      if (this.unscaled % o.unscaled !== 0n) {
        throw new RangeError('Decimal.div: result is not exact; pass an explicit scale and rounding mode');
      }
      return new Decimal(this.unscaled / o.unscaled, this.scale - o.scale);
    }
    const numerator = this.unscaled * pow10(o.scale + scale);
    const denominator = o.unscaled * pow10(this.scale);
    return new Decimal(roundDiv(numerator, denominator, mode), scale);
  }

  /** Remainder with the sign of `this`. */
  mod(other: Decimal | string | number | bigint): Decimal {
    const o = Decimal.of(other);
    if (o.unscaled === 0n) throw new RangeError('Decimal.mod: division by zero');
    const { a, b, scale } = Decimal.align(this, o);
    return new Decimal(a % b, scale);
  }

  neg(): Decimal {
    return new Decimal(-this.unscaled, this.scale);
  }

  abs(): Decimal {
    return this.unscaled < 0n ? this.neg() : this;
  }

  /** -1, 0 or 1. */
  compare(other: Decimal | string | number | bigint): -1 | 0 | 1 {
    const o = Decimal.of(other);
    const { a, b } = Decimal.align(this, o);
    return a < b ? -1 : a > b ? 1 : 0;
  }

  eq(other: Decimal | string | number | bigint): boolean {
    return this.compare(other) === 0;
  }
  gt(other: Decimal | string | number | bigint): boolean {
    return this.compare(other) > 0;
  }
  gte(other: Decimal | string | number | bigint): boolean {
    return this.compare(other) >= 0;
  }
  lt(other: Decimal | string | number | bigint): boolean {
    return this.compare(other) < 0;
  }
  lte(other: Decimal | string | number | bigint): boolean {
    return this.compare(other) <= 0;
  }

  isZero(): boolean {
    return this.unscaled === 0n;
  }
  isNegative(): boolean {
    return this.unscaled < 0n;
  }
  isPositive(): boolean {
    return this.unscaled > 0n;
  }

  /** Clamp to [min, max]. */
  clamp(min: Decimal | string | number | bigint, max: Decimal | string | number | bigint): Decimal {
    if (this.lt(min)) return Decimal.of(min);
    if (this.gt(max)) return Decimal.of(max);
    return this;
  }

  /** Plain-string form, always with `scale` fractional digits. */
  toFixed(scale: number = this.scale): string {
    return this.scaleTo(scale).toString();
  }

  /** Canonical string form preserving this decimal's own scale. */
  toString(): string {
    const negative = this.unscaled < 0n;
    const digits = (negative ? -this.unscaled : this.unscaled).toString();
    if (this.scale === 0) return negative ? `-${digits}` : digits;
    const padded = digits.padStart(this.scale + 1, '0');
    const intPart = padded.slice(0, padded.length - this.scale);
    const fracPart = padded.slice(padded.length - this.scale);
    return `${negative ? '-' : ''}${intPart}.${fracPart}`;
  }

  /** Approximate JS number. Only for display/interop, never for money math. */
  toNumber(): number {
    return Number(this.toString());
  }

  /** JSON form: a string, so round-tripping through JSON stays exact. */
  toJSON(): string {
    return this.toString();
  }

  /**
   * Split this amount into `ratios.length` parts proportional to `ratios`,
   * never losing or inventing a minor unit (largest-remainder method).
   *
   * The remaining minor units are handed out in descending order of fractional
   * remainder; ties go to the earlier index. This is deterministic.
   */
  allocate(ratios: readonly (Decimal | string | number | bigint)[]): Decimal[] {
    if (ratios.length === 0) throw new RangeError('Decimal.allocate: need at least one ratio');
    const parts = ratios.map((r) => Decimal.of(r));
    if (parts.some((p) => p.isNegative())) throw new RangeError('Decimal.allocate: ratios must not be negative');
    const total = parts.reduce<Decimal>((acc, p) => acc.add(p), Decimal.ZERO);
    if (total.isZero()) throw new RangeError('Decimal.allocate: ratios must not total zero');

    const result = parts.map((p) => {
      const exact = this.mul(p).div(total, this.scale + 6, 'HALF_UP');
      return { floor: exact.round(this.scale, 'FLOOR'), remainder: exact.sub(exact.round(this.scale, 'FLOOR')) };
    });
    const allocated = result.reduce<Decimal>((acc, r) => acc.add(r.floor), Decimal.ZERO);
    let leftoverUnits = this.sub(allocated).scaleTo(this.scale).unscaled;

    if (leftoverUnits !== 0n) {
      const step = leftoverUnits > 0n ? 1n : -1n;
      const order = result
        .map((r, index) => ({ index, remainder: r.remainder, floor: r.floor }))
        .sort((x, y) => {
          const byRemainder = y.remainder.compare(x.remainder);
          if (byRemainder !== 0) return byRemainder;
          return x.index - y.index;
        });
      let cursor = 0;
      let guard = 0;
      const maxSteps = order.length * 4 + 8;
      while (leftoverUnits !== 0n && guard < maxSteps) {
        guard += 1;
        const slot = order[cursor % order.length] as { index: number; floor: Decimal };
        slot.floor = slot.floor.add(Decimal.fromMinorUnits(step, this.scale));
        leftoverUnits -= step;
        cursor += 1;
      }
      if (leftoverUnits !== 0n) throw new RangeError('Decimal.allocate: could not fully allocate (internal invariant)');
      return order
        .sort((x, y) => x.index - y.index)
        .map((slot) => slot.floor);
    }
    return result.map((r) => r.floor);
  }
}

/** Convenience: `dec()` mirrors the constructor used across the codebase. */
export function dec(value: Decimal | string | number | bigint): Decimal {
  return Decimal.of(value);
}

/** Sum of decimals; returns 0 (scale 0) for an empty list. */
export function sum(values: readonly (Decimal | string | number | bigint)[]): Decimal {
  return values.reduce<Decimal>((acc, v) => acc.add(v), Decimal.ZERO);
}
