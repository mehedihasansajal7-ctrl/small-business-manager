import { dec, formatDateBn, formatMoney, money, toBanglaDigits } from '@sbm/domain';
import { useApp } from '../state/AppContext';

/**
 * Display helpers for exact values.
 *
 * Money and quantities arrive from the API as STRINGS. They are parsed with the
 * domain's `Decimal`/`money` helpers — never `Number()` — so no rounding error
 * can be introduced by the UI.
 */

export interface MoneyTextProps {
  readonly value: string | null | undefined;
  readonly currency: string;
  readonly signed?: boolean;
  readonly accountingNegative?: boolean;
  readonly className?: string;
  readonly title?: string;
}

export function MoneyText({ value, currency, signed, accountingNegative, className, title }: MoneyTextProps) {
  const { locale } = useApp();
  if (value === null || value === undefined || value === '') return <span className={className}>—</span>;
  try {
    const formatted = formatMoney(money(currency, value), {
      banglaDigits: locale !== 'en',
      ...(signed ? { signed } : {}),
      ...(accountingNegative ? { accountingNegative } : {}),
    });
    return (
      <span className={className} title={title ?? `${value} ${currency}`} data-value={value}>
        {formatted}
      </span>
    );
  } catch {
    // Never show a wrong number: fall back to the raw value.
    return <span className={className}>{value}</span>;
  }
}

export interface QtyTextProps {
  readonly value: string | number | null | undefined;
  readonly unit?: string | null;
  readonly className?: string;
}

export function QtyText({ value, unit, className }: QtyTextProps) {
  const { locale } = useApp();
  if (value === null || value === undefined || value === '') return <span className={className}>—</span>;
  let text: string;
  try {
    text = dec(String(value)).toString();
  } catch {
    text = String(value);
  }
  const withUnit = unit ? `${text} ${unit}` : text;
  return <span className={className}>{locale === 'en' ? withUnit : toBanglaDigits(withUnit)}</span>;
}

/** ISO date → Bangla or English/ISO display. */
export function DateText({ value, className }: { readonly value: string | null | undefined; readonly className?: string }) {
  const { locale } = useApp();
  if (!value) return <span className={className}>—</span>;
  const iso = value.slice(0, 10);
  if (locale === 'en') return <span className={className}>{iso}</span>;
  try {
    return <span className={className}>{formatDateBn(iso)}</span>;
  } catch {
    return <span className={className}>{iso}</span>;
  }
}

/** ISO timestamp → local date + time. */
export function DateTimeText({ value, className }: { readonly value: string | null | undefined; readonly className?: string }) {
  const { locale } = useApp();
  if (!value) return <span className={className}>—</span>;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return <span className={className}>—</span>;
  const text = date.toLocaleString(locale === 'en' ? 'en-GB' : 'bn-BD', { dateStyle: 'medium', timeStyle: 'short' });
  return (
    <span className={className} title={value}>
      {text}
    </span>
  );
}
