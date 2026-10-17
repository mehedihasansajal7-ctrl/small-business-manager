#!/usr/bin/env node
/**
 * Owner lockout escape hatch.
 *
 * The in-app reset needs someone who can still sign in to issue a code. If the
 * only owner has forgotten their password, run this on the machine that hosts
 * the database. It sets a new password directly and ends every session for that
 * account, so the next sign-in uses the new password.
 *
 * Usage:
 *   node scripts/reset-password.mjs mehedi@example.com
 *   node scripts/reset-password.mjs mehedi@example.com --password "my-new-password"
 *   node scripts/reset-password.mjs mehedi@example.com --db "D:\\backup\\sbm.db"
 *
 * Without --password it generates a strong random one and prints it once.
 */
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomInt, scryptSync } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};

const email = (flag('email') ?? args.find((arg) => arg.includes('@')) ?? '').trim().toLowerCase();
if (!email) {
  console.error('Usage: node scripts/reset-password.mjs <email> [--password <new>] [--db <file>]');
  process.exit(1);
}

const dbFile = flag('db') ?? join(root, 'data', 'sbm.db');
if (!existsSync(dbFile)) {
  console.error(`Database not found: ${dbFile}`);
  process.exit(1);
}

// Same shape as `hashPassword()` in apps/api/src/auth.ts: scrypt, 64-byte key,
// hex salt - so the server verifies it without knowing how it was written.
const salt = randomBytes(16).toString('hex');
const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
let generated = '';
for (let index = 0; index < 14; index += 1) generated += alphabet.charAt(randomInt(alphabet.length));
const password = flag('password') ?? generated;
if (password.length < 8) {
  console.error('The new password must be at least 8 characters.');
  process.exit(1);
}

const db = new DatabaseSync(dbFile);
const user = db.prepare('SELECT id, email, display_name FROM users WHERE lower(email) = ?').get(email);
if (!user) {
  const known = db.prepare('SELECT email FROM users ORDER BY email').all();
  console.error(`No account with email ${email}.`);
  if (known.length > 0) console.error(`Accounts on this database: ${known.map((row) => row.email).join(', ')}`);
  db.close();
  process.exit(1);
}

const hash = scryptSync(password, salt, 64).toString('hex');
db.prepare('UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?').run(hash, salt, user.id);
const ended = db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
db.close();

console.log('');
console.log('  Password reset complete');
console.log('  ------------------------');
console.log(`  Account : ${user.display_name} <${user.email}>`);
console.log(`  Password: ${password}`);
console.log(`  Sessions ended: ${ended.changes}`);
console.log('');
console.log('  Sign in with this password, then change it in Settings -> Security.');
console.log('  If you did not ask for this, change the password again immediately.');
console.log('');
