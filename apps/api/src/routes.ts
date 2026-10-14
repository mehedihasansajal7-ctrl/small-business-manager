import {
  ROLES,
  STANDARD_ACCOUNTS,
  FARMING_TYPES,
  FARM_UNIT_KINDS,
  ALLOCATION_BASES,
  addMoney,
  dec,
  formatMoney,
  money,
} from '@sbm/domain';
import type { Permission } from '@sbm/domain';
import type { AIAgent } from './ai.js';
import { SESSION_COOKIE_NAME, type AuthService, type UserRow } from './auth.js';
import type { AppConfig } from './config.js';
import type { Caller, Repository } from './repository.js';
import type { SyncService } from './sync.js';
import {
  HttpError,
  RateLimiter,
  Router,
  asRecord,
  clientIp,
  optionalString,
  parseCookies,
  readRawBody,
  requireEnum,
  requireString,
  serializeCookie,
  type RequestContext,
} from './http.js';
import { describeConfig } from './config.js';
import { renderReportHtml, type PrintSummaryItem, type PrintTable } from './print.js';

export interface RouteDeps {
  readonly repo: Repository;
  readonly auth: AuthService;
  readonly sync: SyncService;
  readonly ai: AIAgent;
  readonly config: AppConfig;
}

interface SessionContext {
  readonly user: UserRow;
  readonly sessionId: string;
  readonly businessId: string | null;
}

