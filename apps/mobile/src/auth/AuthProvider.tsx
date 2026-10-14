import type { BusinessVisibilitySettings, Permission, Role } from '@sbm/domain';
import { permissionsFor } from '@sbm/domain';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import * as api from '../api/endpoints';
import { describeError, onUnauthorized } from '../api/client';
import { clearSession, getSessionSync, loadSession, onSessionChanged } from '../api/session-store';
import type { BusinessMembership, CurrentBusiness, UserSummary } from '../api/types';
import { PREF_KEYS, readJsonPref, writeJsonPref } from '../prefs/storage';
import { setActiveBusinessId as persistActiveBusinessId } from '../offline/repository';
import { useNetwork } from '../lib/network';

/**
 * Authentication + tenancy context.
 *
 * What it owns:
 *  - the session (a signed cookie in the device keystore; see session-store.ts),
 *  - the signed-in user, their businesses, and the *active* business,
 *  - the effective permission set (`@sbm/domain`'s `permissionsFor`, fed with the
 *    member's grants/denials and the owner's visibility settings) used by
 *    `<PermissionGate>` to hide or disable UI.
 *
 * Offline behaviour, deliberately:
 *  - a **cached snapshot** of the last successful `/api/auth/me` + business load
 *    is kept in AsyncStorage, so a partner who opens the app on a plane still
 *    reaches the dashboard and can record sales;
 *  - the permission set is then recomputed locally from the cached role and
 *    overrides, and the server re-checks everything on sync anyway. The UI gate
 *    is a convenience, never the security boundary.
 */

export type AuthStatus = 'loading' | 'signedOut' | 'signedIn';

interface CachedSnapshot {
  readonly user: UserSummary;
  readonly businesses: readonly BusinessMembership[];
  readonly activeBusinessId: string | null;
  readonly business: CurrentBusiness | null;
  readonly cachedAt: string;
}

export interface AuthValue {
  readonly status: AuthStatus;
  readonly user: UserSummary | null;
  readonly businesses: readonly BusinessMembership[];
  readonly business: CurrentBusiness | null;
  readonly role: Role | null;
  readonly permissions: ReadonlySet<Permission>;
  readonly memberId: string | null;
  readonly businessId: string | null;
  readonly useCachedData: boolean;
  readonly online: boolean;
  signIn(email: string, password: string): Promise<void>;
  register(input: { email: string; password: string; displayName: string; businessName?: string }): Promise<void>;
  signOut(): Promise<void>;
  switchBusiness(businessId: string): Promise<void>;
  joinWithCode(code: string): Promise<{ businessId: string; role: string }>;
  refresh(): Promise<void>;
  createBusiness(input: { name: string; currency?: string; timezone?: string; locale?: string }): Promise<void>;
  can(permission: Permission): boolean;
  canAll(permissions: readonly Permission[]): boolean;
}

const AuthContext = createContext<AuthValue | null>(null);

const SETTINGS_KEYS: (keyof BusinessVisibilitySettings)[] = ['partnerCanSeeFinancialReports', 'partnerCanSeeCosts', 'partnerCanSeeCapital'];

function visibilitySettings(business: CurrentBusiness | null): BusinessVisibilitySettings {
  if (!business) return {};
  const settings: Record<string, boolean> = {};
  for (const key of SETTINGS_KEYS) {
    const value = (business.settings as Record<string, unknown> | undefined)?.[key];
    if (typeof value === 'boolean') settings[key] = value;
  }
  return settings as BusinessVisibilitySettings;
}

