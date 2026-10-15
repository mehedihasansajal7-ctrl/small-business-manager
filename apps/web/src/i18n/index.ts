import { CORE_MESSAGES } from './messages.core';
import { SCREEN_MESSAGES } from './messages.screens';

/**
 * Bilingual UI strings. English starts active and Bangla is one tap away, so every
 * key MUST have a `bn` value; `en` is the fallback when a key is missing.
 */
export const MESSAGES = { ...CORE_MESSAGES, ...SCREEN_MESSAGES } as const;

export type MessageKey = keyof typeof MESSAGES;

export type Locale = 'bn-BD' | 'en';

export const LOCALES: readonly { readonly id: Locale; readonly label: string }[] = Object.freeze([
  // The default first, so the switcher mirrors the initial language.
  { id: 'en', label: 'English' },
  { id: 'bn-BD', label: 'বাংলা' },
]);

export const DEFAULT_LOCALE: Locale = 'en';

export function isLocale(value: unknown): value is Locale {
  return value === 'bn-BD' || value === 'en';
}

export type Vars = Readonly<Record<string, string | number>>;

/**
 * Look up a string and interpolate `{name}` placeholders. Unknown keys return the
 * key itself (visible in development) instead of throwing.
 */
export function translate(locale: Locale, key: MessageKey, vars?: Vars): string {
  const entry: { en: string; bn: string } | undefined = MESSAGES[key];
  if (!entry) return String(key);
  const template = (locale === 'en' ? entry.en : entry.bn) || entry.en;
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (_match, name: string) => {
    const value = vars[name];
    return value === undefined ? `{${name}}` : String(value);
  });
}

/** Locale used for `<html lang>` and `Intl` formatting. */
export function htmlLang(locale: Locale): string {
  return locale === 'en' ? 'en' : 'bn';
}

export { CORE_MESSAGES, SCREEN_MESSAGES };
