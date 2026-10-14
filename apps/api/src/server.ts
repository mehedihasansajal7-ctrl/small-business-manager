import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
    try {
      const matched = router.match(method, url.pathname);
      if (!matched) throw HttpError.notFound(`No route for ${method} ${url.pathname}`);

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
