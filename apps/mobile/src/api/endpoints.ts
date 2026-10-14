import { del, get, patch, post, put, request, uploadBytes } from './client';
import type {
  AccountView,
  AIAnswer,
  AIConversationDetail,
  AIConversationSummary,
  AIStatus,
  AttachmentInfo,
  AttachmentUploadResult,
  AuditEntry,
  BalanceSheetReport,
  BackupDump,
  CashFlowReport,
  CostAllocationResult,
  CreatedInvite,
  CreateBusinessResponse,
  CurrentBusiness,
  CustomerView,
  CycleProfitReport,
  CycleView,
  DashboardReport,
  FarmView,
  FarmingDashboard,
  FarmingEventResult,
  FarmingEventView,
  HealthResponse,
  InviteView,
  IsoDate,
  LoginResponse,
  LocationView,
  MeResponse,
  MemberView,
  MetaResponse,
  MovementRow,
  PayableRow,
  PaymentResult,
  ProductView,
  ProfitAndLossReport,
  PurchasePostResult,
  PurchaseView,
  PullResponse,
  PushResponse,
  ReceiptResult,
  ReceivableRow,
  RegisterResponse,
  SalePostResult,
  SaleView,
  StockRow,
  SupplierView,
  SyncStatus,
  UnitView,
  UserSummary,
} from './types';

/**
 * Typed wrappers for every route the mobile client uses.
 *
 * Paths and payload field names mirror `apps/api/src/routes.ts` exactly; when a
 * field is optional in the server's `asRecord` parsing it is optional here too.
 * There is no client-side business-rule duplication beyond shape validation:
 * the server is the authority, and the shared `@sbm/domain` rules decide what a
 * form may submit.
 *
 * Screens should use `src/offline/repository.ts` for reads (it works offline)
 * and call these functions only for online-only actions, or hand the payload to
 * the outbox for offline-capable writes.
 */

// ------------------------------------------------------------------- system

export const health = (): Promise<HealthResponse> => get<HealthResponse>('/api/health', { skipAuthRedirect: true });
export const serverStatus = (): Promise<Record<string, unknown>> => get<Record<string, unknown>>('/api/status');
export const meta = (): Promise<MetaResponse> => get<MetaResponse>('/api/meta');

// --------------------------------------------------------------------- auth

export interface RegisterInput {
  readonly email: string;
  readonly password: string;
  readonly displayName: string;
  readonly businessName?: string;
}

/** `POST /api/auth/register` — creates the account and, optionally, a business. */
export const register = (input: RegisterInput): Promise<RegisterResponse> =>
  post<RegisterResponse>('/api/auth/register', input, { skipAuthRedirect: true });

export const login = (email: string, password: string, businessId?: string): Promise<LoginResponse> =>
  post<LoginResponse>('/api/auth/login', { email, password, ...(businessId ? { businessId } : {}) }, { skipAuthRedirect: true });

export const logout = (): Promise<{ ok: boolean }> => post<{ ok: boolean }>('/api/auth/logout', {}, { skipAuthRedirect: true });

export const me = (): Promise<MeResponse> => get<MeResponse>('/api/auth/me', { skipAuthRedirect: true });

// ----------------------------------------------------------------- business

export interface CreateBusinessInput {
  readonly name: string;
  readonly currency?: string;
  readonly timezone?: string;
  readonly locale?: string;
  readonly country?: string;
}

export const createBusiness = (input: CreateBusinessInput): Promise<CreateBusinessResponse> =>
  post<CreateBusinessResponse>('/api/businesses', input);

export const currentBusiness = (): Promise<CurrentBusiness> => get<CurrentBusiness>('/api/businesses/current');

export const updateBusiness = (patchBody: Record<string, unknown>): Promise<Record<string, unknown>> =>
  patch<Record<string, unknown>>('/api/businesses/current', patchBody);

/** Server-side switch of the session's active business (needed for sync scope). */
export const switchBusiness = (businessId: string): Promise<{ ok: boolean; businessId: string }> =>
  post<{ ok: boolean; businessId: string }>('/api/businesses/switch', { businessId });

export const businessSettings = (): Promise<Record<string, unknown>> => get<Record<string, unknown>>('/api/businesses/settings');

export const saveBusinessSettings = (settings: Record<string, unknown>): Promise<Record<string, unknown>> =>
  put<Record<string, unknown>>('/api/businesses/settings', settings);

