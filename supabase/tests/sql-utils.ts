import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Small SQL reader used by the schema/policy tests.
 *
 * It intentionally does *not* try to be a Postgres parser. It blanks comments
 * and string literals (keeping dollar-quoted function bodies, which are code)
 * and then applies narrow regular expressions, so each assertion is honest
 * about what it actually checks.
 */

const here = dirname(fileURLToPath(import.meta.url));
export const supabaseRoot = join(here, '..');
export const migrationsDir = join(supabaseRoot, 'migrations');
export const functionsDir = join(supabaseRoot, 'functions');

export interface SqlFile {
  /** e.g. `0002_identity_tenancy.sql` */
  readonly name: string;
  /** Raw file contents, comments included. */
  readonly raw: string;
  /** Comments + string literals blanked; dollar-quoted bodies kept as code. */
  readonly sql: string;
  /** Same as `sql` with dollar-quoted bodies blanked too (pure DDL/text). */
  readonly ddl: string;
  /** `sql`, lower-cased. */
  readonly lower: string;
}

/** Tables that are deliberately global (not owned by a single tenant). */
export const GLOBAL_TABLES = ['profiles', 'businesses', 'role_permissions', 'units', 'accounts'] as const;

/** Lower-case names of every global table, for quick lookup. */
export const GLOBAL_TABLE_SET = new Set<string>(GLOBAL_TABLES);

function toSqlFile(name: string, raw: string): SqlFile {
  const sql = sanitize(raw, true);
  const ddl = sanitize(raw, false);
  return { name, raw, sql, ddl, lower: sql.toLowerCase() };
}

function readDirSql(dir: string): SqlFile[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) => toSqlFile(name, readFileSync(join(dir, name), 'utf8')));
}

export function loadMigrations(): SqlFile[] {
  return readDirSql(migrationsDir);
}

export function loadFunctions(): SqlFile[] {
  return readDirSql(functionsDir);
}

export function loadSeed(): SqlFile {
  return toSqlFile('seed.sql', readFileSync(join(supabaseRoot, 'seed.sql'), 'utf8'));
}

/** Concatenated, sanitised SQL from every migration (in order). */
export function allMigrationSql(): string {
  return loadMigrations()
    .map((file) => file.sql)
    .join('\n');
}

/** Concatenated pure-DDL text from every migration. */
export function allMigrationDdl(): string {
  return loadMigrations()
    .map((file) => file.ddl)
    .join('\n');
}

/**
 * Single-pass blanking of comments and `'...'` literals. Dollar-quoted bodies
 * are kept as code when `keepDollarBodies` is true (needed to see the body of
 * `security definer` functions), otherwise blanked as well.
 */
