import { PREF_KEYS, readPreference, writePreference } from '../state/preferences';

/** Light + dark, persisted, and honouring the OS preference on first run. */
export type ThemeChoice = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

export function isThemeChoice(value: unknown): value is ThemeChoice {
  return value === 'light' || value === 'dark' || value === 'system';
}

export function readThemeChoice(): ThemeChoice {
  const stored = readPreference(PREF_KEYS.theme);
  return isThemeChoice(stored) ? stored : 'system';
}

export function resolveTheme(choice: ThemeChoice, prefersDark: boolean): ResolvedTheme {
  if (choice === 'system') return prefersDark ? 'dark' : 'light';
  return choice;
}

export function systemPrefersDark(): boolean {
  try {
    return globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
  } catch {
    return false;
  }
}

export function applyTheme(theme: ResolvedTheme): void {
  const root = globalThis.document?.documentElement;
  if (!root) return;
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
}

export function persistTheme(choice: ThemeChoice): void {
  writePreference(PREF_KEYS.theme, choice);
}
