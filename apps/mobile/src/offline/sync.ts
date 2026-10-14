import { SYNC_STATUS_LABEL, syncBanner, type SyncStatus } from '@sbm/domain';

import { isOfflineError } from '../api/client';
import { pullChanges, pushEvents } from '../api/endpoints';
import type { ConflictRow, PullResponse, PushResponse } from '../api/types';
import { SYNC_BATCH_SIZE } from '../config/env';
import { META_KEYS, all, getMeta, run, setMetaWithin, withTransaction, type Tx } from './db';
import {
  dueOutbox,
  markFailure,
  markSynced,
  markSyncing,
  outboxSummary,
  rowToEvent,
  type OutboxRow,
} from './outbox';

/**
 * The synchronisation engine.
 *
 * Push then pull, in one direction each, always scoped to one business:
 *  - **push** sends whole outbox events; the server applies each one exactly
 *    once using its idempotency key;
 *  - **pull** asks for everything newer than the stored cursor and writes it into
 *    the mirror tables in a single transaction, so a dropped connection cannot
 *    leave the local mirror half-updated.
 *
 * Failure policy is delegated to `@sbm/domain` (`statusAfterFailure`,
 * `retryDelayMs`) so this client, the web client and the server agree on when an
 * event is retried, parked for a human, or dropped as permanently rejected.
 */

export interface SyncSummary {
  /** Counts are mutable on purpose: one pass accumulates push/pull tallies. */
  pushed: number;
  synced: number;
  conflicts: number;
  rejected: number;
  needsAttention: number;
  pulled: number;
  conflictsOpen: number;
  pending: number;
  lastSyncedAt: string | null;
  error: string | null;
  offline: boolean;
}

const PULLED_TABLES: readonly { readonly key: keyof PullResponse; readonly table: string; readonly columns: readonly string[] }[] = [
  { key: 'products', table: 'products', columns: ['id', 'business_id', 'sku', 'name', 'name_bn', 'category_id', 'kind', 'unit', 'sale_price', 'purchase_price', 'tax_rate', 'reorder_level', 'track_lots', 'is_active', 'revision', 'created_at', 'updated_at', 'deleted_at'] },
  { key: 'customers', table: 'customers', columns: ['id', 'business_id', 'name', 'phone', 'email', 'address', 'opening_balance', 'credit_limit', 'is_active', 'revision', 'created_at', 'updated_at'] },
  { key: 'suppliers', table: 'suppliers', columns: ['id', 'business_id', 'name', 'phone', 'email', 'address', 'opening_balance', 'is_active', 'revision', 'created_at', 'updated_at'] },
  { key: 'locations', table: 'locations', columns: ['id', 'business_id', 'name', 'kind', 'address', 'is_default', 'is_active', 'created_at'] },
  { key: 'sales', table: 'sales', columns: ['id', 'business_id', 'reference', 'customer_id', 'document_date', 'currency', 'gross', 'discount', 'tax', 'net', 'cash_received', 'receivable', 'cogs', 'status', 'note', 'revision', 'created_by', 'device_id', 'event_id', 'created_at', 'updated_at'] },
  { key: 'saleLines', table: 'sale_lines', columns: ['id', 'business_id', 'sale_id', 'product_id', 'description', 'quantity', 'unit', 'unit_price', 'discount', 'tax', 'line_total', 'unit_cost', 'location_id', 'lot_id'] },
  { key: 'purchases', table: 'purchases', columns: ['id', 'business_id', 'reference', 'supplier_id', 'document_date', 'currency', 'subtotal', 'discount', 'tax', 'total', 'paid', 'payable', 'status', 'note', 'revision', 'created_by', 'device_id', 'event_id', 'created_at', 'updated_at'] },
  { key: 'purchaseLines', table: 'purchase_lines', columns: ['id', 'business_id', 'purchase_id', 'product_id', 'description', 'quantity', 'unit', 'unit_cost', 'discount', 'tax', 'line_total', 'location_id', 'lot_no', 'expiry_date'] },
  { key: 'stockMovements', table: 'stock_movements', columns: ['id', 'business_id', 'item_id', 'location_id', 'direction', 'quantity', 'unit', 'unit_cost', 'currency', 'lot_id', 'expiry_date', 'source_type', 'source_id', 'actor_id', 'device_id', 'event_id', 'reversal_of', 'reason', 'occurred_at', 'created_at'] },
  { key: 'journalEntries', table: 'journal_entries', columns: ['id', 'business_id', 'document_date', 'reference', 'description', 'source_type', 'source_id', 'currency', 'posted_by', 'device_id', 'event_id', 'reversal_of', 'created_at'] },
  { key: 'journalLines', table: 'journal_lines', columns: ['id', 'business_id', 'entry_id', 'account', 'debit', 'credit', 'currency', 'memo', 'partner_id', 'cost_center'] },
  { key: 'farms', table: 'farms', columns: ['id', 'business_id', 'name', 'location_id', 'address', 'area', 'area_unit', 'latitude', 'longitude', 'notes', 'is_active', 'created_at', 'updated_at'] },
  { key: 'farmUnits', table: 'farm_units', columns: ['id', 'business_id', 'farm_id', 'kind', 'name', 'area', 'area_unit', 'capacity', 'capacity_unit', 'is_active', 'created_at'] },
  { key: 'cycles', table: 'production_cycles', columns: ['id', 'business_id', 'farm_id', 'unit_id', 'reference', 'farming_type', 'title', 'crop_or_species', 'variety_or_breed', 'season', 'responsible_member_id', 'start_date', 'expected_end_date', 'actual_end_date', 'planned_output', 'planned_output_unit', 'status', 'starting_population', 'notes', 'revision', 'created_at', 'updated_at'] },
  { key: 'farmingEvents', table: 'farming_events', columns: ['id', 'business_id', 'cycle_id', 'event_type', 'occurred_on', 'quantity', 'unit', 'amount', 'currency', 'account_code', 'product_id', 'notes', 'actor_id', 'event_id', 'created_at'] },
  { key: 'harvests', table: 'harvests', columns: ['id', 'business_id', 'cycle_id', 'occurred_on', 'quantity', 'unit', 'product_id', 'location_id', 'lot_no', 'costing_method', 'cost_basis', 'unit_cost', 'currency', 'grade', 'notes', 'created_by', 'event_id', 'created_at'] },
  { key: 'costAllocations', table: 'cost_allocations', columns: ['id', 'business_id', 'cost_source_id', 'cycle_id', 'basis', 'basis_value', 'share_ratio', 'currency', 'amount', 'created_by', 'created_at'] },
];

