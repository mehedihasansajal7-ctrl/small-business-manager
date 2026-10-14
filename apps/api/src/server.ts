import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { AIAgent } from './ai.js';
import { AuthService } from './auth.js';
import { loadConfig, loadDotEnv, type AppConfig } from './config.js';
import { Database } from './db.js';
import { HttpError, applySecurityHeaders, clientIp, parseCookies, readJsonBody, sendJson } from './http.js';
import { Repository } from './repository.js';
import { buildRouter } from './routes.js';
import { SyncService } from './sync.js';

export interface App {
  readonly config: AppConfig;
  readonly db: Database;
  readonly repo: Repository;
  readonly auth: AuthService;
  readonly sync: SyncService;
  readonly ai: AIAgent;
  server: ReturnType<typeof createServer>;
  start(): Promise<{ port: number; host: string }>;
  stop(): Promise<void>;
}

/** Interface names that exist but a phone can never reach. */
const VIRTUAL_ADAPTER = /vEthernet|Virtual|Hyper-V|WSL|Default Switch|Loopback|Npcap|Bluetooth|VPN|TAP-|Tailscale|ZeroTier|Docker|Local Area Connection\*\s*\d+/i;
/** The adapters a phone is most likely on the other end of. */
const REAL_ADAPTER = /Wi-?Fi|WLAN|Wireless|Ethernet/i;

/**
 * Every IPv4 address a phone on the same network could use, best candidate first.
 *
 * Ordering matters because a Windows machine typically also has WSL, Hyper-V,
 * Docker and an ICS/hotspot adapter, and picking one of those produces a URL that
 * silently never answers — which looks exactly like a broken server.
 */
export function lanAddresses(port: number, options: { includeVirtual?: boolean } = {}): string[] {
  const found: { url: string; score: number }[] = [];
  for (const [name, entries] of Object.entries(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      if (entry.address.startsWith('169.254.')) continue; // link-local, not routable
      const virtual = VIRTUAL_ADAPTER.test(name);
      if (virtual && !options.includeVirtual) continue;
      const score = (virtual ? 10 : 0) + (REAL_ADAPTER.test(name) ? 0 : 1);
      found.push({ url: `http://${entry.address}:${port}`, score });
    }
  }
  return [...new Set(found.sort((a, b) => a.score - b.score).map((entry) => entry.url))];
}


// ---------------------------------------------------------------- static files

const MIME_TYPES: Readonly<Record<string, string>> = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
});

/**
 * Serve the built web app from the same container as the API.
 *
 * Optional: if `WEB_DIR` is unset or missing, the server is API-only (which is
 * all the Android app needs). Serving both from one origin also means the browser
 * client is same-origin with the API, so its session cookie just works and there
 * is no CORS or third-party-cookie problem.
 */
function tryServeStatic(res: ServerResponse, pathname: string, webDir: string): boolean {
  if (!existsSync(webDir)) return false;

  let target = normalize(decodeURIComponent(pathname));
  if (target === '/' || target === '' || target === '.') target = '/index.html';
  const full = resolve(webDir, `.${target.startsWith('/') ? target : `/${target}`}`);

  // Never serve outside the web root, however the path was crafted.
  const root = resolve(webDir);
  if (full !== root && !full.startsWith(root + sep)) return false;

  const candidate = existsSync(full) && statSync(full).isFile() ? full : join(root, 'index.html');
  if (!existsSync(candidate)) return false;

  const body = readFileSync(candidate);
  const extension = extname(candidate).toLowerCase();
  const isEntryHtml = candidate.endsWith('index.html');
  res.writeHead(200, {
    'content-type': MIME_TYPES[extension] ?? 'application/octet-stream',
    'content-length': body.length,
    // The app shell must never be cached (it references hashed asset names), while
    // hashed assets under /assets/ are immutable.
    'cache-control': isEntryHtml ? 'no-store' : 'public, max-age=31536000, immutable',
  });
  res.end(body);
  return true;
}

