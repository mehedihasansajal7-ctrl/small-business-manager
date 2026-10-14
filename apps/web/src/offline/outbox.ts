import {
  createOutboxEvent,
  outboxCounts,
  pendingCount,
  retryDelayMs,
  statusAfterFailure,
  shouldRetry,
  syncBanner,
  type OutboxEvent,
  type SyncStatus,
} from '@sbm/domain';
import { OUTBOX_STORE, runTransaction, getAll, putMany, txPut, txPutMany, type CacheStore } from './db';
import type { PushResultRow } from '../api/types';

/**
 * The outbox: every local mutation is written together with the record it
 * changes, inside ONE IndexedDB transaction. The server then applies each event
 * at most once (keyed by `idempotencyKey`).
 *
 * The pure functions in this file (`buildEvent`, `selectBatch`,
 * `applyPushResult`, `applyPushResults`, `summarize`) are unit-tested; the
 * IndexedDB functions are the persistence layer.
 */

/** Where a queued event lands in the local cache, and how risky it is. */
export interface MutationSpec {
  readonly aggregateType: string;
  readonly store: CacheStore;
  readonly highRisk: boolean;
}

/**
 * Event types accepted by `POST /api/sync/push` (see apps/api/src/sync.ts).
 * Anything not listed here MUST be done while online — the app says so instead
 * of queueing something the server will reject.
 */
export const MUTATION_TYPES: Readonly<Record<string, MutationSpec>> = Object.freeze({
  'product.upsert': { aggregateType: 'product', store: 'products', highRisk: false },
  'customer.upsert': { aggregateType: 'customer', store: 'customers', highRisk: false },
  'supplier.upsert': { aggregateType: 'supplier', store: 'suppliers', highRisk: false },
  'sale.post': { aggregateType: 'sale', store: 'sales', highRisk: true },
  'purchase.receive': { aggregateType: 'purchase', store: 'purchases', highRisk: true },
  'receipt.post': { aggregateType: 'receipt', store: 'sales', highRisk: true },
  'payment.post': { aggregateType: 'payment', store: 'purchases', highRisk: true },
  'income.post': { aggregateType: 'income_expense', store: 'journalEntries', highRisk: true },
  'expense.post': { aggregateType: 'income_expense', store: 'journalEntries', highRisk: true },
  'transfer.post': { aggregateType: 'transfer', store: 'journalEntries', highRisk: true },
  'capital.contribution': { aggregateType: 'partner_capital', store: 'journalEntries', highRisk: true },
  'capital.withdrawal': { aggregateType: 'partner_capital', store: 'journalEntries', highRisk: true },
  'farming.input_issue': { aggregateType: 'production_cycle', store: 'cycles', highRisk: true },
  'farming.cost': { aggregateType: 'production_cycle', store: 'cycles', highRisk: true },
  'farming.observe': { aggregateType: 'production_cycle', store: 'cycles', highRisk: false },
  'farming.mortality': { aggregateType: 'production_cycle', store: 'cycles', highRisk: true },
  'harvest.post': { aggregateType: 'production_cycle', store: 'harvests', highRisk: true },
  'cycle.create': { aggregateType: 'production_cycle', store: 'cycles', highRisk: false },
  'cycle.close': { aggregateType: 'production_cycle', store: 'cycles', highRisk: true },
  'cost.allocate': { aggregateType: 'cost_source', store: 'cycles', highRisk: true },
});

/** Events the server refuses from the offline queue (they change access/ownership). */
export const ONLINE_ONLY_EVENT_TYPES: readonly string[] = Object.freeze([
  'member.role_change',
  'member.invite',
  'business.transfer_ownership',
  'opening_balance.set',
  'location.create',
]);

export function mutationSpec(eventType: string): MutationSpec | undefined {
  return MUTATION_TYPES[eventType];
}

/** True when the event can be queued on the device and replayed later. */
export function isQueueable(eventType: string): boolean {
  return eventType in MUTATION_TYPES;
}

export function isOnlineOnly(eventType: string): boolean {
  return ONLINE_ONLY_EVENT_TYPES.includes(eventType) || !isQueueable(eventType);
}

export const DEFAULT_BATCH_SIZE = 50;
export const DEFAULT_MAX_ATTEMPTS = 12;

export interface OutboxContext {
  readonly businessId: string;
  readonly actorId: string;
  readonly deviceId: string;
}

