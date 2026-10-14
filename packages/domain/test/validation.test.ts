import { describe, expect, it } from 'vitest';
import {
  addDays,
  currentMonth,
  daysBetween,
  formatDateBn,
  isAcceptablePassword,
  isIsoDate,
  isValidBdMobile,
  isValidEmail,
  isValidNid,
  isValidTimeZone,
  localDateString,
  localTimeString,
  monthStart,
  normalizeBdMobile,
  normalizeDecimalInput,
  normalizeWhitespace,
  passwordProblems,
  safeFileName,
} from '../src/validation.js';

describe('contact + identity validation', () => {
  it('accepts real emails and rejects junk', () => {
    expect(isValidEmail('partner@example.com')).toBe(true);
    expect(isValidEmail('  Owner@Shop.COM.BD ')).toBe(true);
    expect(isValidEmail('no-at-sign')).toBe(false);
    expect(isValidEmail('a@b')).toBe(false);
    expect(isValidEmail(`${'x'.repeat(250)}@example.com`)).toBe(false);
  });

  it('normalises Bangladeshi mobile numbers in every common format', () => {
    expect(normalizeBdMobile('+8801712345678')).toBe('01712345678');
    expect(normalizeBdMobile('880 1711-111 111')).toBe('01711111111');
    expect(normalizeBdMobile('01711 111111')).toBe('01711111111');
    expect(normalizeBdMobile('1711111111')).toBe('01711111111');
    expect(isValidBdMobile('01711111111')).toBe(true);
    expect(isValidBdMobile('+8801711111111')).toBe(true);
    expect(isValidBdMobile('0171111111')).toBe(false); // too short
    expect(isValidBdMobile('02711111111')).toBe(false); // not a mobile prefix
  });

  it('validates NID length', () => {
    expect(isValidNid('1234567890')).toBe(true);
    expect(isValidNid('19901234567890123')).toBe(true);
    expect(isValidNid('123456789012345678')).toBe(false);
    expect(isValidNid('123')).toBe(false);
  });
});

describe('password policy', () => {
  it('lists exactly which requirements are missing', () => {
    expect(passwordProblems('short')).toContain('at least 8 characters');
    expect(passwordProblems('alllowercase')).toContain('at least one number');
    expect(passwordProblems('12345678')).toContain('at least one letter');
    expect(isAcceptablePassword('farm2026ok')).toBe(true);
    expect(isAcceptablePassword('farm2026ok', { minLength: 12 })).toBe(false);
  });
});

describe('file names and numbers', () => {
  it('strips paths and dangerous characters from uploads', () => {
    expect(safeFileName('C:\\Users\\me\\photo 1.JPG')).toBe('photo 1.JPG');
    expect(safeFileName('../../etc/passwd')).toBe('passwd');
    expect(safeFileName('....')).toBe('file');
    expect(safeFileName('a/b/c/receipt.pdf')).toBe('receipt.pdf');
  });

  it('normalises decimal input including Bangla digits', () => {
    expect(normalizeDecimalInput('1,250.50')).toBe('1250.50');
    expect(normalizeDecimalInput('১২৩৪.৫০')).toBe('1234.50');
    expect(normalizeDecimalInput('')).toBe('0');
    expect(normalizeDecimalInput('-')).toBe('0');
    expect(() => normalizeDecimalInput('12abc')).toThrow(/Not a valid number/);
  });

  it('collapses whitespace', () => {
    expect(normalizeWhitespace('  Rahim   Store  ')).toBe('Rahim Store');
  });
});

describe('dates and timezone (Asia/Dhaka is the default)', () => {
  it('validates ISO dates properly, including impossible ones', () => {
    expect(isIsoDate('2026-02-28')).toBe(true);
    expect(isIsoDate('2026-02-30')).toBe(false);
    expect(isIsoDate('26-02-28')).toBe(false);
    expect(isIsoDate('2026-13-01')).toBe(false);
  });

  it('uses the business timezone, not UTC, for the business date', () => {
    // 2026-05-01T19:30Z is already 2026-05-02 01:30 in Dhaka (UTC+6).
    expect(localDateString('2026-05-01T19:30:00.000Z', 'Asia/Dhaka')).toBe('2026-05-02');
    expect(localDateString('2026-05-01T19:30:00.000Z', 'UTC')).toBe('2026-05-01');
    expect(localTimeString('2026-05-01T19:30:00.000Z', 'Asia/Dhaka')).toBe('01:30:00');
    expect(monthStart('2026-05-31T20:00:00.000Z', 'Asia/Dhaka')).toBe('2026-06-01');
  });

  it('respects a business that is not in Dhaka', () => {
    expect(localDateString('2026-05-01T19:30:00.000Z', 'America/New_York')).toBe('2026-05-01');
  });

  it('validates timezones and reports the current month', () => {
    expect(isValidTimeZone('Asia/Dhaka')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
    expect(currentMonth('Asia/Dhaka')).toMatch(/^\d{4}-\d{2}$/);
  });

  it('adds and subtracts days and measures a period inclusively', () => {
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
    expect(daysBetween('2026-01-01', '2026-01-31')).toBe(30);
  });

  it('formats dates in Bangla', () => {
    expect(formatDateBn('2026-03-15')).toBe('১৫ মার্চ ২০২৬');
  });
});
