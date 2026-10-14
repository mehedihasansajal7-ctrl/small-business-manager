import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useColorScheme, type FontVariant } from 'react-native';

import { PREF_KEYS, readPref, writePref } from '../prefs/storage';

/**
 * Theme: light and dark, persisted, with a "follow the system" option.
 *
 * Colours are semantic (surface / text / danger / sync states) rather than
 * literal, so screens never hard-code a hex value and the whole app can be
 * re-skinned in one place. The status colours intentionally match the sync badge
 * vocabulary of `@sbm/domain` (pending / needs attention / conflict / rejected).
 */

export type ThemeMode = 'light' | 'dark' | 'system';

export interface ThemeColors {
  readonly background: string;
  readonly surface: string;
  readonly surfaceAlt: string;
  readonly border: string;
  readonly text: string;
  readonly textMuted: string;
  readonly primary: string;
  readonly primaryText: string;
  readonly primaryMuted: string;
  readonly danger: string;
  readonly dangerMuted: string;
  readonly warning: string;
  readonly warningMuted: string;
  readonly success: string;
  readonly successMuted: string;
  readonly info: string;
  readonly infoMuted: string;
  readonly shadow: string;
}

const LIGHT: ThemeColors = {
  background: '#f6f7f9',
  surface: '#ffffff',
  surfaceAlt: '#f0f2f5',
  border: '#d9dde3',
  text: '#16191d',
  textMuted: '#5f6772',
  primary: '#0f7b4f',
  primaryText: '#ffffff',
  primaryMuted: '#e2f2ea',
  danger: '#b3261e',
  dangerMuted: '#fdecea',
  warning: '#8a5300',
  warningMuted: '#fff4e0',
  success: '#1b6b3a',
  successMuted: '#e6f4ea',
  info: '#1a4fa0',
  infoMuted: '#e8effb',
  shadow: '#101418',
};

const DARK: ThemeColors = {
  background: '#0f1216',
  surface: '#171b21',
  surfaceAlt: '#1f242c',
  border: '#2c333d',
  text: '#f2f4f7',
  textMuted: '#a7b0bd',
  primary: '#3fb27f',
  primaryText: '#08231a',
  primaryMuted: '#123024',
  danger: '#f28175',
  dangerMuted: '#3a1c1a',
  warning: '#f0b866',
  warningMuted: '#3a2c12',
  success: '#6bd39a',
  successMuted: '#123024',
  info: '#8fb6f5',
  infoMuted: '#152439',
  shadow: '#000000',
};

export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;
export const radius = { sm: 6, md: 10, lg: 16, pill: 999 } as const;
export const typography = {
  title: { fontSize: 22, fontWeight: '700' as const },
  heading: { fontSize: 18, fontWeight: '700' as const },
  subheading: { fontSize: 15, fontWeight: '600' as const },
  body: { fontSize: 15, fontWeight: '400' as const },
  label: { fontSize: 13, fontWeight: '600' as const },
  caption: { fontSize: 12, fontWeight: '400' as const },
  /**
   * Money and quantities. `fontVariant: ['tabular-nums']` keeps columns of digits
   * aligned; the assertion is needed because `as const` on the object below would
   * otherwise freeze the array into a readonly type that React Native's
   * `TextStyle.fontVariant` does not accept.
   */
  mono: { fontSize: 14, fontWeight: '400' as const, fontVariant: ['tabular-nums'] as FontVariant[] },
} as const;

export interface ThemeValue {
  readonly mode: ThemeMode;
  readonly scheme: 'light' | 'dark';
  readonly colors: ThemeColors;
  readonly spacing: typeof spacing;
  readonly radius: typeof radius;
  readonly typography: typeof typography;
  setMode(mode: ThemeMode): Promise<void>;
}

const ThemeContext = createContext<ThemeValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const systemScheme = useColorScheme();
  const [mode, setModeState] = useState<ThemeMode>('system');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const stored = await readPref(PREF_KEYS.theme);
      if (!cancelled && (stored === 'light' || stored === 'dark' || stored === 'system')) setModeState(stored);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const setMode = useCallback(async (next: ThemeMode) => {
    setModeState(next);
    await writePref(PREF_KEYS.theme, next);
  }, []);

  const scheme: 'light' | 'dark' = mode === 'system' ? (systemScheme === 'dark' ? 'dark' : 'light') : mode;

  const value = useMemo<ThemeValue>(
    () => ({
      mode,
      scheme,
      colors: scheme === 'dark' ? DARK : LIGHT,
      spacing,
      radius,
      typography,
      setMode,
    }),
    [mode, scheme, setMode],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeValue {
  const context = useContext(ThemeContext);
  if (!context) throw new Error('useTheme must be used inside <ThemeProvider>');
  return context;
}

/** Status → colour pair, shared by the sync badges and every proposal label. */
export function statusColors(scheme: 'light' | 'dark', status: string): { background: string; text: string } {
  const colors = scheme === 'dark' ? DARK : LIGHT;
  switch (status) {
    case 'SYNCED':
      return { background: colors.successMuted, text: colors.success };
    case 'PENDING':
    case 'SYNCING':
      return { background: colors.warningMuted, text: colors.warning };
    case 'CONFLICT':
    case 'REJECTED':
      return { background: colors.dangerMuted, text: colors.danger };
    case 'NEEDS_ATTENTION':
      return { background: colors.infoMuted, text: colors.info };
    default:
      return { background: colors.surfaceAlt, text: colors.textMuted };
  }
}
