#!/usr/bin/env node
/**
 * Take a full, verified backup right now (the server also does this daily).
 *
 *   npm run backup
 *   node scripts/backup.mjs --keep 30
 *   node scripts/backup.mjs --db "D:\\copy\\sbm.db" --dir "D:\\backups"
 *
 * Uses the same implementation as the running server (apps/api/dist/backup.js),
 * so a manual backup and the automatic one can never drift apart.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};

const modulePath = join(root, 'apps', 'api', 'dist', 'backup.js');
if (!existsSync(modulePath)) {
  console.error('The API is not built yet. Run: npm run build -w @sbm/api');
  process.exit(1);
}

const { createBackup } = await import(`file://${modulePath.replace(/\\/g, '/')}`);
const dbFile = flag('db') ?? process.env.SBM_DB ?? join(root, 'data', 'sbm.db');
const dir = flag('dir') ?? process.env.SBM_BACKUP_DIR ?? join(root, 'data', 'backups');
const keep = Number(flag('keep') ?? process.env.BACKUP_KEEP ?? 14);

try {
  const result = createBackup(dbFile, dir, { keep });
  console.log('');
  console.log('  Backup complete');
  console.log('  ---------------');
  console.log(`  file     : ${result.file}`);
  console.log(`  size     : ${(result.bytes / 1024 / 1024).toFixed(1)} MB`);
  console.log(`  verified : ${result.verified ? 'yes (PRAGMA integrity_check = ok)' : 'NO'}`);
  console.log(`  keeping  : last ${result.kept} snapshot(s)`);
  console.log('');
} catch (error) {
  console.error(`Backup failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
