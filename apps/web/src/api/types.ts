/**
 * Response shapes for the endpoints the web app calls.
 *
 * IMPORTANT: every money and quantity value is a STRING (exact decimals). Never
 * run `Number()` on them — use `dec` / `money` from `@sbm/domain`.
 */

export interface UserSummary {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly locale?: string;
}

export interface BusinessSummary {
  readonly businessId: string;
  readonly name: string;
  readonly slug: string;
  readonly currency: string;
  readonly timezone: string;
  readonly role: string;
}

export interface MeResponse {
  readonly user: UserSummary;
  readonly businesses: readonly BusinessSummary[];
  readonly activeBusinessId: string | null;
}

export type PermissionName = string;

export type VisibilitySettings = {
  readonly partnerCanSeeFinancialReports?: boolean;
  readonly partnerCanSeeCosts?: boolean;
  readonly partnerCanSeeCapital?: boolean;
  readonly lowStockAlerts?: boolean;
  readonly mortalityWarningPercent?: number;
  readonly decimalPlaces?: number;
};

export interface BusinessCurrent {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly currency: string;
  readonly timezone: string;
  readonly locale: string;
  readonly country: string;
  readonly farmingTypes: readonly string[];
  readonly enabledModules: readonly string[];
  readonly settings: VisibilitySettings;
  readonly revision: number;
  readonly member: {
    readonly id: string;
    readonly role: string;
    readonly displayName: string;
    readonly grants: readonly string[];
    readonly denials: readonly string[];
  };
  readonly permissions: readonly PermissionName[];
}

export interface UnitRow {
  readonly code: string;
  readonly name: string;
  readonly nameBn: string;
  readonly dimension: string;
  readonly factor: string;
  readonly integerOnly: boolean;
}

export interface LocationRow {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly address: string | null;
  readonly isDefault: boolean;
  readonly isActive: boolean;
}

export type ProductKind = 'PRODUCT' | 'SERVICE' | 'INPUT' | 'OUTPUT' | 'LIVESTOCK';

export interface ProductRow {
  readonly id: string;
  readonly sku: string | null;
  readonly name: string;
  readonly nameBn: string | null;
  readonly kind: string;
  readonly unit: string;
  readonly categoryId: string | null;
  readonly isActive: boolean;
  readonly trackLots: boolean;
  readonly revision: number;
  readonly salePrice: string | null;
  readonly reorderLevel: string | null;
  /** Only present with `purchase.cost.view`. */
  readonly purchasePrice?: string | null;
  readonly taxRate?: string | null;
  readonly onHand: string;
  readonly onHandUnit: string;
}

export interface InventoryRow {
  readonly itemId: string;
  readonly name: string;
  readonly unit: string;
  readonly onHand: string;
  readonly reorderLevel: string | null;
  readonly belowReorder: boolean;
  /** Only present with `purchase.cost.view`. */
  readonly unitCost?: string;
  readonly value?: string;
}

export interface MovementRow {
  readonly id: string;
  readonly itemId: string;
  readonly locationId: string;
  readonly direction: 'IN' | 'OUT';
  readonly quantity: string;
  readonly unit: string;
  readonly sourceType: string;
  readonly sourceId: string;
  readonly reason: string | null;
  readonly occurredAt: string;
}

export interface CustomerRow {
  readonly id: string;
  readonly name: string;
  readonly phone: string | null;
  readonly email: string | null;
  readonly receivable: string;
}

export interface SupplierRow {
  readonly id: string;
  readonly name: string;
  readonly phone: string | null;
  readonly payable: string;
}

export interface SaleLine {
  readonly productId: string | null;
  readonly description: string;
  readonly quantity: string;
  readonly unit: string;
  readonly unitPrice: string;
  readonly lineTotal: string;
}

export interface SaleRow {
  readonly id: string;
  readonly reference: string;
  readonly customerId: string | null;
  readonly documentDate: string;
  readonly currency: string;
  readonly gross: string;
  readonly discount: string;
  readonly net: string;
  readonly cashReceived: string;
  readonly receivable: string;
  /** Only present with cost visibility. */
  readonly cogs?: string;
  readonly grossProfit?: string;
  readonly lines: readonly SaleLine[];
}

export interface PurchaseLine {
  readonly productId: string | null;
  readonly quantity: string;
  readonly unit: string;
  readonly unitCost: string;
  readonly lineTotal: string;
}