export interface MutationInput {
  readonly eventType: string;
  readonly aggregateId: string;
  readonly payload: Record<string, unknown>;
  /** Optimistic local copy written in the same transaction. */
  readonly localRecord?: { readonly store: CacheStore; readonly value: Record<string, unknown> };
  readonly baseRevision?: number | null;
  readonly occurredAt?: string;
}

/** Build (but do not persist) an outbox event. Pure apart from the UUID/clock. */
export function buildEvent(input: MutationInput, context: OutboxContext): OutboxEvent<Record<string, unknown>> {
  const spec = mutationSpec(input.eventType);
  if (!spec) throw new Error(`outbox: ${input.eventType} cannot be queued offline`);
  return createOutboxEvent<Record<string, unknown>>({
    businessId: context.businessId,
    actorId: context.actorId,
    deviceId: context.deviceId,
    aggregateType: spec.aggregateType,
    aggregateId: input.aggregateId,
    eventType: input.eventType,
    payload: input.payload,
    baseRevision: input.baseRevision ?? null,
    ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}),
  });
}

/** Select the events that are due to be pushed, oldest first. */
export function selectBatch(events: readonly OutboxEvent[], now: Date = new Date(), limit = DEFAULT_BATCH_SIZE): OutboxEvent[] {
  const nowMs = now.getTime();
  return events
    .filter((event) => {
      if (event.status !== 'PENDING' && event.status !== 'SYNCING') return false;
      if (!event.nextAttemptAt) return true;
      return new Date(event.nextAttemptAt).getTime() <= nowMs;
    })
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .slice(0, limit);
}

export interface ApplyOptions {
  readonly now?: Date;
  readonly maxAttempts?: number;
  readonly random?: () => number;
  readonly baseDelayMs?: number;
}

/**
 * Fold one `PushResult` (or `null` for a transport failure) back into the event.
 *
 *  - SYNCED           → confirmed by the server (safe to show as shared)
 *  - CONFLICT         → another partner changed the record; a decision is needed
 *  - REJECTED         → permanent (e.g. validation); do not retry
 *  - NEEDS_ATTENTION  → requires an online action; do not retry automatically
 *  - no result        → exponential backoff with jitter, then NEEDS_ATTENTION
 */
export function applyPushResult(event: OutboxEvent, result: PushResultRow | null, options: ApplyOptions = {}): OutboxEvent {
  const now = options.now ?? new Date();
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

  if (!result) {
    const attempts = event.attempts + 1;
    const status = statusAfterFailure(attempts, { maxAttempts });
    const delay = retryDelayMs(attempts, { ...(options.random ? { random: options.random } : {}), ...(options.baseDelayMs ? { baseDelayMs: options.baseDelayMs } : {}) });
    return {
      ...event,
      attempts,
      status,
      lastError: 'Could not reach the server.',
      nextAttemptAt: status === 'PENDING' ? new Date(now.getTime() + delay).toISOString() : null,
    };
  }

  switch (result.status) {
    case 'SYNCED':
      return { ...event, status: 'SYNCED', serverRevision: result.serverRevision ?? null, lastError: null, nextAttemptAt: null };
    case 'CONFLICT':
      return { ...event, status: 'CONFLICT', attempts: event.attempts + 1, lastError: result.message ?? 'Conflicting change detected.', nextAttemptAt: null };
    case 'REJECTED':
      return { ...event, status: 'REJECTED', attempts: event.attempts + 1, lastError: result.message ?? 'The server rejected this change.', nextAttemptAt: null };
    case 'NEEDS_ATTENTION':
      return { ...event, status: 'NEEDS_ATTENTION', attempts: event.attempts + 1, lastError: result.message ?? 'This change needs to be completed online.', nextAttemptAt: null };
    default:
      return event;
  }
}

/** Apply a whole push response. Returns new objects (never mutates). */
export function applyPushResults(events: readonly OutboxEvent[], results: readonly PushResultRow[], options: ApplyOptions = {}): OutboxEvent[] {
  const byKey = new Map(results.map((result) => [result.idempotencyKey, result]));
  return events.map((event) => {
    const result = byKey.get(event.idempotencyKey);
    if (!result) return event;
    return applyPushResult(event, result, options);
  });
}

export interface OutboxSummary {
  readonly counts: Record<SyncStatus, number>;
  readonly pending: number;
  readonly conflicts: number;
  readonly needsAttention: number;
  readonly hasUnconfirmedHighRisk: boolean;
}

