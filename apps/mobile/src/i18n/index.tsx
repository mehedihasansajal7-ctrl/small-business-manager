import { formatDateBn, formatMoney, money, toBanglaDigits } from '@sbm/domain';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import { PREF_KEYS, readPref, writePref } from '../prefs/storage';
import { DEFAULT_LOCALE, isAppLocale, translate, type AppLocale, type StringKey } from './strings';

/**
 * i18n provider.
 *
 * - Bangla is the default (`bn-BD`), matching the target partners.
 * - The choice is persisted, so it survives restarts.
 * - Money, digits and dates are formatted by `@sbm/domain`, never by hand: the
 *   same rupee/taka grouping, the same Bangla digit map and the same month names
 *   as the server and the web client. `Number.toLocaleString` is never used for
 *   money, because ICU data differs between devices and it silently loses the
 *   exact decimal representation.
 */

export interface I18nValue {
  readonly locale: AppLocale;
  /** What the API/domain calls it: `bn` | `en`. */
  readonly language: 'bn' | 'en';
  readonly ready: boolean;
  setLocale(locale: AppLocale): Promise<void>;
  t(key: StringKey): string;
  /** Exact decimal string → localised money, e.g. ৳12,34,567.89 / BDT 12,345.67. */
  money(value: string | number | null | undefined, currency: string): string;
  /** Exact decimal string → localised quantity (no currency symbol). */
  quantity(value: string | number | null | undefined): string;
  /** Replace ASCII digits with Bangla digits when Bangla is selected. */
  digits(value: string | number): string;
  /** ISO date → `১৫ অক্টোবর ২০২৬` or `2026-10-15`. */
  date(isoDate: string | null | undefined): string;
  /** Join parts with the locale's separator for the "as of last sync" hints. */
  asOfLastSync(): string;
}

const I18nContext = createContext<I18nValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<AppLocale>(DEFAULT_LOCALE);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const stored = await readPref(PREF_KEYS.locale);
      if (!cancelled && stored && isAppLocale(stored)) setLocaleState(stored);
      if (!cancelled) setReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const setLocale = useCallback(async (next: AppLocale) => {
    setLocaleState(next);
    await writePref(PREF_KEYS.locale, next);
  }, []);

  const language: 'bn' | 'en' = locale === 'en' ? 'en' : 'bn';
  const bangla = language === 'bn';

  const value = useMemo<I18nValue>(() => {
    const toText = (input: string | number | null | undefined): string => (input === null || input === undefined ? '' : String(input));

    return {
      locale,
      language,
      ready,
      setLocale,
      t: (key) => translate(key, locale),
      money: (amount, currency) => {
        const text = toText(amount);
        if (text === '') return '';
        try {
          return formatMoney(money(currency, text), { banglaDigits: bangla });
        } catch {
          // Never render a broken (or silently wrong) figure: show the raw exact
          // decimal and let the user see that something is off.
          return `${currency} ${text}`;
        }
      },
      quantity: (amount) => {
        const text = toText(amount);
        return bangla ? toBanglaDigits(text) : text;
      },
      digits: (input) => (bangla ? toBanglaDigits(toText(input)) : toText(input)),
      date: (isoDate) => {
        const text = toText(isoDate);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
        return bangla ? formatDateBn(text) : text;
      },
      asOfLastSync: () => (bangla ? 'সর্বশেষ সিঙ্ক অনুযায়ী' : 'as of the last sync'),
    };
  }, [locale, language, bangla, ready, setLocale]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const context = useContext(I18nContext);
  if (!context) throw new Error('useI18n must be used inside <I18nProvider>');
  return context;
}

export { DEFAULT_LOCALE, LOCALES, type AppLocale, type StringKey } from './strings';
