import { describe, expect, it } from 'vitest';
import {
  applyPushResult,
  applyPushResults,
  buildEvent,
  isOnlineOnly,
  isQueueable,
  markSyncing,
  mutationSpec,
  resetForRetry,
  selectBatch,
  summarize,
  toPushEvent,
  DEFAULT_MAX_ATTEMPTS,
} from '../src/offline/outbox';
import type { PushResultRow } from '../src/api/types';
import type { OutboxEvent } from '@sbm/domain';

const context = { businessId: 'biz-1', actorId: 'user-1', deviceId: 'device-a' };

function event(overrides: Partial<Parameters<typeof buildEvent>[0]> = {}, at = '2026-04-10T10:00:00.000Z') {
  return buildEvent(
    {
      eventType: 'sale.post',
      aggregateId: 'sale-local-1',
      payload: { documentDate: '2026-04-10', lines: [{ productId: 'p1', quantity: '2', unit: 'kg', unitPrice: '10' }] },
      occurredAt: at,
      ...overrides,
    },
    context,
  );
}

describe('outbox: event creation', () => {
  it('creates a PENDING event with a deterministic idempotency key and payload hash', () => {
    const created = event();
    expect(created.status).toBe('PENDING');
    expect(created.idempotencyKey).toBe(`biz-1:sale:${created.eventId}`);
    expect(created.payloadHash).toMatch(/^[0-9a-f]{64}$/);
    expect(created.attempts).toBe(0);
    expect(created.nextAttemptAt).toBeNull();
  });

  it('hashes the payload canonically, so key order does not change the hash', () => {
    const first = buildEvent({ eventType: 'sale.post', aggregateId: 'a', payload: { b: 1, a: 2 } }, context);
    const second = buildEvent({ eventType: 'sale.post', aggregateId: 'a', payload: { a: 2, b: 1 } }, context);
    expect(first.payloadHash).toBe(second.payloadHash);
  });

  it('marks high-risk events so the UI never shows them as posted', () => {
    expect(event().risk).toBe('HIGH');
    expect(buildEvent({ eventType: 'product.upsert', aggregateId: 'p1', payload: { name: 'Rice' } }, context).risk).toBe('LOW');
  });

  it('refuses event types the server cannot replay offline', () => {
    expect(() => buildEvent({ eventType: 'location.create', aggregateId: 'l1', payload: {} }, context)).toThrow(/cannot be queued/i);
    expect(isQueueable('location.create')).toBe(false);
    expect(isOnlineOnly('location.create')).toBe(true);
    expect(isOnlineOnly('member.role_change')).toBe(true);
    expect(isQueueable('sale.post')).toBe(true);
  });

  it('maps each event type to the right local cache store', () => {
    expect(mutationSpec('sale.post')?.store).toBe('sales');
    expect(mutationSpec('purchase.receive')?.store).toBe('purchases');
    expect(mutationSpec('product.upsert')?.store).toBe('products');
    expect(mutationSpec('harvest.post')?.store).toBe('harvests');
  });

  it('sends only the fields the sync endpoint needs', () => {
    const push = toPushEvent(event());
    expect(Object.keys(push).sort()).toEqual(
      ['actorId', 'aggregateId', 'aggregateType', 'attempts', 'baseRevision', 'businessId', 'createdAt', 'deviceId', 'eventId', 'eventType', 'id', 'idempotencyKey', 'occurredAt', 'payload', 'payloadHash', 'risk', 'schemaVersion', 'status'].sort(),
    );
    expect('localRecord' in push).toBe(false);
  });
});

describe('outbox: batching', () => {
  it('only selects PENDING/SYNCING events whose backoff has elapsed', () => {
    const due = event({ aggregateId: 'a' }, '2026-04-10T09:00:00.000Z');
    const notDue = { ...event({ aggregateId: 'b' }, '2026-04-10T09:05:00.000Z'), nextAttemptAt: '2026-04-10T12:00:00.000Z' };
    const synced = { ...event({ aggregateId: 'c' }, '2026-04-10T08:00:00.000Z'), status: 'SYNCED' as const };
    const rejected = { ...event({ aggregateId: 'd' }, '2026-04-10T07:00:00.000Z'), status: 'REJECTED' as const };

    const batch = selectBatch([notDue, synced, due, rejected], new Date('2026-04-10T11:00:00.000Z'));
    expect(batch.map((row) => row.aggregateId)).toEqual(['a']);
  });

  it('is ordered oldest first and capped at the batch size', () => {
    const events = Array.from({ length: 60 }, (_, index) =>
      event({ aggregateId: `a${index}` }, `2026-04-10T10:${String(index).padStart(2, '0')}:00.000Z`),
    );
    const batch = selectBatch(events, new Date('2026-04-11T00:00:00.000Z'), 50);
    expect(batch).toHaveLength(50);
    expect(batch[0]?.aggregateId).toBe('a0');
  });

  it('marks a selected batch as SYNCING without touching other statuses', () => {
    const marked = markSyncing([event({ aggregateId: 'a' }), { ...event({ aggregateId: 'b' }), status: 'CONFLICT' as const }]);
    expect(marked.map((row) => row.status)).toEqual(['SYNCING', 'CONFLICT']);
  });
});

