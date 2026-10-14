import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, type App } from '../src/server.js';

/**
 * Security-focused suite: invite scoping/expiry, session handling, multi-business
 * switching, attachment isolation, explicit unit conversions and audit coverage.
 */

let app: App;
let baseUrl = '';

class Client {
  cookie = '';
  async request<T = any>(method: string, path: string, body?: unknown, init: { raw?: BodyInit; contentType?: string } = {}): Promise<{ status: number; body: T }> {
    const headers: Record<string, string> = {};
    if (this.cookie) headers.cookie = this.cookie;
    let payload: BodyInit | undefined;
    if (init.raw !== undefined) {
      payload = init.raw;
      if (init.contentType) headers['content-type'] = init.contentType;
    } else if (body !== undefined) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const response = await fetch(`${baseUrl}${path}`, { method, headers, ...(payload !== undefined ? { body: payload } : {}) });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) this.cookie = setCookie.split(';')[0] as string;
    const text = await response.text();
    try {
      return { status: response.status, body: JSON.parse(text) as T };
    } catch {
      return { status: response.status, body: text as unknown as T };
    }
  }
  get = <T = any>(p: string) => this.request<T>('GET', p);
  post = <T = any>(p: string, b?: unknown) => this.request<T>('POST', p, b);
  put = <T = any>(p: string, b?: unknown) => this.request<T>('PUT', p, b);
  patch = <T = any>(p: string, b?: unknown) => this.request<T>('PATCH', p, b);
  del = <T = any>(p: string) => this.request<T>('DELETE', p);
  upload = (p: string, data: Uint8Array, contentType: string) => this.request('POST', p, undefined, { raw: data as unknown as BodyInit, contentType });
}

function client(): Client {
  return new Client();
}

async function registerOwner(email: string, businessName: string) {
  const c = client();
  const result = await c.post<{ businessId: string }>('/api/auth/register', { email, password: 'password123', displayName: email.split('@')[0], businessName });
  expect(result.status).toBe(200);
  return { client: c, businessId: result.body.businessId };
}

beforeAll(async () => {
  app = createApp({
    port: 0,
    host: '127.0.0.1',
    databaseFile: ':memory:',
    sessionSecret: 'security-suite-secret-security-suite-1234',
    secureCookies: false,
    mode: 'local',
    rateLimits: { registerPerHour: 10_000, loginPer15Min: 10_000, invitePerHour: 10_000 },
  });
  const { port } = await app.start();
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await app.stop();
});

describe('invite security', () => {
  it('rejects an invite that has expired', async () => {
    const owner = await registerOwner('sec.expire@test.sbm', 'Expire Shop');
    const invite = await owner.client.post<{ code: string; invite: { id: string } }>('/api/members/invites', { role: 'manager' });
    // Force the invite into the past, exactly as time would.
    app.db.run('UPDATE invites SET expires_at = ? WHERE id = ?', ['2000-01-01T00:00:00.000Z', invite.body.invite.id]);

    const joiner = client();
    await joiner.post('/api/auth/register', { email: 'sec.expired.joiner@test.sbm', password: 'password123', displayName: 'Late' });
    const result = await joiner.post<{ error: { code: string; message: string } }>('/api/invites/accept', { code: invite.body.code });
    expect(result.status).toBe(400);
    expect(result.body.error.message).toMatch(/EXPIRED/);
  });

  it('binds an email-scoped invite to that email only', async () => {
    const owner = await registerOwner('sec.scope@test.sbm', 'Scope Shop');
    const invite = await owner.client.post<{ code: string }>('/api/members/invites', { role: 'viewer', email: 'intended@test.sbm' });

    const wrong = client();
    await wrong.post('/api/auth/register', { email: 'someone.else@test.sbm', password: 'password123', displayName: 'Wrong' });
    const rejected = await wrong.post<{ error: { message: string } }>('/api/invites/accept', { code: invite.body.code });
    expect(rejected.status).toBe(400);
    expect(rejected.body.error.message).toMatch(/EMAIL_MISMATCH/);

    const intended = client();
    await intended.post('/api/auth/register', { email: 'intended@test.sbm', password: 'password123', displayName: 'Intended' });
    expect((await intended.post('/api/invites/accept', { code: invite.body.code })).status).toBe(200);
  });

  it('records the code only as a hash', async () => {
    const owner = await registerOwner('sec.hash@test.sbm', 'Hash Shop');
    const invite = await owner.client.post<{ code: string }>('/api/members/invites', { role: 'viewer' });
    expect(invite.status).toBe(200);
    const row = app.db.get<{ code_hash: string; code_prefix: string }>('SELECT code_hash, code_prefix FROM invites ORDER BY created_at DESC LIMIT 1');
    expect(row?.code_hash).toHaveLength(64);
    expect(row?.code_hash).not.toContain(invite.body.code.replace(/-/g, ''));
  });
});

