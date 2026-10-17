import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { DatabaseSync as SqliteDatabase } from 'node:sqlite';

// Same loading pattern as db.ts: `node:sqlite` is built into Node, and loading it
// through createRequire keeps bundlers/test runners from trying to resolve it.
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire('node:sqlite') as typeof import('node:sqlite');

/**
 * A real backup of the whole database.
 *
 * The old daily job wrote a *summary* JSON (five tables), which could not restore
 * the business: sales, purchases, products, farming cycles and every other table
 * were missing. This uses SQLite's own `VACUUM INTO`, which writes a complete,
 * internally consistent copy (WAL included) while the server keeps serving, then
 * proves the copy is sound with `PRAGMA integrity_check` before trusting it.
 *
 * The snapshot is written to `*.tmp` first and only renamed into place after it
 * verifies, so a crash or a full disk can never leave a half-written file that
 * looks like a backup.
 */
export interface BackupResult {
  readonly file: string;
  readonly bytes: number;
  readonly kept: number;
  readonly verified: boolean;
}

const DEFAULT_KEEP = 14;

function backupDate(timeZone: string): string {
  // en-CA renders as YYYY-MM-DD, and the date must be the local business date,
  // not UTC: a 23:30 backup in Dhaka is the next day in UTC.
  return new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date());
}

export function createBackup(
  dbFile: string,
  dir: string,
  options: { keep?: number; date?: string; timeZone?: string } = {},
): BackupResult {
  if (!existsSync(dbFile)) throw new Error(`Database not found: ${dbFile}`);
  mkdirSync(dir, { recursive: true });

  const date = options.date ?? backupDate(options.timeZone ?? process.env.APP_TIMEZONE ?? 'Asia/Dhaka');
  const target = join(dir, `sbm-full-${date}.db`);
  const temp = `${target}.tmp`;
  rmSync(temp, { force: true });

  const source = new DatabaseSync(dbFile);
  try {
    // VACUUM INTO is the supported way to copy a live SQLite database: it takes a
    // read snapshot (WAL aware) and writes a defragmented, complete file.
    source.exec(`VACUUM INTO '${temp.replace(/'/g, "''")}'`);
  } finally {
    source.close();
  }

  let verified = false;
  const copy = new DatabaseSync(temp);
  try {
    const row = copy.prepare('PRAGMA integrity_check').get() as { integrity_check?: string } | undefined;
    verified = row?.integrity_check === 'ok';
  } finally {
    copy.close();
  }
  if (!verified) {
    rmSync(temp, { force: true });
    throw new Error('Backup failed PRAGMA integrity_check - the copy was discarded');
  }

  rmSync(target, { force: true });
  renameSync(temp, target);

  const keep = Math.max(1, options.keep ?? Number(process.env.BACKUP_KEEP ?? DEFAULT_KEEP));
  const snapshots = readdirSync(dir)
    .filter((name) => /^sbm-full-\d{4}-\d{2}-\d{2}\.db$/.test(name))
    .sort()
    .reverse();
  for (const stale of snapshots.slice(keep)) rmSync(join(dir, stale), { force: true });

  return {
    file: target,
    bytes: statSync(target).size,
    kept: Math.min(snapshots.length, keep),
    verified,
  };
}
