/** Shared input validation. Small, explicit and dependency-free. */

export const BD_MOBILE_RE = /^01[3-9]\d{8}$/;
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidEmail(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length <= 254 && EMAIL_RE.test(trimmed);
}

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

/** Accepts +880/880/0 prefixes and spaces/dashes, returns `01XXXXXXXXX`. */
export function normalizeBdMobile(value: string): string {
  const digits = value.replace(/[^\d]/g, '');
  if (digits.startsWith('880')) return `0${digits.slice(3)}`;
  if (digits.startsWith('0')) return digits;
  if (digits.startsWith('1') && digits.length === 10) return `0${digits}`;
  return digits;
}

export function isValidBdMobile(value: string): boolean {
  return BD_MOBILE_RE.test(normalizeBdMobile(value));
}

export function isIsoDate(value: string): boolean {
  if (!ISO_DATE_RE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function assertIsoDate(value: string, field = 'date'): string {
  if (!isIsoDate(value)) throw new RangeError(`${field} must be an ISO date (YYYY-MM-DD), got ${JSON.stringify(value)}`);
  return value;
}

/** Keep digits only; BDT National ID length varies from 10 to 17. */
export function normalizeNid(value: string): string {
  return value.replace(/[^\d]/g, '');
}

export function isValidNid(value: string): boolean {
  const digits = normalizeNid(value);
  return digits.length >= 10 && digits.length <= 17;
}

export interface PasswordPolicy {
  readonly minLength?: number;
  readonly requireLetter?: boolean;
  readonly requireNumber?: boolean;
}

/** Returns the list of unmet requirements (empty when the password is acceptable). */
export function passwordProblems(password: string, policy: PasswordPolicy = {}): string[] {
  const minLength = policy.minLength ?? 8;
  const problems: string[] = [];
  if (password.length < minLength) problems.push(`at least ${minLength} characters`);
  if (policy.requireLetter !== false && !/[A-Za-z]/.test(password)) problems.push('at least one letter');
  if (policy.requireNumber !== false && !/\d/.test(password)) problems.push('at least one number');
  return problems;
}

export function isAcceptablePassword(password: string, policy: PasswordPolicy = {}): boolean {
  return passwordProblems(password, policy).length === 0;
}

/** Strip any path components and dangerous characters from an uploaded name. */
export function safeFileName(name: string): string {
  const base = name.replace(/\\/g, '/').split('/').pop() ?? 'file';
  const cleaned = base.replace(/[^\w.\-()+ ]+/g, '_').replace(/^\.+/, '').slice(0, 120);
  return cleaned === '' ? 'file' : cleaned;
}

export function isUuidLike(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/** Trim + collapse internal whitespace. */
export function normalizeWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

/** Coerce a user-entered decimal string ("1,250.50") into a clean string. */
export function normalizeDecimalInput(value: string): string {
  const cleaned = value.replace(/[\s,\u00a0]/g, '').replace(/[০-৯]/g, (d) => String('০১২৩৪৫৬৭৮৯'.indexOf(d)));
  if (cleaned === '' || cleaned === '-' || cleaned === '+') return '0';
  if (!/^[+-]?\d*\.?\d*$/.test(cleaned)) throw new RangeError(`Not a valid number: ${JSON.stringify(value)}`);
  return cleaned;
}

// ---------------------------------------------------------------------------
// Timezone helpers (never trust the device clock or UTC for business dates)
// ---------------------------------------------------------------------------

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The business-local calendar date (YYYY-MM-DD) for a given instant. */
export function localDateString(instant: Date | string | number, timeZone = 'Asia/Dhaka'): string {
  const date = instant instanceof Date ? instant : new Date(instant);
  if (Number.isNaN(date.getTime())) throw new RangeError('localDateString: invalid date');
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
  return parts;
}

export function localTimeString(instant: Date | string | number, timeZone = 'Asia/Dhaka'): string {
  const date = instant instanceof Date ? instant : new Date(instant);
  return new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(date);
}

/** First day of the business-local month containing `instant`. */
export function monthStart(instant: Date | string | number, timeZone = 'Asia/Dhaka'): string {
  return `${localDateString(instant, timeZone).slice(0, 7)}-01`;
}

/** The current business-local month as `YYYY-MM`. */
export function currentMonth(timeZone = 'Asia/Dhaka'): string {
  return localDateString(new Date(), timeZone).slice(0, 7);
}

export function addDays(isoDate: string, days: number): string {
  const parsed = new Date(`${assertIsoDate(isoDate)}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

/** Inclusive number of days between two ISO dates. */
export function daysBetween(fromIso: string, toIso: string): number {
  const from = new Date(`${assertIsoDate(fromIso)}T00:00:00Z`).getTime();
  const to = new Date(`${assertIsoDate(toIso, 'toIso')}T00:00:00Z`).getTime();
  return Math.round((to - from) / 86_400_000);
}

const BN_MONTHS = ['জানুয়ারি', 'ফেব্রুয়ারি', 'মার্চ', 'এপ্রিল', 'মে', 'জুন', 'জুলাই', 'আগস্ট', 'সেপ্টেম্বর', 'অক্টোবর', 'নভেম্বর', 'ডিসেম্বর'];

export function formatDateBn(isoDate: string): string {
  const [y, m, d] = assertIsoDate(isoDate).split('-');
  const month = BN_MONTHS[Number(m) - 1] ?? m;
  const bn = (s: string) => s.replace(/\d/g, (digit) => '০১২৩৪৫৬৭৮৯'[Number(digit)] as string);
  return `${bn(d as string)} ${month} ${bn(y as string)}`;
}
