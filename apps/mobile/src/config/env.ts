import Constants from 'expo-constants';

/**
 * Single source of truth for build-time configuration.
 *
 * The API base URL is resolved in this order:
 *  1. `EXPO_PUBLIC_API_URL` (inlined by Metro at bundle time, and used by
 *     `app.config.ts` for the `extra.apiUrl` value)
 *  2. `expo.extra.apiUrl` from app.json / app.config.ts
 *  3. the Android-emulator default — `10.0.2.2` is the emulator's alias for
 *     "the host machine's localhost", where `apps/api` listens on 8787.
 *
 * A physical device cannot reach `10.0.2.2`; point it at the LAN IP of the
 * machine running the API, e.g.
 *   EXPO_PUBLIC_API_URL=http://192.168.0.20:8787 npm run android
 */
const DEFAULT_API_URL = 'http://10.0.2.2:8787';

function readExtraApiUrl(): string | undefined {
  const extra = Constants.expoConfig?.extra as { apiUrl?: unknown } | undefined;
  return typeof extra?.apiUrl === 'string' ? extra.apiUrl : undefined;
}

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '');
  return trimmed === '' ? DEFAULT_API_URL : trimmed;
}

export const API_BASE_URL = normalizeBaseUrl(
  process.env.EXPO_PUBLIC_API_URL ?? readExtraApiUrl() ?? DEFAULT_API_URL,
);

/** Shown in Settings so a partner can confirm which server the app is using. */
export const APP_INFO = {
  name: 'Small Business Manager',
  version: (Constants.expoConfig?.version as string | undefined) ?? '1.0.0',
  androidPackage: (Constants.expoConfig?.android?.package as string | undefined) ?? 'com.sbm.businessmanager',
} as const;

/**
 * Local dev uses plain HTTP (10.0.2.2 / LAN IP). Android blocks cleartext HTTP
 * to arbitrary hosts by default; `expo run:android` generates a debug manifest
 * that allows it, and for a release build the API must be HTTPS.
 */
export const API_TIMEOUT_MS = 20_000;
export const ATTACHMENT_UPLOAD_TIMEOUT_MS = 60_000;
export const SYNC_BATCH_SIZE = 50;