/** Deletes that must be fanned out from the parent to its child rows. */
const CHILD_TABLES = ['sale_lines', 'purchase_lines', 'journal_lines'] as const;

let running = false;
let lastSummary: SyncSummary | null = null;

export function isSyncing(): boolean {
  return running;
}

export function lastSyncSummary(): SyncSummary | null {
  return lastSummary;
}

export function getSyncCursor(): Promise<string | null> {
  return getMeta(META_KEYS.syncCursor);
}

export function getLastSyncedAt(): Promise<string | null> {
  return getMeta(META_KEYS.lastSyncedAt);
}

// ---------------------------------------------------------------------------
// Push
// ---------------------------------------------------------------------------

async function pushBatch(businessId: string, rows: readonly OutboxRow[]): Promise<Pick<SyncSummary, 'synced' | 'conflicts' | 'rejected' | 'needsAttention' | 'error' | 'offline'>> {
  const summary = { synced: 0, conflicts: 0, rejected: 0, needsAttention: 0, error: null as string | null, offline: false };

  await markSyncing(rows.map((row) => row.id));

  let response: PushResponse;
  try {
    response = await pushEvents(rows.map((row) => rowToEvent(row)));
  } catch (error) {
    const offline = isOfflineError(error);
    const message = error instanceof Error ? error.message : 'Push failed';
    // The server never saw the batch: back every row off and keep the data.
    for (const row of rows) await markFailure(row, { message });
    summary.error = message;
    summary.offline = offline;
    return summary;
  }

  const byEventId = new Map(response.results.map((result) => [result.eventId, result]));

  for (const row of rows) {
    const result = byEventId.get(row.event_id);
    if (!result) {
      await markFailure(row, { message: 'The server did not return a result for this change; it will be retried.' });
      continue;
    }
    switch (result.status) {
      case 'SYNCED':
        await markSynced(row, result.serverRevision ?? null, result.message ?? null);
        summary.synced += 1;
        break;
      case 'CONFLICT':
        // A partner changed the same record first. Never auto-resolve: the whole
        // point of the revision check is that money/stock changes are not
        // last-write-wins.
        await markFailure(row, { conflict: true, message: result.message ?? 'Another partner changed this record first.', serverRevision: result.serverRevision ?? null });
        summary.conflicts += 1;
        break;
      case 'REJECTED':
        await markFailure(row, { permanent: true, message: result.message ?? 'The server rejected this change.' });
        summary.rejected += 1;
        break;
      case 'NEEDS_ATTENTION':
      default:
        // e.g. `member.role_change` / access changes: the server records the event
        // but refuses to apply it offline. Park it for a human.
        await run(
          `UPDATE outbox SET status = 'NEEDS_ATTENTION', last_error = ?, next_attempt_at = NULL, attempts = attempts + 1 WHERE id = ?`,
          [result.message ?? 'This action must be completed online.', row.id],
        );
        summary.needsAttention += 1;
        break;
    }
  }
  return summary;
}

