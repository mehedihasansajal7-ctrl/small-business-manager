import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';

/**
 * Environment configuration + validation.
 *
 * Runs with ZERO cloud credentials in `local` mode (embedded SQLite), so the
 * whole app is usable and testable offline with no accounts and no cost.
 */

export type Mode = 'local' | 'shared';

export interface AppConfig {
  readonly mode: Mode;
  readonly port: number;
  readonly host: string;
  readonly dataDir: string;
  readonly databaseFile: string;
  readonly defaultTimezone: string;
  readonly defaultCurrency: string;
  readonly defaultLocale: string;
  readonly sessionSecret: string;
  readonly sessionTtlHours: number;
  readonly secureCookies: boolean;
  readonly corsOrigin: string | null;
  readonly supabase: { url: string; anonKey: string; serviceRoleKey: string } | null;
  readonly ai: {
    readonly provider: 'none' | 'local-ollama' | 'openai-compatible';
    readonly baseUrl: string;
    readonly apiKey: string;
    readonly model: string;
    readonly ollamaUrl: string;
    readonly ollamaModel: string;
    readonly timeoutMs: number;
    readonly maxOutputTokens: number;
    readonly rateLimitPerHour: number;
  };
  readonly research: {
    readonly provider: 'none' | 'searxng';
    readonly baseUrl: string;
    readonly apiKey: string;
    readonly timeoutMs: number;
    readonly rateLimitPerHour: number;
    readonly cacheTtlHours: number;
  };
  /** Abuse-protection limits. Raised in tests via overrides. */
  readonly rateLimits: {
    readonly registerPerHour: number;
    readonly loginPer15Min: number;
    readonly invitePerHour: number;
  };
}

