import { Decimal, dec, type RoundingMode } from './decimal.js';

/** Physical dimensions. Cross-dimension conversion is refused unless explicitly registered. */
export type Dimension = 'MASS' | 'VOLUME' | 'COUNT' | 'AREA' | 'LENGTH' | 'TIME';

export interface UnitDef {
  readonly code: string;
  readonly name: string;
  readonly nameBn?: string;
  readonly dimension: Dimension;
  /** How many base units one of this unit equals (base: kg, L, unit, m2, m, h). */
  readonly factor: Decimal;
  /** When true the unit may not be used with fractional quantities (e.g. pcs). */
  readonly integerOnly?: boolean;
}

/**
 * Built-in units. Factor is "value in base unit" so conversion is
 * `value * from.factor / to.factor`.
 */
const RAW_UNITS: readonly UnitDef[] = [
  // MASS (base kg)
  { code: 'mg', name: 'milligram', nameBn: 'মিলিগ্রাম', dimension: 'MASS', factor: dec('0.000001') },
  { code: 'g', name: 'gram', nameBn: 'গ্রাম', dimension: 'MASS', factor: dec('0.001') },
  { code: 'kg', name: 'kilogram', nameBn: 'কেজি', dimension: 'MASS', factor: dec('1') },
  { code: 'quintal', name: 'quintal (100 kg)', nameBn: 'কুইন্টাল', dimension: 'MASS', factor: dec('100') },
  { code: 'ton', name: 'metric ton', nameBn: 'টন', dimension: 'MASS', factor: dec('1000') },
  { code: 'maund', name: 'maund (40 seer, BD standard)', nameBn: 'মন', dimension: 'MASS', factor: dec('37.3242') },
  { code: 'seer', name: 'seer (BD standard)', nameBn: 'সের', dimension: 'MASS', factor: dec('0.933105') },

  // VOLUME (base litre)
  { code: 'ml', name: 'millilitre', nameBn: 'মিলিলিটার', dimension: 'VOLUME', factor: dec('0.001') },
  { code: 'l', name: 'litre', nameBn: 'লিটার', dimension: 'VOLUME', factor: dec('1') },
  { code: 'gallon_us', name: 'US gallon', dimension: 'VOLUME', factor: dec('3.785411784') },

  // COUNT (base unit/piece)
  { code: 'pcs', name: 'piece', nameBn: 'পিস', dimension: 'COUNT', factor: dec('1'), integerOnly: true },
  { code: 'pair', name: 'pair', nameBn: 'জোড়া', dimension: 'COUNT', factor: dec('2'), integerOnly: true },
  { code: 'dozen', name: 'dozen', nameBn: 'ডজন', dimension: 'COUNT', factor: dec('12'), integerOnly: true },
  { code: 'hundred', name: 'hundred', nameBn: 'শত', dimension: 'COUNT', factor: dec('100'), integerOnly: true },
  { code: 'thousand', name: 'thousand', nameBn: 'হাজার', dimension: 'COUNT', factor: dec('1000'), integerOnly: true },

  // AREA (base m2)
  { code: 'sqm', name: 'square metre', nameBn: 'বর্গমিটার', dimension: 'AREA', factor: dec('1') },
  { code: 'sqft', name: 'square foot', nameBn: 'বর্গফুট', dimension: 'AREA', factor: dec('0.09290304') },
  { code: 'decimal', name: 'decimal / shotangsho (BD)', nameBn: 'শতাংশ', dimension: 'AREA', factor: dec('40.468564224') },
  { code: 'katha', name: 'katha (BD standard, 720 sqft)', nameBn: 'কাঠা', dimension: 'AREA', factor: dec('66.8901888') },
  { code: 'bigha', name: 'bigha (BD standard, 20 katha)', nameBn: 'বিঘা', dimension: 'AREA', factor: dec('1337.803776') },
  { code: 'acre', name: 'acre', nameBn: 'একর', dimension: 'AREA', factor: dec('4046.8564224') },
  { code: 'hectare', name: 'hectare', nameBn: 'হেক্টর', dimension: 'AREA', factor: dec('10000') },

  // LENGTH (base m)
  { code: 'mm', name: 'millimetre', dimension: 'LENGTH', factor: dec('0.001') },
  { code: 'cm', name: 'centimetre', nameBn: 'সেন্টিমিটার', dimension: 'LENGTH', factor: dec('0.01') },
  { code: 'm', name: 'metre', nameBn: 'মিটার', dimension: 'LENGTH', factor: dec('1') },
  { code: 'km', name: 'kilometre', nameBn: 'কিলোমিটার', dimension: 'LENGTH', factor: dec('1000') },
  { code: 'inch', name: 'inch', nameBn: 'ইঞ্চি', dimension: 'LENGTH', factor: dec('0.0254') },
  { code: 'ft', name: 'foot', nameBn: 'ফুট', dimension: 'LENGTH', factor: dec('0.3048') },

  // TIME (base hour)
  { code: 'minute', name: 'minute', nameBn: 'মিনিট', dimension: 'TIME', factor: dec('0.0166666666666667') },
  { code: 'hour', name: 'hour', nameBn: 'ঘণ্টা', dimension: 'TIME', factor: dec('1') },
  { code: 'day', name: 'day', nameBn: 'দিন', dimension: 'TIME', factor: dec('24') },
  { code: 'month', name: 'month (30 day basis)', nameBn: 'মাস', dimension: 'TIME', factor: dec('720') },
];

