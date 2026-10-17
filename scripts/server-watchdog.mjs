#!/usr/bin/env node
/**
 * Supervisor for the LAN server: restart it when it dies, and when it hangs.
 *
 * Why not a Windows service: registering one needs admin rights on this machine,
 * and a service would also have to be rebuilt on every code change. This runs as
 * a normal user process (started at logon from the Startup folder) and does the
 * three things that matter:
 *
 *   1. crash  -> restart with backoff (2s, 5s, 10s, 20s, 30s, then every 60s)
 *   2. hang   -> /api/health fails 3 times in a row, so the process is killed and
 *                restarted (a wedged event loop would otherwise stay "up" forever)
 *   3. stop   -> `scripts/server-control.cmd stop` drops data/server.stop; the
 *                watchdog stops the child and exits instead of fighting the stop
 *
 * Only one watchdog may run: a pid file and a port probe guard against a second
 * copy double-starting the server.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = process.env.DATA_DIR || join(root, 'data');
const port = Number(process.env.PORT || 8787);
const healthUrl = `http://127.0.0.1:${port}/api/health`;
const pidFile = join(dataDir, 'watchdog.pid');
const stopFile = join(dataDir, 'server.stop');

const BACKOFF_SECONDS = [2, 5, 10, 20, 30, 60];
const HEALTH_INTERVAL_MS = 30_000;
const HEALTH_TIMEOUT_MS = 6_000;
const HEALTH_FAILURES_BEFORE_RESTART = 3;
const SETTLE_MS = 25_000; // ignore health probes while the server boots
const STABLE_MS = 60_000; // uptime that counts as "it recovered"

mkdirSync(dataDir, { recursive: true });

const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const log = (message) => console.log(`[watchdog ${stamp()}] ${message}`);

function isProcessAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function portIsOpen() {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    const done = (open) => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(1200);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

async function healthy() {
  try {
    const response = await fetch(healthUrl, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
    if (!response.ok) return false;
    const body = await response.json();
    return body?.status === 'ok';
  } catch {
    return false;
  }
}

async function buildIfNeeded() {
  const needDomain = !existsSync(join(root, 'packages', 'domain', 'dist', 'index.js'));
  const needApi = !existsSync(join(root, 'apps', 'api', 'dist', 'server.js'));
  if (!needDomain && !needApi) return;
  log(`build output missing (domain=${needDomain}, api=${needApi}) - building once`);
  const commands = [];
  if (needDomain) commands.push(['run', 'build:domain']);
  if (needApi) commands.push(['run', 'build', '-w', '@sbm/api']);
  for (const args of commands) {
    const result = spawnSync('npm', args, { cwd: root, stdio: 'inherit', shell: true });
    if (result.status !== 0) log(`build failed (${args.join(' ')}) - starting anyway`);
  }
}

async function main() {
  // One watchdog at a time.
  if (existsSync(pidFile)) {
    const previous = Number(readFileSync(pidFile, 'utf8').trim());
    if (isProcessAlive(previous)) {
      log(`another watchdog is already running (pid ${previous}) - exiting`);
      return;
    }
    log('removing a stale watchdog pid file');
    rmSync(pidFile, { force: true });
  }
  if (await portIsOpen()) {
    log(`port ${port} is already in use - the server is up, so not starting a second copy`);
    return;
  }

  await buildIfNeeded();
  writeFileSync(pidFile, String(process.pid));

  let child = null;
  let stopping = false;
  let startedAt = 0;
  let failures = 0;
  let restarts = 0;
  let healthTimer = null;
  let stopTimer = null;
  const rapidCrashes = [];

  const cleanup = () => {
    if (healthTimer) clearInterval(healthTimer);
    if (stopTimer) clearInterval(stopTimer);
    healthTimer = null;
    stopTimer = null;
    rmSync(pidFile, { force: true });
    rmSync(stopFile, { force: true });
  };

  const killChild = () => {
    if (!child || child.killed) return;
    try {
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      } else {
        child.kill('SIGTERM');
      }
    } catch (error) {
      log(`could not stop the server process: ${String(error)}`);
    }
  };

  const shutdown = (reason) => {
    if (stopping) return;
    stopping = true;
    log(`stopping (${reason})`);
    killChild();
    cleanup();
    // The intervals above would otherwise keep Node alive forever, so a stopped
    // watchdog would linger and confuse the next "start". Exit, but give the
    // taskkill a moment to land first.
    setTimeout(() => process.exit(0), 800);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('uncaughtException', (error) => {
    log(`watchdog error: ${String(error)} - restarting the server`);
    killChild();
  });

  const startChild = () => {
    startedAt = Date.now();
    failures = 0;
    log(`starting the server (attempt ${restarts + 1})`);
    child = spawn(process.execPath, [join(root, 'scripts', 'serve-lan.mjs')], {
      cwd: root,
      env: process.env,
      stdio: 'inherit',
    });
    child.once('exit', (code, signal) => {
      if (stopping) return;
      const uptime = Date.now() - startedAt;
      log(`server exited (code ${code ?? 'null'}${signal ? `, signal ${signal}` : ''}) after ${Math.round(uptime / 1000)}s`);
      child = null;

      if (uptime >= STABLE_MS) {
        restarts = 0;
        rapidCrashes.length = 0;
      } else {
        rapidCrashes.push(Date.now());
      }
      // Ten fast crashes in a row usually mean a config/port problem; slow down
      // instead of spinning, but keep trying so a transient fault recovers.
      if (rapidCrashes.length >= 10) {
        log('ten fast crashes in a row - waiting 5 minutes before the next attempt');
        setTimeout(() => {
          restarts = 0;
          rapidCrashes.length = 0;
          if (!stopping) startChild();
        }, 5 * 60_000);
        return;
      }
      const waitMs = BACKOFF_SECONDS[Math.min(restarts, BACKOFF_SECONDS.length - 1)] * 1000;
      restarts += 1;
      log(`restarting in ${waitMs / 1000}s`);
      setTimeout(() => {
        if (!stopping) startChild();
      }, waitMs);
    });
  };

  // A wedged process still answers the port but not the API. Probe the API.
  healthTimer = setInterval(async () => {
    if (stopping || !child) return;
    if (Date.now() - startedAt < SETTLE_MS) return;
    if (existsSync(stopFile)) return;
    if (await healthy()) {
      failures = 0;
      return;
    }
    failures += 1;
    log(`health check failed (${failures}/${HEALTH_FAILURES_BEFORE_RESTART})`);
    if (failures >= HEALTH_FAILURES_BEFORE_RESTART) {
      log('the server is not answering /api/health - restarting it');
      failures = 0;
      killChild();
    }
  }, HEALTH_INTERVAL_MS);

  // `stop` and `restart` are requests written to a file, so they work from any
  // shell without admin rights or a service manager.
  stopTimer = setInterval(() => {
    if (!existsSync(stopFile)) return;
    rmSync(stopFile, { force: true });
    shutdown('stop requested from server-control');
  }, 1500);

  startChild();
  log(`watching the server on port ${port} (health every ${HEALTH_INTERVAL_MS / 1000}s)`);
}

await main();
