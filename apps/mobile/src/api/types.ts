import type { Permission, Role } from '@sbm/domain';

/**
 * Wire types for `apps/api/src/routes.ts`.
 *
 * Convention from the server that the whole app depends on:
 *  - every monetary or quantity value crosses the wire as a **string** (never a
 *    float), and is only ever parsed through `@sbm/domain`'s `Decimal`/`money`;
 *  - errors always look like `{ error: { code, message } }`;
 *  - rows the caller may not see are simply *absent* (e.g. `purchasePrice`), and
 *    the UI renders a "restricted" state instead of guessing.
 */

// ---------------------------------------------------------------- primitives

/** ISO calendar date, `YYYY-MM-DD`. */
export type IsoDate = string;
/** ISO instant, `YYYY-MM-DDTHH:mm:ss.sssZ`. */
export type IsoInstant = string;
/** An exact decimal number carried as a string. */
export type DecimalString = string;
/** An exact money amount carried as a string, paired with `currency`. */
export type MoneyString = string;

export type SyncStatus = 'PENDING' | 'SYNCING' | 'SYNCED' | 'NEEDS_ATTENTION' | 'CONFLICT' | 'REJECTED';

// --------------------------------------------------------------------- auth

export interface UserSummary {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly locale?: string;
}

export interface BusinessMembership {
  readonly businessId: string;
  readonly name?: string;
  readonly role: Role;
  readonly slug?: string;
}

export interface RegisterResponse {
  readonly user: UserSummary;
  readonly businessId: string | null;
  readonly expiresAt: string;
}

export interface LoginResponse {
  readonly user: UserSummary;
  readonly businesses: readonly BusinessMembership[];
  readonly businessId: string | null;
}

export interface MeResponse {
  readonly user: UserSummary;
  readonly businesses: readonly BusinessMembership[];
  readonly activeBusinessId: string | null;
}

// ----------------------------------------------------------------- business

export interface BusinessSettings {
  readonly partnerCanSeeFinancialReports?: boolean;
  readonly partnerCanSeeCosts?: boolean;
  readonly partnerCanSeeCapital?: boolean;
  readonly lowStockAlerts?: boolean;
  readonly mortalityWarningPercent?: string | number | null;
  readonly decimalPlaces?: number | null;
}

export interface CurrentBusiness {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly currency: string;
  readonly timezone: string;
  readonly locale: string;
  readonly country: string;
  readonly farming_types?: string;
  readonly farmingTypes: readonly string[];
  readonly enabledModules: readonly string[];
  readonly settings: BusinessSettings;
  readonly member: {
    readonly id: string;
    readonly role: Role;
    readonly displayName: string;
    readonly grants: readonly Permission[];
    readonly denials: readonly Permission[];
  };
  readonly permissions: readonly Permission[];
  readonly revision?: number;
}

export interface CreateBusinessResponse {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly role: Role;
}

// ------------------------------------------------------------------ members

export interface MemberView {
  readonly id: string;
  readonly userId: string;
  readonly email: string;
  readonly displayName: string;
  readonly role: Role;
  readonly status: 'active' | 'invited' | 'suspended' | 'removed';
  readonly grants: readonly Permission[];
  readonly denials: readonly Permission[];
  readonly joinedAt: IsoInstant;
  readonly lastActiveAt: IsoInstant | null;
}

export interface InviteView {
  readonly id: string;
  readonly email: string | null;
  readonly role: Role;
  readonly status: 'open' | 'accepted' | 'expired' | 'revoked';
  readonly createdAt: IsoInstant;
  readonly expiresAt: IsoInstant;
  readonly uses: number;
  readonly maxUses: number;
  readonly codePrefix: string;
}

/** Only ever returned by the create call — the server never stores the code. */
export interface CreatedInvite {
  readonly code: string;
  readonly invite: {
    readonly id: string;
    readonly role: Role;
    readonly email: string | null;
    readonly expiresAt: IsoInstant;
    readonly codePrefix: string;
  };
}

export interface AuditEntry {
  readonly id: string;
  readonly actor: string | null;
  readonly action: string;
  readonly entityType: string;
  readonly entityId: string | null;
  readonly detail: Record<string, unknown>;
  readonly at: IsoInstant;
}

// ------------------------------------------------------------ catalog/stock

export interface UnitView {
  readonly code: string;
  readonly name: string;
  readonly nameBn: string;
  readonly dimension: string;
  readonly factor: DecimalString;
  readonly integerOnly: boolean;
}

