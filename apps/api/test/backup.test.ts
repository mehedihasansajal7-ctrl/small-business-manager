import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createBackup } from '../src/backup.js';

// `node:sqlite` is built into Node; requiring it at runtime keeps Vite's resolver
// out of the way (the same trick apps/api/src/db.ts uses).
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire('node:sqlite') as typeof import('node:sqlite');

/**
 * The backup has to be usable, not merely present.
 *
 * A backup that cannot be restored is worse than no backup: it creates
 * confidence. These tests build a real SQLite file, take a snapshot the way the
 * daily job does, and then open the snapshot to prove the rows are there.
 */
const cleanups: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sbm-backup-'));
  cleanups.push(dir);
  return dir;
}

function seedDatabase(file: string): void {
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE businesses (id TEXT PRIMARY KEY, name TEXT NOT NULL)');
  db.exec('CREATE TABLE journal_lines (entry_id TEXT, debit REAL, credit REAL)');
  db.exec("INSERT INTO businesses VALUES ('b1', 'QA Co')");
  db.exec("INSERT INTO journal_lines VALUES ('e1', 100, 0), ('e1', 0, 100)");
  db.close();
}

afterEach(() => {
  for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('database backup', () => {
  it('writes a snapshot that opens with the data intact', () => {
    const dir = tempDir();
    const dbFile = join(dir, 'live.db');
    seedDatabase(dbFile);

    const result = createBackup(dbFile, join(dir, 'backups'), { date: '2026-01-02', keep: 2 });
    expect(result.verified).toBe(true);
    expect(existsSync(result.file)).toBe(true);

    const copy = new DatabaseSync(result.file);
    expect(copy.prepare('SELECT name FROM businesses').get()?.name).toBe('QA Co');
    const totals = copy.prepare('SELECT SUM(debit) AS debit, SUM(credit) AS credit FROM journal_lines').get();
    expect(totals?.debit).toBe(totals?.credit);
    copy.close();
  });

  it('keeps only the newest snapshots', () => {
    const dir = tempDir();
    const dbFile = join(dir, 'live.db');
    seedDatabase(dbFile);
    const backupDir = join(dir, 'backups');

    for (const date of ['2026-01-01', '2026-01-02', '2026-01-03']) {
      createBackup(dbFile, backupDir, { date, keep: 2 });
    }

    const kept = readdirSync(backupDir).filter((name) => name.endsWith('.db')).sort();
    expect(kept).toEqual(['sbm-full-2026-01-02.db', 'sbm-full-2026-01-03.db']);
  });

  it('replaces the same day snapshot without leaving a temp file behind', () => {
    const dir = tempDir();
    const dbFile = join(dir, 'live.db');
    seedDatabase(dbFile);
    const backupDir = join(dir, 'backups');

    createBackup(dbFile, backupDir, { date: '2026-01-02' });
    const db = new DatabaseSync(dbFile);
    db.exec("INSERT INTO businesses VALUES ('b2', 'Second Co')");
    db.close();
    const second = createBackup(dbFile, backupDir, { date: '2026-01-02' });

    expect(readdirSync(backupDir).some((name) => name.endsWith('.tmp'))).toBe(false);
    const copy = new DatabaseSync(second.file);
    expect(copy.prepare('SELECT COUNT(*) AS n FROM businesses').get()?.n).toBe(2);
    copy.close();
  });

  it('refuses to hand back a file that fails verification', () => {
    const dir = tempDir();
    const broken = join(dir, 'broken.db');
    writeFileSync(broken, 'this is definitely not a sqlite database');
    const backupDir = join(dir, 'backups');

    expect(() => createBackup(broken, backupDir)).toThrow();
    const left = existsSync(backupDir) ? readdirSync(backupDir) : [];
    // A rejected copy must not be left behind looking like a good backup.
    expect(left.filter((name) => name.endsWith('.db'))).toEqual([]);
  });
});
