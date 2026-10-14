import {
  createOutboxEvent,
  outboxCounts as countStatuses,
  pendingCount as countPending,
  retryDelayMs,
  shouldRetry,
  statusAfterFailure,
  type NewOutboxEventInput,
  type OutboxEvent,
  type SyncStatus,
} from '@sbm/domain';

import { META_KEYS, all, getMeta, run, setMeta, withTransaction, type Tx } from './db';

/**
 * The outbox: the only way a business action reaches the server.
 *
 * Contract shared with the web client and the server:
 *  - `createOutboxEvent` (from `@sbm/domain`) builds the event, including the
 *    deterministic `payloadHash` and the `${businessId}:${aggregateType}:${eventId}`
 *    idempotency key. The server stores that key in `processed_events`, so
 *    replaying the same event after a dropped connection can never post a sale
 *    twice.
 *  - the record change **and** the outbox row are written in one SQLite
 *    transaction (`enqueueWithin` is always called from inside `withTransaction`).
 *  - the event is marked `SYNCED` only when the server confirms it.
 *
 * Two rules the UI must respect (both enforced in `src/offline/sync.ts`):
 *  1. a high-risk event is a *proposal* until `isConfirmed()` is true, and
 *  2. `NEEDS_ATTENTION` / `CONFLICT` / `REJECTED` events are never retried
 *     blindly — they surface in Sync status for a human decision.
 */

export interface OutboxRow {
  id: string;
  event_id: string;
  idempotency_key: string;
  business_id: string;
  actor_id: string;
  device_id: string;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  schema_version: number;
  occurred_at: string;
  created_at: string;
  base_revision: number | null;
  payload: string;
  payload_hash: string;
  status: SyncStatus;
  risk: 'LOW' | 'HIGH';
  attempts: number;
  last_error: string | null;
  next_attempt_at: string | null;
  server_revision: number | null;
  server_message: string | null;
  synced_at: string | null;
}

export interface ProposalPreview {
  /** Human title, e.g. "Sale — 3 items". */
  readonly title: string;
  readonly subtitle?: string;
  /** Exact decimal string, already formatted by the caller. */
  readonly amount?: string;
  readonly currency?: string;
  readonly documentDate?: string;
}

/** Stable device id, generated once and kept in the mirror DB. */
export async function getDeviceId(): Promise<string> {
  const existing = await getMeta(META_KEYS.deviceId);
  if (existing) return existing;
  const generated = globalThis.crypto.randomUUID();
  await setMeta(META_KEYS.deviceId, generated);
  return generated;
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

export interface EnqueueInput<T> extends Omit<NewOutboxEventInput<T>, 'deviceId'> {
  readonly deviceId?: string;
}

/**
 * Build and persist an event **inside an existing transaction**.
 *
 * Callers must be inside `withTransaction`, together with the local record
 * change, so both land or neither does.
 */
export async function enqueueWithin<T>(tx: Tx, input: EnqueueInput<T>, preview?: ProposalPreview): Promise<OutboxEvent<T>> {
  const deviceId = input.deviceId ?? (await getDeviceId());
  const event = createOutboxEvent<T>({ ...input, deviceId });

  await tx.runAsync(
    `INSERT INTO outbox (
       id, event_id, idempotency_key, business_id, actor_id, device_id, aggregate_type, aggregate_id,
       event_type, schema_version, occurred_at, created_at, base_revision, payload, payload_hash,
       status, risk, attempts, last_error, next_attempt_at, server_revision, server_message, synced_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      event.id,
      event.eventId,
      event.idempotencyKey,
      event.businessId,
      event.actorId,
      event.deviceId,
      event.aggregateType,
      event.aggregateId,
      event.eventType,
      event.schemaVersion,
      event.occurredAt,
      event.createdAt,
      event.baseRevision,
      JSON.stringify(event.payload),
      event.payloadHash,
      event.status,
      event.risk,
      event.attempts,
      // The domain's OutboxEvent marks these optional, but SQLite needs an explicit
      // NULL rather than `undefined` for a nullable column.
      event.lastError ?? null,
      event.nextAttemptAt ?? null,
      event.serverRevision ?? null,
      null,
      null,
    ],
  );

  if (preview) {
    await tx.runAsync(
      `INSERT INTO outbox_preview (outbox_id, business_id, aggregate_type, title, subtitle, amount, currency, document_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        event.id,
        event.businessId,
        event.aggregateType,
        preview.title,
        preview.subtitle ?? null,
        preview.amount ?? null,
        preview.currency ?? null,
        preview.documentDate ?? null,
      ],
    );
  }

  return event;
}