export interface PurchaseRow {
  readonly id: string;
  readonly reference: string;
  readonly supplierId: string | null;
  readonly documentDate: string;
  readonly currency: string;
  readonly total: string;
  readonly paid: string;
  readonly payable: string;
  /** Only present with cost visibility. */
  readonly subtotal?: string;
  readonly tax?: string;
  readonly lines: readonly PurchaseLine[];
}

export interface DashboardReport {
  readonly range: { readonly from: string; readonly to: string };
  readonly currency: string;
  readonly sales: string;
  readonly purchases: string;
  readonly cashBalance: string;
  readonly cashReceived: string;
  readonly cashPaid: string;
  readonly receivables: string;
  readonly payables: string;
  readonly lowStockItems: number;
  readonly revenue?: string;
  readonly costOfGoodsSold?: string;
  readonly grossProfit?: string;
  readonly operatingExpenses?: string;
  readonly netProfit?: string;
  readonly cashBasisResult?: string;
  readonly costVisibility?: 'restricted';
}

export interface ProfitLossReport {
  readonly from: string;
  readonly to: string;
  readonly currency: string;
  readonly basis: string;
  readonly revenue: string;
  readonly contraRevenue: string;
  readonly netRevenue: string;
  readonly costOfGoodsSold: string;
  readonly grossProfit: string;
  readonly operatingExpenses: string;
  readonly expensesByAccount: readonly { readonly account: string; readonly name: string; readonly amount: string }[];
  readonly otherIncome: string;
  readonly netProfit: string;
  readonly cashBasisResult: string;
  readonly note: string;
}

export interface BalanceSheetReport {
  readonly asOf: string;
  readonly currency: string;
  readonly assets: readonly AccountAmount[];
  readonly liabilities: readonly AccountAmount[];
  readonly equity: readonly AccountAmount[];
  readonly totalAssets: string;
  readonly totalLiabilities: string;
  readonly totalEquity: string;
  readonly totalEquityIncludingResult: string;
  readonly balanced: boolean;
}

export interface AccountAmount {
  readonly account: string;
  readonly name: string;
  readonly amount: string;
}

export interface TrialBalanceReport {
  readonly currency: string;
  readonly balanced: boolean;
  readonly totalDebit: string;
  readonly totalCredit: string;
  readonly rows: readonly {
    readonly account: string;
    readonly name: string;
    readonly type: string;
    readonly debit: string;
    readonly credit: string;
  }[];
}

export interface CashFlowReport {
  readonly from: string;
  readonly to: string;
  readonly currency: string;
  readonly opening: string;
  readonly inflows: string;
  readonly outflows: string;
  readonly netChange: string;
  readonly closing: string;
}

export interface ReceivableRow {
  readonly customerId: string;
  readonly name: string;
  readonly phone: string | null;
  readonly outstanding: string;
}

export interface PayableRow {
  readonly supplierId: string;
  readonly name: string;
  readonly phone: string | null;
  readonly outstanding: string;
}

export interface AccountRow {
  readonly code: string;
  readonly name: string;
  readonly nameBn: string;
  readonly type: string;
  readonly balance: string;
  readonly isCash: boolean;
}

export interface FarmUnitSummary {
  readonly id: string;
  readonly kind: string;
  readonly name: string;
  readonly area: string | null;
  readonly area_unit: string | null;
  readonly capacity: string | null;
  readonly capacity_unit: string | null;
}

export interface FarmRow {
  readonly id: string;
  readonly name: string;
  readonly address: string | null;
  readonly area: string | null;
  readonly areaUnit: string | null;
  readonly units: readonly FarmUnitSummary[];
}

export interface CycleRow {
  readonly id: string;
  readonly reference: string;
  readonly farmingType: string;
  readonly title: string;
  readonly cropOrSpecies: string | null;
  readonly varietyOrBreed: string | null;
  readonly status: string;
  readonly farmId: string;
  readonly unitId: string;
  readonly startDate: string;
  readonly expectedEndDate: string | null;
  readonly plannedOutput: string | null;
  readonly plannedOutputUnit: string | null;
  readonly startingPopulation: string | null;
  readonly harvestedQuantity: string;
  readonly costToDate?: string;
  readonly revenue?: string;
  readonly cogs?: string;
  readonly grossProfit?: string;
  readonly costVisibility?: 'restricted';
}

