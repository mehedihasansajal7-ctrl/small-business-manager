import { sha256Hex } from './hash.js';

/**
 * Offline-first sync primitives shared by the web app, the Android app and the
 * server. Every local mutation produces a durable outbox event in the same
 * local transaction as the record change, and the server applies each event
 * idempotently.
 */

export type SyncStatus = 'PENDING' | 'SYNCING' | 'SYNCED' | 'NEEDS_ATTENTION' | 'CONFLICT' | 'REJECTED';

export const SYNC_STATUS_LABEL: Readonly<Record<SyncStatus, { en: string; bn: string }>> = Object.freeze({
  PENDING: { en: 'Pending', bn: 'অপেক্ষমাণ' },
  SYNCING: { en: 'Syncing', bn: 'সিঙ্ক হচ্ছে' },
  SYNCED: { en: 'Synced', bn: 'সিঙ্ক হয়েছে' },
  NEEDS_ATTENTION: { en: 'Needs attention', bn: 'মনোযোগ প্রয়োজন' },
  CONFLICT: { en: 'Conflict', bn: 'সংঘাত' },
  REJECTED: { en: 'Rejected', bn: 'বাতিল' },
});

/** How risky an operation is when attempted offline. */
export type RiskLevel = 'LOW' | 'HIGH';

/**
 * High-risk operations are shown as a clearly-marked local proposal until the
 * server confirms them, so a partner never sees "posted" for something that was
 * never actually shared.
 */
export const HIGH_RISK_EVENTS: ReadonlySet<string> = new Set([
  'sale.post',
  'purchase.receive',
  'stock.move',
  'stock.adjust',
  'harvest.post',
  'cost.allocate',
  'payment.post',
  'journal.post',
  'member.role_change',
  'opening_balance.set',
]);

export interface OutboxEvent<T = unknown> {
  /** Local primary key. */
  readonly id: string;
  /** Globally unique event id; becomes the server's idempotency key. */
  readonly eventId: string;
  readonly idempotencyKey: string;
  readonly businessId: string;
  readonly actorId: string;
  readonly deviceId: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly schemaVersion: number;
  /** ISO timestamp of when the user performed the action. */
  readonly occurredAt: string;
  readonly createdAt: string;
  /** Server revision this change was based on, for conflict detection. */
  readonly baseRevision: number | null;
  readonly payload: T;
  readonly payloadHash: string;
  readonly status: SyncStatus;
  readonly risk: RiskLevel;
  readonly attempts: number;
  readonly lastError?: string | null;
  readonly nextAttemptAt?: string | null;
  readonly serverRevision?: number | null;
}

export interface NewOutboxEventInput<T> {
  readonly businessId: string;
  readonly actorId: string;
  readonly deviceId: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly payload: T;
  readonly baseRevision?: number | null;
  readonly schemaVersion?: number;
  readonly occurredAt?: string;
  readonly eventId?: string;
  readonly id?: string;
}

/** Deterministic JSON with sorted object keys, so hashes are reproducible. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}

function normalize(value: unknown): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map((v) => (v === undefined ? null : normalize(v)));
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    const source = value as Record<string, unknown>;
    // Decimal-like and Money-like values expose toJSON; JSON.stringify would
    // already call it, but doing it here keeps key ordering applied afterwards.
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      const raw = source[key];
      if (raw === undefined) continue;
      out[key] = normalize(raw);
    }
    return out;
  }
  return value;
}

export function payloadHash(payload: unknown): string {
  return sha256Hex(canonicalJson(payload));
}

function uuid(): string {
  const cryptoObj = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoObj?.randomUUID) return cryptoObj.randomUUID();
  throw new Error('sync: a Web Crypto `randomUUID` implementation is required to create outbox events');
}

export const OUTBOX_SCHEMA_VERSION = 1;

export function createOutboxEvent<T>(input: NewOutboxEventInput<T>): OutboxEvent<T> {
  const now = new Date().toISOString();
  const eventId = input.eventId ?? uuid();
  return {
    id: input.id ?? eventId,
    eventId,
    idempotencyKey: `${input.businessId}:${input.aggregateType}:${eventId}`,
    businessId: input.businessId,
    actorId: input.actorId,
    deviceId: input.deviceId,
    aggregateType: input.aggregateType,
    aggregateId: input.aggregateId,
    eventType: input.eventType,
    schemaVersion: input.schemaVersion ?? OUTBOX_SCHEMA_VERSION,
    occurredAt: input.occurredAt ?? now,
    createdAt: now,
    baseRevision: input.baseRevision ?? null,
    payload: input.payload,
    payloadHash: payloadHash(input.payload),
    status: 'PENDING',
    risk: HIGH_RISK_EVENTS.has(input.eventType) ? 'HIGH' : 'LOW',
    attempts: 0,
    lastError: null,
    nextAttemptAt: null,
    serverRevision: null,
  };
}

export interface RetryOptions {
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  /** 0..1 source of randomness; injectable for deterministic tests. */
  readonly random?: () => number;
  /** Fraction of the delay that may be jittered (default 0.25 = +/-25%). */
  readonly jitterRatio?: number;
}

