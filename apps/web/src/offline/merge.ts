import type { CacheStore } from './db';

/**
 * Turning a `GET /api/sync/pull` payload into concrete cache writes.
 *
 * Pure functions only — the IndexedDB writes live in `sync.ts` — so the merge
 * rules can be unit-tested without a browser.
 */

export interface PullPayload {
  readonly since?: string;
  readonly serverTime?: string;
  readonly serverTimeIso?: string;
  readonly businessRevision?: number;
  readonly business?: Record<string, unknown>;
  readonly products?: readonly Record<string, unknown>[];
  readonly customers?: readonly Record<string, unknown>[];
  readonly suppliers?: readonly Record<string, unknown>[];
  readonly locations?: readonly Record<string, unknown>[];
  readonly sales?: readonly Record<string, unknown>[];
  readonly purchases?: readonly Record<string, unknown>[];
  readonly stockMovements?: readonly Record<string, unknown>[];
  readonly journalEntries?: readonly Record<string, unknown>[];
  readonly cycles?: readonly Record<string, unknown>[];
  readonly harvests?: readonly Record<string, unknown>[];
  readonly farms?: readonly Record<string, unknown>[];
  readonly conflicts?: readonly Record<string, unknown>[];
  readonly [key: string]: unknown;
}

/** Pull field name → local cache store. Fields not listed are not cached. */
export const PULL_STORE_MAP: Readonly<Record<string, CacheStore>> = Object.freeze({
  products: 'products',
  customers: 'customers',
  suppliers: 'suppliers',
  locations: 'locations',
  sales: 'sales',
  purchases: 'purchases',
  stockMovements: 'stockMovements',
  journalEntries: 'journalEntries',
  cycles: 'cycles',
  harvests: 'harvests',
  farms: 'farms',
});

export interface MergePlan {
  readonly business: Record<string, unknown> | null;
  readonly upserts: readonly { readonly store: CacheStore; readonly rows: readonly Record<string, unknown>[] }[];
  readonly conflicts: readonly Record<string, unknown>[];
  /** Server clock at pull time; the next `since` cursor. */
  readonly serverTime: string | null;
  readonly rowCount: number;
}

function rowsOf(pull: PullPayload, key: string): readonly Record<string, unknown>[] {
  const value = pull[key];
  if (!Array.isArray(value)) return [];
  return value.filter((row): row is Record<string, unknown> => typeof row === 'object' && row !== null);
}

/** Work out which stores change, skipping empty collections entirely. */
export function planMerge(pull: PullPayload): MergePlan {
  const upserts: { store: CacheStore; rows: readonly Record<string, unknown>[] }[] = [];
  let rowCount = 0;
  for (const [field, store] of Object.entries(PULL_STORE_MAP)) {
    const rows = rowsOf(pull, field);
    if (rows.length === 0) continue;
    upserts.push({ store, rows });
    rowCount += rows.length;
  }
  const business = pull.business && typeof pull.business === 'object' ? (pull.business as Record<string, unknown>) : null;
  return {
    business,
    upserts,
    conflicts: rowsOf(pull, 'conflicts'),
    serverTime: typeof pull.serverTime === 'string' ? pull.serverTime : typeof pull.serverTimeIso === 'string' ? pull.serverTimeIso : null,
    rowCount,
  };
}

/**
 * Local records that have NOT been confirmed by the server take precedence over
 * the server's copy after a pull — otherwise a partner's unsent edit would be
 * silently overwritten by someone else's older version.
 */
export function overlayPending<T extends Record<string, unknown>>(
  serverRows: readonly T[],
  pendingRows: readonly T[],
  key: string,
): T[] {
  if (pendingRows.length === 0) return [...serverRows];
  const pendingByKey = new Map<string, T>();
  for (const row of pendingRows) {
    const id = row[key];
    if (typeof id === 'string') pendingByKey.set(id, row);
  }
  const out: T[] = [];
  const seen = new Set<string>();
  for (const row of serverRows) {
    const id = row[key];
    if (typeof id === 'string' && pendingByKey.has(id)) {
      out.push(pendingByKey.get(id) as T);
      seen.add(id);
      continue;
    }
    out.push(row);
    if (typeof id === 'string') seen.add(id);
  }
  for (const [id, row] of pendingByKey) {
    if (!seen.has(id)) out.push(row);
  }
  return out;
}

/**
 * A record is only shown as "confirmed" when its outbox event is SYNCED. Until
 * then the UI labels it as a local proposal.
 */
export function isConfirmedRow(row: Record<string, unknown>): boolean {
  return row.__pending !== true;
}

/** Mark optimistic rows coming from the outbox so screens can badge them. */
export function markPending<T extends Record<string, unknown>>(row: T, eventId: string): T & { __pending: true; __eventId: string } {
  return { ...row, __pending: true, __eventId: eventId };
}

/** Strip the local-only markers before sending anything to the API. */
export function stripLocalMarkers<T extends Record<string, unknown>>(row: T): T {
  const clone: Record<string, unknown> = { ...row };
  delete clone.__pending;
  delete clone.__eventId;
  return clone as T;
}