export interface LocationView {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly address: string | null;
  readonly isDefault: boolean;
  readonly isActive: boolean;
}

export type ProductKind = 'PRODUCT' | 'SERVICE' | 'INPUT' | 'OUTPUT' | 'LIVESTOCK';

export interface ProductView {
  readonly id: string;
  readonly sku: string | null;
  readonly name: string;
  readonly nameBn: string | null;
  readonly kind: ProductKind;
  readonly unit: string;
  readonly categoryId: string | null;
  readonly isActive: boolean;
  readonly trackLots: boolean;
  readonly revision: number;
  readonly salePrice: DecimalString | null;
  readonly reorderLevel: DecimalString | null;
  /** Absent unless the caller may see purchase cost. */
  readonly purchasePrice?: DecimalString | null;
  readonly taxRate?: DecimalString | null;
  readonly onHand: DecimalString;
  readonly onHandUnit: string;
}

export interface CustomerView {
  readonly id: string;
  readonly name: string;
  readonly phone: string | null;
  readonly email: string | null;
  /** Sum of unpaid invoices, exact decimal string. */
  readonly receivable?: DecimalString;
}

export interface SupplierView {
  readonly id: string;
  readonly name: string;
  readonly phone: string | null;
  readonly payable?: DecimalString;
}

export interface StockRow {
  readonly itemId: string;
  readonly name: string;
  readonly unit: string;
  readonly onHand: DecimalString;
  readonly reorderLevel: DecimalString | null;
  readonly belowReorder: boolean;
  /** Absent unless the caller may see cost. */
  readonly unitCost?: DecimalString;
  readonly value?: DecimalString;
}

export interface MovementRow {
  readonly id: string;
  readonly itemId: string;
  readonly locationId: string | null;
  readonly direction: 'IN' | 'OUT';
  readonly quantity: DecimalString;
  readonly unit: string;
  readonly sourceType: string;
  readonly sourceId: string | null;
  readonly reason: string | null;
  readonly occurredAt: IsoDate;
}

// ----------------------------------------------------------------- commerce

export interface PurchaseLineView {
  readonly productId: string | null;
  readonly quantity: DecimalString;
  readonly unit: string;
  readonly unitCost: DecimalString;
  readonly lineTotal: DecimalString;
}

export interface PurchaseView {
  readonly id: string;
  readonly reference: string;
  readonly supplierId: string | null;
  readonly documentDate: IsoDate;
  readonly currency: string;
  readonly total: MoneyString;
  readonly paid: MoneyString;
  readonly payable: MoneyString;
  readonly subtotal?: MoneyString;
  readonly tax?: MoneyString;
  readonly lines: readonly PurchaseLineView[];
}

export interface SaleLineView {
  readonly productId: string | null;
  readonly description: string;
  readonly quantity: DecimalString;
  readonly unit: string;
  readonly unitPrice: MoneyString;
  readonly lineTotal: MoneyString;
}

export interface SaleView {
  readonly id: string;
  readonly reference: string;
  readonly customerId: string | null;
  readonly documentDate: IsoDate;
  readonly currency: string;
  readonly gross: MoneyString;
  readonly discount: MoneyString;
  readonly net: MoneyString;
  readonly cashReceived: MoneyString;
  readonly receivable: MoneyString;
  /** Absent unless the caller may see cost. */
  readonly cogs?: MoneyString;
  readonly grossProfit?: string;
  readonly lines: readonly SaleLineView[];
}

/** Response of `POST /api/sales`. */
export interface SalePostResult {
  readonly id: string;
  readonly reference: string;
  readonly gross: MoneyString;
  readonly discount: MoneyString;
  readonly net: MoneyString;
  readonly cashReceived: MoneyString;
  readonly receivable: MoneyString;
  readonly cogs?: MoneyString;
  readonly currency: string;
}

export interface PurchasePostResult {
  readonly id: string;
  readonly reference: string;
  readonly total: MoneyString;
  readonly payable: MoneyString;
  readonly paid: MoneyString;
  readonly currency: string;
}

export interface ReceiptResult {
  readonly reference: string;
  readonly amount: MoneyString;
  readonly receivableRemaining: MoneyString | null;
}

export interface PaymentResult {
  readonly reference: string;
  readonly amount: MoneyString;
  readonly payableRemaining: MoneyString | null;
}

