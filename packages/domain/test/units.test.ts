import { describe, expect, it } from 'vitest';
import { dec } from '../src/decimal.js';
import { UnitError, UnitRegistry, bagConversion, defaultUnits } from '../src/units.js';

describe('UnitRegistry conversion', () => {
  it('converts within a dimension using exact factors', () => {
    expect(defaultUnits.convert('1', 'kg', 'g').value.toString()).toBe('1000');
    expect(defaultUnits.convert('500', 'g', 'kg').value.toString()).toBe('0.5');
    expect(defaultUnits.convert('2', 'day', 'hour').value.toString()).toBe('48');
    expect(defaultUnits.convert('1', 'acre', 'sqft').value.toString()).toBe('43560');
    expect(defaultUnits.convert('1', 'katha', 'sqft').value.toString()).toBe('720');
    expect(defaultUnits.convert('3', 'dozen', 'pcs').value.toString()).toBe('36');
  });

  it('converts Bangladeshi land and weight units the way local users expect', () => {
    expect(defaultUnits.convert('1', 'bigha', 'katha').value.toString()).toBe('20');
    expect(defaultUnits.convert('1', 'maund', 'kg').value.toString()).toBe('37.3242');
    expect(defaultUnits.convert('1', 'decimal', 'sqft').value.toString()).toBe('435.6');
  });

  it('is the identity for the same unit', () => {
    const result = defaultUnits.convert('12.5', 'kg', 'kg');
    expect(result.value.toString()).toBe('12.5');
    expect(result.usedExplicitConversion).toBe(false);
  });

  it('REFUSES to convert between incompatible dimensions', () => {
    expect(() => defaultUnits.convert('1', 'kg', 'l')).toThrow(UnitError);
    expect(() => defaultUnits.convert('1', 'pcs', 'kg')).toThrow(/explicit, documented conversion/);
    expect(defaultUnits.isConvertible('kg', 'l')).toBe(false);
    expect(defaultUnits.isConvertible('kg', 'g')).toBe(true);
  });

  it('allows a cross-dimension conversion only when registered with a note', () => {
    const { unit, conversion } = bagConversion('urea-bag', 'urea_bag', '50', 'Urea retail bag = 50 kg, approved by the owner');
    const registry = new UnitRegistry([unit], [conversion]);

    const forward = registry.convert('2', 'urea_bag', 'kg');
    expect(forward.value.toString()).toBe('100');
    expect(forward.usedExplicitConversion).toBe(true);
    expect(forward.conversionId).toBe('urea-bag');

    const backward = registry.convert('100', 'kg', 'urea_bag');
    expect(backward.value.toString()).toBe('2');
    expect(backward.usedExplicitConversion).toBe(true);

    // And the plain registry must still refuse that pair.
    expect(() => defaultUnits.convert('2', 'urea_bag', 'kg')).toThrow(UnitError);
  });

  it('rejects an explicit conversion whose unit was never declared', () => {
    expect(() =>
      new UnitRegistry([], [{ id: 'ghost', from: 'ghost_bag', to: 'kg', factor: dec('50'), note: 'no such unit exists' }]),
    ).toThrow(/unknown unit/);
  });

  it('rejects an explicit conversion without a documented note', () => {
    expect(
      () =>
        new UnitRegistry(
          [{ code: 'crate', name: 'crate', dimension: 'COUNT', factor: dec('1') }],
          [{ id: 'bad', from: 'crate', to: 'kg', factor: dec('5'), note: 'no' }],
        ),
    ).toThrow(/documented note/);
  });

  it('validates quantities, including integer-only units', () => {
    expect(() => defaultUnits.validateQuantity('1.5', 'pcs')).toThrow(/only allows whole quantities/);
    expect(() => defaultUnits.validateQuantity('2', 'pcs')).not.toThrow();
    expect(() => defaultUnits.validateQuantity('-1', 'kg')).toThrow(/must not be negative/);
    expect(() => defaultUnits.validateQuantity('0', 'kg')).toThrow(/greater than zero/);
    expect(() => defaultUnits.validateQuantity('0', 'kg', { allowZero: true })).not.toThrow();
    expect(() => defaultUnits.validateQuantity('1.25', 'kg')).not.toThrow();
  });

  it('quantizes to a sensible precision for the unit', () => {
    expect(defaultUnits.quantize('1.23456789', 'kg').toString()).toBe('1.2346');
    expect(defaultUnits.quantize('1.23456789', 'l').toString()).toBe('1.234568');
    expect(defaultUnits.quantize('2.7', 'pcs').toString()).toBe('3');
  });

  it('lists units by dimension', () => {
    const mass = defaultUnits.list('MASS').map((u) => u.code);
    expect(mass).toContain('kg');
    expect(mass).toContain('maund');
    expect(mass).not.toContain('l');
  });

  it('throws for unknown units and duplicate registration', () => {
    expect(() => defaultUnits.getUnit('zzz')).toThrow(/Unknown unit/);
    expect(() => new UnitRegistry([{ code: 'kg', name: 'dupe', dimension: 'MASS', factor: dec('1') }])).toThrow(/Duplicate unit code/);
  });
});
