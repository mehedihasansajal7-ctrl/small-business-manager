import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp, type App } from '../../../api/src/server.js';
import { auth, businesses, catalog, inventory, sync as syncApi } from '../../src/api/endpoints';
import { purchases as purchaseApi, reports as reportApi, sales as salesApi } from '../../src/api/endpointsFinance';
import { ai as aiApi } from '../../src/api/endpointsAi';
import { ApiError } from '../../src/api/client';
import { buildEvent, selectBatch, toPushEvent } from '../../src/offline/outbox';
import { planMerge, type PullPayload } from '../../src/offline/merge';
import { FULL_PULL_SINCE } from '../../src/offline/sync';

/**
 * Wire-protocol test: the REAL web client modules talking to the REAL API
 * server (in-memory SQLite). It proves the payload shapes, the error envelope,
 * the outbox push/pull contract and the idempotency guarantee actually line up.
 *
 * The browser-only parts (IndexedDB, service worker, React) are not covered
 * here; those are exercised by the app itself.
 */

let app: App;
let cookie = '';
const realFetch = globalThis.fetch;

beforeAll(async () => {
  app = createApp({
    port: 0,
    host: '127.0.0.1',
    databaseFile: ':memory:',
    // Keep every test artefact inside apps/web (never the repo root).
    dataDir: '.test-data',
    sessionSecret: 'web-test-secret-web-test-secret-1234',
    secureCookies: false,
    mode: 'local',
    rateLimits: { registerPerHour: 10_000, loginPer15Min: 1_000, invitePerHour: 10_000 },
  });
  const { port } = await app.start();
  // The client always calls the same-origin `/api` path; in the test that origin
  // is the ephemeral API port, and the session cookie is carried manually (Node's
  // fetch has no cookie jar).
  vi.stubEnv('VITE_API_BASE', `http://127.0.0.1:${port}`);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    if (cookie) headers.set('cookie', cookie);
    const response = await realFetch(input, { ...init, headers });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0] as string;
    return response;
  }) as typeof fetch;
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  vi.unstubAllEnvs();
  await app.stop();
});

describe('auth + tenancy through the web client', () => {
  it('registers a business, then reads it back with its permissions', async () => {
    const registered = await auth.register({
      email: 'web@test.sbm',
      password: 'password123',
      displayName: 'Web Owner',
      businessName: 'Web Shop',
    });
    expect(registered.businessId).toBeTruthy();

    const me = await auth.me();
    expect(me.user.email).toBe('web@test.sbm');
    expect(me.activeBusinessId).toBe(registered.businessId);

    const business = await businesses.current();
    expect(business.currency).toBe('BDT');
    expect(business.timezone).toBe('Asia/Dhaka');
    expect(business.member.role).toBe('owner');
    // The permission list is what every screen gates on.
    expect(business.permissions).toContain('sale.create');
    expect(business.permissions).toContain('purchase.cost.view');
  });

  it('surfaces the server error envelope as a typed ApiError', async () => {
    await expect(catalog.createProduct({ name: '', unit: 'kg' })).rejects.toBeInstanceOf(ApiError);
    try {
      await catalog.createProduct({ name: 'Bad unit', unit: 'not-a-unit' });
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).status).toBe(400);
      expect((error as ApiError).message).toMatch(/unit/i);
    }
  });
});

describe('commerce through the web client', () => {
  it('creates master data, receives stock and posts a sale with matching numbers', async () => {
    const product = await catalog.createProduct({ name: 'Rice', unit: 'kg', kind: 'PRODUCT', salePrice: '68', purchasePrice: '58', reorderLevel: '10' });
    expect(product.id).toBeTruthy();
    expect(product.onHand).toBe('0');

    await catalog.createCustomer({ name: 'Nasir', phone: '01711111111' });

    const purchase = await purchaseApi.create({
      documentDate: '2026-04-02',
      paid: '2000',
      lines: [{ productId: product.id, quantity: '100', unit: 'kg', unitCost: '58' }],
    });
    expect(purchase.total).toBe('5800.00');
    expect(purchase.payable).toBe('3800.00');

    const sale = await salesApi.create({
      documentDate: '2026-04-05',
      cashReceived: '3000',
      lines: [{ productId: product.id, quantity: '50', unit: 'kg', unitPrice: '68', discount: '100' }],
    });
    expect(sale.net).toBe('3300.00');
    expect(sale.receivable).toBe('300.00');

    const stock = await inventory.list();
    expect(stock.find((row) => row.itemId === product.id)?.onHand).toBe('50');
    // Money and quantity stay strings all the way to the UI.
    expect(typeof stock.find((row) => row.itemId === product.id)?.unitCost).toBe('string');

    const dashboard = await reportApi.dashboard({ from: '2026-04-01', to: '2026-04-30' });
    expect(dashboard.currency).toBe('BDT');
    expect(dashboard.netProfit).toBe('400.00'); // 3300 - 2900 COGS
  });

  it('reports a negative-stock conflict as 409 STOCK_CONFLICT, which the POS surfaces', async () => {
    const products = await catalog.products();
    const rice = products.find((row) => row.name === 'Rice');
    expect(rice).toBeTruthy();
    try {
      await salesApi.create({ documentDate: '2026-04-06', cashReceived: '0', lines: [{ productId: rice?.id as string, quantity: '9999', unit: 'kg', unitPrice: '68' }] });
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).status).toBe(409);
      expect((error as ApiError).code).toBe('STOCK_CONFLICT');
      expect((error as ApiError).isConflict).toBe(true);
    }
  });
});