export interface AccountView {
  readonly code: string;
  readonly name: string;
  readonly nameBn: string;
  readonly type: 'ASSET' | 'LIABILITY' | 'EQUITY' | 'REVENUE' | 'EXPENSE';
  readonly balance: MoneyString;
  readonly isCash: boolean;
}

// -------------------------------------------------------------------- farms

export interface FarmUnitView {
  readonly id: string;
  readonly kind: string;
  readonly name: string;
  readonly area: DecimalString | null;
  readonly area_unit?: string | null;
  readonly areaUnit?: string | null;
  readonly capacity: DecimalString | null;
  readonly capacity_unit?: string | null;
  readonly capacityUnit?: string | null;
}

export interface FarmView {
  readonly id: string;
  readonly name: string;
  readonly address: string | null;
  readonly area: DecimalString | null;
  readonly areaUnit: string | null;
  readonly units: readonly FarmUnitView[];
}

export interface CycleView {
  readonly id: string;
  readonly reference: string;
  readonly farmingType: string;
  readonly title: string;
  readonly cropOrSpecies: string | null;
  readonly varietyOrBreed: string | null;
  readonly status: 'PLANNED' | 'ACTIVE' | 'HARVESTING' | 'CLOSED' | 'CANCELLED';
  readonly farmId: string;
  readonly unitId: string;
  readonly startDate: IsoDate;
  readonly expectedEndDate: IsoDate | null;
  readonly plannedOutput: DecimalString | null;
  readonly plannedOutputUnit: string | null;
  readonly startingPopulation: DecimalString | null;
  readonly harvestedQuantity: DecimalString;
  /** Absent unless the caller may see farming cost. */
  readonly costToDate?: MoneyString;
  readonly revenue?: MoneyString;
  readonly cogs?: MoneyString;
  readonly grossProfit?: string;
  readonly costVisibility?: 'restricted';
}

export interface FarmingEventView {
  readonly id: string;
  readonly cycleId: string;
  readonly cycleReference: string;
  readonly eventType: string;
  readonly occurredOn: IsoDate;
  readonly quantity: DecimalString | null;
  readonly unit: string | null;
  readonly amount: MoneyString | null;
  readonly currency: string | null;
  readonly notes: string | null;
}

export interface FarmingEventResult {
  readonly eventType: string;
  readonly cost?: MoneyString;
  readonly currency?: string;
  readonly costToDate?: MoneyString;
  readonly quantity?: DecimalString;
  readonly abnormal?: boolean;
  readonly escalation?: string | null;
  readonly cycleReference?: string;
  readonly recorded?: boolean;
}

export interface HarvestResult {
  readonly harvestId: string;
  readonly quantity: DecimalString;
  readonly unitCost: MoneyString;
  readonly costBasis: MoneyString;
  readonly capped: boolean;
  readonly costToDate: MoneyString;
  readonly remainingCostInBatch: MoneyString;
  readonly currency: string;
  readonly note: string;
}

export interface CostAllocationResult {
  readonly costSourceId: string;
  readonly basis: string;
  readonly currency: string;
  readonly totalCost: MoneyString;
  readonly shares: readonly { readonly cycleId: string; readonly amount: MoneyString; readonly ratio: DecimalString }[];
  readonly allocatedTotal: MoneyString;
  readonly unallocated: MoneyString;
}

export interface CycleProfitReport {
  readonly cycleId: string;
  readonly reference: string;
  readonly title: string;
  readonly farmingType: string;
  readonly currency: string;
  readonly costToDate: MoneyString;
  readonly costBreakdown: readonly { readonly kind: string; readonly amount: MoneyString }[];
  readonly harvestedQuantity: DecimalString;
  readonly outputUnit: string;
  readonly assignedToFinishedStock: MoneyString;
  readonly costRemainingInBatch: MoneyString;
  readonly revenue: MoneyString;
  readonly cogs: MoneyString;
  readonly grossProfit: MoneyString;
  readonly costInUnsoldOutput: MoneyString;
  readonly note: string;
}

export interface FarmingDashboard {
  readonly currency: string;
  readonly activeCycles: number;
  readonly closedCycles: number;
  readonly totalCostToDate: MoneyString;
  readonly revenue: MoneyString;
  readonly grossProfit: string;
  readonly mortalityAlerts: number;
  readonly mortalityRecords: number;
  readonly cycles: readonly CycleView[];
}