export async function pushAll(businessId: string): Promise<SyncSummary> {
  const total: SyncSummary = { pushed: 0, synced: 0, conflicts: 0, rejected: 0, needsAttention: 0, pulled: 0, conflictsOpen: 0, pending: 0, lastSyncedAt: null, error: null, offline: false };

  for (let guard = 0; guard < 20; guard += 1) {
    const rows = await dueOutbox(businessId, SYNC_BATCH_SIZE);
    if (rows.length === 0) break;
    const batch = await pushBatch(businessId, rows);
    total.pushed += rows.length;
    total.synced += batch.synced;
    total.conflicts += batch.conflicts;
    total.rejected += batch.rejected;
    total.needsAttention += batch.needsAttention;
    if (batch.error) {
      total.error = batch.error;
      total.offline = batch.offline;
      break;
    }
    // A conflict/rejection leaves rows out of the due set, so the loop advances.
    if (batch.synced === 0) break;
  }

  return total;
}

// ---------------------------------------------------------------------------
// Pull
// ---------------------------------------------------------------------------

function toBind(value: unknown): string | number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

async function upsertRows(tx: Tx, table: string, columns: readonly string[], rows: readonly Record<string, unknown>[]): Promise<number> {
  if (rows.length === 0) return 0;
  const placeholders = columns.map(() => '?').join(', ');
  const sql = `INSERT OR REPLACE INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`;
  let written = 0;
  for (const row of rows) {
    // Skip rows that lost their primary key; they cannot be addressed later.
    if (row.id === undefined || row.id === null) continue;
    await tx.runAsync(sql, columns.map((column) => toBind(row[column])));
    written += 1;
  }
  return written;
}