/** Exponential backoff with jitter, capped. `attempt` is 1-based. */
export function retryDelayMs(attempt: number, options: RetryOptions = {}): number {
  const base = options.baseDelayMs ?? 1_000;
  const max = options.maxDelayMs ?? 15 * 60_000;
  const random = options.random ?? Math.random;
  const jitterRatio = options.jitterRatio ?? 0.25;
  const safeAttempt = Math.max(1, Math.floor(attempt));
  const raw = Math.min(max, base * 2 ** (safeAttempt - 1));
  const jitter = raw * jitterRatio * (random() * 2 - 1);
  return Math.max(0, Math.round(raw + jitter));
}

export function shouldRetry(event: Pick<OutboxEvent, 'status' | 'attempts'>, maxAttempts = 12): boolean {
  if (event.status === 'SYNCED' || event.status === 'REJECTED') return false;
  return event.attempts < maxAttempts;
}

/** Status after a failed attempt, so the UI can show the right badge. */
export function statusAfterFailure(attempts: number, options: { maxAttempts?: number; conflict?: boolean; permanent?: boolean } = {}): SyncStatus {
  if (options.permanent) return 'REJECTED';
  if (options.conflict) return 'CONFLICT';
  if (attempts >= (options.maxAttempts ?? 12)) return 'NEEDS_ATTENTION';
  return 'PENDING';
}

export type RevisionVerdict = 'IN_SYNC' | 'LOCAL_IS_NEWER' | 'SERVER_IS_NEWER' | 'CONFLICT';

/**
 * Compare the revision a change was based on with the current server revision.
 * Money, stock and posted production events must never be resolved by blind
 * last-write-wins, so a divergence is surfaced as a conflict instead.
 */
export function classifyRevision(baseRevision: number | null, serverRevision: number): RevisionVerdict {
  if (baseRevision === null) return 'IN_SYNC';
  if (baseRevision === serverRevision) return 'IN_SYNC';
  if (baseRevision < serverRevision) return 'CONFLICT';
  return 'LOCAL_IS_NEWER';
}

export interface ConflictRecord {
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly localEventId: string;
  readonly localDeviceId: string;
  readonly localActorId: string;
  readonly localChangedAt: string;
  readonly serverRevision: number;
  readonly baseRevision: number | null;
  readonly serverUpdatedAt: string;
  readonly serverUpdatedBy: string;
  /** Field-level differences when a merge is safe; empty when it is not. */
  readonly differingFields: readonly string[];
  readonly autoMergeable: boolean;
}

/** Fields that are safe to merge field-by-field when two partners edit a draft. */
export const MERGEABLE_FIELDS: ReadonlySet<string> = new Set(['notes', 'description', 'attachmentIds', 'tags', 'phone', 'address', 'contactPerson']);