function computePermissions(business: CurrentBusiness | null): ReadonlySet<Permission> {
  if (!business) return new Set<Permission>();
  // The server already sends the resolved list; prefer it, and fall back to the
  // shared domain function (identical rules) when running from a cache that
  // predates it.
  if (Array.isArray(business.permissions) && business.permissions.length > 0) return new Set(business.permissions);
  return permissionsFor(business.member.role, { grants: business.member.grants, denials: business.member.denials }, visibilitySettings(business));
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const { online } = useNetwork();
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [user, setUser] = useState<UserSummary | null>(null);
  const [businesses, setBusinesses] = useState<readonly BusinessMembership[]>([]);
  const [business, setBusiness] = useState<CurrentBusiness | null>(null);
  const [useCachedData, setUseCachedData] = useState(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const reset = useCallback(async () => {
    await clearSession();
    if (!mounted.current) return;
    setUser(null);
    setBusinesses([]);
    setBusiness(null);
    setUseCachedData(false);
    setStatus('signedOut');
  }, []);

  /** Load `/api/auth/me` + the active business, falling back to the cache. */
  const loadFromServer = useCallback(async (): Promise<boolean> => {
    try {
      const me = await api.me();
      let current: CurrentBusiness | null = null;
      if (me.activeBusinessId) {
        current = await api.currentBusiness();
      }
      if (!mounted.current) return true;
      setUser(me.user);
      setBusinesses(me.businesses);
      setBusiness(current);
      setUseCachedData(false);
      setStatus('signedIn');
      if (me.activeBusinessId) await persistActiveBusinessId(me.activeBusinessId);
      const snapshot: CachedSnapshot = {
        user: me.user,
        businesses: me.businesses,
        activeBusinessId: me.activeBusinessId,
        business: current,
        cachedAt: new Date().toISOString(),
      };
      await writeJsonPref(PREF_KEYS.activeBusinessId, snapshot);
      return true;
    } catch {
      return false;
    }
  }, []);

  const loadFromCache = useCallback(async (): Promise<boolean> => {
    const snapshot = await readJsonPref<CachedSnapshot>(PREF_KEYS.activeBusinessId);
    if (!snapshot?.user) return false;
    if (!mounted.current) return true;
    setUser(snapshot.user);
    setBusinesses(snapshot.businesses);
    setBusiness(snapshot.business);
    setUseCachedData(true);
    setStatus('signedIn');
    return true;
  }, []);

  const refresh = useCallback(async () => {
    if (getSessionSync()?.cookie) {
      const ok = await loadFromServer();
      if (!ok) await loadFromCache();
    }
  }, [loadFromServer, loadFromCache]);

  // Boot: a stored cookie means the user expects to be signed in.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      await loadSession();
      if (cancelled) return;
      if (!getSessionSync()?.cookie) {
        // No cookie, but a cached snapshot may exist from a previous session
        // whose cookie was cleared: never auto-sign-in without a session.
        setStatus('signedOut');
        return;
      }
      const ok = await loadFromServer();
      if (cancelled) return;
      if (!ok) {
        const cached = await loadFromCache();
        if (!cached && !cancelled) setStatus('signedOut');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadFromServer, loadFromCache]);

  // The API client clears the session and fires this on any 401.
  useEffect(() => onUnauthorized(() => void reset()), [reset]);

  // A session captured by a login/register elsewhere also refreshes the state.
  useEffect(() => onSessionChanged(() => void refresh()), [refresh]);

  const signIn = useCallback(
    async (email: string, password: string) => {
      const result = await api.login(email.trim(), password);
      setUser(result.user);
      setBusinesses(result.businesses);
      setStatus('signedIn');
      const ok = await loadFromServer();
      if (!ok) {
        setStatus('signedIn');
        setUseCachedData(true);
      }
    },
    [loadFromServer],
  );

  const register = useCallback(
    async (input: { email: string; password: string; displayName: string; businessName?: string }) => {
      await api.register(input);
      await loadFromServer();
    },
    [loadFromServer],
  );

  const switchBusiness = useCallback(
    async (businessId: string) => {
      // Ask the server to re-scope the session (sync push/pull is business-scoped),
      // then reflect the change locally. Switching needs the internet because the
      // session cookie itself carries the active business.
      await api.switchBusiness(businessId);
      await loadFromServer();
      await persistActiveBusinessId(businessId);
    },
    [loadFromServer],
  );

  const joinWithCode = useCallback(
    async (code: string) => {
      const result = await api.acceptInvite(code);
      await loadFromServer();
      return result;
    },
    [loadFromServer],
  );

  const createBusiness = useCallback(
    async (input: { name: string; currency?: string; timezone?: string; locale?: string }) => {
      await api.createBusiness(input);
      await loadFromServer();
    },
    [loadFromServer],
  );

  const permissions = useMemo(() => computePermissions(business), [business]);
  const role = business?.member.role ?? null;

  const value = useMemo<AuthValue>(
    () => ({
      status,
      user,
      businesses,
      business,
      role,
      permissions,
      memberId: business?.member.id ?? null,
      businessId: business?.id ?? null,
      useCachedData,
      online,
      signIn,
      register,
      signOut: reset,
      switchBusiness,
      joinWithCode,
      refresh,
      createBusiness,
      can: (permission) => permissions.has(permission),
      canAll: (list) => list.every((permission) => permissions.has(permission)),
    }),
    [status, user, businesses, business, role, permissions, useCachedData, online, signIn, register, reset, switchBusiness, joinWithCode, refresh, createBusiness],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside <AuthProvider>');
  return context;
}

/** Convenience for screens that only need to show a friendly error. */
export function authErrorMessage(error: unknown): string {
  return describeError(error).message;
}
