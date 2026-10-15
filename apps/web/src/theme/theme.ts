import { PREF_KEYS, readPreference, writePreference } from '../state/preferences';

/**
 * Light + dark, persisted.
 *
 * There is no "System" option: it is a preference the person cannot see, and a
 * business app should show exactly what it is set to. The OS preference is still
 * honoured ONCE, when nothing has been chosen yet, so that removing the option
 * never flips somebody's theme on them - after that the choice is explicit.
 */
export type ThemeChoice = 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

export function isThemeChoice(value: unknown): value is ThemeChoice {
  return value === 'light' || value === 'dark';
}

export function systemPrefersDark(): boolean {
  try {
    return globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
  } catch {
    return false;
  }
}

/**
 * The stored choice, or - only when nothing explicit was ever stored (including
 * a legacy `'system'`) - whatever the operating system prefers right now.
 */
export function readThemeChoice(): ThemeChoice {
  const stored = readPreference(PREF_KEYS.theme);
  if (isThemeChoice(stored)) return stored;
  return systemPrefersDark() ? 'dark' : 'light';
}

export function resolveTheme(choice: ThemeChoice, prefersDark?: boolean): ResolvedTheme {
  // Kept as a function (and keeping the second parameter optional) so callers and
  // tests that pass the OS preference keep working unchanged.
  void prefersDark;
  return choice;
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