export function analyseFieldConflict(input: {
  aggregateType: string;
  aggregateId: string;
  localEventId: string;
  localDeviceId: string;
  localActorId: string;
  localChangedAt: string;
  baseRevision: number | null;
  serverRevision: number;
  serverUpdatedAt: string;
  serverUpdatedBy: string;
  localFields: Record<string, unknown>;
  serverFields: Record<string, unknown>;
}): ConflictRecord {
  const keys = new Set([...Object.keys(input.localFields), ...Object.keys(input.serverFields)]);
  const differingFields: string[] = [];
  for (const key of keys) {
    const local = canonicalJson(input.localFields[key] ?? null);
    const server = canonicalJson(input.serverFields[key] ?? null);
    if (local !== server) differingFields.push(key);
  }
  const autoMergeable = differingFields.length > 0 && differingFields.every((f) => MERGEABLE_FIELDS.has(f));
  return {
    aggregateType: input.aggregateType,
    aggregateId: input.aggregateId,
    localEventId: input.localEventId,
    localDeviceId: input.localDeviceId,
    localActorId: input.localActorId,
    localChangedAt: input.localChangedAt,
    serverRevision: input.serverRevision,
    baseRevision: input.baseRevision,
    serverUpdatedAt: input.serverUpdatedAt,
    serverUpdatedBy: input.serverUpdatedBy,
    differingFields,
    autoMergeable,
  };
}

/** Field-level merge for drafts: server wins on non-mergeable, local on mergeable. */
export function mergeDraftFields(local: Record<string, unknown>, server: Record<string, unknown>, acceptLocalFor: readonly string[]): Record<string, unknown> {
  const accept = new Set(acceptLocalFor);
  const merged: Record<string, unknown> = { ...server };
  for (const [key, value] of Object.entries(local)) {
    if (accept.has(key)) merged[key] = value;
  }
  return merged;
}

/**
 * A high-risk event may only be displayed as confirmed once the server has
 * acknowledged it. Until then the UI must label it as a local proposal.
 */
export function isConfirmed(event: Pick<OutboxEvent, 'status' | 'risk'>): boolean {
  return event.status === 'SYNCED';
}

export function outboxCounts(events: readonly Pick<OutboxEvent, 'status'>[]): Record<SyncStatus, number> {
  const counts: Record<SyncStatus, number> = { PENDING: 0, SYNCING: 0, SYNCED: 0, NEEDS_ATTENTION: 0, CONFLICT: 0, REJECTED: 0 };
  for (const event of events) counts[event.status] += 1;
  return counts;
}

export function pendingCount(events: readonly Pick<OutboxEvent, 'status'>[]): number {
  return events.filter((e) => e.status === 'PENDING' || e.status === 'SYNCING' || e.status === 'NEEDS_ATTENTION').length;
}

/** Human-readable sync banner for the app header. */
export function syncBanner(state: { online: boolean; pending: number; conflicts: number; lastSyncedAt?: string | null }): { level: 'ok' | 'warn' | 'error'; en: string; bn: string } {
  if (state.conflicts > 0) {
    return { level: 'error', en: `${state.conflicts} record(s) need your decision before syncing.`, bn: `${state.conflicts}টি রেকর্ড সিঙ্ক করার আগে আপনার সিদ্ধান্ত প্রয়োজন।` };
  }
  if (!state.online) {
    return {
      level: 'warn',
      en: state.pending > 0 ? `Offline. ${state.pending} change(s) saved on this device and waiting to sync.` : 'Offline. Changes will be saved on this device.',
      bn: state.pending > 0 ? `অফলাইন। ${state.pending}টি পরিবর্তন এই ডিভাইসে সংরক্ষিত, সিঙ্কের অপেক্ষায়।` : 'অফলাইন। পরিবর্তন এই ডিভাইসে সংরক্ষিত হবে।',
    };
  }
  if (state.pending > 0) {
    return { level: 'warn', en: `Syncing ${state.pending} pending change(s)…`, bn: `${state.pending}টি পরিবর্তন সিঙ্ক হচ্ছে…` };
  }
  const when = state.lastSyncedAt ? new Date(state.lastSyncedAt).toLocaleString() : 'just now';
  return { level: 'ok', en: `All changes shared. Last sync: ${when}`, bn: `সব পরিবর্তন শেয়ার হয়েছে। সর্বশেষ সিঙ্ক: ${when}` };
}