// ------------------------------------------------------------------ members

export const listMembers = (): Promise<MemberView[]> => get<MemberView[]>('/api/members');

export const createInvite = (role: string, email?: string, ttlHours?: number): Promise<CreatedInvite> =>
  post<CreatedInvite>('/api/members/invites', { role, ...(email ? { email } : {}), ...(ttlHours ? { ttlHours } : {}) });

export const listInvites = (): Promise<InviteView[]> => get<InviteView[]>('/api/members/invites');

export const revokeInvite = (inviteId: string): Promise<{ ok: boolean }> =>
  del<{ ok: boolean }>(`/api/members/invites/${encodeURIComponent(inviteId)}`);

/** Requires the internet: joins the caller to the invite's business. */
export const acceptInvite = (code: string): Promise<{ businessId: string; role: string }> =>
  post<{ businessId: string; role: string }>('/api/invites/accept', { code });

export const updateMember = (
  memberId: string,
  patchBody: { role?: string; status?: string; grants?: string[]; denials?: string[] },
): Promise<{ ok: boolean }> => patch<{ ok: boolean }>(`/api/members/${encodeURIComponent(memberId)}`, patchBody);

export const auditLog = (limit = 100): Promise<AuditEntry[]> => get<AuditEntry[]>('/api/audit', { query: { limit } });

// ------------------------------------------------------------------ catalog

export const listUnits = (dimension?: string): Promise<UnitView[]> => get<UnitView[]>('/api/units', { query: { dimension } });

export const createUnitConversion = (input: {
  id?: string;
  from: string;
  to: string;
  factor: string;
  note: string;
  itemId?: string;
}): Promise<{ id: string }> => post<{ id: string }>('/api/units/conversions', input);

export const listLocations = (): Promise<LocationView[]> => get<LocationView[]>('/api/locations');

export const createLocation = (input: { name: string; kind?: string; address?: string }): Promise<{ id: string }> =>
  post<{ id: string }>('/api/locations', input);

export interface ProductInput {
  readonly id?: string;
  readonly name?: string;
  readonly nameBn?: string;
  readonly sku?: string;
  readonly kind?: string;
  readonly unit?: string;
  readonly salePrice?: string | null;
  readonly purchasePrice?: string | null;
  readonly taxRate?: string | null;
  readonly reorderLevel?: string | null;
  readonly trackLots?: boolean;
  readonly isActive?: boolean;
}

export const listProducts = (options: { search?: string; kind?: string } = {}): Promise<ProductView[]> =>
  get<ProductView[]>('/api/products', { query: options });

export const createProduct = (input: ProductInput): Promise<ProductView> => post<ProductView>('/api/products', input);

export const updateProduct = (id: string, input: ProductInput): Promise<ProductView> =>
  patch<ProductView>(`/api/products/${encodeURIComponent(id)}`, input);

export interface CustomerInput {
  readonly name: string;
  readonly phone?: string;
  readonly email?: string;
  readonly address?: string;
  readonly openingBalance?: string;
  readonly creditLimit?: string | null;
}

export const listCustomers = (search?: string): Promise<CustomerView[]> => get<CustomerView[]>('/api/customers', { query: { search } });
export const createCustomer = (input: CustomerInput): Promise<{ id: string }> => post<{ id: string }>('/api/customers', input);

export interface SupplierInput {
  readonly name: string;
  readonly phone?: string;
  readonly email?: string;
  readonly address?: string;
  readonly openingBalance?: string;
}

export const listSuppliers = (search?: string): Promise<SupplierView[]> => get<SupplierView[]>('/api/suppliers', { query: { search } });
export const createSupplier = (input: SupplierInput): Promise<{ id: string }> => post<{ id: string }>('/api/suppliers', input);

// ---------------------------------------------------------------- inventory

export const listInventory = (): Promise<StockRow[]> => get<StockRow[]>('/api/inventory');
export const listMovements = (itemId?: string): Promise<MovementRow[]> => get<MovementRow[]>('/api/inventory/movements', { query: { itemId } });

export interface AdjustStockInput {
  readonly itemId: string;
  readonly direction: 'IN' | 'OUT';
  readonly quantity: string;
  readonly unit: string;
  readonly reason: string;
  readonly unitCost?: string;
  readonly currency?: string;
  /** Requires `inventory.adjust.approve` on the server. */
  readonly allowNegative?: boolean;
}

