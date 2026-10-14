import type { ConfigContext, ExpoConfig } from 'expo/config';

/**
 * `app.config.ts` runs in Node (not on the device), so `process.env` is real here.
 * Declared module-scoped to type-check without pulling in `@types/node`.
 */
declare const process: { env: Record<string, string | undefined> };

/**
 * Dynamic Expo config.
 *
 * `app.json` holds the static manifest (name, scheme, android package, version
 * code and the permission list). This file only layers the two things that must
 * be able to differ per machine without editing a tracked file:
 *
 *  1. `EXPO_PUBLIC_API_URL` — the base URL of the self-hosted API.
 *     Default `http://10.0.2.2:8787` is the Android emulator's alias for the
 *     developer machine's `localhost`.
 *  2. a version-code bump via `SBM_ANDROID_VERSION_CODE` for sideloaded builds.
 *
 * NOTE: Expo reads `app.config.{js,ts}` in preference to `app.json`; the `config`
 * argument below is the parsed `app.json`, so nothing is duplicated.
 * TypeScript here requires `ts-node` (declared in devDependencies) — this is the
 * documented Expo requirement for `app.config.ts`.
 */
export default ({ config }: ConfigContext): ExpoConfig => {
  const apiUrl = process.env.EXPO_PUBLIC_API_URL ?? (config.extra?.apiUrl as string | undefined) ?? 'http://10.0.2.2:8787';
  const versionCode = process.env.SBM_ANDROID_VERSION_CODE ? Number(process.env.SBM_ANDROID_VERSION_CODE) : undefined;

  return {
    ...config,
    name: config.name ?? 'Small Business Manager',
    slug: config.slug ?? 'small-business-manager',
    extra: {
      ...config.extra,
      apiUrl,
    },
    android: {
      ...config.android,
      ...(versionCode && Number.isFinite(versionCode) ? { versionCode } : {}),
    },
  };
};
