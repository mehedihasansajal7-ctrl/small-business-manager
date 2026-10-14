import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../src/hash.js';
import {
  OUTBOX_SCHEMA_VERSION,
  analyseFieldConflict,
  canonicalJson,
  classifyRevision,
  createOutboxEvent,
  isConfirmed,
  mergeDraftFields,
  outboxCounts,
  payloadHash,
  pendingCount,
  retryDelayMs,
  shouldRetry,
  statusAfterFailure,
  syncBanner,
} from '../src/sync.js';

describe('sha256 (dependency-free, browser + node)', () => {
  it('matches the published NIST vectors', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
  });

  it('handles multi-block input (longer than one 64-byte block)', () => {
    const long = 'a'.repeat(1000);
    expect(sha256Hex(long)).toHaveLength(64);
    expect(sha256Hex(long)).toBe(sha256Hex(long));
    expect(sha256Hex(`${long}b`)).not.toBe(sha256Hex(long));
  });

  it('hashes UTF-8 (Bangla) text consistently', () => {
    expect(sha256Hex('ফসল')).toBe(sha256Hex('ফসল'));
    expect(sha256Hex('ফসল')).toHaveLength(64);
  });
});

describe('canonical payload hashing', () => {
  it('is stable regardless of object key order', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
    expect(payloadHash({ b: 1, a: 2 })).toBe(payloadHash({ a: 2, b: 1 }));
  });

  it('changes when a decimal value changes', () => {
    expect(payloadHash({ amount: '10.00' })).not.toBe(payloadHash({ amount: '10.01' }));
  });

  it('normalises nested arrays, nulls and undefined', () => {
    expect(canonicalJson({ list: [1, undefined, null] })).toBe('{"list":[1,null,null]}');
    expect(canonicalJson({ skip: undefined, keep: 1 })).toBe('{"keep":1}');
  });
});