export const adjustStock = (input: AdjustStockInput): Promise<{ id: string }> => post<{ id: string }>('/api/inventory/adjust', input);

// ----------------------------------------------------------------- commerce

export interface PurchaseLineInput {
  readonly productId: string;
  readonly quantity: string;
  readonly unit: string;
  readonly unitCost: string;
  readonly tax?: string;
  readonly lotNo?: string;
  readonly expiryDate?: string;
}

export interface PurchaseInput {
  readonly documentDate: IsoDate;
  readonly supplierId?: string;
  readonly locationId?: string;
  readonly reference?: string;
  readonly currency?: string;
  readonly paid?: string;
  readonly accountCode?: string;
  readonly note?: string;
  readonly deviceId?: string;
  readonly lines: readonly PurchaseLineInput[];
}

export const createPurchase = (input: PurchaseInput): Promise<PurchasePostResult> => post<PurchasePostResult>('/api/purchases', input);

export const listPurchases = (from?: IsoDate, to?: IsoDate): Promise<PurchaseView[]> =>
  get<PurchaseView[]>('/api/purchases', { query: { from, to } });

export interface SaleLineInput {
  readonly productId?: string;
  readonly description?: string;
  readonly quantity: string;
  readonly unit: string;
  readonly unitPrice: string;
  readonly discount?: string;
  readonly tax?: string;
}

export interface SaleInput {
  readonly documentDate: IsoDate;
  readonly customerId?: string;
  readonly locationId?: string;
  readonly reference?: string;
  readonly currency?: string;
  readonly discount?: string;
  readonly cashReceived?: string;
  readonly accountCode?: string;
  readonly note?: string;
  readonly deviceId?: string;
  readonly allowNegative?: boolean;
  readonly negativeReason?: string;
  readonly lines: readonly SaleLineInput[];
}

export const createSale = (input: SaleInput): Promise<SalePostResult> => post<SalePostResult>('/api/sales', input);
export const listSales = (from?: IsoDate, to?: IsoDate): Promise<SaleView[]> => get<SaleView[]>('/api/sales', { query: { from, to } });

export const createReceipt = (input: {
  documentDate: IsoDate;
  amount: string;
  customerId?: string;
  accountCode?: string;
  reference?: string;
  note?: string;
}): Promise<ReceiptResult> => post<ReceiptResult>('/api/receipts', input);

export const createSupplierPayment = (input: {
  documentDate: IsoDate;
  amount: string;
  supplierId?: string;
  accountCode?: string;
  reference?: string;
  note?: string;
}): Promise<PaymentResult> => post<PaymentResult>('/api/payments', input);

export const createTransfer = (input: {
  documentDate: IsoDate;
  amount: string;
  fromAccount: string;
  toAccount: string;
  reference?: string;
  note?: string;
}): Promise<{ reference: string; amount: string }> => post<{ reference: string; amount: string }>('/api/transfers', input);

export const createIncomeExpense = (input: {
  kind: 'INCOME' | 'EXPENSE';
  categoryAccount: string;
  documentDate: IsoDate;
  amount: string;
  accountCode?: string;
  paid?: boolean;
  reference?: string;
  note?: string;
}): Promise<{ reference: string; amount: string }> => post<{ reference: string; amount: string }>('/api/income-expenses', input);

export const createPartnerCapital = (input: {
  memberId: string;
  kind: 'CONTRIBUTION' | 'WITHDRAWAL';
  documentDate: IsoDate;
  amount: string;
  accountCode?: string;
  reference?: string;
  note?: string;
}): Promise<{ reference: string; amount: string; kind: string }> =>
  post<{ reference: string; amount: string; kind: string }>('/api/partner-capital', input);

export const listAccounts = (): Promise<AccountView[]> => get<AccountView[]>('/api/accounts');

// ------------------------------------------------------------------- farming

export const listFarms = (): Promise<FarmView[]> => get<FarmView[]>('/api/farming/farms');

export const createFarm = (input: {
  name: string;
  address?: string;
  area?: string;
  areaUnit?: string;
  locationId?: string;
  notes?: string;
}): Promise<{ id: string }> => post<{ id: string }>('/api/farming/farms', input);

export const createFarmUnit = (input: {
  farmId: string;
  kind: string;
  name: string;
  area?: string;
  areaUnit?: string;
  capacity?: string;
  capacityUnit?: string;
}): Promise<{ id: string }> => post<{ id: string }>('/api/farming/units', input);

