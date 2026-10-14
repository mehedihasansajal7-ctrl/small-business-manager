import { describe, expect, it } from 'vitest';
import { retryDelayMs, type OutboxEvent } from '@sbm/domain';
import { applyPushResult, buildEvent } from '../src/offline/outbox';

const context = { businessId: 'biz-1', actorId: 'user-1', deviceId: 'device-a' };

const baseEvent = () =>
  buildEvent({ eventType: 'purchase.receive', aggregateId: 'p-local', payload: { documentDate: '2026-04-01' } }, context);

/** The delay formula is injected with a fixed random source, so it is exact. */
describe('exponential backoff with jitter', () => {
  it('doubles per attempt and caps at the maximum', () => {
    const options = { random: () => 0.5, baseDelayMs: 1_000, maxDelayMs: 15 * 60_000 };
    expect(retryDelayMs(1, options)).toBe(1_000);
    expect(retryDelayMs(2, options)).toBe(2_000);
    expect(retryDelayMs(3, options)).toBe(4_000);
    // 1s x 2^9 = 512s, still below the 15 minute ceiling.
    expect(retryDelayMs(10, options)).toBe(512_000);
    // …and it never exceeds the ceiling, however many attempts have failed.
    expect(retryDelayMs(20, options)).toBe(15 * 60_000);
    expect(retryDelayMs(50, options)).toBe(15 * 60_000);
  });

  it('spreads the delay by ±25% instead of retrying every device at once', () => {
    const low = retryDelayMs(3, { random: () => 0, baseDelayMs: 1_000 });
    const high = retryDelayMs(3, { random: () => 1, baseDelayMs: 1_000 });
    expect(low).toBe(3_000);
    expect(high).toBe(5_000);
  });

  it('schedules the next attempt from the injected clock on a transport failure', () => {
    const now = new Date('2026-04-10T11:00:00.000Z');
    const first = applyPushResult(baseEvent(), null, { now, random: () => 0.5, baseDelayMs: 1_000 });
    expect(first.status).toBe('PENDING');
    expect(first.attempts).toBe(1);
    expect(first.nextAttemptAt).toBe('2026-04-10T11:00:01.000Z');

    const second = applyPushResult(first, null, { now, random: () => 0.5, baseDelayMs: 1_000 });
    expect(second.attempts).toBe(2);
    expect(second.nextAttemptAt).toBe('2026-04-10T11:00:02.000Z');
  });

  it('throws nothing and stays PENDING until the attempt budget is exhausted', () => {
    const now = new Date('2026-04-10T11:00:00.000Z');
    let current: OutboxEvent = baseEvent();
    const statuses: string[] = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      current = applyPushResult(current, null, { now, random: () => 0.5, maxAttempts: 3 });
      statuses.push(current.status);
    }
    expect(statuses).toEqual(['PENDING', 'PENDING', 'NEEDS_ATTENTION', 'NEEDS_ATTENTION', 'NEEDS_ATTENTION']);
  });
});