describe('outbox: applying push results', () => {
  it('marks only server-confirmed events as SYNCED', () => {
    const created = event();
    const result: PushResultRow = { idempotencyKey: created.idempotencyKey, eventId: created.eventId, status: 'SYNCED', serverRevision: 7 };
    const updated = applyPushResult(created, result);
    expect(updated.status).toBe('SYNCED');
    expect(updated.serverRevision).toBe(7);
    expect(updated.nextAttemptAt).toBeNull();
  });

  it('keeps a conflict clearly marked and stops automatic retries', () => {
    const created = event();
    const updated = applyPushResult(created, { idempotencyKey: created.idempotencyKey, eventId: created.eventId, status: 'CONFLICT', message: 'Another partner changed this record.' });
    expect(updated.status).toBe('CONFLICT');
    expect(updated.lastError).toMatch(/another partner/i);
    expect(updated.nextAttemptAt).toBeNull();
  });

  it('treats a REJECTED result as permanent', () => {
    const created = event();
    const updated = applyPushResult(created, { idempotencyKey: created.idempotencyKey, eventId: created.eventId, status: 'REJECTED', message: 'VALIDATION: quantity must be greater than zero' });
    expect(updated.status).toBe('REJECTED');
    expect(updated.nextAttemptAt).toBeNull();
  });

  it('keeps NEEDS_ATTENTION events out of the automatic queue', () => {
    const created = event();
    const updated = applyPushResult(created, { idempotencyKey: created.idempotencyKey, eventId: created.eventId, status: 'NEEDS_ATTENTION', message: 'Complete this online.' });
    expect(updated.status).toBe('NEEDS_ATTENTION');
    expect(selectBatch([updated], new Date('2026-05-01T00:00:00.000Z'))).toHaveLength(0);
  });

  it('backs off a transport failure and finally asks for attention', () => {
    const created = event();
    let current: OutboxEvent = created;
    const now = new Date('2026-04-10T11:00:00.000Z');
    for (let attempt = 1; attempt <= DEFAULT_MAX_ATTEMPTS; attempt += 1) {
      current = applyPushResult(current, null, { now, random: () => 0.5 });
    }
    expect(current.attempts).toBe(DEFAULT_MAX_ATTEMPTS);
    expect(current.status).toBe('NEEDS_ATTENTION');
    expect(current.lastError).toMatch(/could not reach the server/i);
  });

  it('applies a whole response by idempotency key and leaves unknown events alone', () => {
    const first = event({ aggregateId: 'a' });
    const second = event({ aggregateId: 'b' });
    const results: PushResultRow[] = [{ idempotencyKey: first.idempotencyKey, eventId: first.eventId, status: 'SYNCED' }];
    const updated = applyPushResults([first, second], results);
    expect(updated[0]?.status).toBe('SYNCED');
    expect(updated[1]?.status).toBe('PENDING');
  });

  it('counts pending, conflicted and attention-needing events for the banner', () => {
    const events = [
      event({ aggregateId: 'a' }),
      { ...event({ aggregateId: 'b' }), status: 'SYNCED' as const },
      { ...event({ aggregateId: 'c' }), status: 'CONFLICT' as const },
      { ...event({ aggregateId: 'd' }), status: 'NEEDS_ATTENTION' as const },
      { ...event({ aggregateId: 'e' }), status: 'REJECTED' as const },
    ];
    const summary = summarize(events);
    // pendingCount = PENDING + SYNCING + NEEDS_ATTENTION (a conflict needs a decision, not a retry).
    expect(summary.pending).toBe(2);
    expect(summary.conflicts).toBe(1);
    expect(summary.needsAttention).toBe(2);
    expect(summary.counts.SYNCED).toBe(1);
    expect(summary.hasUnconfirmedHighRisk).toBe(true);
  });

  it('can put a failed event back in the queue on the user’s request', () => {
    const failed = { ...event(), status: 'NEEDS_ATTENTION' as const, attempts: 9, lastError: 'boom' };
    const retried = resetForRetry(failed);
    expect(retried.status).toBe('PENDING');
    expect(retried.attempts).toBe(0);
    expect(retried.lastError).toBeNull();
  });
});