export const listCycles = (status?: string): Promise<CycleView[]> => get<CycleView[]>('/api/farming/cycles', { query: { status } });

export const createCycle = (input: {
  farmId: string;
  unitId: string;
  farmingType: string;
  title: string;
  startDate: IsoDate;
  cropOrSpecies?: string;
  varietyOrBreed?: string;
  season?: string;
  responsibleMemberId?: string;
  expectedEndDate?: IsoDate;
  plannedOutput?: string;
  plannedOutputUnit?: string;
  startingPopulation?: string;
  notes?: string;
}): Promise<{ id: string; reference: string; status: string }> =>
  post<{ id: string; reference: string; status: string }>('/api/farming/cycles', input);

export interface FarmingEventInput {
  readonly cycleId: string;
  readonly eventType: string;
  readonly occurredOn: IsoDate;
  readonly productId?: string;
  readonly quantity?: string;
  readonly unit?: string;
  readonly amount?: string;
  readonly accountCode?: string;
  readonly paymentAccount?: string;
  readonly paid?: boolean;
  readonly reason?: string;
  readonly kind?: string;
  readonly value?: string;
  readonly bookValue?: string;
  readonly notes?: string;
  readonly currency?: string;
}

export const recordFarmingEvent = ({ cycleId, ...body }: FarmingEventInput): Promise<FarmingEventResult> =>
  post<FarmingEventResult>(`/api/farming/cycles/${encodeURIComponent(cycleId)}/events`, body);

export const recordHarvest = (input: {
  cycleId: string;
  quantity: string;
  unit: string;
  occurredOn: IsoDate;
  method?: 'PLANNED_YIELD_PRORATA' | 'CLOSING_REMAINDER';
  productId?: string;
  locationId?: string;
  lotNo?: string;
  grade?: string;
  notes?: string;
}): Promise<import('./types').HarvestResult> => {
  const { cycleId, ...body } = input;
  return post<import('./types').HarvestResult>(`/api/farming/cycles/${encodeURIComponent(cycleId)}/harvest`, body);
};

export const closeCycle = (
  cycleId: string,
  input: { closedOn?: IsoDate; harvestRemainingCost?: boolean; remainingQuantity?: string } = {},
): Promise<{ cycleId: string; status: string; releasedToFinishedStock: string }> =>
  post<{ cycleId: string; status: string; releasedToFinishedStock: string }>(
    `/api/farming/cycles/${encodeURIComponent(cycleId)}/close`,
    input,
  );

export const cycleProfit = (cycleId: string): Promise<CycleProfitReport> =>
  get<CycleProfitReport>(`/api/farming/cycles/${encodeURIComponent(cycleId)}/profit`);

export const allocateSharedCost = (input: {
  amount: string;
  basis: string;
  incurredOn: IsoDate;
  targets: readonly { cycleId: string; basisValue: string; manualPercent?: string }[];
  note?: string;
}): Promise<CostAllocationResult> => post<CostAllocationResult>('/api/farming/allocations', input);

export const farmingDashboard = (): Promise<FarmingDashboard> => get<FarmingDashboard>('/api/farming/dashboard');
export const farmingEvents = (): Promise<FarmingEventView[]> => get<FarmingEventView[]>('/api/farming/events');

// ------------------------------------------------------------------- reports

export interface RangeQuery {
  readonly from?: IsoDate;
  readonly to?: IsoDate;
}

/** Spread into a fresh object so the index-signature query type accepts it. */
const rangeQuery = (range: RangeQuery): Record<string, string | undefined> => ({ from: range.from, to: range.to });

export const dashboardReport = (range: RangeQuery = {}): Promise<DashboardReport> =>
  get<DashboardReport>('/api/reports/dashboard', { query: rangeQuery(range) });
export const profitAndLoss = (range: RangeQuery = {}): Promise<ProfitAndLossReport> =>
  get<ProfitAndLossReport>('/api/reports/profit-loss', { query: rangeQuery(range) });
export const balanceSheet = (asOf?: IsoDate): Promise<BalanceSheetReport> =>
  get<BalanceSheetReport>('/api/reports/balance-sheet', { query: { asOf } });
export const trialBalance = (range: RangeQuery = {}): Promise<Record<string, unknown>> =>
  get<Record<string, unknown>>('/api/reports/trial-balance', { query: rangeQuery(range) });