/** Convenience wrapper that opens its own transaction (no record change). */
export async function enqueue<T>(input: EnqueueInput<T>, preview?: ProposalPreview): Promise<OutboxEvent<T>> {
  return withTransaction((tx) => enqueueWithin(tx, input, preview));
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export async function listOutbox(businessId: string, statuses?: readonly SyncStatus[]): Promise<OutboxRow[]> {
  if (!statuses || statuses.length === 0) {
    return all<OutboxRow>('SELECT * FROM outbox WHERE business_id = ? ORDER BY created_at DESC LIMIT 500', [businessId]);
  }
  const placeholders = statuses.map(() => '?').join(', ');
  return all<OutboxRow>(`SELECT * FROM outbox WHERE business_id = ? AND status IN (${placeholders}) ORDER BY created_at DESC LIMIT 500`, [
    businessId,
    ...statuses,
  ]);
}

/** Events eligible for the next push attempt (backoff already elapsed). */
export async function dueOutbox(businessId: string, limit: number): Promise<OutboxRow[]> {
  const now = new Date().toISOString();
  return all<OutboxRow>(
    `SELECT * FROM outbox
      WHERE business_id = ?
        AND status IN ('PENDING', 'SYNCING')
        AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
      ORDER BY created_at ASC
      LIMIT ?`,
    [businessId, now, limit],
  );
}

export async function outboxSummary(businessId: string): Promise<{
  counts: Record<SyncStatus, number>;
  pending: number;
  conflicts: number;
  needsAttention: number;
}> {
  const rows = await all<{ status: SyncStatus }>('SELECT status FROM outbox WHERE business_id = ?', [businessId]);
  const counts = countStatuses(rows);
  const conflicts = await all<{ id: string }>(`SELECT id FROM server_conflicts WHERE business_id = ? AND status = 'OPEN'`, [businessId]);
  return {
    counts,
    pending: countPending(rows),
    conflicts: conflicts.length + counts.CONFLICT,
    needsAttention: counts.NEEDS_ATTENTION + counts.REJECTED,
  };
}

export interface ProposalRow extends OutboxRow {
  title: string;
  subtitle: string | null;
  preview_amount: string | null;
  preview_currency: string | null;
  document_date: string | null;
}

/**
 * Local proposals for a module (e.g. sales). The list screens show these above
 * the confirmed rows so that "what I just recorded" is never invisible on a
 * plane, but always labelled as not-yet-shared.
 */
export async function proposals(businessId: string, aggregateType: string): Promise<ProposalRow[]> {
  return all<ProposalRow>(
    `SELECT o.*, p.title, p.subtitle, p.amount AS preview_amount, p.currency AS preview_currency, p.document_date
       FROM outbox o
       LEFT JOIN outbox_preview p ON p.outbox_id = o.id
      WHERE o.business_id = ?
        AND o.aggregate_type = ?
        AND o.status IN ('PENDING', 'SYNCING', 'NEEDS_ATTENTION', 'CONFLICT')
      ORDER BY o.created_at DESC
      LIMIT 200`,
    [businessId, aggregateType],
  );
}

// ---------------------------------------------------------------------------
// State transitions (only sync.ts and the conflict screen call these)
// ---------------------------------------------------------------------------

export async function markSyncing(ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  await withTransaction(async (tx) => {
    for (const id of ids) {
      await tx.runAsync(`UPDATE outbox SET status = 'SYNCING' WHERE id = ? AND status IN ('PENDING','SYNCING')`, [id]);
    }
  });
}

export interface FailureInput {
  readonly conflict?: boolean;
  readonly permanent?: boolean;
  readonly message: string;
  readonly serverRevision?: number | null;
  readonly maxAttempts?: number;
}

/**
 * Record a failed attempt.
 *
 * The status is derived from `@sbm/domain`'s `statusAfterFailure`, so the mobile
 * app, the web client and any future client agree on when an event stops being
 * retried automatically:
 *   - a 4xx rejection is `REJECTED` (permanent, never retried),
 *   - a revision clash is `CONFLICT` (needs a human decision),
 *   - anything else back-offs and stays `PENDING` until `maxAttempts`.
 */
export async function markFailure(row: OutboxRow, input: FailureInput): Promise<SyncStatus> {
  const attempts = row.attempts + 1;
  const status = statusAfterFailure(attempts, {
    conflict: input.conflict,
    permanent: input.permanent,
    maxAttempts: input.maxAttempts ?? 12,
  });
  const retryable = shouldRetry({ status, attempts }, input.maxAttempts ?? 12);
  const nextAttemptAt = retryable ? new Date(Date.now() + retryDelayMs(attempts)).toISOString() : null;

  await run(
    `UPDATE outbox SET status = ?, attempts = ?, last_error = ?, next_attempt_at = ?, server_revision = COALESCE(?, server_revision)
      WHERE id = ?`,
    [status, attempts, input.message, nextAttemptAt, input.serverRevision ?? null, row.id],
  );
  return status;
}

export async function markSynced(row: OutboxRow, serverRevision: number | null, message: string | null): Promise<void> {
  await run(
    `UPDATE outbox SET status = 'SYNCED', server_revision = ?, server_message = ?, last_error = NULL, next_attempt_at = NULL, synced_at = ?
      WHERE id = ?`,
    [serverRevision, message, new Date().toISOString(), row.id],
  );
}

/** Manual "try again" from the Sync screen: clears the backoff. */
export async function retryNow(id: string): Promise<void> {
  await run(`UPDATE outbox SET status = 'PENDING', next_attempt_at = NULL, last_error = NULL WHERE id = ?`, [id]);
}

/** Drop a permanent rejection from the queue after the user has seen it. */
export async function discard(id: string): Promise<void> {
  await withTransaction(async (tx) => {
    await tx.runAsync('DELETE FROM outbox_preview WHERE outbox_id = ?', [id]);
    await tx.runAsync('DELETE FROM outbox WHERE id = ?', [id]);
  });
}

/** Housekeeping: keep the queue readable by trimming old, confirmed events. */
export async function pruneSynced(keepDays = 14): Promise<number> {
  const cutoff = new Date(Date.now() - keepDays * 86_400_000).toISOString();
  const result = await run(`DELETE FROM outbox WHERE status = 'SYNCED' AND synced_at IS NOT NULL AND synced_at < ?`, [cutoff]);
  return result.changes;
}

// ---------------------------------------------------------------------------
// Row ↔ event mapping
// ---------------------------------------------------------------------------

export function rowToEvent(row: OutboxRow): OutboxEvent {
  let payload: unknown = {};
  try {
    payload = JSON.parse(row.payload);
  } catch {
    payload = {};
  }
  return {
    id: row.id,
    eventId: row.event_id,
    idempotencyKey: row.idempotency_key,
    businessId: row.business_id,
    actorId: row.actor_id,
    deviceId: row.device_id,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    eventType: row.event_type,
    schemaVersion: row.schema_version,
    occurredAt: row.occurred_at,
    createdAt: row.created_at,
    baseRevision: row.base_revision,
    payload,
    payloadHash: row.payload_hash,
    status: row.status,
    risk: row.risk,
    attempts: row.attempts,
    lastError: row.last_error,
    nextAttemptAt: row.next_attempt_at,
    serverRevision: row.server_revision,
  };
}

/**
 * The outbox row is POSTed verbatim through `rowToEvent`: the server re-hashes
 * the payload and re-derives the idempotency key, so the client must never
 * "fix up" or rewrite an event on the way out.
 */
