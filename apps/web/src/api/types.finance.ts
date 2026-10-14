/** Response shapes for this area of the API. */
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