export function sanitize(input: string, keepDollarBodies: boolean): string {
  let out = '';
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch === '-' && input[i + 1] === '-') {
      while (i < input.length && input[i] !== '\n') {
        out += ' ';
        i += 1;
      }
      continue;
    }
    if (ch === '/' && input[i + 1] === '*') {
      out += '  ';
      i += 2;
      while (i < input.length && !(input[i] === '*' && input[i + 1] === '/')) {
        out += input[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      if (i < input.length) {
        out += '  ';
        i += 2;
      }
      continue;
    }
    if (ch === "'") {
      out += ' ';
      i += 1;
      while (i < input.length) {
        if (input[i] === "'" && input[i + 1] === "'") {
          out += '  ';
          i += 2;
          continue;
        }
        if (input[i] === "'") {
          out += ' ';
          i += 1;
          break;
        }
        out += input[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      continue;
    }
    if (ch === '$') {
      const quoted = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(input.slice(i));
      if (quoted) {
        const tag = quoted[0];
        const close = input.indexOf(tag, i + tag.length);
        const end = close === -1 ? input.length : close + tag.length;
        const body = input.slice(i, end);
        out += keepDollarBodies ? body : body.replace(/[^\n]/g, ' ');
        i = end;
        continue;
      }
    }
    out += ch;
    i += 1;
  }
  return out;
}

export interface TableDef {
  readonly name: string;
  readonly file: string;
  /** Just the `create table ... ( ... );` block, sanitised. */
  readonly block: string;
}

const CREATE_TABLE_RE = /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?([a-z_][a-z0-9_]*)\s*\(/gi;

/** Every `create table` across the given files, with its balanced-paren body. */
export function createTables(files: readonly SqlFile[] = loadMigrations()): TableDef[] {
  const tables: TableDef[] = [];
  for (const file of files) {
    for (const match of file.sql.matchAll(CREATE_TABLE_RE)) {
      const name = (match[1] as string).toLowerCase();
      const open = match.index + match[0].length - 1;
      const close = matchingParen(file.sql, open);
      const block = file.sql.slice(match.index, close === -1 ? undefined : close + 1);
      tables.push({ name, file: file.name, block });
    }
  }
  return tables;
}

/** Every `alter table X enable row level security` statement, lower-cased names. */
export function rlsEnabledTables(files: readonly SqlFile[] = loadMigrations()): Set<string> {
  return collectAlter(files, 'enable');
}

/** Every `alter table X force row level security` statement, lower-cased names. */
export function rlsForcedTables(files: readonly SqlFile[] = loadMigrations()): Set<string> {
  return collectAlter(files, 'force');
}

function collectAlter(files: readonly SqlFile[], verb: 'enable' | 'force'): Set<string> {
  const set = new Set<string>();
  const re = new RegExp(
    `alter\\s+table\\s+(?:if\\s+exists\\s+)?(?:only\\s+)?(?:public\\.)?([a-z_][a-z0-9_]*)\\s+${verb}\\s+row\\s+level\\s+security`,
    'gi',
  );
  for (const file of files) {
    for (const match of file.sql.matchAll(re)) set.add((match[1] as string).toLowerCase());
  }
  return set;
}

export type PolicyCommand = 'all' | 'select' | 'insert' | 'update' | 'delete';

export interface PolicyDef {
  readonly name: string;
  readonly table: string;
  readonly command: PolicyCommand;
  /** The whole `create policy ... ;` text, lower-cased. */
  readonly text: string;
}

const CREATE_POLICY_RE = /create\s+policy\s+([a-z_][a-z0-9_]*)\s+on\s+(?:public\.)?([a-z_][a-z0-9_]*)([\s\S]*?);/gi;

export function policies(files: readonly SqlFile[] = loadMigrations()): PolicyDef[] {
  const out: PolicyDef[] = [];
  for (const file of files) {
    for (const match of file.sql.matchAll(CREATE_POLICY_RE)) {
      const body = (match[3] ?? '').toLowerCase();
      const cmd = /for\s+(select|insert|update|delete|all)/.exec(body);
      out.push({
        name: (match[1] as string).toLowerCase(),
        table: (match[2] as string).toLowerCase(),
        command: (cmd?.[1] as PolicyCommand | undefined) ?? 'all',
        text: `${match[1]} on ${match[2]}${match[3]};`.toLowerCase(),
      });
    }
  }
  return out;
}

export interface FunctionDef {
  readonly name: string;
  readonly file: string;
  /** Header + dollar-quoted body + trailing `language ...;`. */
  readonly statement: string;
  readonly securityDefiner: boolean;
  readonly hasSearchPath: boolean;
}

const CREATE_FUNCTION_RE = /create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?([a-z_][a-z0-9_]*)\s*\(/gi;

/** Every function, with its full statement sliced out to the closing `$tag$;`. */
export function functions(files: readonly SqlFile[] = [...loadMigrations(), ...loadFunctions()]): FunctionDef[] {
  const out: FunctionDef[] = [];
  for (const file of files) {
    for (const match of file.sql.matchAll(CREATE_FUNCTION_RE)) {
      const start = match.index;
      const name = (match[1] as string).toLowerCase();
      const bodyStart = findDollarQuoteStart(file.sql, start + match[0].length);
      if (bodyStart === -1) continue;
      const tagLen = dollarTagLength(file.sql, bodyStart);
      const tag = file.sql.slice(bodyStart, bodyStart + tagLen);
      const closeIdx = file.sql.indexOf(`${tag};`, bodyStart + tagLen);
      const end = closeIdx === -1 ? file.sql.length : closeIdx + tagLen + 1;
      const statement = file.sql.slice(start, end);
      out.push({
        name,
        file: file.name,
        statement,
        securityDefiner: /\bsecurity\s+definer\b/i.test(file.sql.slice(start, Math.min(end, start + 400))),
        hasSearchPath: /set\s+search_path\s*=/i.test(statement),
      });
    }
  }
  return out;
}

export function findDollarQuoteStart(sql: string, from: number): number {
  const rest = sql.slice(from);
  const idx = rest.search(/\$[A-Za-z_][A-Za-z0-9_]*\$|\$\$/);
  return idx === -1 ? -1 : from + idx;
}

export function dollarTagLength(sql: string, at: number): number {
  if (sql.startsWith('$$', at)) return 2;
  const end = sql.indexOf('$', at + 1);
  return end === -1 ? 2 : end - at + 1;
}

/** Index of the `)` that balances the `(` at `open`. */
export function matchingParen(sql: string, open: number): number {
  if (open < 0) return -1;
  let depth = 0;
  for (let i = open; i < sql.length; i += 1) {
    const ch = sql[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** The `create table` block for a single table, or `undefined`. */
export function tableBlock(name: string, files: readonly SqlFile[] = loadMigrations()): string | undefined {
  return createTables(files).find((table) => table.name === name.toLowerCase())?.block;
}

/** Column names declared in a `create table` block (best effort). */
export function columnNames(block: string): string[] {
  const body = block.slice(block.indexOf('(') + 1, block.lastIndexOf(')'));
  const columns: string[] = [];
  const re =
    /(?:^|,)\s*(?:constraint\s+[a-z_][a-z0-9_]*\s+)?([a-z_][a-z0-9_]*)\s+(?=(?:uuid|text|citext|boolean|bool|integer|int|bigint|smallint|numeric|decimal|real|jsonb|json|timestamptz|timestamp|date|time|interval|bytea)\b)/gi;
  for (const match of body.matchAll(re)) columns.push((match[1] as string).toLowerCase());
  return columns;
}

/** Counts occurrences of a character, for balanced-parentheses checks. */
export function countChar(text: string, char: string): number {
  let count = 0;
  for (const ch of text) if (ch === char) count += 1;
  return count;
}