/** Minimal .env reader (no dependency). Existing process env always wins. */
export function loadDotEnv(file: string): void {
  if (!existsSync(file)) return;
  const text = readFileSync(file, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function env(key: string): string {
  return (process.env[key] ?? '').trim();
}

function num(key: string, fallback: number): number {
  const raw = env(key);
  if (raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new Error(`Environment variable ${key} must be a number, got ${JSON.stringify(raw)}`);
  return parsed;
}

function bool(key: string): boolean {
  const raw = env(key).toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}

/** Load and validate configuration. Throws with a clear message on bad input. */
export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const dataDir = resolve(env('DATA_DIR') || './data');
  mkdirSync(dataDir, { recursive: true });

  // `SBM_MODE` is the app's own setting. `MODE` is only consulted as a fallback
  // because bundlers (Vite/Vitest) set MODE=test/development for their own needs.
  const explicitMode = env('SBM_MODE');
  const legacyMode = env('MODE');
  const bundlerModes = new Set(['test', 'development', 'production']);
  let modeRaw = (explicitMode || legacyMode || 'local').toLowerCase();
  if (!explicitMode && bundlerModes.has(modeRaw)) modeRaw = 'local';
  if (modeRaw !== 'local' && modeRaw !== 'shared') {
    throw new Error(`SBM_MODE must be "local" or "shared", got ${JSON.stringify(modeRaw)}`);
  }
  const mode = modeRaw as Mode;

  let sessionSecret = env('SESSION_SECRET');
  if (sessionSecret === '') {
    // Local development: generate once and persist so sessions survive restarts.
    const secretFile = join(dataDir, '.session_secret');
    if (existsSync(secretFile)) {
      sessionSecret = readFileSync(secretFile, 'utf8').trim();
    } else {
      sessionSecret = randomBytes(48).toString('base64url');
      mkdirSync(dirname(secretFile), { recursive: true });
      writeFileSync(secretFile, sessionSecret, { mode: 0o600 });
    }
  }
  if (mode === 'shared' && sessionSecret.length < 32) {
    throw new Error('SESSION_SECRET must be at least 32 characters in shared mode');
  }

  const supabaseUrl = env('SUPABASE_URL');
  const supabaseAnon = env('SUPABASE_ANON_KEY');
  const supabaseService = env('SUPABASE_SERVICE_ROLE_KEY');
  const supabase = supabaseUrl && supabaseAnon ? { url: supabaseUrl, anonKey: supabaseAnon, serviceRoleKey: supabaseService } : null;

  const aiProviderRaw = env('AI_PROVIDER').toLowerCase() || 'none';
  if (!['none', 'local-ollama', 'openai-compatible'].includes(aiProviderRaw)) {
    throw new Error(`AI_PROVIDER must be none|local-ollama|openai-compatible, got ${JSON.stringify(aiProviderRaw)}`);
  }

  const researchRaw = env('RESEARCH_PROVIDER').toLowerCase() || 'none';
  if (!['none', 'searxng'].includes(researchRaw)) {
    throw new Error(`RESEARCH_PROVIDER must be none|searxng, got ${JSON.stringify(researchRaw)}`);
  }

  const config: AppConfig = {
    mode,
    port: num('PORT', 8787),
    host: env('HOST') || '127.0.0.1',
    dataDir,
    databaseFile: env('DATABASE_FILE') || join(dataDir, 'sbm.db'),
    defaultTimezone: env('DEFAULT_TIMEZONE') || 'Asia/Dhaka',
    defaultCurrency: env('DEFAULT_CURRENCY') || 'BDT',
    defaultLocale: env('DEFAULT_LOCALE') || 'bn-BD',
    sessionSecret,
    sessionTtlHours: num('SESSION_TTL_HOURS', 720),
    secureCookies: !bool('INSECURE_COOKIES'),
    corsOrigin: env('CORS_ORIGIN') || null,
    supabase,
    ai: {
      provider: aiProviderRaw as AppConfig['ai']['provider'],
      baseUrl: env('AI_BASE_URL'),
      apiKey: env('AI_API_KEY'),
      model: env('AI_MODEL'),
      ollamaUrl: env('AI_OLLAMA_URL') || 'http://127.0.0.1:11434',
      ollamaModel: env('AI_OLLAMA_MODEL') || 'llama3.1:8b',
      timeoutMs: num('AI_TIMEOUT_MS', 20_000),
      maxOutputTokens: num('AI_MAX_OUTPUT_TOKENS', 700),
      rateLimitPerHour: num('AI_RATE_LIMIT_PER_HOUR', 30),
    },
    research: {
      provider: researchRaw as AppConfig['research']['provider'],
      baseUrl: env('RESEARCH_BASE_URL'),
      apiKey: env('RESEARCH_API_KEY'),
      timeoutMs: num('RESEARCH_TIMEOUT_MS', 15_000),
      rateLimitPerHour: num('RESEARCH_RATE_LIMIT_PER_HOUR', 20),
      cacheTtlHours: num('RESEARCH_CACHE_TTL_HOURS', 24 * 7),
    },
    rateLimits: {
      registerPerHour: num('RATE_LIMIT_REGISTER_PER_HOUR', 10),
      loginPer15Min: num('RATE_LIMIT_LOGIN_PER_15MIN', 20),
      invitePerHour: num('RATE_LIMIT_INVITE_PER_HOUR', 30),
    },
  };

  return { ...config, ...overrides };
}

/** A short, non-secret description of the active configuration for the status screen. */
export function describeConfig(config: AppConfig): Record<string, unknown> {
  return {
    mode: config.mode,
    database: config.mode === 'local' ? 'embedded-sqlite' : 'shared-cloud',
    timezone: config.defaultTimezone,
    currency: config.defaultCurrency,
    locale: config.defaultLocale,
    supabaseConfigured: config.supabase !== null,
    ai: {
      provider: config.ai.provider,
      hasKey: config.ai.apiKey !== '',
      model: config.ai.model || config.ai.ollamaModel,
      rateLimitPerHour: config.ai.rateLimitPerHour,
      fallbackAvailable: true,
    },
    research: {
      provider: config.research.provider,
      hasKey: config.research.apiKey !== '',
      curatedFallback: true,
    },
    secureCookies: config.secureCookies,
  };
}