async function applyPull(tx: Tx, businessId: string, pull: PullResponse): Promise<number> {
  let written = 0;

  written += await upsertRows(tx, 'local_business', ['business_id', 'name', 'currency', 'timezone', 'locale', 'farming_types', 'revision', 'synced_at'], [
    {
      business_id: pull.business.id,
      name: pull.business.name,
      currency: pull.business.currency,
      timezone: pull.business.timezone,
      locale: pull.business.locale,
      farming_types: JSON.stringify(pull.business.farmingTypes ?? []),
      revision: pull.business.revision,
      synced_at: pull.serverTime,
    },
  ]);

  for (const entry of PULLED_TABLES) {
    const rows = pull[entry.key];
    if (!Array.isArray(rows)) continue;
    written += await upsertRows(tx, entry.table, entry.columns, rows as Record<string, unknown>[]);
  }

  // Conflicts are authoritative on the server; replace the local inbox view.
  for (const conflict of pull.conflicts ?? []) {
    await tx.runAsync(
      `INSERT OR REPLACE INTO server_conflicts (id, business_id, aggregate_type, aggregate_id, event_id, device_id, base_revision, server_revision, differing_fields, auto_mergeable, detail, status, created_at, resolved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        conflict.id,
        conflict.business_id,
        conflict.aggregate_type,
        conflict.aggregate_id,
        conflict.event_id,
        conflict.device_id,
        conflict.base_revision,
        conflict.server_revision,
        conflict.differing_fields,
        conflict.auto_mergeable,
        conflict.detail,
        conflict.status,
        conflict.created_at,
        conflict.resolved_at ?? null,
      ],
    );
  }

  await setMetaWithin(tx, META_KEYS.syncCursor, pull.serverTimeIso ?? pull.serverTime);
  await setMetaWithin(tx, META_KEYS.lastSyncedAt, new Date().toISOString());
  void businessId;
  return written;
}

export async function pull(businessId: string, since?: string): Promise<{ written: number }> {
  const cursor = since ?? (await getSyncCursor()) ?? '1970-01-01T00:00:00.000Z';
  const response = await pullChanges(cursor);
  const written = await withTransaction((tx) => applyPull(tx, businessId, response));
  return { written };
}

// ---------------------------------------------------------------------------
// Full pass
// ---------------------------------------------------------------------------

export interface SyncOptions {
  /** Skip the push phase (used by "pull only" from the Sync screen). */
  readonly pullOnly?: boolean;
  readonly pushOnly?: boolean;
}

export async function syncNow(businessId: string, options: SyncOptions = {}): Promise<SyncSummary> {
  if (running) return lastSummary ?? (await summaryOf(businessId, null, false));
  running = true;
  const summary: SyncSummary = {
    pushed: 0,
    synced: 0,
    conflicts: 0,
    rejected: 0,
    needsAttention: 0,
    pulled: 0,
    conflictsOpen: 0,
    pending: 0,
    lastSyncedAt: null,
    error: null,
    offline: false,
  };

  try {
    if (!options.pullOnly) {
      const pushResult = await pushAll(businessId);
      summary.pushed = pushResult.pushed;
      summary.synced = pushResult.synced;
      summary.conflicts = pushResult.conflicts;
      summary.rejected = pushResult.rejected;
      summary.needsAttention = pushResult.needsAttention;
      summary.error = pushResult.error;
      summary.offline = pushResult.offline;
    }

    if (!options.pushOnly && !summary.offline) {
      try {
        const pulled = await pull(businessId);
        summary.pulled = pulled.written;
      } catch (error) {
        summary.error = error instanceof Error ? error.message : 'Pull failed';
        summary.offline = isOfflineError(error);
      }
    }

    const final = await summaryOf(businessId, summary.error, summary.offline);
    lastSummary = { ...summary, ...final, pushed: summary.pushed, synced: summary.synced, pulled: summary.pulled };
    await setMetaSafe(META_KEYS.lastSyncError, summary.error);
    return lastSummary;
  } finally {
    running = false;
  }
}

async function setMetaSafe(key: string, value: string | null): Promise<void> {
  if (value === null) {
    await run('DELETE FROM local_meta WHERE key = ?', [key]);
    return;
  }
  await run(
    `INSERT INTO local_meta (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [key, value, new Date().toISOString()],
  );
}

async function summaryOf(businessId: string, error: string | null, offline: boolean): Promise<SyncSummary> {
  const summary = await outboxSummary(businessId);
  return {
    pushed: 0,
    synced: 0,
    conflicts: summary.counts.CONFLICT,
    rejected: summary.counts.REJECTED,
    needsAttention: summary.counts.NEEDS_ATTENTION,
    pulled: 0,
    conflictsOpen: summary.conflicts,
    pending: summary.pending,
    lastSyncedAt: await getLastSyncedAt(),
    error,
    offline,
  };
}

// ---------------------------------------------------------------------------
// Conflicts
// ---------------------------------------------------------------------------

export async function openConflicts(businessId: string): Promise<ConflictRow[]> {
  return all<ConflictRow>(`SELECT * FROM server_conflicts WHERE business_id = ? AND status = 'OPEN' ORDER BY created_at DESC LIMIT 200`, [businessId]);
}

export async function allConflicts(businessId: string): Promise<ConflictRow[]> {
  return all<ConflictRow>('SELECT * FROM server_conflicts WHERE business_id = ? ORDER BY created_at DESC LIMIT 200', [businessId]);
}

/**
 * Apply the user's decision locally after the server has recorded it.
 *
 *  - `SERVER_WINS` — drop our queued change: the server's version stands.
 *  - `LOCAL_WINS` — re-queue our change against the server's *current* revision,
 *    so the retry is a legitimate edit rather than the same stale clash.
 */
export async function applyConflictResolution(
  conflict: ConflictRow,
  resolution: 'LOCAL_WINS' | 'SERVER_WINS',
): Promise<void> {
  await withTransaction(async (tx) => {
    await tx.runAsync(`UPDATE server_conflicts SET status = ?, resolved_at = ? WHERE id = ?`, [resolution, new Date().toISOString(), conflict.id]);

    const localRows = await tx.getAllAsync<OutboxRow>(`SELECT * FROM outbox WHERE event_id = ?`, [conflict.event_id]);
    for (const row of localRows) {
      if (resolution === 'SERVER_WINS') {
        await tx.runAsync('DELETE FROM outbox_preview WHERE outbox_id = ?', [row.id]);
        await tx.runAsync('DELETE FROM outbox WHERE id = ?', [row.id]);
      } else {
        await tx.runAsync(
          `UPDATE outbox SET status = 'PENDING', next_attempt_at = NULL, base_revision = ?, last_error = NULL, attempts = 0 WHERE id = ?`,
          [conflict.server_revision ?? row.base_revision, row.id],
        );
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Presentation helpers
// ---------------------------------------------------------------------------

export function statusLabel(status: SyncStatus, locale: 'bn' | 'en'): string {
  return SYNC_STATUS_LABEL[status][locale];
}

export function banner(state: { online: boolean; pending: number; conflicts: number; lastSyncedAt?: string | null }): { level: 'ok' | 'warn' | 'error'; en: string; bn: string } {
  return syncBanner(state);
}

export type { SyncStatus };