/** Build the whole application. `databaseFile: ':memory:'` gives an isolated instance for tests. */
export function createApp(overrides: Partial<AppConfig> = {}): App {
  const config = loadConfig(overrides);
  const db = new Database(config.databaseFile);
  const auth = new AuthService(db, config.sessionSecret, config.sessionTtlHours);
  const repo = new Repository(db, auth, config);
  const sync = new SyncService(repo);
  const ai = new AIAgent(repo, config);
  const router = buildRouter({ repo, auth, sync, ai, config });

  const server = createServer((req, res) => {
    void handle(req, res);
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    applySecurityHeaders(res);
    const method = req.method ?? 'GET';
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    const corsOrigin = config.corsOrigin;
    if (corsOrigin) {
      res.setHeader('access-control-allow-origin', corsOrigin);
      res.setHeader('access-control-allow-credentials', 'true');
      res.setHeader('access-control-allow-headers', 'content-type');
      res.setHeader('access-control-allow-methods', 'GET,POST,PATCH,PUT,DELETE,OPTIONS');
      if (method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }
    }

    const started = Date.now();
    const webDir = process.env.WEB_DIR ?? join(process.cwd(), 'apps', 'web', 'dist');
    try {
      const matched = router.match(method, url.pathname);
      if (!matched) {
        // Not an API route: this may be the browser client (or its assets).
        if (!url.pathname.startsWith('/api/') && (method === 'GET' || method === 'HEAD')) {
          if (tryServeStatic(res, url.pathname, webDir)) return;
        }
        throw HttpError.notFound(`No route for ${method} ${url.pathname}`);
      }

      let body: unknown;
      if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) && !url.pathname.startsWith('/api/attachments/')) {
        body = await readJsonBody(req);
      }

      const result = await matched.handler({
        req,
        res,
        method,
        url,
        params: matched.params,
        query: url.searchParams,
        body,
      });

      if (res.writableEnded || res.headersSent) return;
      if (result === undefined) {
        res.writeHead(204);
        res.end();
        return;
      }
      sendJson(res, 200, result);
    } catch (error) {
      if (res.writableEnded || res.headersSent) return;
      if (error instanceof HttpError) {
        sendJson(res, error.status, { error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) } });
      } else {
        const message = error instanceof Error ? error.message : 'Unexpected error';
        const name = error instanceof Error ? error.name : '';
        const stockConflict = name === 'StockError' || /NEGATIVE_STOCK|DUPLICATE_IDEMPOTENCY|UNIT_MISMATCH|MIXED_CURRENCY/.test(message);
        const badInput = name === 'CurrencyError' || name === 'UnitError' || name === 'AccountingError' || /Unknown currency|Unknown unit|not balanced|Cannot convert/.test(message);
        const status = stockConflict ? 409 : badInput ? 400 : 500;
        const code = stockConflict ? 'STOCK_CONFLICT' : badInput ? 'VALIDATION' : 'INTERNAL';
        sendJson(res, status, { error: { code, message } });
      }
    } finally {
      const elapsed = Date.now() - started;
      if (elapsed > 1500) {
        // Slow-request visibility without a paid monitoring product.
        process.stderr.write(`[slow] ${method} ${url.pathname} ${elapsed}ms ip=${clientIp(req)}\n`);
      }
    }
  }

  /** Background maintenance: session pruning + a dated data snapshot. */
  function runJobs(): void {
    try {
      auth.pruneExpiredSessions();
    } catch (error) {
      process.stderr.write(`[jobs] session prune failed: ${(error as Error).message}\n`);
    }
  }

  function writeDailyBackup(): void {
    try {
      const dir = join(config.dataDir, 'backups');
      mkdirSync(dir, { recursive: true });
      const date = new Date().toISOString().slice(0, 10);
      const file = join(dir, `sbm-${date}.json`);
      const businesses = db.all<{ id: string }>('SELECT id FROM businesses');
      const snapshot: Record<string, unknown> = { createdAt: new Date().toISOString(), schemaVersion: db.schemaVersion, businesses: {} };
      for (const business of businesses) {
        (snapshot.businesses as Record<string, unknown>)[business.id] = {
          business: db.get('SELECT * FROM businesses WHERE id = ?', [business.id]),
          members: db.all('SELECT * FROM members WHERE business_id = ?', [business.id]),
          journalLines: db.all('SELECT * FROM journal_lines WHERE business_id = ?', [business.id]),
          stockMovements: db.all('SELECT * FROM stock_movements WHERE business_id = ?', [business.id]),
          harvests: db.all('SELECT * FROM harvests WHERE business_id = ?', [business.id]),
        };
      }
      writeFileSync(file, JSON.stringify(snapshot));
      process.stdout.write(`[jobs] wrote backup ${file}\n`);
    } catch (error) {
      process.stderr.write(`[jobs] backup failed: ${(error as Error).message}\n`);
    }
  }

  return {
    config,
    db,
    repo,
    auth,
    sync,
    ai,
    server,
    start() {
      return new Promise((resolve) => {
        server.listen(config.port, config.host, () => {
          const address = server.address();
          const port = typeof address === 'object' && address ? address.port : config.port;
          const timer = setInterval(runJobs, 60 * 60_000);
          timer.unref();
          const backupTimer = setInterval(writeDailyBackup, 24 * 60 * 60_000);
          backupTimer.unref();
          writeDailyBackup();
          process.stdout.write(`Small Business Manager API listening on http://${config.host}:${port} (mode=${config.mode})\n`);
          const webDir = process.env.WEB_DIR ?? join(process.cwd(), 'apps', 'web', 'dist');
          process.stdout.write(existsSync(webDir) ? `Serving the web app from ${webDir}\n` : 'Web app not bundled; API only.\n');
          if (config.host === '0.0.0.0' || config.host === '::') {
            const addresses = lanAddresses(port);
            process.stdout.write('\nReachable from other devices on this network:\n');
            if (addresses.length === 0) {
              process.stdout.write('  (no LAN address found - is this machine on Wi-Fi or ethernet?)\n');
            } else {
              process.stdout.write(`  USE THIS ONE -> ${addresses[0]}\n`);
              for (const address of addresses.slice(1)) process.stdout.write(`  also works    ${address}\n`);
              process.stdout.write(`\nOn the phone, open the app and set the server to ${addresses[0]}\n`);
            }
          } else {
            process.stdout.write(`\nThis server only listens on ${config.host}. To let a phone reach it, use:\n  npm run api:lan\n`);
          }
          if (config.ai.provider === 'none' || config.research.provider === 'none') {
            process.stdout.write('AI: offline rule engine + curated official links are active (no paid service required).\n');
          }
          resolve({ port, host: config.host });
        });
      });
    },
    stop() {
      return new Promise((resolve) => {
        server.close(() => {
          db.close();
          resolve();
        });
      });
    },
  };
}

const isMain = process.argv[1] ? process.argv[1].replace(/\\/g, '/').endsWith('/server.js') || process.argv[1].replace(/\\/g, '/').endsWith('/server.ts') : false;

if (isMain) {
  loadDotEnv(join(process.cwd(), '.env'));
  loadDotEnv(join(process.cwd(), '..', '..', '.env'));
  const app = createApp();
  void app.start();
  const shutdown = (signal: string) => {
    process.stdout.write(`\nReceived ${signal}, shutting down…\n`);
    void app.stop().then(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

export { parseCookies };