describe('session and business selection', () => {
  it('rejects a tampered session cookie', async () => {
    const owner = await registerOwner('sec.cookie@test.sbm', 'Cookie Shop');
    const original = owner.client.cookie;
    owner.client.cookie = `${original.split('.')[0]}.forgedsignature`;
    expect((await owner.client.get('/api/auth/me')).status).toBe(401);

    owner.client.cookie = original;
    expect((await owner.client.get('/api/auth/me')).status).toBe(200);
  });

  it('drops an expired session server-side', async () => {
    const owner = await registerOwner('sec.session@test.sbm', 'Session Shop');
    const sessionId = (owner.client.cookie.split('=')[1] ?? '').split('.')[0] as string;
    expect(sessionId).toMatch(/^[0-9a-f-]{36}$/i);
    app.db.run('UPDATE sessions SET expires_at = ? WHERE id = ?', ['2000-01-01T00:00:00.000Z', sessionId]);
    expect((await owner.client.get('/api/auth/me')).status).toBe(401);
    // The expired row is cleaned up rather than left behind.
    expect(app.db.get('SELECT id FROM sessions WHERE id = ?', [sessionId])).toBeUndefined();
  });

  it('lets one partner belong to two businesses and keeps their data apart', async () => {
    const first = await registerOwner('sec.multi@test.sbm', 'First Shop');
    await first.client.post('/api/products', { name: 'Only in first', unit: 'kg' });

    const second = await first.client.post<{ id: string }>('/api/businesses', { name: 'Second Shop' });
    expect(second.status).toBe(200);

    // Creating a business switches the active workspace, so the new products
    // list must not contain the first business's catalogue.
    const current = await first.client.get<{ id: string }>('/api/businesses/current');
    expect(current.body.id).toBe(second.body.id);
    const secondProducts = await first.client.get<{ name: string }[]>('/api/products');
    expect(secondProducts.body.some((p) => p.name === 'Only in first')).toBe(false);

    // Switching back shows the original catalogue.
    expect((await first.client.post('/api/businesses/switch', { businessId: first.businessId })).status).toBe(200);
    const firstProducts = await first.client.get<{ name: string }[]>('/api/products');
    expect(firstProducts.body.some((p) => p.name === 'Only in first')).toBe(true);

    const mine = await first.client.get<{ businesses: { businessId: string }[] }>('/api/auth/me');
    expect(mine.body.businesses).toHaveLength(2);

    // And the caller cannot switch into a business they are not a member of.
    const stranger = await registerOwner('sec.stranger@test.sbm', 'Stranger Shop');
    expect((await stranger.client.post('/api/businesses/switch', { businessId: first.businessId })).status).toBe(403);
  });

  it('rejects a member who has been suspended', async () => {
    const owner = await registerOwner('sec.suspend@test.sbm', 'Suspend Shop');
    const invite = await owner.client.post<{ code: string }>('/api/members/invites', { role: 'manager', email: 'suspended@test.sbm' });
    const member = client();
    await member.post('/api/auth/register', { email: 'suspended@test.sbm', password: 'password123', displayName: 'Soon Suspended' });
    await member.post('/api/invites/accept', { code: invite.body.code });
    expect((await member.get('/api/products')).status).toBe(200);

    const members = await owner.client.get<{ id: string; email: string }[]>('/api/members');
    const target = members.body.find((m) => m.email === 'suspended@test.sbm');
    expect((await owner.client.patch(`/api/members/${target?.id}`, { status: 'suspended' })).status).toBe(200);

    // Their sessions are revoked and further calls are refused.
    expect((await member.get('/api/products')).status).toBe(401);
  });
});