/** Build the full HTTP API surface. */
export function buildRouter(deps: RouteDeps): Router {
  const { repo, auth, sync, ai, config } = deps;
  const router = new Router();
  const loginLimiter = new RateLimiter(config.rateLimits.loginPer15Min, 15 * 60_000);
  const registerLimiter = new RateLimiter(config.rateLimits.registerPerHour, 60 * 60_000);
  const inviteLimiter = new RateLimiter(config.rateLimits.invitePerHour, 60 * 60_000);

  const requireSession = (ctx: RequestContext): SessionContext => {
    const cookies = parseCookies(ctx.req.headers.cookie);
    const resolved = auth.resolveSession(cookies[SESSION_COOKIE_NAME]);
    if (!resolved) throw HttpError.unauthorized();
    return { user: resolved.user, sessionId: resolved.session.id, businessId: resolved.session.business_id };
  };

  const requireCaller = (ctx: RequestContext, explicitBusinessId?: string): Caller => {
    const session = requireSession(ctx);
    const requested = explicitBusinessId ?? ctx.query.get('businessId') ?? null;
    // A caller may only ever address a business they are a member of. Passing
    // another business's id is rejected with 403 by `repo.caller`.
    const businessId = requested ?? session.businessId;
    if (!businessId) throw HttpError.badRequest('NO_BUSINESS', 'Select or create a business first');
    return repo.caller(session.user, businessId);
  };

  const setSessionCookie = (ctx: RequestContext, cookieValue: string) => {
    ctx.res.setHeader(
      'set-cookie',
      serializeCookie(SESSION_COOKIE_NAME, cookieValue, {
        maxAgeSeconds: config.sessionTtlHours * 3600,
        secure: config.secureCookies,
        httpOnly: true,
        sameSite: 'Lax',
      }),
    );
  };

  const range = (ctx: RequestContext): { from: string; to: string } => {
    const today = new Date().toISOString().slice(0, 10);
    const from = ctx.query.get('from') ?? `${today.slice(0, 7)}-01`;
    const to = ctx.query.get('to') ?? today;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      throw HttpError.badRequest('VALIDATION', 'from/to must be ISO dates (YYYY-MM-DD)');
    }
    if (from > to) throw HttpError.badRequest('VALIDATION', 'from must not be after to');
    return { from, to };
  };

  // ------------------------------------------------------------------ health

  router.get('/api/health', () => ({
    status: 'ok',
    service: 'small-business-manager-api',
    schemaVersion: repo.db.schemaVersion,
    time: new Date().toISOString(),
  }));

  router.get('/api/status', () => describeConfig(config));

  router.get('/api/meta', () => ({
    roles: ROLES,
    accounts: STANDARD_ACCOUNTS,
    farmingTypes: FARMING_TYPES,
    farmUnitKinds: FARM_UNIT_KINDS,
    allocationBases: ALLOCATION_BASES,
    routes: router.describe(),
  }));

  // -------------------------------------------------------------------- auth

  router.post('/api/auth/register', (ctx) => {
    registerLimiter.consume(clientIp(ctx.req));
    const body = asRecord(ctx.body, 'body');
    const email = requireString(body.email, 'email', { maxLength: 254 });
    const password = requireString(body.password, 'password', { maxLength: 200 });
    const displayName = requireString(body.displayName, 'displayName', { maxLength: 120 });
    const user = auth.createUser({ email, displayName, password });
    const businessName = optionalString(body.businessName, 'businessName', 120);
    let businessId: string | null = null;
    if (businessName) {
      const created = repo.createBusiness(user, { name: businessName });
      businessId = created.business.id;
    }
    const session = auth.createSession(user.id, businessId, ctx.req.headers['user-agent'] ?? null);
    setSessionCookie(ctx, session.cookieValue);
    return { user: { id: user.id, email: user.email, displayName: user.display_name }, businessId, expiresAt: session.expiresAt };
  });

  router.post('/api/auth/login', (ctx) => {
    loginLimiter.consume(`${clientIp(ctx.req)}:${String((ctx.body as Record<string, unknown> | undefined)?.email ?? '')}`);
    const body = asRecord(ctx.body, 'body');
    const email = requireString(body.email, 'email', { maxLength: 254 });
    const password = requireString(body.password, 'password', { maxLength: 200 });
    const user = auth.authenticate(email, password);
    if (!user) throw HttpError.unauthorized('Email or password is incorrect');
    const businesses = repo.listBusinessesForUser(user.id) as { businessId: string }[];
    const requested = optionalString(body.businessId, 'businessId', 64);
    const businessId = requested ?? businesses[0]?.businessId ?? null;
    if (businessId && !businesses.some((b) => b.businessId === businessId)) throw HttpError.forbidden('You do not have access to that business');
    const session = auth.createSession(user.id, businessId, ctx.req.headers['user-agent'] ?? null);
    setSessionCookie(ctx, session.cookieValue);
    repo.audit({ businessId, actorId: user.id, actorEmail: user.email, action: 'auth.login', entityType: 'user', entityId: user.id });
    return { user: { id: user.id, email: user.email, displayName: user.display_name }, businesses, businessId };
  });

  router.post('/api/auth/logout', (ctx) => {
    const session = requireSession(ctx);
    auth.destroySession(session.sessionId);
    ctx.res.setHeader('set-cookie', serializeCookie(SESSION_COOKIE_NAME, '', { maxAgeSeconds: 0, secure: config.secureCookies }));
    return { ok: true };
  });

  router.get('/api/auth/me', (ctx) => {
    const session = requireSession(ctx);
    return {
      user: { id: session.user.id, email: session.user.email, displayName: session.user.display_name, locale: session.user.locale },
      businesses: repo.listBusinessesForUser(session.user.id),
      activeBusinessId: session.businessId,
    };
  });

  // ---------------------------------------------------------------- business

  router.post('/api/businesses', (ctx) => {
    const session = requireSession(ctx);
    const body = asRecord(ctx.body, 'body');
    const created = repo.createBusiness(session.user, {
      name: requireString(body.name, 'name', { maxLength: 120 }),
      ...(optionalString(body.currency, 'currency', 8) ? { currency: String(body.currency).toUpperCase() } : {}),
      ...(optionalString(body.timezone, 'timezone', 64) ? { timezone: String(body.timezone) } : {}),
      ...(optionalString(body.locale, 'locale', 16) ? { locale: String(body.locale) } : {}),
    });
    auth.switchBusiness(session.sessionId, created.business.id);
    return { id: created.business.id, name: created.business.name, slug: created.business.slug, role: created.member.role };
  });

  router.get('/api/businesses/current', (ctx) => {
    const caller = requireCaller(ctx);
    const business = repo.getBusiness(caller.business.id);
    return {
      ...business,
      farmingTypes: JSON.parse(business.farming_types || '[]') as string[],
      enabledModules: JSON.parse(business.enabled_modules || '[]') as string[],
      settings: repo.settingsFor(caller.business.id),
      member: { id: caller.member.id, role: caller.role, displayName: caller.member.display_name, grants: JSON.parse(caller.member.grants || '[]'), denials: JSON.parse(caller.member.denials || '[]') },
      permissions: [...repo.permissions(caller)],
    };
  });

  router.patch('/api/businesses/current', (ctx) => {
    const caller = requireCaller(ctx);
    return repo.updateBusiness(caller, asRecord(ctx.body, 'body'));
  });

  router.post('/api/businesses/switch', (ctx) => {
    const session = requireSession(ctx);
    const body = asRecord(ctx.body, 'body');
    const businessId = requireString(body.businessId, 'businessId', { maxLength: 64 });
    repo.caller(session.user, businessId);
    auth.switchBusiness(session.sessionId, businessId);
    return { ok: true, businessId };
  });

  router.get('/api/businesses/settings', (ctx) => {
    const caller = requireCaller(ctx);
    return repo.settingsFor(caller.business.id);
  });

  router.put('/api/businesses/settings', (ctx) => {
    const caller = requireCaller(ctx);
    repo.assertPermission(caller, 'business.settings');
    const body = asRecord(ctx.body, 'body');
    const allowed = ['partnerCanSeeFinancialReports', 'partnerCanSeeCosts', 'partnerCanSeeCapital', 'lowStockAlerts', 'mortalityWarningPercent', 'decimalPlaces'];
    for (const key of allowed) {
      if (body[key] !== undefined) repo.setSetting(caller.business.id, key, body[key]);
    }
    repo.audit({ businessId: caller.business.id, actorId: caller.user.id, action: 'settings.update', entityType: 'business', entityId: caller.business.id, detail: body });
    return repo.settingsFor(caller.business.id);
  });

  // ----------------------------------------------------------------- members

  router.get('/api/members', (ctx) => repo.listMembers(requireCaller(ctx)));

  router.post('/api/members/invites', (ctx) => {
    const caller = requireCaller(ctx);
    inviteLimiter.consume(clientIp(ctx.req));
    const body = asRecord(ctx.body, 'body');
    return repo.createInvite(caller, {
      role: requireString(body.role, 'role', { maxLength: 32 }),
      ...(optionalString(body.email, 'email', 254) ? { email: optionalString(body.email, 'email', 254) } : {}),
      ...(body.ttlHours !== undefined ? { ttlHours: Number(body.ttlHours) } : {}),
    });
  });

  router.get('/api/members/invites', (ctx) => repo.listInvites(requireCaller(ctx)));

  router.delete('/api/members/invites/:id', (ctx) => {
    repo.revokeInvite(requireCaller(ctx), ctx.params.id as string);
    return { ok: true };
  });

  router.post('/api/invites/accept', (ctx) => {
    const session = requireSession(ctx);
    inviteLimiter.consume(clientIp(ctx.req));
    const body = asRecord(ctx.body, 'body');
    const code = requireString(body.code, 'code', { maxLength: 80 });
    const result = repo.acceptInvite(session.user, code);
    auth.switchBusiness(session.sessionId, result.businessId);
    return result;
  });

  router.patch('/api/members/:id', (ctx) => {
    const caller = requireCaller(ctx);
    const body = asRecord(ctx.body, 'body');
    repo.updateMember(caller, ctx.params.id as string, {
      ...(body.role !== undefined ? { role: String(body.role) } : {}),
      ...(body.status !== undefined ? { status: String(body.status) } : {}),
      ...(Array.isArray(body.grants) ? { grants: body.grants.map(String) } : {}),
      ...(Array.isArray(body.denials) ? { denials: body.denials.map(String) } : {}),
    });
    return { ok: true };
  });

  router.get('/api/audit', (ctx) => repo.listAuditLog(requireCaller(ctx), Number(ctx.query.get('limit') ?? 100)));

  // ----------------------------------------------------------------- catalog

  router.get('/api/units', (ctx) => repo.listUnits(requireCaller(ctx), ctx.query.get('dimension') ?? undefined));

  router.post('/api/units/conversions', (ctx) => {
    const caller = requireCaller(ctx);
    repo.assertPermission(caller, 'product.manage');
    const body = asRecord(ctx.body, 'body');
    const id = requireString(body.id ?? `conv-${Date.now()}`, 'id', { maxLength: 60 });
    const from = requireString(body.from, 'from', { maxLength: 24 });
    const to = requireString(body.to, 'to', { maxLength: 24 });
    // A second, different factor for the same unit pair would be ambiguous.
    const clash = repo.db.get<{ id: string }>(
      'SELECT id FROM explicit_conversions WHERE business_id = ? AND ((from_unit = ? AND to_unit = ?) OR (from_unit = ? AND to_unit = ?))',
      [caller.business.id, from, to, to, from],
    );
    if (clash) throw HttpError.conflict('CONVERSION_EXISTS', `A conversion between ${from} and ${to} is already registered (${clash.id})`);
    repo.db.run('INSERT INTO explicit_conversions (id, business_id, from_unit, to_unit, factor, note, item_id, approved_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [
      id,
      caller.business.id,
      from,
      to,
      String(body.factor ?? '1'),
      requireString(body.note, 'note', { minLength: 5, maxLength: 400 }),
      optionalString(body.itemId, 'itemId', 64),
      caller.user.email,
      new Date().toISOString(),
    ]);
    repo.audit({ businessId: caller.business.id, actorId: caller.user.id, action: 'unit.conversion.create', entityType: 'explicit_conversion', entityId: id, detail: { from, to, factor: body.factor } });
    return { id };
  });

  router.get('/api/locations', (ctx) => repo.listLocations(requireCaller(ctx)));
  router.post('/api/locations', (ctx) => repo.createLocation(requireCaller(ctx), asRecord(ctx.body, 'body')));

  router.get('/api/products', (ctx) =>
    repo.listProducts(requireCaller(ctx), {
      ...(ctx.query.get('search') ? { search: ctx.query.get('search') as string } : {}),
      ...(ctx.query.get('kind') ? { kind: ctx.query.get('kind') as string } : {}),
    }),
  );
  router.post('/api/products', (ctx) => {
    const caller = requireCaller(ctx);
    const product = repo.createProduct(caller, asRecord(ctx.body, 'body'));
    return repo.productView(product, caller);
  });
  router.patch('/api/products/:id', (ctx) => {
    const caller = requireCaller(ctx);
    const product = repo.updateProduct(caller, ctx.params.id as string, asRecord(ctx.body, 'body'));
    return repo.productView(product, caller);
  });

  router.get('/api/customers', (ctx) => repo.listCustomers(requireCaller(ctx), ctx.query.get('search') ?? undefined));
  router.post('/api/customers', (ctx) => repo.createCustomer(requireCaller(ctx), asRecord(ctx.body, 'body')));
  router.patch('/api/customers/:id', (ctx) => repo.updateParty(requireCaller(ctx), 'customer', ctx.params.id as string, asRecord(ctx.body, 'body')));
  router.get('/api/suppliers', (ctx) => repo.listSuppliers(requireCaller(ctx), ctx.query.get('search') ?? undefined));
  router.post('/api/suppliers', (ctx) => repo.createSupplier(requireCaller(ctx), asRecord(ctx.body, 'body')));
  router.patch('/api/suppliers/:id', (ctx) => repo.updateParty(requireCaller(ctx), 'supplier', ctx.params.id as string, asRecord(ctx.body, 'body')));

  // Corrections: void/return with an audited reversal instead of editing history.
  router.post('/api/sales/:id/void', (ctx) => repo.voidDocument(requireCaller(ctx), 'sale', ctx.params.id as string, asRecord(ctx.body ?? {}, 'body')));
  router.post('/api/purchases/:id/void', (ctx) => repo.voidDocument(requireCaller(ctx), 'purchase', ctx.params.id as string, asRecord(ctx.body ?? {}, 'body')));

  // --------------------------------------------------------------- inventory

  router.get('/api/inventory', (ctx) => repo.listStock(requireCaller(ctx)));
  router.get('/api/inventory/movements', (ctx) => repo.listMovements(requireCaller(ctx), ctx.query.get('itemId') ?? undefined));

  router.post('/api/inventory/transfer', (ctx) => repo.transferStock(requireCaller(ctx), asRecord(ctx.body, 'body')));
  router.post('/api/inventory/opening', (ctx) => repo.recordOpeningStock(requireCaller(ctx), asRecord(ctx.body, 'body')));
  router.post('/api/finance/opening-balance', (ctx) => repo.recordOpeningBalance(requireCaller(ctx), asRecord(ctx.body, 'body')));

  router.post('/api/inventory/adjust', (ctx) => {
    const caller = requireCaller(ctx);
    repo.assertPermission(caller, 'inventory.adjust');
    const body = asRecord(ctx.body, 'body');
    const itemId = requireString(body.itemId, 'itemId', { maxLength: 64 });
    const direction = requireEnum(body.direction, 'direction', ['IN', 'OUT'] as const);
    const quantity = String(body.quantity ?? '0');
    const reason = requireString(body.reason, 'reason', { minLength: 5, maxLength: 400 });
    const currency = String(body.currency ?? caller.business.currency).toUpperCase();
    const allowNegative = body.allowNegative === true;
    if (allowNegative) repo.assertPermission(caller, 'inventory.adjust.approve');
    return repo.db.transaction(() => {
      const unitCost = body.unitCost !== undefined ? money(currency, String(body.unitCost)) : repo.itemUnitCost(caller.business.id, itemId, currency);
      const id = repo.recordMovement(caller, {
        itemId,
        direction,
        quantity: (await_quantity(quantity)),
        unit: requireString(body.unit, 'unit', { maxLength: 24 }),
        unitCost,
        sourceType: 'ADJUSTMENT',
        sourceId: `ADJ-${Date.now()}`,
        reason,
        allowNegative,
      });
      repo.audit({ businessId: caller.business.id, actorId: caller.user.id, action: 'inventory.adjust', entityType: 'stock_movement', entityId: id, detail: { itemId, direction, quantity, reason, allowNegative } });
      return { id, adjustment: { itemId, direction, quantity, reason } };
    });
  });

  // ---------------------------------------------------------------- commerce

  router.post('/api/purchases', (ctx) => repo.createPurchase(requireCaller(ctx), asRecord(ctx.body, 'body')));
  router.get('/api/purchases', (ctx) => {
    const caller = requireCaller(ctx);
    repo.assertPermission(caller, 'purchase.view');
    const from = ctx.query.get('from') ?? '1970-01-01';
    const to = ctx.query.get('to') ?? '2999-12-31';
    const showCost = repo.permissions(caller).has('purchase.cost.view');
    return repo.db.all<Record<string, unknown>>('SELECT * FROM purchases WHERE business_id = ? AND document_date BETWEEN ? AND ? ORDER BY document_date DESC LIMIT 500', [caller.business.id, from, to]).map((row) => ({
      id: row.id, reference: row.reference, supplierId: row.supplier_id, documentDate: row.document_date, currency: row.currency, status: row.status,
      total: row.total, paid: row.paid, payable: row.payable,
      ...(showCost ? { subtotal: row.subtotal, tax: row.tax } : {}),
      lines: repo.db.all('SELECT product_id AS productId, quantity, unit, unit_cost AS unitCost, line_total AS lineTotal FROM purchase_lines WHERE purchase_id = ?', [row.id]),
    }));
  });

  router.post('/api/sales', (ctx) => repo.createSale(requireCaller(ctx), asRecord(ctx.body, 'body')));
  router.get('/api/sales', (ctx) => {
    const caller = requireCaller(ctx);
    repo.assertPermission(caller, 'sale.view');
    const from = ctx.query.get('from') ?? '1970-01-01';
    const to = ctx.query.get('to') ?? '2999-12-31';
    const showCost = repo.permissions(caller).has('sale.view') && repo.permissions(caller).has('purchase.cost.view');
    return repo.db.all<Record<string, unknown>>('SELECT * FROM sales WHERE business_id = ? AND document_date BETWEEN ? AND ? ORDER BY document_date DESC LIMIT 500', [caller.business.id, from, to]).map((row) => ({
      id: row.id, reference: row.reference, customerId: row.customer_id, documentDate: row.document_date, currency: row.currency, status: row.status,
      gross: row.gross, discount: row.discount, net: row.net, cashReceived: row.cash_received, receivable: row.receivable,
      ...(showCost ? { cogs: row.cogs, grossProfit: String(Number(row.net) - Number(row.cogs)) } : {}),
      lines: repo.db.all('SELECT product_id AS productId, description, quantity, unit, unit_price AS unitPrice, line_total AS lineTotal FROM sale_lines WHERE sale_id = ?', [row.id]),
    }));
  });

  router.post('/api/receipts', (ctx) => repo.recordCustomerReceipt(requireCaller(ctx), asRecord(ctx.body, 'body')));
  router.post('/api/payments', (ctx) => repo.recordSupplierPayment(requireCaller(ctx), asRecord(ctx.body, 'body')));
  router.post('/api/transfers', (ctx) => repo.recordTransfer(requireCaller(ctx), asRecord(ctx.body, 'body')));
  router.post('/api/income-expenses', (ctx) => repo.recordIncomeExpense(requireCaller(ctx), asRecord(ctx.body, 'body')));
  router.post('/api/partner-capital', (ctx) => repo.recordPartnerCapital(requireCaller(ctx), asRecord(ctx.body, 'body')));

  router.get('/api/accounts', (ctx) => {
    const caller = requireCaller(ctx);
    const currency = caller.business.currency;
    const entries = repo.journalEntries(caller.business.id);
    const balances = new Map<string, { debit: number; credit: number }>();
    for (const entry of entries) {
      for (const line of entry.lines) {
        const row = balances.get(line.account) ?? { debit: 0, credit: 0 };
        row.debit += line.debit.amount.toNumber();
        row.credit += line.credit.amount.toNumber();
        balances.set(line.account, row);
      }
    }
    return STANDARD_ACCOUNTS.map((account) => ({
      code: account.code,
      name: account.name,
      nameBn: account.nameBn,
      type: account.type,
      balance: formatMoney(money(currency, (balances.get(account.code)?.debit ?? 0) - (balances.get(account.code)?.credit ?? 0))),
      isCash: ['1000', '1010', '1020'].includes(account.code),
    }));
  });

  // ----------------------------------------------------------------- farming

  router.get('/api/farming/farms', (ctx) => repo.listFarms(requireCaller(ctx)));
  router.post('/api/farming/farms', (ctx) => repo.createFarm(requireCaller(ctx), asRecord(ctx.body, 'body')));
  router.post('/api/farming/units', (ctx) => repo.createFarmUnit(requireCaller(ctx), asRecord(ctx.body, 'body')));
  router.get('/api/farming/cycles', (ctx) => repo.listCycles(requireCaller(ctx), ctx.query.get('status') ?? undefined));
  router.post('/api/farming/cycles', (ctx) => repo.createCycle(requireCaller(ctx), asRecord(ctx.body, 'body')));
  router.post('/api/farming/cycles/:id/events', (ctx) => {
    const caller = requireCaller(ctx);
    const body = asRecord(ctx.body, 'body');
    return repo.recordFarmingEvent(caller, { ...body, cycleId: ctx.params.id });
  });
  router.post('/api/farming/cycles/:id/harvest', (ctx) => {
    const caller = requireCaller(ctx);
    const body = asRecord(ctx.body, 'body');
    return repo.recordHarvest(caller, { ...body, cycleId: ctx.params.id });
  });
  router.post('/api/farming/cycles/:id/close', (ctx) => repo.closeCycle(requireCaller(ctx), ctx.params.id as string, asRecord(ctx.body ?? {}, 'body')));
  router.get('/api/farming/cycles/:id/profit', (ctx) => repo.cycleProfitReport(requireCaller(ctx), ctx.params.id as string));
  router.post('/api/farming/allocations', (ctx) => repo.allocateSharedCost(requireCaller(ctx), asRecord(ctx.body, 'body')));
  router.get('/api/farming/dashboard', (ctx) => repo.farmingDashboard(requireCaller(ctx)));
  router.get('/api/farming/events', (ctx) => {
    const caller = requireCaller(ctx);
    repo.assertPermission(caller, 'farming.view');
    return repo.db.all(
      `SELECT e.id, e.cycle_id AS cycleId, c.reference AS cycleReference, e.event_type AS eventType, e.occurred_on AS occurredOn,
              e.quantity, e.unit, e.amount, e.currency, e.notes
       FROM farming_events e JOIN production_cycles c ON c.id = e.cycle_id
       WHERE e.business_id = ? ORDER BY e.occurred_on DESC LIMIT 500`,
      [caller.business.id],
    );
  });

  // ----------------------------------------------------------------- reports

  router.get('/api/reports/dashboard', (ctx) => repo.dashboard(requireCaller(ctx), range(ctx)));
  router.get('/api/reports/profit-loss', (ctx) => repo.profitAndLossReport(requireCaller(ctx), range(ctx)));
  router.get('/api/reports/balance-sheet', (ctx) => {
    const caller = requireCaller(ctx);
    const asOf = ctx.query.get('asOf') ?? new Date().toISOString().slice(0, 10);
    return repo.balanceSheetReport(caller, asOf);
  });
  router.get('/api/reports/trial-balance', (ctx) => repo.trialBalanceReport(requireCaller(ctx), range(ctx)));
  router.get('/api/reports/cash-flow', (ctx) => repo.cashFlowReport(requireCaller(ctx), range(ctx)));
  router.get('/api/reports/stock-valuation', (ctx) => repo.stockValuationReport(requireCaller(ctx), ctx.query.get('locationId') ?? undefined));
  router.get('/api/reports/integrity', (ctx) => repo.integrityReport(requireCaller(ctx)));
  router.get('/api/alerts', (ctx) => {
    const caller = requireCaller(ctx);
    const number = (key: string, fallback: number) => {
      const raw = ctx.query.get(key);
      if (raw === null) return fallback;
      const parsed = Number(raw);
      if (!Number.isFinite(parsed) || parsed < 0) throw HttpError.badRequest('VALIDATION', `${key} must be a non-negative number`);
      return parsed;
    };
    return repo.alerts(caller, {
      expiryDays: number('expiryDays', 30),
      harvestDays: number('harvestDays', 14),
      receivableDays: number('receivableDays', 30),
      staleDays: number('staleDays', 7),
    });
  });
  router.get('/api/reports/receivables', (ctx) => {
    const caller = requireCaller(ctx);
    repo.assertPermission(caller, 'report.view');
    return repo
      .db.all<{ id: string; name: string; phone: string | null }>('SELECT id, name, phone FROM customers WHERE business_id = ? AND is_active = 1 ORDER BY name', [caller.business.id])
      .map((row) => ({ customerId: row.id, name: row.name, phone: row.phone, outstanding: repo.receivableFor(caller.business.id, row.id).amount.toString() }))
      .filter((row) => Number(row.outstanding) !== 0);
  });
  router.get('/api/reports/payables', (ctx) => {
    const caller = requireCaller(ctx);
    repo.assertPermission(caller, 'report.view');
    return repo
      .db.all<{ id: string; name: string; phone: string | null }>('SELECT id, name, phone FROM suppliers WHERE business_id = ? AND is_active = 1 ORDER BY name', [caller.business.id])
      .map((row) => ({ supplierId: row.id, name: row.name, phone: row.phone, outstanding: repo.payableFor(caller.business.id, row.id).amount.toString() }))
      .filter((row) => Number(row.outstanding) !== 0);
  });

  // Printable HTML reports (the browser's Print → Save as PDF makes the document).
  router.get('/api/reports/print/:report', (ctx) => {
    const caller = requireCaller(ctx);
    const report = String(ctx.params.report);
    const { from, to } = range(ctx);
    const currency = caller.business.currency;
    const business = repo.getBusiness(caller.business.id);
    const tables: PrintTable[] = [];
    const summary: PrintSummaryItem[] = [];
    const notes: string[] = [];
    let title = '';
    let titleBn = '';
    let periodLabel = `Period ${from} → ${to}`;
    let basis: string | undefined;

    const money2 = (value: string) => formatMoney(money(currency, value));
    const asOf = ctx.query.get('asOf') ?? to;

    switch (report) {
      case 'profit-loss': {
        const pnl = repo.profitAndLossReport(caller, { from, to });
        title = 'Profit and Loss';
        titleBn = 'লাভ-ক্ষতি হিসাব';
        basis = 'Accrual basis';
        summary.push(
          { label: 'Net revenue', labelBn: 'নিট আয়', value: money2(pnl.netRevenue) },
          { label: 'Cost of goods sold', labelBn: 'বিক্রিত পণ্যের ব্যয়', value: money2(pnl.costOfGoodsSold) },
          { label: 'Gross profit', labelBn: 'স্থূল মুনাফা', value: money2(pnl.grossProfit) },
          { label: 'Net profit', labelBn: 'নিট মুনাফা', value: money2(pnl.netProfit), emphasis: true },
        );
        tables.push({
          title: 'Revenue and cost',
          titleBn: 'আয় ও ব্যয়',
          columns: ['Line', 'Amount'],
          rows: [
            { cells: ['Sales revenue', money2(pnl.revenue)] },
            { cells: ['Less: discounts and returns', `(${money2(pnl.contraRevenue)})`] },
            { cells: ['Net revenue', money2(pnl.netRevenue)], emphasis: true },
            { cells: ['Cost of goods sold', `(${money2(pnl.costOfGoodsSold)})`] },
            { cells: ['Gross profit', money2(pnl.grossProfit)], emphasis: true },
            { cells: ['Other income', money2(pnl.otherIncome)] },
          ],
        });
        tables.push({
          title: 'Operating expenses',
          titleBn: 'পরিচালন ব্যয়',
          columns: ['Account', 'Amount'],
          rows: pnl.expensesByAccount.map((row) => ({ cells: [`${row.account} ${row.name}`, money2(row.amount)] })),
        });
        tables[1]?.rows.push({ cells: ['Total operating expenses', money2(pnl.operatingExpenses)], emphasis: true });
        notes.push(`Cash-basis operating result for the same period: ${money2(pnl.cashBasisResult)}. Stock purchases are assets until sold, so cash and profit differ.`);
        break;
      }
      case 'balance-sheet': {
        const sheet = repo.balanceSheetReport(caller, asOf);
        title = 'Balance Sheet';
        titleBn = 'উদ্বৃত্তপত্র';
        periodLabel = `As at ${asOf}`;
        basis = 'Accrual basis';
        summary.push(
          { label: 'Total assets', labelBn: 'মোট সম্পদ', value: money2(sheet.totalAssets) },
          { label: 'Total liabilities', labelBn: 'মোট দায়', value: money2(sheet.totalLiabilities) },
          { label: 'Total equity', labelBn: 'মোট পুঁজি', value: money2(sheet.totalEquityIncludingResult), emphasis: true },
        );
        tables.push({ title: 'Assets', titleBn: 'সম্পদ', columns: ['Account', 'Amount'], rows: sheet.assets.map((row) => ({ cells: [`${row.account} ${row.name}`, money2(row.amount)] })) });
        tables[0]?.rows.push({ cells: ['Total assets', money2(sheet.totalAssets)], emphasis: true });
        tables.push({ title: 'Liabilities', titleBn: 'দায়', columns: ['Account', 'Amount'], rows: sheet.liabilities.map((row) => ({ cells: [`${row.account} ${row.name}`, money2(row.amount)] })) });
        tables[1]?.rows.push({ cells: ['Total liabilities', money2(sheet.totalLiabilities)], emphasis: true });
        tables.push({
          title: 'Equity',
          titleBn: 'পুঁজি',
          columns: ['Account', 'Amount'],
          rows: [
            ...sheet.equity.map((row) => ({ cells: [`${row.account} ${row.name}`, money2(row.amount)] })),
            { cells: ['Current period result (unclosed)', money2(String(Number(sheet.totalEquityIncludingResult) - Number(sheet.totalEquity)))] },
            { cells: ['Total equity', money2(sheet.totalEquityIncludingResult)], emphasis: true },
          ],
        });
        notes.push(sheet.balanced ? 'Assets equal liabilities plus equity.' : 'WARNING: the balance sheet does not balance - run the integrity report before relying on these figures.');
        break;
      }
      case 'trial-balance': {
        const balance = repo.trialBalanceReport(caller, { from, to });
        title = 'Trial Balance';
        titleBn = 'রেওয়ামিল';
        basis = 'Accrual basis';
        summary.push(
          { label: 'Total debit', labelBn: 'মোট ডেবিট', value: money2(balance.totalDebit) },
          { label: 'Total credit', labelBn: 'মোট ক্রেডিট', value: money2(balance.totalCredit) },
        );
        tables.push({
          title: 'Accounts',
          titleBn: 'হিসাবসমূহ',
          columns: ['Code', 'Account', 'Debit', 'Credit'],
          rows: [
            ...balance.rows.map((row) => ({ cells: [row.account, row.name, money2(row.debit), money2(row.credit)] })),
            { cells: ['', 'Total', money2(balance.totalDebit), money2(balance.totalCredit)], emphasis: true },
          ],
        });
        notes.push(balance.balanced ? 'Debits equal credits.' : 'WARNING: debits do not equal credits.');
        break;
      }
      case 'cash-flow': {
        const flow = repo.cashFlowReport(caller, { from, to });
        title = 'Cash Flow';
        titleBn = 'নগদ প্রবাহ';
        summary.push(
          { label: 'Opening balance', labelBn: 'প্রারম্ভিক জের', value: money2(flow.opening) },
          { label: 'Cash in', labelBn: 'নগদ প্রাপ্তি', value: money2(flow.inflows) },
          { label: 'Cash out', labelBn: 'নগদ প্রদান', value: money2(flow.outflows) },
          { label: 'Closing balance', labelBn: 'সমাপনি জের', value: money2(flow.closing), emphasis: true },
        );
        tables.push({
          title: 'Movement',
          titleBn: 'নগদ চলাচল',
          columns: ['Line', 'Amount'],
          rows: [
            { cells: ['Opening balance', money2(flow.opening)] },
            { cells: ['Total cash received', money2(flow.inflows)] },
            { cells: ['Total cash paid', `(${money2(flow.outflows)})`] },
            { cells: ['Net change', money2(flow.netChange)], emphasis: true },
            { cells: ['Closing balance', money2(flow.closing)], emphasis: true },
          ],
        });
        notes.push('A cash-flow figure is not a profit figure: capital contributions and account transfers are excluded because they are not operating results.');
        break;
      }
      case 'stock-valuation': {
        const valuation = repo.stockValuationReport(caller, ctx.query.get('locationId') ?? undefined);
        title = 'Stock Valuation';
        titleBn = 'মজুদ মূল্যায়ন';
        periodLabel = `As at ${to}`;
        basis = 'Weighted average';
        summary.push({ label: 'Total inventory value', labelBn: 'মোট মজুদ মূল্য', value: valuation.totalValue ? money2(valuation.totalValue) : 'restricted', emphasis: true });
        tables.push({
          title: 'Items',
          titleBn: 'পণ্যসমূহ',
          columns: ['Item', 'Quantity', 'Unit cost', 'Value'],
          rows: valuation.rows.map((row) => ({
            cells: [row.name, `${row.quantity} ${row.unit}`, row.unitCost ? money2(row.unitCost) : 'restricted', row.value ? money2(row.value) : 'restricted'],
          })),
        });
        notes.push('Valuation uses the weighted-average unit cost in force at each movement; historical COGS is never recomputed.');
        break;
      }
      case 'receivables': {
        repo.assertPermission(caller, 'report.view');
        const rows = repo
          .db.all<{ id: string; name: string; phone: string | null }>('SELECT id, name, phone FROM customers WHERE business_id = ? AND is_active = 1 ORDER BY name', [caller.business.id])
          .map((row) => ({ row, outstanding: repo.receivableFor(caller.business.id, row.id) }))
          .filter((entry) => !entry.outstanding.amount.isZero());
        title = 'Receivables';
        titleBn = 'প্রাপ্য হিসাব';
        periodLabel = `As at ${to}`;
        const total = rows.reduce((acc, entry) => addMoney(acc, entry.outstanding), money(currency, 0));
        summary.push({ label: 'Total receivable', labelBn: 'মোট প্রাপ্য', value: formatMoney(total), emphasis: true });
        tables.push({
          title: 'Customers owing money',
          titleBn: 'গ্রাহক তালিকা',
          columns: ['Customer', 'Phone', 'Outstanding'],
          rows: rows.map((entry) => ({ cells: [entry.row.name, entry.row.phone ?? '', formatMoney(entry.outstanding)] })),
        });
        notes.push('A sale increases revenue when posted; the receivable falls when the customer actually pays.');
        break;
      }
      case 'payables': {
        repo.assertPermission(caller, 'report.view');
        const rows = repo
          .db.all<{ id: string; name: string; phone: string | null }>('SELECT id, name, phone FROM suppliers WHERE business_id = ? AND is_active = 1 ORDER BY name', [caller.business.id])
          .map((row) => ({ row, outstanding: repo.payableFor(caller.business.id, row.id) }))
          .filter((entry) => !entry.outstanding.amount.isZero());
        title = 'Payables';
        titleBn = 'প্রদেয় হিসাব';
        periodLabel = `As at ${to}`;
        const total = rows.reduce((acc, entry) => addMoney(acc, entry.outstanding), money(currency, 0));
        summary.push({ label: 'Total payable', labelBn: 'মোট প্রদেয়', value: formatMoney(total), emphasis: true });
        tables.push({
          title: 'Suppliers to pay',
          titleBn: 'সরবরাহকারী তালিকা',
          columns: ['Supplier', 'Phone', 'Outstanding'],
          rows: rows.map((entry) => ({ cells: [entry.row.name, entry.row.phone ?? '', formatMoney(entry.outstanding)] })),
        });
        notes.push('Recording a supplier payment settles a payable; it is not a second expense.');
        break;
      }
      case 'integrity': {
        const integrity = repo.integrityReport(caller);
        title = 'Reconciliation Check';
        titleBn = 'হিসাব মিলকরণ';
        summary.push({ label: 'Result', value: integrity.ok ? 'ALL CHECKS PASSED' : 'ISSUES FOUND', emphasis: true });
        tables.push({
          title: 'Checks',
          titleBn: 'পরীক্ষাসমূহ',
          columns: ['Check', 'Result', 'Detail'],
          rows: integrity.checks.map((check) => ({ cells: [check.id, check.ok ? 'OK' : 'FAIL', check.detail], ...(check.ok ? {} : { emphasis: true }) })),
        });
        break;
      }
      default:
        throw HttpError.badRequest('VALIDATION', `Unknown printable report ${JSON.stringify(report)}. Use: profit-loss, balance-sheet, trial-balance, cash-flow, stock-valuation, receivables, payables, integrity`);
    }

    const html = renderReportHtml({
      businessName: business.name,
      reportTitle: title,
      reportTitleBn: titleBn,
      periodLabel,
      currency,
      timezone: business.timezone,
      tables,
      summary,
      notes,
      generatedAt: new Date().toISOString(),
      ...(basis ? { basis } : {}),
    });
    ctx.res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    ctx.res.end(html);
    return undefined;
  });

  router.get('/api/reports/export/:table', (ctx) => {
    const caller = requireCaller(ctx);
    const table = ctx.params.table as string;
    // Each export names the permission it needs and the columns a role without
    // cost visibility must never receive. A bare `report.export` is NOT enough
    // for cost or ledger data.
    const exports: Record<string, { sql: string; permission: Permission; hidden: readonly string[]; hiddenPermission?: Permission }> = {
      sales: { sql: 'SELECT * FROM sales WHERE business_id = ?', permission: 'sale.view', hidden: ['cogs'], hiddenPermission: 'financial_reports.view' },
      purchases: { sql: 'SELECT * FROM purchases WHERE business_id = ?', permission: 'purchase.view', hidden: ['subtotal', 'tax'], hiddenPermission: 'purchase.cost.view' },
      stock_movements: { sql: 'SELECT * FROM stock_movements WHERE business_id = ?', permission: 'inventory.view', hidden: ['unit_cost'], hiddenPermission: 'purchase.cost.view' },
      products: { sql: 'SELECT * FROM products WHERE business_id = ?', permission: 'product.view', hidden: ['purchase_price', 'tax_rate'], hiddenPermission: 'purchase.cost.view' },
      customers: { sql: 'SELECT * FROM customers WHERE business_id = ?', permission: 'customer.view', hidden: [] },
      suppliers: { sql: 'SELECT * FROM suppliers WHERE business_id = ?', permission: 'supplier.view', hidden: [] },
      production_cycles: { sql: 'SELECT * FROM production_cycles WHERE business_id = ?', permission: 'farming.view', hidden: [] },
      // Ledger and cost exports require the matching sensitivity permission.
      journal_lines: { sql: 'SELECT * FROM journal_lines WHERE business_id = ?', permission: 'financial_reports.view', hidden: [] },
      journal_entries: { sql: 'SELECT * FROM journal_entries WHERE business_id = ?', permission: 'financial_reports.view', hidden: [] },
      harvests: { sql: 'SELECT * FROM harvests WHERE business_id = ?', permission: 'farming.cost.view', hidden: [] },
      cost_sources: { sql: 'SELECT * FROM cost_sources WHERE business_id = ?', permission: 'farming.cost.view', hidden: [] },
      cost_allocations: { sql: 'SELECT * FROM cost_allocations WHERE business_id = ?', permission: 'farming.cost.view', hidden: [] },
      payments: { sql: 'SELECT * FROM payments WHERE business_id = ?', permission: 'finance.view', hidden: [] },
      income_expenses: { sql: 'SELECT * FROM income_expenses WHERE business_id = ?', permission: 'finance.view', hidden: [] },
      account_transfers: { sql: 'SELECT * FROM account_transfers WHERE business_id = ?', permission: 'finance.view', hidden: [] },
      partner_capital: { sql: 'SELECT * FROM partner_capital WHERE business_id = ?', permission: 'partner_capital.view', hidden: [] },
    };
    const spec = exports[table];
    if (!spec) throw HttpError.badRequest('VALIDATION', `Unsupported export table. Allowed: ${Object.keys(exports).join(', ')}`);
    repo.assertPermission(caller, 'report.export');
    repo.assertPermission(caller, spec.permission);
    const permissions = repo.permissions(caller);
    const hideCost = spec.hidden.length > 0 && !permissions.has(spec.hiddenPermission ?? 'purchase.cost.view');
    const rows = repo.db.all<Record<string, unknown>>(spec.sql, [caller.business.id]).map((row) => {
      if (!hideCost) return row;
      const clone = { ...row };
      for (const column of spec.hidden) delete clone[column];
      return clone;
    });
    const csv = toCsv(rows);
    ctx.res.writeHead(200, {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${table}-${new Date().toISOString().slice(0, 10)}.csv"`,
      'cache-control': 'no-store',
    });
    ctx.res.end(csv);
    return undefined;
  });

  router.get('/api/reports/backup', (ctx) => {
    const caller = requireCaller(ctx);
    repo.assertPermission(caller, 'backup.manage');
    // `businesses` is keyed by id; every other tenant table by business_id.
    const tenantTables = ['members', 'locations', 'products', 'customers', 'suppliers', 'stock_movements', 'purchases', 'purchase_lines', 'sales', 'sale_lines', 'payments', 'account_transfers', 'income_expenses', 'partner_capital', 'journal_entries', 'journal_lines', 'farms', 'farm_units', 'production_cycles', 'farming_events', 'cost_sources', 'cost_allocations', 'harvests', 'observations', 'mortality_losses', 'cost_allocations'];
    const businessTables = ['businesses', 'business_settings', 'explicit_conversions', 'financial_accounts', 'stock_lots'];
    const dump: Record<string, unknown[]> = {};
    dump.businesses = repo.db.all('SELECT * FROM businesses WHERE id = ?', [caller.business.id]);
    for (const table of new Set([...tenantTables, ...businessTables.filter((t) => t !== 'businesses')])) {
      dump[table] = repo.db.all(`SELECT * FROM ${table} WHERE business_id = ?`, [caller.business.id]);
    }
    repo.audit({ businessId: caller.business.id, actorId: caller.user.id, action: 'backup.export', entityType: 'business', entityId: caller.business.id, detail: { tables: Object.keys(dump).length } });
    return { exportedAt: new Date().toISOString(), businessId: caller.business.id, format: 'sbm-backup-v1', tables: dump };
  });

  // Restore into an EMPTY workspace only; validated and atomic (see repository).
  router.post('/api/reports/restore', (ctx) => repo.restoreBackup(requireCaller(ctx), ctx.body ?? {}));

  // -------------------------------------------------------------------- sync

  router.post('/api/sync/push', (ctx) => {
    const caller = requireCaller(ctx);
    const body = asRecord(ctx.body, 'body');
    const events = Array.isArray(body.events) ? body.events : [];
    if (events.length > 200) throw HttpError.badRequest('VALIDATION', 'Push at most 200 events at a time');
    return { results: sync.push(caller, events as never) };
  });

  router.get('/api/sync/pull', (ctx) => {
    const caller = requireCaller(ctx);
    return sync.pull(caller, ctx.query.get('since') ?? '1970-01-01T00:00:00.000Z');
  });

  router.get('/api/sync/conflicts', (ctx) => sync.listConflicts(requireCaller(ctx)));
  router.post('/api/sync/conflicts/:id/resolve', (ctx) => {
    const caller = requireCaller(ctx);
    const body = asRecord(ctx.body, 'body');
    sync.resolveConflict(caller, ctx.params.id as string, requireEnum(body.resolution, 'resolution', ['LOCAL_WINS', 'SERVER_WINS'] as const));
    return { ok: true };
  });

  // ---------------------------------------------------------------------- ai

  router.get('/api/ai/status', (ctx) => {
    requireCaller(ctx);
    return ai.status();
  });

  router.post('/api/ai/ask', async (ctx) => {
    const caller = requireCaller(ctx);
    const body = asRecord(ctx.body, 'body');
    const answer = await ai.ask(caller, {
      question: requireString(body.question, 'question', { maxLength: 2000 }),
      ...(optionalString(body.language, 'language', 4) === 'en' ? { language: 'en' as const } : {}),
      ...(optionalString(body.conversationId, 'conversationId', 64) ? { conversationId: String(body.conversationId) } : {}),
    });
    return answer;
  });

  router.get('/api/ai/conversations', (ctx) => ai.listConversations(requireCaller(ctx)));
  router.get('/api/ai/conversations/:id', (ctx) => ai.getConversation(requireCaller(ctx), ctx.params.id as string));
  router.delete('/api/ai/conversations/:id', (ctx) => {
    ai.deleteConversation(requireCaller(ctx), ctx.params.id as string);
    return { ok: true };
  });
  router.post('/api/ai/plans', (ctx) => {
    const caller = requireCaller(ctx);
    const body = asRecord(ctx.body, 'body');
    return ai.savePlan(caller, { title: requireString(body.title, 'title', { maxLength: 200 }), content: requireString(body.content, 'content', { maxLength: 20_000 }), ...(optionalString(body.kind, 'kind', 20) ? { kind: String(body.kind) } : {}) });
  });
  router.get('/api/ai/plans', (ctx) => ai.listPlans(requireCaller(ctx)));
  router.post('/api/ai/feedback', (ctx) => {
    const caller = requireCaller(ctx);
    const body = asRecord(ctx.body, 'body');
    ai.recordFeedback(caller, { messageId: requireString(body.messageId, 'messageId', { maxLength: 64 }), helpful: body.helpful === true, comment: optionalString(body.comment, 'comment', 500) });
    return { ok: true };
  });
  router.post('/api/ai/research', async (ctx) => {
    const caller = requireCaller(ctx);
    const body = asRecord(ctx.body, 'body');
    return ai.research(caller, requireString(body.query, 'query', { maxLength: 300 }));
  });

  // -------------------------------------------------------------- attachments

  router.post('/api/attachments/:entityType/:entityId', async (ctx) => {
    const caller = requireCaller(ctx);
    repo.assertPermission(caller, 'attachment.manage');
    const raw = await readRawBody(ctx.req, 5_000_000);
    if (raw.length === 0) throw HttpError.badRequest('VALIDATION', 'Empty upload');
    const fileName = ctx.query.get('fileName') ?? 'attachment.bin';
    const checksum = (await import('node:crypto')).createHash('sha256').update(raw).digest('hex');
    const { safeFileName } = await import('@sbm/domain');
    const id = (await import('node:crypto')).randomUUID();
    const { join } = await import('node:path');
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const dir = join(config.dataDir, 'attachments', caller.business.id);
    mkdirSync(dir, { recursive: true });
    const safe = safeFileName(fileName);
    const storedPath = join(dir, `${id}-${safe}`);
    writeFileSync(storedPath, raw);
    repo.db.run('INSERT INTO attachments (id, business_id, entity_type, entity_id, file_name, mime, size_bytes, stored_path, checksum, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [
      id,
      caller.business.id,
      String(ctx.params.entityType),
      String(ctx.params.entityId),
      safe,
      String(ctx.req.headers['content-type'] ?? 'application/octet-stream'),
      raw.length,
      storedPath,
      checksum,
      caller.user.id,
      new Date().toISOString(),
    ]);
    return { id, fileName: safe, sizeBytes: raw.length, checksum, note: 'Attachments are stored on this server and are NOT shared with partners who are offline.' };
  });

  router.get('/api/attachments/:entityType/:entityId', (ctx) => {
    const caller = requireCaller(ctx);
    return repo.db.all('SELECT id, file_name AS fileName, mime, size_bytes AS sizeBytes, checksum, created_at AS createdAt FROM attachments WHERE business_id = ? AND entity_type = ? AND entity_id = ?', [
      caller.business.id,
      String(ctx.params.entityType),
      String(ctx.params.entityId),
    ]);
  });

  // Attachment bytes. Membership is re-checked here, so a guessed id is useless.
  router.get('/api/attachments/:entityType/:entityId/:attachmentId/content', async (ctx) => {
    const caller = requireCaller(ctx);
    const row = repo.db.get<{ file_name: string; mime: string; stored_path: string; checksum: string }>(
      'SELECT file_name, mime, stored_path, checksum FROM attachments WHERE id = ? AND business_id = ? AND entity_type = ? AND entity_id = ?',
      [String(ctx.params.attachmentId), caller.business.id, String(ctx.params.entityType), String(ctx.params.entityId)],
    );
    if (!row) throw HttpError.notFound('Attachment not found');
    const { readFileSync, existsSync } = await import('node:fs');
    const { createHash } = await import('node:crypto');
    if (!existsSync(row.stored_path)) throw HttpError.notFound('The stored file is missing from the server');
    const bytes = readFileSync(row.stored_path);
    // Verify integrity before serving: a tampered file is refused, not handed out.
    if (createHash('sha256').update(bytes).digest('hex') !== row.checksum) {
      throw new HttpError(500, 'ATTACHMENT_CORRUPT', `Attachment ${String(ctx.params.attachmentId)} failed its checksum check`);
    }
    ctx.res.writeHead(200, {
      'content-type': row.mime,
      'content-length': bytes.length,
      'content-disposition': `inline; filename="${row.file_name.replace(/"/g, '')}"`,
      'cache-control': 'no-store',
    });
    ctx.res.end(bytes);
    return undefined;
  });

  return router;
}

/** Small helper so the inventory adjust handler can convert a string quantity. */
function await_quantity(value: string): import('@sbm/domain').Decimal {
  return dec(value);
}

export function toCsv(rows: readonly Record<string, unknown>[]): string {
  if (rows.length === 0) return '';
  const headers = Object.keys(rows[0] as Record<string, unknown>);
  const escape = (value: unknown): string => {
    if (value === null || value === undefined) return '';
    const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const lines = [headers.join(',')];
  for (const row of rows) lines.push(headers.map((header) => escape(row[header])).join(','));
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

export { applySecurityHeaders, sendJson, readJsonBody } from './http.js';