// ------------------------------------------------------------------ reports

export interface DashboardReport {
  readonly range: { readonly from: IsoDate; readonly to: IsoDate };
  readonly currency: string;
  readonly sales: MoneyString;
  readonly purchases: MoneyString;
  readonly cashBalance: MoneyString;
  readonly cashReceived: MoneyString;
  readonly cashPaid: MoneyString;
  readonly receivables: MoneyString;
  readonly payables: MoneyString;
  readonly lowStockItems: number;
  readonly revenue?: MoneyString;
  readonly costOfGoodsSold?: MoneyString;
  readonly grossProfit?: string;
  readonly operatingExpenses?: MoneyString;
  readonly netProfit?: string;
  readonly cashBasisResult?: string;
  readonly costVisibility?: 'restricted';
}

export interface ProfitAndLossReport {
  readonly from: IsoDate;
  readonly to: IsoDate;
  readonly currency: string;
  readonly basis: 'ACCRUAL';
  readonly revenue: MoneyString;
  readonly contraRevenue: MoneyString;
  readonly netRevenue: MoneyString;
  readonly costOfGoodsSold: MoneyString;
  readonly grossProfit: MoneyString;
  readonly operatingExpenses: MoneyString;
  readonly expensesByAccount: readonly { readonly account: string; readonly name: string; readonly amount: MoneyString }[];
  readonly otherIncome: MoneyString;
  readonly netProfit: MoneyString;
  readonly cashBasisResult: string;
  readonly note: string;
}

export interface BalanceSheetReport {
  readonly asOf: IsoDate;
  readonly currency: string;
  readonly assets: readonly { readonly account: string; readonly name: string; readonly amount: MoneyString }[];
  readonly liabilities: readonly { readonly account: string; readonly name: string; readonly amount: MoneyString }[];
  readonly equity: readonly { readonly account: string; readonly name: string; readonly amount: MoneyString }[];
  readonly totalAssets: MoneyString;
  readonly totalLiabilities: MoneyString;
  readonly totalEquity: MoneyString;
  readonly totalEquityIncludingResult: MoneyString;
  readonly balanced: boolean;
}

export interface CashFlowReport {
  readonly from: IsoDate;
  readonly to: IsoDate;
  readonly currency: string;
  readonly opening: MoneyString;
  readonly inflows: MoneyString;
  readonly outflows: MoneyString;
  readonly netChange: MoneyString;
  readonly closing: MoneyString;
}

export interface ReceivableRow {
  readonly customerId: string;
  readonly name: string;
  readonly phone: string | null;
  readonly outstanding: MoneyString;
}

export interface PayableRow {
  readonly supplierId: string;
  readonly name: string;
  readonly phone: string | null;
  readonly outstanding: MoneyString;
}

export interface BackupDump {
  readonly exportedAt: IsoInstant;
  readonly businessId: string;
  readonly format: 'sbm-backup-v1';
  readonly tables: Record<string, readonly Record<string, unknown>[]>;
}

// --------------------------------------------------------------------- sync

export interface PushResultDto {
  readonly idempotencyKey: string;
  readonly eventId: string;
  readonly status: 'SYNCED' | 'CONFLICT' | 'REJECTED' | 'NEEDS_ATTENTION';
  readonly serverRevision?: number;
  readonly aggregateType?: string;
  readonly aggregateId?: string;
  readonly result?: unknown;
  readonly message?: string;
}

export interface PushResponse {
  readonly results: readonly PushResultDto[];
}

/** Mirrors `SyncService.pull` — snake_case columns for the mirrored tables. */
export interface PullResponse {
  readonly since: IsoInstant;
  readonly serverTime: IsoInstant;
  readonly serverTimeIso: IsoInstant;
  readonly businessRevision: number;
  readonly business: {
    readonly id: string;
    readonly name: string;
    readonly currency: string;
    readonly timezone: string;
    readonly locale: string;
    readonly farmingTypes: readonly string[];
    readonly revision: number;
  };
  readonly products: readonly Record<string, unknown>[];
  readonly customers: readonly Record<string, unknown>[];
  readonly suppliers: readonly Record<string, unknown>[];
  readonly locations: readonly Record<string, unknown>[];
  readonly sales: readonly Record<string, unknown>[];
  readonly saleLines: readonly Record<string, unknown>[];
  readonly purchases: readonly Record<string, unknown>[];
  readonly purchaseLines: readonly Record<string, unknown>[];
  readonly stockMovements: readonly Record<string, unknown>[];
  readonly journalEntries: readonly Record<string, unknown>[];
  readonly journalLines: readonly Record<string, unknown>[];
  readonly farms: readonly Record<string, unknown>[];
  readonly farmUnits: readonly Record<string, unknown>[];
  readonly cycles: readonly Record<string, unknown>[];
  readonly farmingEvents: readonly Record<string, unknown>[];
  readonly harvests: readonly Record<string, unknown>[];
  readonly costAllocations: readonly Record<string, unknown>[];
  readonly conflicts: readonly ConflictRow[];
}

