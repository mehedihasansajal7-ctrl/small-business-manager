#!/usr/bin/env node
/**
 * Prove that the newest backup can actually be used.
 *
 * A backup nobody has restored is a hope, not a backup. This opens the newest
 * `data/backups/sbm-full-*.db`, runs `PRAGMA integrity_check`, checks that the
 * bookkeeping still balances *inside the copy*, and compares the row counts of
 * the important tables with the live database.
 *
 *   npm run backup:verify
 *
 * Exit code 0 = the snapshot opens, is sound and is not missing data.
 */
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};

const dir = flag('dir') ?? process.env.SBM_BACKUP_DIR ?? join(root, 'data', 'backups');
const liveFile = flag('db') ?? process.env.SBM_DB ?? join(root, 'data', 'sbm.db');

if (!existsSync(dir)) {
  console.error(`No backup folder at ${dir}`);
  process.exit(1);
}
const snapshots = readdirSync(dir)
  .filter((name) => /^sbm-full-\d{4}-\d{2}-\d{2}\.db$/.test(name))
  .sort();
if (snapshots.length === 0) {
  console.error(`No snapshot found in ${dir}. Run: npm run backup`);
  process.exit(1);
}
const newest = snapshots[snapshots.length - 1];
const snapshotFile = join(dir, newest);

const TABLES = [
  'businesses',
  'users',
  'members',
  'products',
  'customers',
  'suppliers',
  'sales',
  'sale_lines',
  'purchases',
  'purchase_lines',
  'journal_entries',
  'journal_lines',
  'stock_movements',
  'production_cycles',
  'farming_events',
  'harvests',
  'password_resets',
];

const count = (db, table) => {
  try {
    return db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  } catch {
    return null; // older snapshot taken before that table existed
  }
};

const snapshot = new DatabaseSync(snapshotFile);
const live = existsSync(liveFile) ? new DatabaseSync(liveFile) : null;

let ok = true;
const integrity = snapshot.prepare('PRAGMA integrity_check').get()?.integrity_check;
if (integrity !== 'ok') {
  ok = false;
  console.log(`integrity_check: ${integrity}`);
}

// The books inside the copy must still balance, or the backup is worthless.
const totals = snapshot
  .prepare('SELECT COALESCE(SUM(debit), 0) AS debit, COALESCE(SUM(credit), 0) AS credit FROM journal_lines')
  .get();
const balanced = Math.abs(Number(totals.debit) - Number(totals.credit)) < 0.005;
if (!balanced) ok = false;

console.log('');
console.log(`  Verifying ${newest}`);
console.log('  ---------------------------------------------------------');
console.log(`  integrity_check : ${integrity}`);
console.log(`  journal         : debit ${totals.debit} / credit ${totals.credit} -> ${balanced ? 'balanced' : 'NOT BALANCED'}`);
console.log('');
console.log('  table                     snapshot        live');
for (const table of TABLES) {
  const inSnapshot = count(snapshot, table);
  const inLive = live ? count(live, table) : null;
  const flagText = inSnapshot === null ? '(not in snapshot)' : inLive !== null && inSnapshot > inLive ? 'SNAPSHOT HAS MORE THAN LIVE' : '';
  if (flagText) ok = false;
  console.log(
    `  ${table.padEnd(24)} ${String(inSnapshot ?? '-').padStart(9)} ${String(inLive ?? '-').padStart(11)}  ${flagText}`,
  );
}

snapshot.close();
live?.close();

console.log('');
console.log(ok ? '  PASS - this snapshot opens, is sound, and the books balance.' : '  FAIL - do not rely on this snapshot.');
console.log('');
process.exit(ok ? 0 : 1);