describe('outbox → POST /api/sync/push → GET /api/sync/pull', () => {
  it('applies a queued sale exactly once and reports it as SYNCED', async () => {
    const business = await businesses.current();
    const products = await catalog.products();
    const rice = products.find((row) => row.name === 'Rice');
    const before = Number((await inventory.list()).find((row) => row.itemId === rice?.id)?.onHand ?? '0');

    const event = buildEvent(
      {
        eventType: 'sale.post',
        aggregateId: 'sale-local-offline-1',
        payload: { documentDate: '2026-04-07', cashReceived: '340', lines: [{ productId: rice?.id, quantity: '5', unit: 'kg', unitPrice: '68' }] },
        occurredAt: '2026-04-07T09:00:00.000Z',
      },
      { businessId: business.id, actorId: business.member.id, deviceId: 'test-device' },
    );

    const first = await syncApi.push([toPushEvent(event)]);
    expect(first.results[0]?.status).toBe('SYNCED');
    expect(first.results[0]?.idempotencyKey).toBe(event.idempotencyKey);
    expect(first.results[0]?.result).toMatchObject({ net: '340.00' });

    // A retry must not create a second sale (that is the whole point of the outbox).
    const retry = await syncApi.push([toPushEvent(event)]);
    expect(retry.results[0]?.status).toBe('SYNCED');
    expect(String(retry.results[0]?.message)).toMatch(/idempotent/i);

    const after = Number((await inventory.list()).find((row) => row.itemId === rice?.id)?.onHand ?? '0');
    expect(after).toBe(before - 5);
  });

  it('refuses an access-changing event from the offline queue', async () => {
    const business = await businesses.current();
    const event = buildEvent(
      { eventType: 'farming.observe', aggregateId: 'x', payload: { kind: 'leaf colour' } },
      { businessId: business.id, actorId: business.member.id, deviceId: 'test-device' },
    );
    const forged = { ...event, eventType: 'member.role_change', aggregateType: 'member' };
    const result = await syncApi.push([toPushEvent(forged)]);
    expect(result.results[0]?.status).toBe('NEEDS_ATTENTION');
  });

  it('pulls server changes and plans them into the local cache stores', async () => {
    const payload = (await syncApi.pull(FULL_PULL_SINCE)) as PullPayload;
    const plan = planMerge(payload);
    const stores = plan.upserts.map((row) => row.store);
    expect(stores).toContain('products');
    expect(stores).toContain('sales');
    expect(stores).toContain('purchases');
    expect(plan.business?.id).toBeTruthy();
    expect(plan.serverTime).toBeTruthy();
    // The next incremental pull starts from the server clock.
    const incremental = planMerge((await syncApi.pull(plan.serverTime as string)) as PullPayload);
    expect(incremental.rowCount).toBe(0);
  });

  it('selects only due events for a push batch (what the coordinator sends)', async () => {
    const pending = buildEvent(
      { eventType: 'sale.post', aggregateId: 'local-2', payload: { documentDate: '2026-04-08', lines: [] } },
      { businessId: 'b', actorId: 'a', deviceId: 'd' },
    );
    const batch = selectBatch([pending], new Date());
    expect(batch).toHaveLength(1);
    expect(batch[0]?.status).toBe('PENDING');
  });
});

describe('AI output is honestly labelled and never a transaction', () => {
  it('answers in fallback mode and says so', async () => {
    const status = await aiApi.status();
    expect(status.mode).toBe('fallback');

    const answer = await aiApi.ask({ question: 'How is my business doing this month?', language: 'en' });
    expect(answer.mode).toBe('fallback');
    expect(answer.limitations.length).toBeGreaterThan(0);
    expect(answer.text).toMatch(/review and confirm/i);
    expect(answer.citations).toEqual([]);
  });

  it('returns curated official links, labelled as links, for a pesticide question', async () => {
    const answer = await aiApi.ask({ question: 'Which pesticide dose for rice stem borer?', language: 'en' });
    expect(answer.citations.some((citation) => citation.kind === 'CURATED_LINK')).toBe(true);
    expect(answer.citations.every((citation) => citation.url.startsWith('https://'))).toBe(true);
    expect(answer.limitations.join(' ')).toMatch(/curated|not live search/i);
  });
});