export class UnitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnitError';
  }
}

/**
 * A conversion between different dimensions that is only valid for a specific
 * real-world context (e.g. "1 bag of urea = 50 kg", "1 litre of milk = 1.03 kg").
 * These must be registered explicitly and carry a documented note + approval.
 */
export interface ExplicitConversion {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  /** 1 `from` = factor `to`. */
  readonly factor: Decimal;
  readonly note: string;
  readonly approvedBy?: string;
  /** Optional scope so the same code pair can differ per business/item. */
  readonly itemId?: string;
}

export interface ConversionResult {
  readonly value: Decimal;
  readonly unit: string;
  /** True when an explicit cross-dimension conversion was used. */
  readonly usedExplicitConversion: boolean;
  readonly conversionId?: string;
}

/** Registry of units + approved cross-dimension conversions. */
export class UnitRegistry {
  private readonly units = new Map<string, UnitDef>();
  private readonly explicit = new Map<string, ExplicitConversion>();

  constructor(extraUnits: readonly UnitDef[] = [], explicitConversions: readonly ExplicitConversion[] = []) {
    for (const unit of [...RAW_UNITS, ...extraUnits]) {
      const existing = this.units.get(unit.code);
      if (existing) throw new UnitError(`Duplicate unit code: ${unit.code}`);
      if (unit.factor.isZero() || unit.factor.isNegative()) throw new UnitError(`Unit ${unit.code} must have a positive factor`);
      this.units.set(unit.code, Object.freeze({ ...unit }));
    }
    for (const conv of explicitConversions) this.registerConversion(conv);
  }

  registerUnit(unit: UnitDef): void {
    if (this.units.has(unit.code)) throw new UnitError(`Duplicate unit code: ${unit.code}`);
    if (unit.factor.isZero() || unit.factor.isNegative()) throw new UnitError(`Unit ${unit.code} must have a positive factor`);
    this.units.set(unit.code, Object.freeze({ ...unit }));
  }

  registerConversion(conv: ExplicitConversion): void {
    if (!this.units.has(conv.from)) throw new UnitError(`Explicit conversion ${conv.id}: unknown unit ${conv.from}`);
    if (!this.units.has(conv.to)) throw new UnitError(`Explicit conversion ${conv.id}: unknown unit ${conv.to}`);
    if (conv.factor.isZero() || conv.factor.isNegative()) throw new UnitError(`Explicit conversion ${conv.id}: factor must be positive`);
    if (!conv.note || conv.note.trim().length < 5) throw new UnitError(`Explicit conversion ${conv.id}: a documented note is required`);
    const key = this.key(conv.from, conv.to, conv.itemId);
    const reverse = this.key(conv.to, conv.from, conv.itemId);
    if (this.explicit.has(key) || this.explicit.has(reverse)) {
      throw new UnitError(`Explicit conversion already registered for ${conv.from} -> ${conv.to}`);
    }
    this.explicit.set(key, Object.freeze({ ...conv }));
  }

  private key(from: string, to: string, itemId?: string): string {
    return `${from}->${to}${itemId ? `#${itemId}` : ''}`;
  }

  getUnit(code: string): UnitDef {
    const unit = this.units.get(code);
    if (!unit) throw new UnitError(`Unknown unit: ${code}`);
    return unit;
  }

  has(code: string): boolean {
    return this.units.has(code);
  }

  list(dimension?: Dimension): UnitDef[] {
    const all = [...this.units.values()];
    return dimension ? all.filter((u) => u.dimension === dimension) : all;
  }

  /** Are these two units the same dimension, or bridged by an explicit conversion? */
  isConvertible(from: string, to: string, itemId?: string): boolean {
    if (from === to) return true;
    const a = this.getUnit(from);
    const b = this.getUnit(to);
    if (a.dimension === b.dimension) return true;
    return this.findExplicit(from, to, itemId) !== undefined;
  }