export const cashFlow = (range: RangeQuery = {}): Promise<CashFlowReport> => get<CashFlowReport>('/api/reports/cash-flow', { query: rangeQuery(range) });
export const receivables = (): Promise<ReceivableRow[]> => get<ReceivableRow[]>('/api/reports/receivables');
export const payables = (): Promise<PayableRow[]> => get<PayableRow[]>('/api/reports/payables');
export const backupDump = (): Promise<BackupDump> => get<BackupDump>('/api/reports/backup');

/** `GET /api/reports/export/:table` returns CSV text, not JSON. */
export const exportTableCsv = (table: string): Promise<string> => request<string>('GET', `/api/reports/export/${encodeURIComponent(table)}`);

export const EXPORTABLE_TABLES = [
  'sales',
  'purchases',
  'stock_movements',
  'journal_lines',
  'products',
  'customers',
  'suppliers',
  'production_cycles',
  'harvests',
  'cost_sources',
] as const;

// ---------------------------------------------------------------------- sync

/** `events` must be a whole `OutboxEvent` (the server re-hashes and validates it). */
export const pushEvents = (events: readonly unknown[]): Promise<PushResponse> =>
  post<PushResponse>('/api/sync/push', { events }, { timeoutMs: 60_000 });

export const pullChanges = (since: string): Promise<PullResponse> =>
  get<PullResponse>('/api/sync/pull', { query: { since }, timeoutMs: 60_000 });

export const listConflicts = (): Promise<import('./types').ConflictRow[]> => get('/api/sync/conflicts');

export const resolveConflict = (conflictId: string, resolution: 'LOCAL_WINS' | 'SERVER_WINS'): Promise<{ ok: boolean }> =>
  post<{ ok: boolean }>(`/api/sync/conflicts/${encodeURIComponent(conflictId)}/resolve`, { resolution });

// ------------------------------------------------------------------------ ai

export const aiStatus = (): Promise<AIStatus> => get<AIStatus>('/api/ai/status');

export const aiAsk = (input: { question: string; language?: 'bn' | 'en'; conversationId?: string }): Promise<AIAnswer> =>
  post<AIAnswer>('/api/ai/ask', input, { timeoutMs: 60_000 });

export const aiConversations = (): Promise<AIConversationSummary[]> => get<AIConversationSummary[]>('/api/ai/conversations');
export const aiConversation = (id: string): Promise<AIConversationDetail> =>
  get<AIConversationDetail>(`/api/ai/conversations/${encodeURIComponent(id)}`);
export const aiDeleteConversation = (id: string): Promise<{ ok: boolean }> =>
  del<{ ok: boolean }>(`/api/ai/conversations/${encodeURIComponent(id)}`);

export const aiSavePlan = (input: { title: string; content: string; kind?: string }): Promise<Record<string, unknown>> =>
  post<Record<string, unknown>>('/api/ai/plans', input);
export const aiPlans = (): Promise<Record<string, unknown>[]> => get<Record<string, unknown>[]>('/api/ai/plans');
export const aiFeedback = (input: { messageId: string; helpful: boolean; comment?: string }): Promise<{ ok: boolean }> =>
  post<{ ok: boolean }>('/api/ai/feedback', input);
export const aiResearch = (query: string): Promise<Record<string, unknown>> => post<Record<string, unknown>>('/api/ai/research', { query }, { timeoutMs: 60_000 });

// --------------------------------------------------------------- attachments

export const listAttachments = (entityType: string, entityId: string): Promise<AttachmentInfo[]> =>
  get<AttachmentInfo[]>(`/api/attachments/${encodeURIComponent(entityType)}/${encodeURIComponent(entityId)}`);

/**
 * Uploads one photo for an entity and resolves the server's receipt.
 * Kept separate from the outbox on purpose: see `src/offline/attachments.ts`.
 */
export const uploadAttachment = (
  entityType: string,
  entityId: string,
  bytes: Uint8Array,
  fileName: string,
  contentType: string,
): Promise<AttachmentUploadResult> =>
  uploadBytes(`/api/attachments/${encodeURIComponent(entityType)}/${encodeURIComponent(entityId)}`, bytes, {
    fileName,
    contentType,
  }) as Promise<AttachmentUploadResult>;

export type { SyncStatus, UserSummary };
