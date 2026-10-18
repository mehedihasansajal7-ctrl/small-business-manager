import type { OutboxEvent, SyncStatus } from '@sbm/domain';
import { ApiError } from '../api/client';
import { sync as syncApi } from '../api/endpoints';
import type { ConflictRow } from '../api/types';
import { META_KEYS, getMeta, setMeta, type CacheStore } from './db';
import { applyPushResult, applyPushResults, bannerFor, markSyncing, mutationSpec, resetForRetry, saveEvents, selectBatch, summarize, toPushEvent, DEFAULT_BATCH_SIZE, type OutboxContext } from './outbox';
import { clearPendingMark, confirmLocalRecord, pendingRecords, saveCached } from './localStorage';
import { planMerge, type PullPayload } from './merge';
import { normalizeRows } from './normalize';
import { listOutbox } from './outbox';

/**
 * The sync coordinator.
 *
 * Order matters: PUSH first (so the device's own work reaches the server), then
 * PULL (so the cache matches the server). Only server-confirmed events become
 * SYNCED; everything else keeps a visible Pending / Conflict / Needs-attention
 * state. Failures back off exponentially with jitter (see `retryDelayMs`).
 */

export const SYNC_INTERVAL_MS = 60_000;
export const FULL_PULL_SINCE = '1970-01-01T00:00:00.000Z';

export interface SyncSnapshot {
  readonly online: boolean;
  readonly flushing: boolean;
  readonly pulling: boolean;
  readonly pending: number;
  readonly conflicts: number;
  readonly counts: Record<SyncStatus, number>;
  readonly lastSyncedAt: string | null;
  readonly lastError: string | null;
  readonly banner: { readonly level: 'ok' | 'warn' | 'error'; readonly en: string; readonly bn: string };
  readonly outbox: readonly OutboxEvent[];
  readonly openConflicts: readonly ConflictRow[];
}

export interface SyncCoordinatorOptions {
  readonly getContext: () => OutboxContext | null;
  readonly intervalMs?: number;
  readonly batchSize?: number;
  readonly now?: () => Date;
  readonly random?: () => number;
  readonly maxRounds?: number;
}

function isOnline(): boolean {
  if (typeof navigator === 'undefined') return true;
  return navigator.onLine !== false;
}

const EMPTY_COUNTS: Record<SyncStatus, number> = { PENDING: 0, SYNCING: 0, SYNCED: 0, NEEDS_ATTENTION: 0, CONFLICT: 0, REJECTED: 0 };

export class SyncCoordinator {
  private state: SyncSnapshot = {
    online: isOnline(),
    flushing: false,
    pulling: false,
    pending: 0,
    conflicts: 0,
    counts: { ...EMPTY_COUNTS },
    lastSyncedAt: null,
    lastError: null,
    banner: bannerFor({ online: true, pending: 0, conflicts: 0 }),
    outbox: [],
    openConflicts: [],
  };

  private readonly listeners = new Set<(snapshot: SyncSnapshot) => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<SyncSnapshot> | null = null;
  private readonly onOnline = () => {
    this.patch({ online: true });
    void this.syncNow();
  };
  private readonly onOffline = () => {
    this.patch({ online: false });
  };

  constructor(private options: SyncCoordinatorOptions) {}

  setOptions(options: SyncCoordinatorOptions): void {
    this.options = options;
  }