  private findExplicit(from: string, to: string, itemId?: string): { conv: ExplicitConversion; inverted: boolean } | undefined {
    const direct = this.explicit.get(this.key(from, to, itemId));
    if (direct) return { conv: direct, inverted: false };
    const reverse = this.explicit.get(this.key(to, from, itemId));
    if (reverse) return { conv: reverse, inverted: true };
    if (itemId) {
      const directGeneric = this.explicit.get(this.key(from, to));
      if (directGeneric) return { conv: directGeneric, inverted: false };
      const reverseGeneric = this.explicit.get(this.key(to, from));
      if (reverseGeneric) return { conv: reverseGeneric, inverted: true };
    }
    return undefined;
  }

  /**
   * Convert a quantity. Throws `UnitError` for incompatible dimensions so a
   * caller can never silently turn kilograms into litres or pieces.
   */
  convert(value: Decimal | string | number, from: string, to: string, options: { scale?: number; mode?: RoundingMode; itemId?: string } = {}): ConversionResult {
    const amount = dec(value);
    const a = this.getUnit(from);
    const b = this.getUnit(to);

    if (from === to) return { value: amount, unit: to, usedExplicitConversion: false };

    if (a.dimension === b.dimension) {
      const scale = options.scale ?? Math.max(a.factor.scale, b.factor.scale, amount.scale) + 6;
      const converted = amount.mul(a.factor).div(b.factor, scale, options.mode ?? 'HALF_UP');
      const finalScale = options.scale ?? trimmedScale(converted);
      return { value: converted.round(finalScale, options.mode ?? 'HALF_UP'), unit: to, usedExplicitConversion: false };
    }

    const found = this.findExplicit(from, to, options.itemId);
    if (!found) {
      throw new UnitError(
        `Cannot convert ${from} (${a.dimension}) to ${to} (${b.dimension}). Register an explicit, documented conversion if this is valid for your goods.`,
      );
    }
    const factor = found.inverted ? Decimal.ONE.div(found.conv.factor, 12, 'HALF_UP') : found.conv.factor;
    const converted = amount.mul(factor);
    const finalScale = options.scale ?? trimmedScale(converted, 6);
    return {
      value: converted.round(finalScale, options.mode ?? 'HALF_UP'),
      unit: to,
      usedExplicitConversion: true,
      conversionId: found.conv.id,
    };
  }

  /** Validate a quantity before it is stored (integer-only units, positivity). */
  validateQuantity(value: Decimal | string | number, unit: string, opts: { allowZero?: boolean } = {}): void {
    const amount = dec(value);
    const def = this.getUnit(unit);
    if (amount.isNegative()) throw new UnitError(`Quantity for ${unit} must not be negative`);
    if (!opts.allowZero && amount.isZero()) throw new UnitError(`Quantity for ${unit} must be greater than zero`);
    if (def.integerOnly && amount.scale > 0 && !amount.scaleTo(0).eq(amount)) {
      throw new UnitError(`Unit ${unit} (${def.name}) only allows whole quantities, got ${amount.toString()}`);
    }
  }

  /** Round a quantity to a sensible number of decimals for its unit. */
  quantize(value: Decimal | string | number, unit: string): Decimal {
    const def = this.getUnit(unit);
    const coarse = def.dimension === 'MASS' || def.dimension === 'COUNT';
    const scale = def.integerOnly ? 0 : coarse ? 4 : 6;
    return dec(value).round(scale, 'HALF_UP');
  }

  /** Best-effort shortest exact scale for a decimal (used to avoid `1.000000`). */
  static trim(d: Decimal, max = 6): Decimal {
    for (let scale = 0; scale <= max; scale += 1) {
      const candidate = d.round(scale, 'HALF_UP');
      if (candidate.eq(d)) return candidate;
    }
    return d.round(max, 'HALF_UP');
  }
}

/** Trim trailing zero decimals without changing the value (up to `max` decimals). */
function trimmedScale(d: Decimal, max = 6): number {
  for (let scale = 0; scale <= max; scale += 1) {
    if (d.round(scale, 'HALF_UP').eq(d)) return scale;
  }
  return max;
}

/** The built-in registry, no custom units or conversions. */
export const defaultUnits = new UnitRegistry();

/** A convenient "1 bag = 50 kg" style conversion factory. */
export function bagConversion(id: string, unitCode: string, kilograms: string, note: string, approvedBy?: string): { unit: UnitDef; conversion: ExplicitConversion } {
  return {
    unit: { code: unitCode, name: `${unitCode} (${kilograms} kg bag)`, dimension: 'COUNT', factor: dec('1'), integerOnly: true },
    conversion: { id, from: unitCode, to: 'kg', factor: dec(kilograms), note, ...(approvedBy ? { approvedBy } : {}) },
  };
}