export interface ConflictRow {
  readonly id: string;
  readonly business_id: string;
  readonly aggregate_type: string;
  readonly aggregate_id: string;
  readonly event_id: string;
  readonly device_id: string | null;
  readonly base_revision: number | null;
  readonly server_revision: number | null;
  readonly differing_fields: string;
  readonly auto_mergeable: number;
  readonly detail: string;
  readonly status: 'OPEN' | 'LOCAL_WINS' | 'SERVER_WINS';
  readonly created_at: IsoInstant;
  readonly resolved_at?: IsoInstant | null;
}

// ----------------------------------------------------------------------- ai

export type AIMode = 'generative' | 'local' | 'fallback';

export type CitationKind = 'OFFICIAL' | 'RESEARCH' | 'RETAILER' | 'USER_REVIEW' | 'WARNING' | 'CURATED_LINK';

export interface Citation {
  readonly title: string;
  readonly publisher: string;
  readonly url: string;
  readonly publishedAt?: string;
  readonly accessedAt: string;
  readonly excerpt: string;
  readonly kind: CitationKind;
  readonly note?: string;
}

export interface AIAnswer {
  readonly text: string;
  /** `generative` (user's own OpenAI-compatible endpoint) | `local` (Ollama) | `fallback` (rule engine). */
  readonly mode: AIMode;
  readonly provider: string;
  readonly citations: readonly Citation[];
  readonly factsUsed: readonly string[];
  readonly usage: { readonly tokensIn: number; readonly tokensOut: number };
  readonly limitations: readonly string[];
  readonly conversationId?: string;
}

export interface AIStatus {
  readonly provider: string;
  readonly mode: AIMode;
  readonly configured: boolean;
  readonly research: { readonly provider: string; readonly configured: boolean };
  readonly limits: { readonly timeoutMs: number; readonly maxOutputTokens: number; readonly requestsPerHour: number };
  readonly notes: readonly string[];
}

export interface AIConversationSummary {
  readonly id: string;
  readonly title?: string;
  readonly createdAt?: IsoInstant;
  readonly updatedAt?: IsoInstant;
  readonly [key: string]: unknown;
}

export interface AIConversationDetail {
  readonly id: string;
  readonly messages: readonly {
    readonly role: 'user' | 'assistant';
    readonly content: string;
    readonly mode?: AIMode;
    readonly provider?: string;
    readonly citations?: readonly Citation[];
    readonly createdAt?: IsoInstant;
  }[];
}

// ------------------------------------------------------------- attachments

export interface AttachmentInfo {
  readonly id: string;
  readonly fileName: string;
  readonly mime: string;
  readonly sizeBytes: number;
  readonly checksum: string;
  readonly createdAt: IsoInstant;
}

export interface AttachmentUploadResult {
  readonly id: string;
  readonly fileName: string;
  readonly sizeBytes: number;
  readonly checksum: string;
  readonly note: string;
}

// ------------------------------------------------------------------- misc

export interface HealthResponse {
  readonly status: 'ok';
  readonly service: string;
  readonly schemaVersion: number;
  readonly time: IsoInstant;
}

export interface MetaResponse {
  readonly roles: readonly { readonly role: Role; readonly name: string; readonly nameBn: string; readonly description: string }[];
  readonly accounts: readonly { readonly code: string; readonly name: string; readonly nameBn?: string; readonly type: string }[];
  readonly farmingTypes: readonly { readonly type: string; readonly name: string; readonly nameBn: string }[];
  readonly farmUnitKinds: readonly { readonly kind: string; readonly name: string; readonly nameBn: string }[];
  readonly allocationBases: readonly { readonly basis: string; readonly name: string; readonly description: string }[];
  readonly routes: readonly string[];
}
