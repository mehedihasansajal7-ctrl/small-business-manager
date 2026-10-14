import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { businesses as businessApi, auth as authApi } from '../api/endpoints';
import { ApiError, onUnauthorized } from '../api/client';
import type { BusinessCurrent, MeResponse } from '../api/types';
import { DEFAULT_LOCALE, isLocale, translate, type Locale, type MessageKey, type Vars } from '../i18n';
import { applyTheme, persistTheme, readThemeChoice, resolveTheme, systemPrefersDark, type ResolvedTheme, type ThemeChoice } from '../theme/theme';
import { getSyncCoordinator } from '../offline/sync';
import { deviceId } from '../offline/localStorage';
import type { OutboxContext } from '../offline/outbox';
import { PREF_KEYS, readPreference, writePreference } from './preferences';
import { navigate } from './router';

/**
 * App-wide state: the signed-in user, the active business (and therefore the
 * permission list), locale, theme and transient status messages.
 *
 * It also supplies the business context to the sync coordinator, so queued work
 * always belongs to the business the user is actually looking at.
 */

export type StatusLevel = 'info' | 'success' | 'warn' | 'error';

export interface StatusMessage {
  readonly text: string;
  readonly level: StatusLevel;
  readonly at: number;
}

export interface RegisterInput {
  readonly email: string;
  readonly password: string;
  readonly displayName: string;
  readonly businessName?: string;
}

export interface AppValue {
  readonly ready: boolean;
  readonly me: MeResponse | null;
  readonly business: BusinessCurrent | null;
  readonly permissions: readonly string[];
  readonly role: string;
  readonly locale: Locale;
  setLocale: (locale: Locale) => void;
  readonly themeChoice: ThemeChoice;
  setThemeChoice: (choice: ThemeChoice) => void;
  readonly resolvedTheme: ResolvedTheme;
  readonly status: StatusMessage | null;
  notify: (text: string, level?: StatusLevel) => void;
  signIn: (email: string, password: string) => Promise<void>;
  register: (input: RegisterInput) => Promise<void>;
  signOut: () => Promise<void>;
  switchBusiness: (businessId: string) => Promise<void>;
  acceptInvite: (code: string) => Promise<void>;
  refresh: () => Promise<void>;
  readonly needsSetup: boolean;
  readonly outboxContext: OutboxContext | null;
}

const AppContext = createContext<AppValue | null>(null);

export function useApp(): AppValue {
  const value = useContext(AppContext);
  if (!value) throw new Error('useApp must be used inside <AppProvider>');
  return value;
}

/** Translation helper: `const { t } = useT()`. */
export function useT(): { t: (key: MessageKey, vars?: Vars) => string; locale: Locale } {
  const { locale } = useApp();
  return useMemo(() => ({ t: (key: MessageKey, vars?: Vars) => translate(locale, key, vars), locale }), [locale]);
}

function readStoredLocale(): Locale {
  const stored = readPreference(PREF_KEYS.locale);
  return isLocale(stored) ? stored : DEFAULT_LOCALE;
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(() => readStoredLocale());
  const [themeChoice, setThemeChoiceState] = useState<ThemeChoice>(() => readThemeChoice());
  const [systemDark, setSystemDark] = useState<boolean>(() => systemPrefersDark());
  const [me, setMe] = useState<MeResponse | null>(null);
  const [business, setBusiness] = useState<BusinessCurrent | null>(null);
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState<StatusMessage | null>(null);
  const statusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const resolvedTheme = resolveTheme(themeChoice, systemDark);

  // ---------------------------------------------------------------- theme
  useEffect(() => {
    applyTheme(resolvedTheme);
  }, [resolvedTheme]);

  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const media = matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => setSystemDark(media.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    document.documentElement.lang = locale === 'en' ? 'en' : 'bn';
    writePreference(PREF_KEYS.locale, locale);
  }, [locale]);

  const notify = useCallback((text: string, level: StatusLevel = 'info') => {
    setStatus({ text, level, at: Date.now() });
    if (statusTimer.current) clearTimeout(statusTimer.current);
    statusTimer.current = setTimeout(() => setStatus(null), 8_000);
  }, []);

  // ---------------------------------------------------------------- session
  const loadBusiness = useCallback(async (activeBusinessId: string | null) => {
    if (!activeBusinessId) {
      setBusiness(null);
      return;
    }
    try {
      setBusiness(await businessApi.current());
    } catch (error) {
      if (error instanceof ApiError && error.code === 'NO_BUSINESS') {
        setBusiness(null);
        return;
      }
      throw error;
    }
  }, []);

  const refresh = useCallback(async () => {
    try {
      const session = await authApi.me();
      setMe(session);
      await loadBusiness(session.activeBusinessId);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setMe(null);
        setBusiness(null);
        return;
      }
      throw error;
    }
  }, [loadBusiness]);

  useEffect(() => {
    void refresh().finally(() => setReady(true));
  }, [refresh]);

  // Session expiry anywhere in the app sends the user back to sign-in.
  useEffect(
    () =>
      onUnauthorized(() => {
        setMe(null);
        setBusiness(null);
        navigate('/sign-in', { replace: true });
      }),
    [],
  );

  // Keep the sync coordinator pointed at the active business.
  const outboxContext = useMemo<OutboxContext | null>(() => {
    if (!me || !business) return null;
    return { businessId: business.id, actorId: me.user.id, deviceId: deviceId() };
  }, [me, business]);

  useEffect(() => {
    const coordinator = getSyncCoordinator();
    if (!outboxContext) {
      coordinator.stop();
      return;
    }
    coordinator.setOptions({ getContext: () => outboxContext });
    coordinator.start();
    return () => coordinator.stop();
  }, [outboxContext]);

  const signIn = useCallback(
    async (email: string, password: string) => {
      await authApi.login({ email, password });
      await refresh();
      navigate('/', { replace: true });
    },
    [refresh],
  );

  const register = useCallback(
    async (input: RegisterInput) => {
      await authApi.register(input);
      await refresh();
      navigate('/', { replace: true });
    },
    [refresh],
  );

  const signOut = useCallback(async () => {
    try {
      await authApi.logout();
    } catch {
      /* the local session is cleared regardless */
    }
    getSyncCoordinator().stop();
    setMe(null);
    setBusiness(null);
    navigate('/sign-in', { replace: true });
  }, []);

  const switchBusiness = useCallback(
    async (businessId: string) => {
      await businessApi.switch(businessId);
      writePreference(PREF_KEYS.businessId, businessId);
      await refresh();
      navigate('/', { replace: true });
    },
    [refresh],
  );

  const acceptInvite = useCallback(
    async (code: string) => {
      const result = await authApi.acceptInvite(code);
      writePreference(PREF_KEYS.businessId, result.businessId);
      await refresh();
    },
    [refresh],
  );

  const needsSetup = Boolean(me) && !business;

  const value = useMemo<AppValue>(
    () => ({
      ready,
      me,
      business,
      permissions: business?.permissions ?? [],
      role: business?.member.role ?? '',
      locale,
      setLocale: setLocaleState,
      themeChoice,
      setThemeChoice: (choice: ThemeChoice) => {
        setThemeChoiceState(choice);
        persistTheme(choice);
      },
      resolvedTheme,
      status,
      notify,
      signIn,
      register,
      signOut,
      switchBusiness,
      acceptInvite,
      refresh,
      needsSetup,
      outboxContext,
    }),
    [ready, me, business, locale, themeChoice, resolvedTheme, status, notify, signIn, register, signOut, switchBusiness, acceptInvite, refresh, needsSetup, outboxContext],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}
