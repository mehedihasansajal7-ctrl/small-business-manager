import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, type App } from '../src/server.js';

let app: App;
let baseUrl = '';

/** Minimal cookie-aware HTTP client. */
class Client {
  cookie = '';
  constructor(private readonly base: string) {}

  async request(method: string, path: string, body?: unknown, opts: { raw?: boolean } = {}): Promise<{ status: number; body: any }> {
    const response = await fetch(`${this.base}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(this.cookie ? { cookie: this.cookie } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) this.cookie = setCookie.split(';')[0] as string;
    const text = await response.text();
    if (opts.raw) return { status: response.status, body: text };
    try {
      return { status: response.status, body: JSON.parse(text) };
    } catch {
      return { status: response.status, body: text };
    }
  }
  get = (path: string) => this.request('GET', path);
  post = (path: string, body?: unknown) => this.request('POST', path, body);
  patch = (path: string, body?: unknown) => this.request('PATCH', path, body);
  put = (path: string, body?: unknown) => this.request('PUT', path, body);
  del = (path: string) => this.request('DELETE', path);
}

function client(): Client {
  return new Client(baseUrl);
}

async function setupBusiness(ownerEmail = 'owner@test.sbm') {
  const c = client();
  const registered = await c.post('/api/auth/register', { email: ownerEmail, password: 'password123', displayName: 'Test Owner', businessName: `Shop ${ownerEmail}`, timezone: 'Asia/Dhaka' });
  expect(registered.status).toBe(200);
  const products = await c.post('/api/products', { name: 'Rice', unit: 'kg', kind: 'PRODUCT', salePrice: '68', purchasePrice: '58', reorderLevel: '10' });
  const input = await c.post('/api/products', { name: 'Feed', unit: 'kg', kind: 'INPUT', purchasePrice: '60' });
  const customer = await c.post('/api/customers', { name: 'Nasir', phone: '01711111111' });
  const supplier = await c.post('/api/suppliers', { name: 'Agro Ltd', phone: '01822222222' });
  return {
    client: c,
    businessId: registered.body.businessId as string,
    productId: products.body.id as string,
    inputId: input.body.id as string,
    customerId: customer.body.id as string,
    supplierId: supplier.body.id as string,
  };
}

beforeAll(async () => {
  app = createApp({
    port: 0,
    host: '127.0.0.1',
    databaseFile: ':memory:',
    sessionSecret: 'test-secret-test-secret-test-secret-1234',
    secureCookies: false,
    mode: 'local',
    // Generous limits so the suite itself is not throttled; the dedicated
    // rate-limit test uses the login window, which stays deliberately small.
    rateLimits: { registerPerHour: 10_000, loginPer15Min: 25, invitePerHour: 10_000 },
  });
  const { port } = await app.start();
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await app.stop();
});

describe('health and metadata', () => {
  it('exposes a health endpoint and the role/account catalogue', async () => {
    const c = client();
    const health = await c.get('/api/health');
    expect(health.status).toBe(200);
    expect(health.body.status).toBe('ok');
    expect(health.body.schemaVersion).toBeGreaterThan(0);

    const meta = await c.get('/api/meta');
    expect(meta.body.roles).toHaveLength(7);
    expect(meta.body.accounts.some((a: { code: string }) => a.code === '4000')).toBe(true);
    expect(meta.body.routes.length).toBeGreaterThan(30);
  });

  it('reports the zero-cost AI configuration honestly', async () => {
    const c = client();
    const status = await c.get('/api/status');
    expect(status.body.ai.fallbackAvailable).toBe(true);
    expect(status.body.research.curatedFallback).toBe(true);
  });
});

describe('auth and session', () => {
  it('registers a user with a business and returns the session user', async () => {
    const c = client();
    const result = await c.post('/api/auth/register', { email: 'owner.a@test.sbm', password: 'password123', displayName: 'Owner A', businessName: 'Alpha Store' });
    expect(result.status).toBe(200);
    expect(result.body.businessId).toBeTruthy();
    expect(c.cookie).toContain('sbm_session');

    const me = await c.get('/api/auth/me');
    expect(me.body.user.email).toBe('owner.a@test.sbm');
    expect(me.body.businesses).toHaveLength(1);
  });

  it('rejects weak or duplicate registrations and bad logins', async () => {
    const c = client();
    expect((await c.post('/api/auth/register', { email: 'weak@test.sbm', password: 'short', displayName: 'Weak' })).status).toBe(400);
    expect((await c.post('/api/auth/register', { email: 'dup@test.sbm', password: 'password123', displayName: 'Dup', businessName: 'Dup Store' })).status).toBe(200);
    const dup = await c.post('/api/auth/register', { email: 'dup@test.sbm', password: 'password123', displayName: 'Dup2' });
    expect(dup.status).toBe(409);

    const wrong = await c.post('/api/auth/login', { email: 'dup@test.sbm', password: 'nope-nope-1' });
    expect(wrong.status).toBe(401);
    const unknown = await c.post('/api/auth/login', { email: 'ghost@test.sbm', password: 'password123' });
    expect(unknown.status).toBe(401);
  });

  it('requires a session for protected endpoints', async () => {
    const anon = client();
    expect((await anon.get('/api/businesses/current')).status).toBe(401);
    expect((await anon.get('/api/products')).status).toBe(401);
  });

  it('removes the session on logout', async () => {
    const c = client();
    await c.post('/api/auth/login', { email: 'owner.a@test.sbm', password: 'password123' });
    expect((await c.get('/api/auth/me')).status).toBe(200);
    await c.post('/api/auth/logout');
    expect((await c.get('/api/auth/me')).status).toBe(401);
  });
});

describe('tenant isolation', () => {
  it('never lets one business read or mutate another business', async () => {
    const a = await setupBusiness('iso.a@test.sbm');
    const b = await setupBusiness('iso.b@test.sbm');

    // A can read its own products.
    expect((await a.client.get('/api/products')).body).toHaveLength(2);
    expect((await b.client.get('/api/products')).body).toHaveLength(2);

    // B cannot address A's business by id.
    const crossRead = await b.client.get(`/api/products?businessId=${a.businessId}`);
    expect(crossRead.status).toBe(403);

    // Nor can B write into A's business.
    const crossWrite = await b.client.post(`/api/inventory/adjust?businessId=${a.businessId}`, {
      itemId: a.productId,
      direction: 'IN',
      quantity: '5',
      unit: 'kg',
      reason: 'cross-tenant attempt',
    });
    expect(crossWrite.status).toBe(403);

    // And A's own stock is untouched.
    const stock = await a.client.get('/api/inventory');
    const rice = (stock.body as { itemId: string; onHand: string }[]).find((row) => row.itemId === a.productId);
    expect(rice?.onHand).toBe('0');
  });
});

describe('partner invitations', () => {
  it('lets an owner invite a partner who joins the same workspace with a different role', async () => {
    const owner = await setupBusiness('invite.owner@test.sbm');
    const invite = await owner.client.post('/api/members/invites', { role: 'manager', email: 'invite.partner@test.sbm' });
    expect(invite.status).toBe(200);
    expect(invite.body.code).toMatch(/^[A-Z2-9]{4}(-[A-Z2-9]{4})+$/);

    const partner = client();
    await partner.post('/api/auth/register', { email: 'invite.partner@test.sbm', password: 'password123', displayName: 'Partner One' });
    const accepted = await partner.post('/api/invites/accept', { code: invite.body.code });
    expect(accepted.status).toBe(200);
    expect(accepted.body.businessId).toBe(owner.businessId);
    expect(accepted.body.role).toBe('manager');

    const members = await owner.client.get('/api/members');
    expect(members.body).toHaveLength(2);

    // The same code cannot be reused.
    const second = client();
    await second.post('/api/auth/register', { email: 'late.partner@test.sbm', password: 'password123', displayName: 'Late' });
    expect((await second.post('/api/invites/accept', { code: invite.body.code })).status).toBe(400);
  });

  it('rejects a revoked invite and an unknown code', async () => {
    const owner = await setupBusiness('revoke.owner@test.sbm');
    const invite = await owner.client.post('/api/members/invites', { role: 'viewer' });
    await owner.client.del(`/api/members/invites/${invite.body.invite.id}`);

    const joiner = client();
    await joiner.post('/api/auth/register', { email: 'revoke.joiner@test.sbm', password: 'password123', displayName: 'Joiner' });
    expect((await joiner.post('/api/invites/accept', { code: invite.body.code })).status).toBe(400);
    expect((await joiner.post('/api/invites/accept', { code: 'ZZZZ-ZZZZ-ZZZZ-ZZZZ' })).body.error.code).toBe('INVALID_INVITE');
  });

  it('blocks demoting or removing the only owner', async () => {
    const owner = await setupBusiness('lastowner@test.sbm');
    const members = await owner.client.get('/api/members');
    const ownerMemberId = (members.body as { id: string; role: string }[]).find((m) => m.role === 'owner')?.id as string;

    expect((await owner.client.patch(`/api/members/${ownerMemberId}`, { role: 'viewer' })).status).toBe(409);
    expect((await owner.client.patch(`/api/members/${ownerMemberId}`, { status: 'removed' })).status).toBe(400);
  });
});

describe('role permissions', () => {
  it('enforces least privilege server-side, not just in the UI', async () => {
    const owner = await setupBusiness('perm.owner@test.sbm');
    const invite = await owner.client.post('/api/members/invites', { role: 'cashier', email: 'perm.cashier@test.sbm' });
    const cashier = client();
    await cashier.post('/api/auth/register', { email: 'perm.cashier@test.sbm', password: 'password123', displayName: 'Cashier' });
    await cashier.post('/api/invites/accept', { code: invite.body.code });

    // Stock must exist before anyone can sell it.
    await owner.client.post('/api/purchases', { documentDate: '2026-05-01', paid: '5800', lines: [{ productId: owner.productId, quantity: '100', unit: 'kg', unitCost: '58' }] });

    // A cashier may sell...
    const sale = await cashier.post('/api/sales', {
      documentDate: '2026-05-01',
      cashReceived: '100',
      lines: [{ productId: owner.productId, quantity: '2', unit: 'kg', unitPrice: '68' }],
    });
    expect(sale.status).toBe(200);

    // ...but not purchase, not adjust stock, and must not see cost data.
    expect((await cashier.post('/api/purchases', { documentDate: '2026-05-01', paid: '0', lines: [{ productId: owner.productId, quantity: '1', unit: 'kg', unitCost: '1' }] })).status).toBe(403);
    expect((await cashier.post('/api/inventory/adjust', { itemId: owner.productId, direction: 'IN', quantity: '1', unit: 'kg', reason: 'nope' })).status).toBe(403);
    expect((await cashier.get('/api/reports/profit-loss')).status).toBe(403);
    const products = await cashier.get('/api/products');
    expect(products.body.every((p: Record<string, unknown>) => !('purchasePrice' in p))).toBe(true);

    // A cashier also cannot invite members.
    expect((await cashier.post('/api/members/invites', { role: 'viewer' })).status).toBe(403);
  });

  it('lets the owner widen partner visibility with a setting', async () => {
    const owner = await setupBusiness('vis.owner@test.sbm');
    const invite = await owner.client.post('/api/members/invites', { role: 'manager', email: 'vis.manager@test.sbm' });
    const manager = client();
    await manager.post('/api/auth/register', { email: 'vis.manager@test.sbm', password: 'password123', displayName: 'Manager' });
    await manager.post('/api/invites/accept', { code: invite.body.code });

    expect((await manager.get('/api/reports/profit-loss')).status).toBe(403);
    const updated = await owner.client.put('/api/businesses/settings', { partnerCanSeeFinancialReports: true, partnerCanSeeCosts: true });
    expect(updated.status).toBe(200);
    expect((await manager.get('/api/reports/profit-loss')).status).toBe(200);
  });
});

describe('commerce and accounting', () => {
  it('records purchase, sale, receipt and expense with correct double entry', async () => {
    const w = await setupBusiness('books@test.sbm');
    const purchase = await w.client.post('/api/purchases', {
      documentDate: '2026-04-02',
      supplierId: w.supplierId,
      paid: '2000',
      accountCode: '1010',
      lines: [{ productId: w.productId, quantity: '100', unit: 'kg', unitCost: '58' }],
    });
    expect(purchase.status).toBe(200);
    expect(purchase.body.total).toBe('5800.00');
    expect(purchase.body.payable).toBe('3800.00');

    const sale = await w.client.post('/api/sales', {
      documentDate: '2026-04-05',
      customerId: w.customerId,
      cashReceived: '3000',
      accountCode: '1010',
      lines: [{ productId: w.productId, quantity: '50', unit: 'kg', unitPrice: '68', discount: '100' }],
    });
    expect(sale.status).toBe(200);
    // 50*68 = 3400 gross, 100 discount, 3300 net, 3000 cash, 300 receivable
    expect(sale.body.gross).toBe('3400.00');
    expect(sale.body.net).toBe('3300.00');
    expect(sale.body.receivable).toBe('300.00');
    // COGS uses the weighted average purchase cost (58)
    expect(sale.body.cogs).toBe('2900.00');

    const stock = await w.client.get('/api/inventory');
    const rice = (stock.body as { itemId: string; onHand: string }[]).find((row) => row.itemId === w.productId);
    expect(rice?.onHand).toBe('50');

    const receipt = await w.client.post('/api/receipts', { documentDate: '2026-04-06', customerId: w.customerId, amount: '300', accountCode: '1010' });
    expect(receipt.status).toBe(200);
    expect(receipt.body.receivableRemaining).toBe('0.00');

    await w.client.post('/api/income-expenses', { kind: 'EXPENSE', categoryAccount: '5170', documentDate: '2026-04-07', amount: '1000', note: 'Rent' });

    // The books must tie out.
    const trial = await w.client.get('/api/reports/trial-balance?from=2026-04-01&to=2026-04-30');
    expect(trial.body.balanced).toBe(true);
    expect(trial.body.totalDebit).toBe(trial.body.totalCredit);

    const pnl = await w.client.get('/api/reports/profit-loss?from=2026-04-01&to=2026-04-30');
    expect(pnl.body.netRevenue).toBe('3300.00'); // 3400 gross - 100 discount
    expect(pnl.body.costOfGoodsSold).toBe('2900.00');
    expect(pnl.body.netProfit).toBe('-600.00'); // 400 gross profit - 1000 rent

    const sheet = await w.client.get('/api/reports/balance-sheet?asOf=2026-04-30');
    expect(sheet.body.balanced).toBe(true);

    const dashboard = await w.client.get('/api/reports/dashboard?from=2026-04-01&to=2026-04-30');
    expect(dashboard.body.receivables).toBe('0.00');
    expect(dashboard.body.payables).toBe('3800.00');
    expect(dashboard.body.lowStockItems).toBe(0);
  });

  it('refuses negative stock by default, even for the owner', async () => {
    const w = await setupBusiness('negstock@test.sbm');
    const sale = await w.client.post('/api/sales', {
      documentDate: '2026-04-05',
      cashReceived: '0',
      lines: [{ productId: w.productId, quantity: '10', unit: 'kg', unitPrice: '68' }],
    });
    expect(sale.status).toBe(409);
    expect(sale.body.error.code).toBe('STOCK_CONFLICT');

    // An override needs an explicit request, the approval permission and a reason.
    const anonymousOverride = await w.client.post('/api/sales', {
      documentDate: '2026-04-05',
      cashReceived: '0',
      allowNegative: true,
      lines: [{ productId: w.productId, quantity: '10', unit: 'kg', unitPrice: '68' }],
    });
    expect(anonymousOverride.status).toBe(400);

    const override = await w.client.post('/api/sales', {
      documentDate: '2026-04-05',
      cashReceived: '0',
      allowNegative: true,
      negativeReason: 'Physical count pending; goods already handed to the customer',
      lines: [{ productId: w.productId, quantity: '10', unit: 'kg', unitPrice: '68' }],
    });
    expect(override.status).toBe(200);
    expect(override.body.net).toBe('680.00');
  });

  it('rejects a discount without the discount permission', async () => {
    const owner = await setupBusiness('disc.owner@test.sbm');
    const invite = await owner.client.post('/api/members/invites', { role: 'cashier', email: 'disc.cashier@test.sbm' });
    const cashier = client();
    await cashier.post('/api/auth/register', { email: 'disc.cashier@test.sbm', password: 'password123', displayName: 'Cashier' });
    await cashier.post('/api/invites/accept', { code: invite.body.code });
    await owner.client.post('/api/purchases', { documentDate: '2026-04-02', paid: '5800', lines: [{ productId: owner.productId, quantity: '100', unit: 'kg', unitCost: '58' }] });

    const discounted = await cashier.post('/api/sales', {
      documentDate: '2026-04-05',
      cashReceived: '0',
      discount: '100',
      lines: [{ productId: owner.productId, quantity: '1', unit: 'kg', unitPrice: '68' }],
    });
    expect(discounted.status).toBe(403);
  });

  it('treats partner capital as equity, not revenue', async () => {
    const w = await setupBusiness('capital@test.sbm');
    const members = await w.client.get('/api/members');
    const memberId = (members.body as { id: string }[])[0]?.id as string;
    const contribution = await w.client.post('/api/partner-capital', { memberId, kind: 'CONTRIBUTION', documentDate: '2026-04-01', amount: '50000', accountCode: '1010' });
    expect(contribution.status).toBe(200);

    const pnl = await w.client.get('/api/reports/profit-loss?from=2026-04-01&to=2026-04-30');
    expect(pnl.body.netRevenue).toBe('0.00');
    expect(pnl.body.netProfit).toBe('0.00');

    const sheet = await w.client.get('/api/reports/balance-sheet?asOf=2026-04-30');
    expect(sheet.body.totalEquity).toBe('50000.00');
    expect(sheet.body.balanced).toBe(true);
  });
});

describe('farming workflow', () => {
  it('runs input purchase → issue → labour → harvest → sale with correct costing', async () => {
    const w = await setupBusiness('farm@test.sbm');
    const farm = await w.client.post('/api/farming/farms', { name: 'Poultry Farm', area: '10', areaUnit: 'decimal' });
    const unit = await w.client.post('/api/farming/units', { farmId: farm.body.id, kind: 'POULTRY_HOUSE', name: 'Shed 1', capacity: '1000', capacityUnit: 'pcs' });
    const chicken = await w.client.post('/api/products', { name: 'Live Chicken', unit: 'kg', kind: 'OUTPUT', salePrice: '175' });
    const cycle = await w.client.post('/api/farming/cycles', {
      farmId: farm.body.id,
      unitId: unit.body.id,
      farmingType: 'POULTRY',
      title: 'Batch 1',
      startDate: '2026-04-01',
      plannedOutput: '1000',
      plannedOutputUnit: 'kg',
      startingPopulation: '1000',
    });
    expect(cycle.status).toBe(200);

    // Buy feed into stock (an asset, not yet a batch cost).
    await w.client.post('/api/purchases', {
      documentDate: '2026-04-01',
      paid: '20000',
      lines: [{ productId: w.inputId, quantity: '200', unit: 'kg', unitCost: '60' }],
    });

    const issue = await w.client.post(`/api/farming/cycles/${cycle.body.id}/events`, { eventType: 'INPUT_ISSUE', occurredOn: '2026-04-05', productId: w.inputId, quantity: '100', unit: 'kg' });
    expect(issue.status).toBe(200);
    expect(issue.body.cost).toBe('6000.00');

    // Issuing must not double count: the input stock went down by 100, cost added once.
    const stock = await w.client.get('/api/inventory');
    expect((stock.body as { itemId: string; onHand: string }[]).find((row) => row.itemId === w.inputId)?.onHand).toBe('100');

    await w.client.post(`/api/farming/cycles/${cycle.body.id}/events`, { eventType: 'DIRECT_LABOUR', occurredOn: '2026-04-10', amount: '3000' });
    await w.client.post(`/api/farming/cycles/${cycle.body.id}/events`, { eventType: 'MORTALITY', occurredOn: '2026-04-12', quantity: '30', unit: 'pcs', reason: 'Sudden mortality after heat wave' });

    const harvest = await w.client.post(`/api/farming/cycles/${cycle.body.id}/harvest`, { occurredOn: '2026-04-25', quantity: '500', unit: 'kg', productId: chicken.body.id, method: 'PLANNED_YIELD_PRORATA' });
    expect(harvest.status).toBe(200);
    // Cost to date 9000 over a planned 1000 kg => 9.00/kg for 500 kg
    expect(harvest.body.costBasis).toBe('4500.00');
    expect(harvest.body.capped).toBe(false);
    expect(Number(harvest.body.remainingCostInBatch)).toBeCloseTo(4500, 2);

    const sale = await w.client.post('/api/sales', {
      documentDate: '2026-04-26',
      cashReceived: '87500',
      lines: [{ productId: chicken.body.id, quantity: '500', unit: 'kg', unitPrice: '175' }],
    });
    expect(sale.status).toBe(200);
    expect(sale.body.cogs).toBe('4500.00');

    const profit = await w.client.get(`/api/farming/cycles/${cycle.body.id}/profit`);
    expect(profit.body.revenue).toBe('87500.00');
    expect(profit.body.cogs).toBe('4500.00');
    expect(profit.body.grossProfit).toBe('83000.00');
    expect(profit.body.costRemainingInBatch).toBe('4500.00');
  });

  it('splits a shared cost across cycles without losing a poysha', async () => {
    const w = await setupBusiness('shared@test.sbm');
    const farm = await w.client.post('/api/farming/farms', { name: 'Farm' });
    const unit = await w.client.post('/api/farming/units', { farmId: farm.body.id, kind: 'PLOT', name: 'Plot A' });
    const first = await w.client.post('/api/farming/cycles', { farmId: farm.body.id, unitId: unit.body.id, farmingType: 'CROP', title: 'Boro', startDate: '2026-04-01' });
    const second = await w.client.post('/api/farming/cycles', { farmId: farm.body.id, unitId: unit.body.id, farmingType: 'CROP', title: 'Aman', startDate: '2026-04-01' });

    const allocation = await w.client.post('/api/farming/allocations', {
      amount: '1000',
      basis: 'AREA',
      incurredOn: '2026-04-15',
      note: 'Irrigation pump shared between both plots',
      targets: [
        { cycleId: first.body.id, basisValue: '10' },
        { cycleId: second.body.id, basisValue: '20' },
      ],
    });
    expect(allocation.status).toBe(200);
    expect(allocation.body.allocatedTotal).toBe('1000.00');
    expect(allocation.body.unallocated).toBe('0.00');
    const byCycle = new Map((allocation.body.shares as { cycleId: string; amount: string }[]).map((share) => [share.cycleId, Number(share.amount)]));
    // 10 : 20 area share => one third / two thirds
    expect(byCycle.get(first.body.id)).toBeCloseTo(333.33, 2);
    expect(byCycle.get(second.body.id)).toBeCloseTo(666.67, 2);
    expect([...byCycle.values()].reduce((a, b) => a + b, 0)).toBeCloseTo(1000, 6);
  });

  it('flags a large mortality event for escalation', async () => {
    const w = await setupBusiness('mortality@test.sbm');
    const farm = await w.client.post('/api/farming/farms', { name: 'Farm' });
    const unit = await w.client.post('/api/farming/units', { farmId: farm.body.id, kind: 'BARN', name: 'Barn 1' });
    const cycle = await w.client.post('/api/farming/cycles', { farmId: farm.body.id, unitId: unit.body.id, farmingType: 'LIVESTOCK', title: 'Cattle', startDate: '2026-04-01', startingPopulation: '40' });
    const event = await w.client.post(`/api/farming/cycles/${cycle.body.id}/events`, { eventType: 'MORTALITY', occurredOn: '2026-04-09', quantity: '30', unit: 'pcs', reason: 'Sudden deaths overnight' });
    expect(event.body.abnormal).toBe(true);
    expect(String(event.body.escalation)).toMatch(/veterinar/i);
  });
});

describe('offline sync', () => {
  it('applies an outbox event exactly once, even when retried', async () => {
    const w = await setupBusiness('sync@test.sbm');
    await w.client.post('/api/purchases', { documentDate: '2026-04-01', paid: '5800', lines: [{ productId: w.productId, quantity: '100', unit: 'kg', unitCost: '58' }] });

    const event = {
      id: 'local-1',
      eventId: '11111111-1111-4111-8111-111111111111',
      idempotencyKey: 'biz:sale:11111111-1111-4111-8111-111111111111',
      businessId: w.businessId,
      actorId: 'device-user',
      deviceId: 'device-a',
      aggregateType: 'sale',
      aggregateId: 'sale-local-1',
      eventType: 'sale.post',
      schemaVersion: 1,
      occurredAt: '2026-04-10T10:00:00.000Z',
      createdAt: '2026-04-10T10:00:00.000Z',
      baseRevision: null,
      payloadHash: 'hash-1',
      status: 'PENDING',
      risk: 'HIGH',
      attempts: 0,
      payload: { documentDate: '2026-04-10', cashReceived: '3400', lines: [{ productId: w.productId, quantity: '50', unit: 'kg', unitPrice: '68' }] },
    };

    const first = await w.client.post('/api/sync/push', { events: [event] });
    expect(first.body.results[0].status).toBe('SYNCED');

    // Retry the exact same event: it must NOT create a second sale or stock movement.
    const retry = await w.client.post('/api/sync/push', { events: [event] });
    expect(retry.body.results[0].status).toBe('SYNCED');
    expect(String(retry.body.results[0].message)).toMatch(/idempotent/i);

    const stock = await w.client.get('/api/inventory');
    expect((stock.body as { itemId: string; onHand: string }[]).find((row) => row.itemId === w.productId)?.onHand).toBe('50');

    const sales = await w.client.get('/api/sales');
    expect(sales.body).toHaveLength(1);
  });

  it('refuses to apply access changes from an offline queue', async () => {
    const w = await setupBusiness('syncguard@test.sbm');
    const event = {
      id: 'local-2', eventId: '22222222-2222-4222-8222-222222222222', idempotencyKey: 'k-2', businessId: w.businessId, actorId: 'u', deviceId: 'd',
      aggregateType: 'member', aggregateId: 'm1', eventType: 'member.role_change', schemaVersion: 1,
      occurredAt: '2026-04-10T10:00:00.000Z', createdAt: '2026-04-10T10:00:00.000Z', baseRevision: null, payloadHash: 'h', status: 'PENDING', risk: 'HIGH', attempts: 0,
      payload: { role: 'owner' },
    };
    const result = await w.client.post('/api/sync/push', { events: [event] });
    expect(result.body.results[0].status).toBe('NEEDS_ATTENTION');
  });

  it('reports a conflict when a partner edits a record that changed on the server', async () => {
    const w = await setupBusiness('conflict@test.sbm');
    await w.client.patch(`/api/products/${w.productId}`, { name: 'Rice (renamed)' });
    const event = {
      id: 'local-3', eventId: '33333333-3333-4333-8333-333333333333', idempotencyKey: 'k-3', businessId: w.businessId, actorId: 'u', deviceId: 'd',
      aggregateType: 'product', aggregateId: w.productId, eventType: 'product.upsert', schemaVersion: 1,
      occurredAt: '2026-04-10T10:00:00.000Z', createdAt: '2026-04-10T10:00:00.000Z', baseRevision: 1, payloadHash: 'h', status: 'PENDING', risk: 'LOW', attempts: 0,
      payload: { id: w.productId, name: 'Rice (stale edit)' },
    };
    const result = await w.client.post('/api/sync/push', { events: [event] });
    expect(result.body.results[0].status).toBe('CONFLICT');

    const conflicts = await w.client.get('/api/sync/conflicts');
    expect(conflicts.body).toHaveLength(1);
    await w.client.post(`/api/sync/conflicts/${conflicts.body[0].id}/resolve`, { resolution: 'SERVER_WINS' });
    expect((await w.client.get('/api/sync/conflicts')).body[0].status).toBe('SERVER_WINS');
  });

  it('pulls only the caller own business changes', async () => {
    const a = await setupBusiness('pull.a@test.sbm');
    const b = await setupBusiness('pull.b@test.sbm');
    await a.client.post('/api/products', { name: 'Only in A', unit: 'kg' });

    const pulled = await a.client.get('/api/sync/pull?since=1970-01-01T00:00:00.000Z');
    expect((pulled.body.products as { name: string }[]).some((p) => p.name === 'Only in A')).toBe(true);
    expect(pulled.body.business.id).toBe(a.businessId);
    expect(pulled.body.business.id).not.toBe(b.businessId);

    const bPulled = await b.client.get('/api/sync/pull?since=1970-01-01T00:00:00.000Z');
    expect((bPulled.body.products as { name: string }[]).some((p) => p.name === 'Only in A')).toBe(false);
  });
});

describe('AI agent', () => {
  it('answers in offline fallback mode and says so', async () => {
    const w = await setupBusiness('ai@test.sbm');
    const ask = await w.client.post('/api/ai/ask', { question: 'How is my business doing this month?', language: 'en' });
    expect(ask.status).toBe(200);
    expect(ask.body.mode).toBe('fallback');
    expect(ask.body.text).toMatch(/offline rule-based mode/i);
    expect(ask.body.limitations.length).toBeGreaterThan(0);
    expect(String(ask.body.text)).toMatch(/review and confirm/i);
  });

  it('returns curated official links (clearly labelled) for a pesticide question', async () => {
    const w = await setupBusiness('aipest@test.sbm');
    const ask = await w.client.post('/api/ai/ask', { question: 'Which pesticide dose should I use for rice stem borer?', language: 'en' });
    expect(ask.status).toBe(200);
    const citations = ask.body.citations as { url: string; kind: string; note?: string }[];
    expect(citations.length).toBeGreaterThan(0);
    expect(citations.some((c) => c.url.includes('dae.gov.bd'))).toBe(true);
    expect(citations.every((c) => c.kind === 'CURATED_LINK')).toBe(true);
    expect(ask.body.limitations.join(' ')).toMatch(/curated official source links|not live search results|no live search provider/i);
  });

  it('never leaks restricted cost data to a role that cannot see it', async () => {
    const owner = await setupBusiness('airestrict@test.sbm');
    await owner.client.post('/api/income-expenses', { kind: 'EXPENSE', categoryAccount: '5170', documentDate: '2026-04-03', amount: '9999', note: 'Secret rent' });
    const invite = await owner.client.post('/api/members/invites', { role: 'cashier', email: 'ai.cashier@test.sbm' });
    const cashier = client();
    await cashier.post('/api/auth/register', { email: 'ai.cashier@test.sbm', password: 'password123', displayName: 'Cashier' });
    await cashier.post('/api/invites/accept', { code: invite.body.code });

    const ask = await cashier.post('/api/ai/ask', { question: 'What is my profit this month?', language: 'en' });
    expect(ask.status).toBe(200);
    expect(ask.body.factsUsed.join(' ')).toMatch(/restricted/i);
    expect(JSON.stringify(ask.body.factsUsed)).not.toContain('9999');
  });

  it('stores conversations, supports deletion, and caches research', async () => {
    const w = await setupBusiness('aichat@test.sbm');
    await w.client.post('/api/ai/ask', { question: 'Explain how receivables work', language: 'en' });
    const conversations = await w.client.get('/api/ai/conversations');
    expect(conversations.body.length).toBeGreaterThan(0);
    const conversationId = conversations.body[0].id;
    const detail = await w.client.get(`/api/ai/conversations/${conversationId}`);
    expect(detail.body.messages.length).toBe(2);
    await w.client.del(`/api/ai/conversations/${conversationId}`);
    expect((await w.client.get('/api/ai/conversations')).body).toHaveLength(0);

    const research = await w.client.post('/api/ai/research', { query: 'urea fertilizer application for boro rice' });
    expect(research.status).toBe(200);
    const second = await w.client.post('/api/ai/research', { query: 'urea fertilizer application for boro rice' });
    expect(second.body.cached).toBe(true);
  });

  it('rejects AI use for a role without the permission', async () => {
    const owner = await setupBusiness('ainoperm@test.sbm');
    const invite = await owner.client.post('/api/members/invites', { role: 'viewer', email: 'ai.viewer@test.sbm' });
    expect(invite.status).toBe(200);
    const viewer = client();
    await viewer.post('/api/auth/register', { email: 'ai.viewer@test.sbm', password: 'password123', displayName: 'Viewer' });
    const joined = await viewer.post('/api/invites/accept', { code: invite.body.code });
    expect(joined.status).toBe(200);

    const members = (await owner.client.get('/api/members')).body as { id: string; role: string }[];
    const viewerMember = members.find((member) => member.role === 'viewer');
    expect(viewerMember).toBeTruthy();
    const patched = await owner.client.patch(`/api/members/${viewerMember?.id}`, { denials: ['ai.use'] });
    expect(patched.status).toBe(200);

    expect((await viewer.post('/api/ai/ask', { question: 'help me plan my season' })).status).toBe(403);
  });
});

describe('exports and backup', () => {
  it('exports CSV and a full JSON backup for permitted roles', async () => {
    const w = await setupBusiness('export@test.sbm');
    await w.client.post('/api/purchases', { documentDate: '2026-04-01', paid: '5800', lines: [{ productId: w.productId, quantity: '100', unit: 'kg', unitCost: '58' }] });
    await w.client.post('/api/sales', { documentDate: '2026-04-05', cashReceived: '680', lines: [{ productId: w.productId, quantity: '10', unit: 'kg', unitPrice: '68' }] });

    const csv = await w.client.request('GET', '/api/reports/export/sales', undefined, { raw: true });
    expect(String(csv.body)).toContain('reference');
    expect(csv.status).toBe(200);
    expect(String(csv.body)).toContain('reference');
    expect(String(csv.body)).toContain('SAL-');

    const backup = await w.client.get('/api/reports/backup');
    expect(backup.status).toBe(200);
    expect(backup.body.format).toBe('sbm-backup-v1');
    expect((backup.body.tables.products as unknown[]).length).toBe(2);
    expect(backup.body.tables.journal_lines.length).toBeGreaterThan(0);

    const unknown = await w.client.get('/api/reports/export/secrets');
    expect(unknown.status).toBe(400);
  });

  it('audits sensitive actions', async () => {
    const w = await setupBusiness('audit@test.sbm');
    const audit = await w.client.get('/api/audit');
    const actions = (audit.body as { action: string }[]).map((row) => row.action);
    expect(actions).toContain('business.create');
    expect(actions).toContain('product.create');
  });
});

describe('validation and limits', () => {
  it('rejects malformed input instead of storing it', async () => {
    const w = await setupBusiness('valid@test.sbm');
    expect((await w.client.post('/api/sales', { documentDate: 'nope', lines: [] })).status).toBe(400);
    expect((await w.client.post('/api/sales', { documentDate: '2026-04-01', lines: [{ productId: w.productId, quantity: '0', unit: 'kg', unitPrice: '1' }] })).status).toBe(400);
    expect((await w.client.post('/api/products', { name: 'Bad unit', unit: 'zzz' })).status).toBe(400);
    expect((await w.client.post('/api/income-expenses', { kind: 'EXPENSE', categoryAccount: '4000', documentDate: '2026-04-01', amount: '5' })).status).toBe(400);
    expect((await w.client.get('/api/reports/dashboard?from=2026-05-01&to=2026-04-01')).status).toBe(400);
  });

  it('rate limits repeated login failures', async () => {
    const c = client();
    let sawLimit = false;
    for (let i = 0; i < 30; i += 1) {
      const result = await c.post('/api/auth/login', { email: 'ratelimit@test.sbm', password: `wrong-${i}-aaaa` });
      if (result.status === 429) {
        sawLimit = true;
        break;
      }
    }
    expect(sawLimit).toBe(true);
  });
});