  subscribe(listener: (snapshot: SyncSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  getState(): SyncSnapshot {
    return this.state;
  }

  /** Register connectivity listeners, run an immediate sync, then poll. */
  start(): void {
    if (this.timer) return;
    if (typeof addEventListener === 'function') {
      addEventListener('online', this.onOnline);
      addEventListener('offline', this.onOffline);
    }
    // IndexedDB (and therefore the outbox) may be unavailable in a private
    // window; the app must still render, so failures here are not fatal.
    void this.refresh()
      .then(() => this.syncNow())
      .catch(() => undefined);
    this.timer = setInterval(() => {
      if (isOnline()) void this.syncNow();
      else void this.refresh();
    }, this.options.intervalMs ?? SYNC_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (typeof removeEventListener === 'function') {
      removeEventListener('online', this.onOnline);
      removeEventListener('offline', this.onOffline);
    }
  }

  private patch(partial: Partial<SyncSnapshot>): void {
    const next = { ...this.state, ...partial };
    const banner = bannerFor({
      online: next.online,
      pending: next.pending,
      conflicts: next.conflicts,
      ...(next.lastSyncedAt ? { lastSyncedAt: next.lastSyncedAt } : {}),
    });
    this.state = { ...next, banner };
    for (const listener of this.listeners) listener(this.state);
  }

  /** Re-read local state (outbox, last sync time, conflicts) without a network call. */
  async refresh(): Promise<SyncSnapshot> {
    const outbox = await listOutbox().catch(() => [] as OutboxEvent[]);
    const summary = summarize(outbox);
    const lastSyncedAt = (await getMeta<string>(META_KEYS.lastSyncedAt).catch(() => undefined)) ?? null;
    const lastError = (await getMeta<string>(META_KEYS.lastError).catch(() => undefined)) ?? null;
    this.patch({
      outbox,
      counts: summary.counts,
      pending: summary.pending,
      conflicts: Math.max(summary.conflicts, this.state.openConflicts.filter((row) => row.status === 'OPEN').length),
      lastSyncedAt,
      lastError,
      online: isOnline(),
    });
    return this.state;
  }

  /** Push pending work, then pull server changes. Safe to call concurrently. */
  syncNow(): Promise<SyncSnapshot> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.runSync().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async runSync(): Promise<SyncSnapshot> {
    const context = this.options.getContext();
    if (!context) {
      await this.refresh();
      return this.state;
    }
    if (!isOnline()) {
      await this.refresh();
      return this.state;
    }
    await this.flush(context);
    await this.pull(context);
    return this.refresh();
  }

  /** Send due outbox events in batches of ≤ `batchSize` (50 by default). */
  async flush(context: OutboxContext): Promise<void> {
    const now = this.options.now ?? (() => new Date());
    const batchSize = this.options.batchSize ?? DEFAULT_BATCH_SIZE;
    const maxRounds = this.options.maxRounds ?? 5;
    this.patch({ flushing: true });
    try {
      for (let round = 0; round < maxRounds; round += 1) {
        const events = await listOutbox();
        const batch = selectBatch(events, now(), batchSize);
        if (batch.length === 0) break;
        const syncing = markSyncing(batch);
        await saveEvents(syncing);
        try {
          const { results } = await syncApi.push(syncing.map(toPushEvent));
          const updated = applyPushResults(syncing, results, {
            now: now(),
            ...(this.options.random ? { random: this.options.random } : {}),
          });
          await saveEvents(updated);
          await this.reconcile(syncing, updated, results);
          await setMeta(META_KEYS.lastSyncedAt, now().toISOString());
          await setMeta(META_KEYS.lastError, '');
        } catch (error) {
          // Transport failure: keep the work and back off.
          const failed = syncing.map((event) =>
            applyPushResult(event, null, {
              now: now(),
              ...(this.options.random ? { random: this.options.random } : {}),
            }),
          );
          await saveEvents(failed);
          const message = error instanceof Error ? error.message : 'Sync failed';
          await setMeta(META_KEYS.lastError, message);
          break;
        }
      }
    } finally {
      this.patch({ flushing: false });
    }
  }

  /**
   * After a push: a confirmed local draft becomes a normal cached row. When the
   * server assigned its own id (offline-created master data) the local draft is
   * replaced by the server's record.
   */
  private async reconcile(before: readonly OutboxEvent[], after: readonly OutboxEvent[], results: readonly { idempotencyKey: string; status: string; result?: unknown }[]): Promise<void> {
    const resultByKey = new Map(results.map((row) => [row.idempotencyKey, row]));
    for (const [index, event] of after.entries()) {
      if (event.status !== 'SYNCED') continue;
      const original = before[index];
      if (!original) continue;
      const spec = mutationSpec(event.eventType);
      if (!spec) continue;
      const applied = (resultByKey.get(event.idempotencyKey)?.result ?? undefined) as Record<string, unknown> | undefined;
      const serverId = applied && typeof applied.id === 'string' ? applied.id : typeof applied?.harvestId === 'string' ? (applied.harvestId as string) : undefined;
      try {
        if (serverId && serverId !== original.aggregateId) {
          await confirmLocalRecord(spec.store, original.aggregateId);
          await saveCached(spec.store, [applied as Record<string, unknown>]);
        } else {
          await clearPendingMark(spec.store, original.aggregateId);
        }
      } catch {
        /* the pull below will reconcile the cache anyway */
      }
    }
  }

  /** Fetch everything the device is missing and merge it into the cache. */
  async pull(context: OutboxContext): Promise<void> {
    void context;
    this.patch({ pulling: true });
    try {
      const since = (await getMeta<string>(META_KEYS.lastSyncedAt)) ?? FULL_PULL_SINCE;
      const payload = (await syncApi.pull(since)) as PullPayload;
      const plan = planMerge(payload);
      if (plan.business) await saveCached('business', [plan.business]);
      for (const upsert of plan.upserts) {
        // Never overwrite a draft that has not reached the server yet.
        const pending = await pendingRecords<Record<string, unknown>>(upsert.store);
        const pendingIds = new Set(pending.map((row) => String(row.id ?? '')));
        const rows = upsert.rows.filter((row) => !pendingIds.has(String(row.id ?? '')));
        await saveCached(upsert.store as CacheStore, normalizeRows(upsert.store as CacheStore, rows));
      }
      if (plan.serverTime) await setMeta(META_KEYS.lastSyncedAt, plan.serverTime);
      // A successful pull means the earlier failure is over: keeping it would show
      // a stale warning next to perfectly fresh data.
      await setMeta(META_KEYS.lastError, '');
      this.patch({ openConflicts: plan.conflicts as unknown as ConflictRow[] });
    } catch (error) {
      // A 401 means the session is not established yet (or expired). That is not a
      // data problem, it is the sign-in screen's job - and a stored
      // "Sign in required" would otherwise sit under the toolbar forever.
      if (error instanceof ApiError && error.status === 401) {
        await setMeta(META_KEYS.lastError, '');
        throw error;
      }
      const message = error instanceof Error ? error.message : 'Pull failed';
      await setMeta(META_KEYS.lastError, message);
      throw error;
    } finally {
      this.patch({ pulling: false });
    }
  }

  /** Load open conflicts from the API (the sync screen uses this). */
  async loadConflicts(): Promise<ConflictRow[]> {
    const rows = await syncApi.conflicts();
    this.patch({ openConflicts: rows, conflicts: rows.filter((row) => row.status === 'OPEN').length });
    return rows;
  }

  async resolveConflict(id: string, resolution: 'LOCAL_WINS' | 'SERVER_WINS'): Promise<void> {
    await syncApi.resolveConflict(id, resolution);
    await this.loadConflicts();
    await this.refresh();
  }

  /** Put a failed event back in the queue at the user's request. */
  async retryEvent(eventId: string): Promise<void> {
    const events = await listOutbox();
    const target = events.find((event) => event.id === eventId);
    if (!target) return;
    await saveEvents([resetForRetry(target)]);
    await this.refresh();
    void this.syncNow();
  }

  /** Reset a snapshot for tests. */
  setSnapshotForTest(snapshot: Partial<SyncSnapshot>): void {
    this.patch(snapshot);
  }
}

let singleton: SyncCoordinator | null = null;

/** The app-wide coordinator. The session provider supplies the business context. */
export function getSyncCoordinator(): SyncCoordinator {
  if (!singleton) singleton = new SyncCoordinator({ getContext: () => null });
  return singleton;
}