describe('attachments', () => {
  it('stores an upload for the owning business only, with a checksum', async () => {
    const owner = await registerOwner('sec.attach@test.sbm', 'Attach Shop');
    const product = await owner.client.post<{ id: string }>('/api/products', { name: 'Rice', unit: 'kg' });
    const bytes = new TextEncoder().encode('a tiny receipt image placeholder');
    const upload = await owner.client.upload(`/api/attachments/product/${product.body.id}?fileName=receipt%20photo.png`, bytes, 'image/png');
    expect(upload.status).toBe(200);
    expect((upload.body as { fileName: string }).fileName).toBe('receipt photo.png');
    expect((upload.body as { checksum: string }).checksum).toHaveLength(64);

    const listed = await owner.client.get<{ id: string }[]>(`/api/attachments/product/${product.body.id}`);
    expect(listed.body).toHaveLength(1);

    // Another business must not see it, even with the same entity id.
    const other = await registerOwner('sec.attach.other@test.sbm', 'Other Shop');
    const otherList = await other.client.get('/api/attachments/product/' + product.body.id); 
    expect(otherList.body).toHaveLength(0);
  });

  it('rejects an empty upload', async () => {
    const owner = await registerOwner('sec.attach2@test.sbm', 'Attach Shop 2');
    const result = await owner.client.upload('/api/attachments/product/whatever?fileName=x.bin', new Uint8Array(0), 'application/octet-stream');
    expect(result.status).toBe(400);
  });
});

describe('units and conversions in transactions', () => {
  it('serves the built-in unit catalogue and refuses an unregistered cross-dimension conversion', async () => {
    const owner = await registerOwner('sec.units@test.sbm', 'Units Shop');
    const units = await owner.client.get<{ code: string; dimension: string }[]>('/api/units');
    expect(units.body.some((u) => u.code === 'maund' && u.dimension === 'MASS')).toBe(true);
    expect(units.body.some((u) => u.code === 'katha' && u.dimension === 'AREA')).toBe(true);

    const mass = await owner.client.get<{ code: string }[]>('/api/units?dimension=MASS');
    expect(mass.body.every((u) => u.dimension === 'MASS')).toBe(true);

    // 'bag' is not a registered unit, so a product cannot be created with it.
    expect((await owner.client.post('/api/products', { name: 'Fertiliser', unit: 'bag' })).status).toBe(400);
  });

  it('accepts a documented explicit conversion and rejects one without a note', async () => {
    const owner = await registerOwner('sec.conv@test.sbm', 'Conv Shop');
    const withoutNote = await owner.client.post('/api/units/conversions', { id: 'bad', from: 'urea_bag', to: 'kg', factor: '50', note: 'no' });
    expect(withoutNote.status).toBe(400);

    const created = await owner.client.post('/api/units/conversions', { id: 'urea-bag', from: 'urea_bag', to: 'kg', factor: '50', note: 'Standard 50 kg urea bag, approved by the owner' });
    expect(created.status).toBe(200);

    // A duplicate registration is refused rather than silently overriding the factor.
    expect((await owner.client.post('/api/units/conversions', { id: 'urea-bag-2', from: 'urea_bag', to: 'kg', factor: '45', note: 'a competing definition of the same bag' })).status).toBe(409);
  });
});

describe('audit coverage', () => {
  it('records sensitive actions with actor and detail, and is read-only for members without permission', async () => {
    const owner = await registerOwner('sec.audit@test.sbm', 'Audit Shop');
    const farm = await owner.client.post<{ id: string }>('/api/farming/farms', { name: 'Farm' });
    const unit = await owner.client.post<{ id: string }>('/api/farming/units', { farmId: farm.body.id, kind: 'PLOT', name: 'Plot A' });
    const cycle = await owner.client.post<{ id: string }>('/api/farming/cycles', { farmId: farm.body.id, unitId: unit.body.id, farmingType: 'CROP', title: 'Boro', startDate: '2026-04-01' });
    const allocation = await owner.client.post('/api/farming/allocations', {
      amount: '1000',
      basis: 'AREA',
      incurredOn: '2026-04-10',
      note: 'Shared irrigation pump cost',
      targets: [{ cycleId: cycle.body.id, basisValue: '10' }],
    });
    expect(allocation.status).toBe(200);

    const audit = await owner.client.get<{ action: string; actor: string; detail: Record<string, unknown> }[]>('/api/audit');
    const actions = audit.body.map((row) => row.action);
    expect(actions).toContain('farming.allocate');
    expect(actions).toContain('farm.create');
    const allocationRow = audit.body.find((row) => row.action === 'farming.allocate');
    expect(allocationRow?.actor).toBe('sec.audit@test.sbm');
    expect(allocationRow?.detail.amount).toBe('1000.00');

    // A viewer cannot read the audit log.
    const invite = await owner.client.post<{ code: string }>('/api/members/invites', { role: 'viewer', email: 'audit.viewer@test.sbm' });
    const viewer = client();
    await viewer.post('/api/auth/register', { email: 'audit.viewer@test.sbm', password: 'password123', displayName: 'Viewer' });
    await viewer.post('/api/invites/accept', { code: invite.body.code });
    expect((await viewer.get('/api/audit')).status).toBe(403);
  });
});
