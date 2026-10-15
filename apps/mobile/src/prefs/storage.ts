import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * Tiny preferences store (locale, theme, active business, last seen values).
 *
 * Deliberately NOT expo-secure-store: these are not secrets, and SecureStore has
 * a small per-value size limit and is slower. The session cookie — the only real
 * credential — lives in `src/api/session-store.ts`.
 *
 * Every read is defensive: a corrupt or missing value must degrade to the
 * default, never crash the app on start-up.
 */

export async function readPref(key: string): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(key);
  } catch {
    return null;
  }
}

export async function writePref(key: string, value: string): Promise<void> {
  try {
    await AsyncStorage.setItem(key, value);
  } catch {
    // Losing a preference is not worth surfacing an error for.
  }
}

export async function readJsonPref<T>(key: string): Promise<T | null> {
  const raw = await readPref(key);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function writeJsonPref(key: string, value: unknown): Promise<void> {
  await writePref(key, JSON.stringify(value));
}

export const PREF_KEYS = {
  // v2: the old key only ever held the previous Bangla default, so it is ignored
  // once - the app now starts in English.
  locale: 'sbm.locale.v2',
  theme: 'sbm.theme',
  /** Last successful `/api/auth/me` + business load, so the app opens offline. */
  authSnapshot: 'sbm.auth.snapshot',
  activeBusinessId: 'sbm.business.active',
  lastOutboxCount: 'sbm.outbox.lastCount',
  onboardingDone: 'sbm.onboarding.done',
} as const;
