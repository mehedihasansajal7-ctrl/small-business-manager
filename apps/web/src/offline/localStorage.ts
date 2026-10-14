import { clearStores, getAll, runTransaction, OUTBOX_STORE, type CacheStore } from './db';
import { buildEvent, enqueueEvent, isOnlineOnly, listOutbox, summarize, type MutationInput, type OutboxContext, type OutboxSummary } from './outbox';
import type { OutboxEvent } from '@sbm/domain';
import { markPending, overlayPending } from './merge';
import { PREF_KEYS, readPreference, writePreference } from '../state/preferences';

/**
 * The device-local work queue.
 *
 * "Saved" may only be shown AFTER the write has committed, so every mutation
 * goes through `saveLocally`, which writes the optimistic record and its outbox
 * event in ONE IndexedDB transaction and resolves on commit. `localStorage` is
 * used only for the device id — business data never goes there.
 */

export class OfflineQueueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OfflineQueueError';
  }
}

/** A stable per-device id, so the server can tell which device queued an event. */
export function deviceId(): string {
  const existing = readPreference(PREF_KEYS.deviceId);
  if (existing) return existing;
  const generated = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `dev-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  writePreference(PREF_KEYS.deviceId, generated);
  return generated;
}

/** Local (not yet shared) ids are clearly marked so document screens can block them. */
export const LOCAL_ID_PREFIX = 'local-';

export function isLocalId(id: string): boolean {
  return id.startsWith(LOCAL_ID_PREFIX);
}

export function newLocalId(): string {
  const suffix = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  return `${LOCAL_ID_PREFIX}${suffix}`;
}

export interface SaveLocallyInput {
  readonly eventType: string;
  readonly aggregateId: string;
  readonly payload: Record<string, unknown>;
  readonly store: CacheStore;
  readonly record: Record<string, unknown>;
  readonly baseRevision?: number | null;
  readonly occurredAt?: string;
}

export interface SaveLocallyResult {
  readonly event: OutboxEvent;
  readonly record: Record<string, unknown>;
}

/**
 * Persist a local mutation durably, then return. If this resolves, the change
 * survives a browser restart even if the server is unreachable.
 */
export async function saveLocally(input: SaveLocallyInput, context: OutboxContext): Promise<SaveLocallyResult> {
  if (isOnlineOnly(input.eventType)) {
    throw new OfflineQueueError(`${input.eventType} cannot be queued offline`);
  }
  const mutation: MutationInput = {
    eventType: input.eventType,
    aggregateId: input.aggregateId,
    payload: input.payload,
    baseRevision: input.baseRevision ?? null,
    ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}),
  };
  const event = buildEvent(mutation, context);
  // The marker (so screens can badge it "not shared yet") is written with the
  // event in the SAME transaction: one commit or nothing.
  const record = markPending(input.record, event.id);
  await enqueueEvent(event, [{ store: input.store, value: record }]);
  return { event, record };
}

/** Cache rows that came from the server. */
export async function saveCached(store: CacheStore, rows: readonly Record<string, unknown>[]): Promise<void> {
  if (rows.length === 0) return;
  await runTransaction([store], 'readwrite', (tx) => {
    const objectStore = tx.objectStore(store);
    for (const row of rows) objectStore.put(row);
  });
}

export async function readCached<T>(store: CacheStore): Promise<T[]> {
  return getAll<T>(store);
}

/** Cached rows for a store, with unsynced local edits kept on top. */
export async function readCachedWithPending<T>(store: CacheStore, key = 'id'): Promise<T[]> {
  const rows = await getAll<T>(store);
  const pending = await pendingRecords<T>(store);
  return overlayPending(rows as unknown as Record<string, unknown>[], pending as unknown as Record<string, unknown>[], key) as unknown as T[];
}

/** Cached rows still awaiting confirmation. */
export async function pendingRecords<T>(store: CacheStore): Promise<readonly T[]> {
  const rows = await getAll<Record<string, unknown>>(store);
  return rows.filter((row) => row.__pending === true) as unknown as T[];
}

export async function listOutboxEvents(): Promise<OutboxEvent[]> {
  return listOutbox();
}

/** How many local mutations are waiting, by status. */
export async function queueSummary(): Promise<OutboxSummary> {
  return summarize(await listOutbox());
}

/** Remove the local marker once the server has confirmed the event. */
export async function confirmLocalRecord(store: CacheStore, recordId: string, serverRow?: Record<string, unknown>): Promise<void> {
  await runTransaction([store], 'readwrite', (tx) => {
    const objectStore = tx.objectStore(store);
    if (serverRow) objectStore.put(serverRow);
    else objectStore.delete(recordId);
  });
}

/** Strip the `__pending` marker from a cached row (the server has confirmed it). */
export async function clearPendingMark(store: CacheStore, recordId: string): Promise<void> {
  await runTransaction([store], 'readwrite', (tx) => {
    const objectStore = tx.objectStore(store);
    const request = objectStore.get(recordId);
    request.onsuccess = () => {
      const row = request.result as Record<string, unknown> | undefined;
      if (!row || row.__pending !== true) return;
      const clean: Record<string, unknown> = { ...row };
      delete clean.__pending;
      delete clean.__eventId;
      objectStore.put(clean);
    };
  });
}

/** Clear cached server copies but NEVER the outbox. */
export async function clearCache(): Promise<void> {
  await clearStores([
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
  ]);
}

/** Delete one queued event (used to discard a permanently failed local change). */
export async function discardEvent(eventId: string): Promise<void> {
  await runTransaction([OUTBOX_STORE], 'readwrite', (tx) => {
    tx.objectStore(OUTBOX_STORE).delete(eventId);
  });
}

/** Rows on this device that the server has not seen yet, across all stores. */
export async function unsyncedLocalCount(): Promise<number> {
  const events = await listOutbox();
  return events.filter((event) => event.status !== 'SYNCED' && event.status !== 'REJECTED').length;
}

export { overlayPending, markPending };