export interface CycleProfitReport {
  readonly cycleId: string;
  readonly reference: string;
  readonly title: string;
  readonly farmingType: string;
  readonly currency: string;
  readonly costToDate: string;
  readonly costBreakdown: readonly { readonly kind: string; readonly amount: string }[];
  readonly harvestedQuantity: string;
  readonly outputUnit: string;
  readonly assignedToFinishedStock: string;
  readonly costRemainingInBatch: string;
  readonly revenue: string;
  readonly cogs: string;
  readonly grossProfit: string;
  readonly costInUnsoldOutput: string;
  readonly note: string;
}

export interface FarmingEventRow {
  readonly id: string;
  readonly cycleId: string;
  readonly cycleReference: string;
  readonly eventType: string;
  readonly occurredOn: string;
  readonly quantity: string | null;
  readonly unit: string | null;
  readonly amount: string | null;
  readonly currency: string | null;
  readonly notes: string | null;
}

export interface FarmingDashboard {
  readonly currency: string;
  readonly activeCycles: number;
  readonly closedCycles: number;
  readonly totalCostToDate: string;
  readonly revenue: string;
  readonly grossProfit: string;
  readonly mortalityAlerts: number;
  readonly mortalityRecords: number;
  readonly cycles: readonly CycleRow[];
}

export interface MemberRow {
  readonly id: string;
  readonly userId: string;
  readonly email: string;
  readonly displayName: string;
  readonly role: string;
  readonly status: string;
  readonly grants: readonly string[];
  readonly denials: readonly string[];
  readonly joinedAt: string;
  readonly lastActiveAt: string | null;
}

export interface InviteRow {
  readonly id: string;
  readonly email: string | null;
  readonly role: string;
  readonly status: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly uses: number;
  readonly maxUses: number;
  readonly codePrefix: string;
}

export interface CreatedInvite {
  readonly code: string;
  readonly invite: {
    readonly id: string;
    readonly role: string;
    readonly email: string | null;
    readonly expiresAt: string;
    readonly codePrefix: string;
  };
}

export interface AuditRow {
  readonly id: string;
  readonly actor: string | null;
  readonly action: string;
  readonly entityType: string;
  readonly entityId: string | null;
  readonly detail: Record<string, unknown>;
  readonly at: string;
}

export interface ConflictRow {
  readonly id: string;
  readonly business_id: string;
  readonly aggregate_type: string;
  readonly aggregate_id: string;
  readonly event_id: string;
  readonly device_id: string | null;
  readonly actor_id: string | null;
  readonly base_revision: number | null;
  readonly server_revision: number | null;
  readonly differing_fields: string;
  readonly auto_mergeable: number;
  readonly detail: string;
  readonly status: string;
  readonly created_at: string;
  readonly resolved_at?: string | null;
}

/** `POST /api/sync/push` result for one event. */
export interface PushResultRow {
  readonly idempotencyKey: string;
  readonly eventId: string;
  readonly status: 'SYNCED' | 'CONFLICT' | 'REJECTED' | 'NEEDS_ATTENTION';
  readonly serverRevision?: number;
  readonly aggregateType?: string;
  readonly aggregateId?: string;
  readonly result?: unknown;
  readonly message?: string;
}

export type AIMode = 'generative' | 'local' | 'fallback';

export interface Citation {
  readonly title: string;
  readonly publisher: string;
  readonly url: string;
  readonly publishedAt?: string;
  readonly accessedAt: string;
  readonly excerpt: string;
  readonly kind: 'OFFICIAL' | 'RESEARCH' | 'RETAILER' | 'USER_REVIEW' | 'WARNING' | 'CURATED_LINK';
  readonly note?: string;
}

export interface AIAnswer {
  readonly text: string;
  readonly mode: AIMode;
  readonly provider: string;
  readonly citations: readonly Citation[];
  readonly factsUsed: readonly string[];
  readonly usage: { readonly tokensIn: number; readonly tokensOut: number };
  readonly limitations: readonly string[];
}

export interface AIStatus {
  readonly provider: string;
  readonly mode: AIMode;
  readonly configured: boolean;
  readonly research: { readonly provider: string; readonly configured: boolean };
  readonly limits: { readonly timeoutMs: number; readonly maxOutputTokens: number; readonly requestsPerHour: number };
  readonly notes: readonly string[];
}

export interface ConversationRow {
  readonly id: string;
  readonly title: string;
  readonly language: string;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface ConversationMessage {
  readonly role: 'user' | 'assistant';
  readonly content: string;
  readonly mode: string;
  readonly provider: string;
  readonly citations: readonly Citation[];
  readonly created_at: string;
}