export function summarize(events: readonly OutboxEvent[]): OutboxSummary {
  return {
    counts: outboxCounts(events),
    pending: pendingCount(events),
    conflicts: events.filter((event) => event.status === 'CONFLICT').length,
    needsAttention: events.filter((event) => event.status === 'NEEDS_ATTENTION' || event.status === 'REJECTED').length,
    hasUnconfirmedHighRisk: events.some((event) => event.risk === 'HIGH' && event.status !== 'SYNCED'),
  };
}

/** The header banner, from the shared domain vocabulary. */
export function bannerFor(state: { online: boolean; pending: number; conflicts: number; lastSyncedAt?: string | null }) {
  return syncBanner(state);
}

export function canRetry(event: Pick<OutboxEvent, 'status' | 'attempts'>, maxAttempts = DEFAULT_MAX_ATTEMPTS): boolean {
  return shouldRetry(event, maxAttempts) && event.status !== 'SYNCED';
}

/** Reset an event so the user can retry it by hand from the sync screen. */
export function resetForRetry(event: OutboxEvent): OutboxEvent {
  return { ...event, status: 'PENDING', attempts: 0, nextAttemptAt: null, lastError: null };
}

export function markSyncing(events: readonly OutboxEvent[]): OutboxEvent[] {
  return events.map((event) => (event.status === 'PENDING' ? { ...event, status: 'SYNCING' } : event));
}

/** The shape `POST /api/sync/push` expects (no local bookkeeping fields). */
export function toPushEvent(event: OutboxEvent): Record<string, unknown> {
  return {
    id: event.id,
    eventId: event.eventId,
    idempotencyKey: event.idempotencyKey,
    businessId: event.businessId,
    actorId: event.actorId,
    deviceId: event.deviceId,
    aggregateType: event.aggregateType,
    aggregateId: event.aggregateId,
    eventType: event.eventType,
    schemaVersion: event.schemaVersion,
    occurredAt: event.occurredAt,
    createdAt: event.createdAt,
    baseRevision: event.baseRevision,
    payload: event.payload,
    payloadHash: event.payloadHash,
    status: event.status,
    risk: event.risk,
    attempts: event.attempts,
  };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export async function listOutbox(): Promise<OutboxEvent[]> {
  return getAll<OutboxEvent>(OUTBOX_STORE);
}

export async function saveEvents(events: readonly OutboxEvent[]): Promise<void> {
  await putMany(OUTBOX_STORE, events);
}

/**
 * THE local-mutation entry point: the record and its outbox event are written in
 * a single transaction, which only resolves once it has COMMITTED. Callers must
 * therefore only show "Saved" after `await` resolves.
 */
export async function enqueueMutation(input: MutationInput, context: OutboxContext): Promise<OutboxEvent> {
  const event = buildEvent(input, context);
  const stores: CacheStore[] = input.localRecord ? [input.localRecord.store] : [];
  await runTransaction([OUTBOX_STORE, ...stores], 'readwrite', (tx) => {
    txPut(tx, OUTBOX_STORE, event);
    if (input.localRecord) txPut(tx, input.localRecord.store, input.localRecord.value);
    return event;
  });
  return event;
}

/** Queue several events (and their local records) in one transaction. */
export async function enqueueBatch(entries: readonly MutationInput[], context: OutboxContext): Promise<OutboxEvent[]> {
  const events = entries.map((entry) => buildEvent(entry, context));
  const stores = new Set<CacheStore>();
  for (const entry of entries) if (entry.localRecord) stores.add(entry.localRecord.store);
  await runTransaction([OUTBOX_STORE, ...stores], 'readwrite', (tx) => {
    txPutMany(tx, OUTBOX_STORE, events);
    for (const entry of entries) if (entry.localRecord) txPut(tx, entry.localRecord.store, entry.localRecord.value);
    return events;
  });
  return events;
}

/** Drop confirmed events older than the retention window. */
export async function purgeSyncedEvents(events: readonly OutboxEvent[], keepMs = 7 * 24 * 60 * 60_000, now: Date = new Date()): Promise<number> {
  const cutoff = now.getTime() - keepMs;
  const stale = events.filter((event) => (event.status === 'SYNCED' || event.status === 'REJECTED') && new Date(event.createdAt).getTime() < cutoff);
  if (stale.length === 0) return 0;
  await runTransaction([OUTBOX_STORE], 'readwrite', (tx) => {
    const store = tx.objectStore(OUTBOX_STORE);
    for (const event of stale) store.delete(event.id);
  });
  return stale.length;
}
