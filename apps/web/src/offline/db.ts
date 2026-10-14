/**
 * A tiny promise wrapper over IndexedDB. No external dependency.
 *
 * Stores:
 *  - one store per synced cache collection (`CACHE_STORES`)
 *  - `outbox`: the durable queue of local mutations (see `outbox.ts`)
 *  - `meta`:   sync bookkeeping (`lastSyncedAt`, `serverTime`, schema flag)
 *
 * The database is versioned, and `onupgradeneeded` creates/updates stores, so a
 * future change is a migration rather than a wipe.
 */

export const DB_NAME = 'sbm-offline';
export const DB_VERSION = 1;

/** Collections mirrored from the server (keyed by their API id). */
export const CACHE_STORES = [
  'business',
  'products',
  'customers',
  'suppliers',
  'locations',
  'sales',
  'purchases',
  'stockMovements',
  'cycles',
  'harvests',
  'journalEntries',
  'farms',
  'inventory',
] as const;

export type CacheStore = (typeof CACHE_STORES)[number];
export const OUTBOX_STORE = 'outbox';
export const META_STORE = 'meta';

export type StoreName = CacheStore | typeof OUTBOX_STORE | typeof META_STORE;

export const ALL_STORES: readonly StoreName[] = [...CACHE_STORES, OUTBOX_STORE, META_STORE];

/** `inventory` rows are keyed by `itemId`; `meta` by `key`; everything else by `id`. */
export function keyPathFor(store: StoreName): string {
  if (store === 'inventory') return 'itemId';
  if (store === META_STORE) return 'key';
  return 'id';
}

let dbPromise: Promise<IDBDatabase> | null = null;

export function isIndexedDbAvailable(): boolean {
  return typeof globalThis.indexedDB !== 'undefined';
}

/** Open (and migrate) the database. Safe to call repeatedly. */
export function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  if (!isIndexedDbAvailable()) return Promise.reject(new Error('db: IndexedDB is not available in this environment'));
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = globalThis.indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const store of ALL_STORES) {
        if (!db.objectStoreNames.contains(store)) {
          const created = db.createObjectStore(store, { keyPath: keyPathFor(store) });
          if (store === OUTBOX_STORE) {
            created.createIndex('by_status', 'status', { unique: false });
            created.createIndex('by_aggregate', 'aggregateId', { unique: false });
          }
        }
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('db: failed to open IndexedDB'));
    request.onblocked = () => reject(new Error('db: another tab is holding an older version open'));
  });
  return dbPromise;
}

/** Reset the cached connection (used by tests and after a version change). */
export function resetDbHandle(): void {
  dbPromise = null;
}

function toPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('db: request failed'));
  });
}

/**
 * Run `work` inside a transaction and resolve when the transaction COMMITS.
 *
 * Resolving on commit (not on the last request) is what gives the outbox its
 * "must not lose a change" guarantee: a rejected/aborted transaction never
 * reports success.
 */
export async function runTransaction<T>(stores: readonly StoreName[], mode: IDBTransactionMode, work: (tx: IDBTransaction) => Promise<T> | T): Promise<T> {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction(stores as string[], mode);
    } catch (error) {
      reject(error);
      return;
    }
    let settled = false;
    let value: T;
    tx.oncomplete = () => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    tx.onerror = () => {
      if (!settled) {
        settled = true;
        reject(tx.error ?? new Error('db: transaction failed'));
      }
    };
    tx.onabort = () => {
      if (!settled) {
        settled = true;
        reject(tx.error ?? new Error('db: transaction aborted'));
      }
    };
    Promise.resolve()
      .then(() => work(tx))
      .then((result) => {
        value = result;
      })
      .catch((error: unknown) => {
        try {
          tx.abort();
        } catch {
          /* already finished */
        }
        if (!settled) {
          settled = true;
          reject(error);
        }
      });
  });
}

/** Queue several requests inside one transaction (`idbPutMany`). */
export function txPutMany(tx: IDBTransaction, store: StoreName, values: readonly unknown[]): void {
  const objectStore = tx.objectStore(store);
  for (const value of values) objectStore.put(value);
}

export function txPut(tx: IDBTransaction, store: StoreName, value: unknown): void {
  tx.objectStore(store).put(value);
}

export function txGetAll<T>(tx: IDBTransaction, store: StoreName): Promise<T[]> {
  return toPromise(tx.objectStore(store).getAll() as IDBRequest<T[]>);
}

export function txGet<T>(tx: IDBTransaction, store: StoreName, key: IDBValidKey): Promise<T | undefined> {
  return toPromise(tx.objectStore(store).get(key) as IDBRequest<T | undefined>);
}

export async function getAll<T>(store: StoreName): Promise<T[]> {
  const db = await openDb();
  return toPromise(db.transaction(store, 'readonly').objectStore(store).getAll() as IDBRequest<T[]>);
}

export async function putMany(store: StoreName, values: readonly unknown[]): Promise<void> {
  if (values.length === 0) return;
  await runTransaction([store], 'readwrite', (tx) => {
    txPutMany(tx, store, values);
  });
}

export async function putValue(store: StoreName, value: unknown): Promise<void> {
  await runTransaction([store], 'readwrite', (tx) => {
    txPut(tx, store, value);
  });
}

export async function deleteValue(store: StoreName, key: IDBValidKey): Promise<void> {
  await runTransaction([store], 'readwrite', (tx) => {
    tx.objectStore(store).delete(key);
  });
}

export async function clearStores(stores: readonly CacheStore[]): Promise<void> {
  await runTransaction(stores, 'readwrite', (tx) => {
    for (const store of stores) tx.objectStore(store).clear();
  });
}

/** Read a value from the `meta` store. */
export async function getMeta<T>(key: string): Promise<T | undefined> {
  const rows = await getMetaMany<T>([key]);
  return rows[key];
}

export async function getMetaMany<T>(keys: readonly string[]): Promise<Record<string, T | undefined>> {
  const db = await openDb();
  const tx = db.transaction(META_STORE, 'readonly');
  const store = tx.objectStore(META_STORE);
  const out: Record<string, T | undefined> = {};
  await Promise.all(
    keys.map(async (key) => {
      const row = await toPromise(store.get(key) as IDBRequest<{ key: string; value: T } | undefined>);
      out[key] = row?.value;
    }),
  );
  return out;
}

export async function setMeta(key: string, value: unknown): Promise<void> {
  await putValue(META_STORE, { key, value });
}

/** Count rows per store — used by the settings screen and the sync screen. */
export async function countStore(store: StoreName): Promise<number> {
  const db = await openDb();
  return toPromise(db.transaction(store, 'readonly').objectStore(store).count());
}

export const META_KEYS = {
  lastSyncedAt: 'lastSyncedAt',
  serverTime: 'serverTime',
  lastError: 'lastError',
  /** Last known `GET /api/auth/me` payload, so the app opens offline. */
  session: 'session',
  /** Last known `GET /api/businesses/current` payload (permissions included). */
  currentBusiness: 'currentBusiness',
} as const;