describe('outbox events', () => {
  const input = {
    businessId: 'biz-1',
    actorId: 'user-1',
    deviceId: 'device-a',
    aggregateType: 'sale',
    aggregateId: 'sale-1',
    eventType: 'sale.post',
    payload: { total: '500.00', lines: 2 },
  } as const;

  it('creates a pending event with a business-scoped idempotency key', () => {
    const event = createOutboxEvent(input);
    expect(event.status).toBe('PENDING');
    expect(event.attempts).toBe(0);
    expect(event.schemaVersion).toBe(OUTBOX_SCHEMA_VERSION);
    expect(event.risk).toBe('HIGH'); // money posting is high risk
    expect(event.idempotencyKey).toBe(`biz-1:sale:${event.eventId}`);
    expect(event.payloadHash).toBe(payloadHash(input.payload));
    expect(event.eventId).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it('marks descriptive edits as low risk', () => {
    const event = createOutboxEvent({ ...input, eventType: 'product.rename' });
    expect(event.risk).toBe('LOW');
  });

  it('is only "confirmed" once the server has acknowledged it', () => {
    const event = createOutboxEvent(input);
    expect(isConfirmed(event)).toBe(false);
    expect(isConfirmed({ ...event, status: 'SYNCED' })).toBe(true);
    // A high-risk local proposal that is still pending must never read as posted.
    expect(isConfirmed({ ...event, status: 'NEEDS_ATTENTION' })).toBe(false);
  });

  it('counts the queue by status', () => {
    const events: { status: 'PENDING' | 'SYNCED' | 'CONFLICT' | 'NEEDS_ATTENTION' }[] = [
      { status: 'PENDING' },
      { status: 'PENDING' },
      { status: 'SYNCED' },
      { status: 'CONFLICT' },
      { status: 'NEEDS_ATTENTION' },
    ];
    const counts = outboxCounts(events);
    expect(counts.PENDING).toBe(2);
    expect(counts.SYNCED).toBe(1);
    expect(pendingCount(events)).toBe(3);
    expect(counts.CONFLICT).toBe(1);
  });
});

describe('retry backoff', () => {
  it('grows exponentially and is deterministic when the randomness is injected', () => {
    const random = () => 0.5; // exactly the middle => zero jitter
    expect(retryDelayMs(1, { random })).toBe(1_000);
    expect(retryDelayMs(2, { random })).toBe(2_000);
    expect(retryDelayMs(3, { random })).toBe(4_000);
    expect(retryDelayMs(4, { random })).toBe(8_000);
  });

  it('applies bounded jitter', () => {
    expect(retryDelayMs(1, { random: () => 0 })).toBe(750);
    expect(retryDelayMs(1, { random: () => 1 })).toBe(1_250);
  });

  it('caps at the maximum delay', () => {
    const random = () => 0.5;
    expect(retryDelayMs(50, { random, maxDelayMs: 60_000 })).toBe(60_000);
  });

  it('stops retrying terminal states and gives up after the attempt budget', () => {
    expect(shouldRetry({ status: 'SYNCED', attempts: 0 })).toBe(false);
    expect(shouldRetry({ status: 'REJECTED', attempts: 1 })).toBe(false);
    expect(shouldRetry({ status: 'PENDING', attempts: 3 })).toBe(true);
    expect(shouldRetry({ status: 'PENDING', attempts: 12 }, 12)).toBe(false);
  });

  it('classifies the status after a failure', () => {
    expect(statusAfterFailure(1)).toBe('PENDING');
    expect(statusAfterFailure(1, { permanent: true })).toBe('REJECTED');
    expect(statusAfterFailure(1, { conflict: true })).toBe('CONFLICT');
    expect(statusAfterFailure(12, { maxAttempts: 12 })).toBe('NEEDS_ATTENTION');
  });
});

describe('revision conflict detection', () => {
  it('detects divergence instead of blindly overwriting', () => {
    expect(classifyRevision(5, 5)).toBe('IN_SYNC');
    expect(classifyRevision(null, 9)).toBe('IN_SYNC');
    expect(classifyRevision(4, 9)).toBe('CONFLICT');
    expect(classifyRevision(9, 4)).toBe('LOCAL_IS_NEWER');
  });

  it('auto-merges only safe descriptive fields', () => {
    const conflicts = analyseFieldConflict({
      aggregateType: 'customer',
      aggregateId: 'c1',
      localEventId: 'evt-1',
      localDeviceId: 'device-a',
      localActorId: 'user-1',
      localChangedAt: '2026-05-01T10:00:00.000Z',
      baseRevision: 3,
      serverRevision: 4,
      serverUpdatedAt: '2026-05-01T09:59:00.000Z',
      serverUpdatedBy: 'user-2',
      localFields: { name: 'Rahim Store', phone: '01711111111' },
      serverFields: { name: 'Rahim Store', phone: '01722222222' },
    });
    expect(conflicts.differingFields).toEqual(['phone']);
    expect(conflicts.autoMergeable).toBe(true);

    const money = analyseFieldConflict({
      aggregateType: 'sale',
      aggregateId: 's1',
      localEventId: 'evt-2',
      localDeviceId: 'device-a',
      localActorId: 'user-1',
      localChangedAt: '2026-05-01T10:00:00.000Z',
      baseRevision: 3,
      serverRevision: 4,
      serverUpdatedAt: '2026-05-01T09:59:00.000Z',
      serverUpdatedBy: 'user-2',
      localFields: { total: '500.00' },
      serverFields: { total: '450.00' },
    });
    expect(money.differingFields).toEqual(['total']);
    expect(money.autoMergeable).toBe(false);
  });

  it('merges drafts field by field when the owner accepts the local value', () => {
    const merged = mergeDraftFields({ notes: 'local note', total: '999.00' }, { notes: 'server note', total: '100.00' }, ['notes']);
    expect(merged).toEqual({ notes: 'local note', total: '100.00' });
  });
});

describe('sync status banner', () => {
  it('prioritises conflicts, then offline, then pending', () => {
    expect(syncBanner({ online: true, pending: 0, conflicts: 2 }).level).toBe('error');
    expect(syncBanner({ online: false, pending: 3, conflicts: 0 }).level).toBe('warn');
    expect(syncBanner({ online: false, pending: 3, conflicts: 0 }).en).toMatch(/Offline/);
    expect(syncBanner({ online: false, pending: 3, conflicts: 0 }).bn).toMatch(/অফলাইন/);
    expect(syncBanner({ online: true, pending: 2, conflicts: 0 }).level).toBe('warn');
    expect(syncBanner({ online: true, pending: 0, conflicts: 0, lastSyncedAt: '2026-05-01T10:00:00.000Z' }).level).toBe('ok');
  });

  it('never claims success while offline with pending changes', () => {
    const banner = syncBanner({ online: false, pending: 1, conflicts: 0 });
    expect(banner.level).not.toBe('ok');
  });
});
