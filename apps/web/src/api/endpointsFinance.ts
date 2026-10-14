import { STANDARD_ACCOUNTS } from '@sbm/domain';
import { apiRequest } from './client';
import type {
  AccountRow,
  BalanceSheetReport,
  CashFlowReport,
  DashboardReport,
  PayableRow,
  ProfitLossReport,
  PurchaseRow,
  ReceivableRow,
  SaleRow,
  TrialBalanceReport,
} from './types';

/** Commerce (sales/purchases) and finance voucher endpoints. */

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
  readonly documentDate: string;
  readonly currency?: string;
  readonly customerId?: string;
  readonly locationId?: string;
  readonly reference?: string;
  readonly discount?: string;
  readonly cashReceived?: string;
  readonly accountCode?: string;
  readonly note?: string;
  readonly allowNegative?: boolean;
  readonly negativeReason?: string;
  readonly deviceId?: string;
  readonly lines: readonly SaleLineInput[];
}

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
  readonly documentDate: string;
  readonly currency?: string;
  readonly supplierId?: string;
  readonly locationId?: string;
  readonly reference?: string;
  readonly paid?: string;
  readonly accountCode?: string;
  readonly note?: string;
  readonly deviceId?: string;
  readonly lines: readonly PurchaseLineInput[];
}

export const sales = {
  list: (range: { from?: string; to?: string } = {}) => apiRequest<SaleRow[]>('/api/sales', { query: range }),
  create: (body: SaleInput) => apiRequest<Record<string, string>>('/api/sales', { method: 'POST', body }),
};

export const purchases = {
  list: (range: { from?: string; to?: string } = {}) => apiRequest<PurchaseRow[]>('/api/purchases', { query: range }),
  create: (body: PurchaseInput) => apiRequest<Record<string, string>>('/api/purchases', { method: 'POST', body }),
};

export const finance = {
  receipt: (body: { documentDate: string; amount: string; customerId?: string; accountCode?: string; reference?: string; note?: string; currency?: string; deviceId?: string }) =>
    apiRequest<{ reference: string; amount: string; receivableRemaining: string | null }>('/api/receipts', { method: 'POST', body }),
  payment: (body: { documentDate: string; amount: string; supplierId?: string; accountCode?: string; reference?: string; note?: string; currency?: string; deviceId?: string }) =>
    apiRequest<{ reference: string; amount: string; payableRemaining: string | null }>('/api/payments', { method: 'POST', body }),
  transfer: (body: { documentDate: string; amount: string; fromAccount: string; toAccount: string; reference?: string; note?: string; currency?: string; deviceId?: string }) =>
    apiRequest<{ reference: string; amount: string }>('/api/transfers', { method: 'POST', body }),
  incomeExpense: (body: {
    kind: 'INCOME' | 'EXPENSE';
    categoryAccount: string;
    documentDate: string;
    amount: string;
    paid?: boolean;
    accountCode?: string;
    reference?: string;
    note?: string;
    currency?: string;
    deviceId?: string;
  }) => apiRequest<{ reference: string; amount: string }>('/api/income-expenses', { method: 'POST', body }),
  partnerCapital: (body: { memberId: string; kind: 'CONTRIBUTION' | 'WITHDRAWAL'; documentDate: string; amount: string; accountCode?: string; reference?: string; note?: string; currency?: string; deviceId?: string }) =>
    apiRequest<{ reference: string; amount: string; kind: string }>('/api/partner-capital', { method: 'POST', body }),
  accounts: () => apiRequest<AccountRow[]>('/api/accounts'),
};

export const reports = {
  dashboard: (range: { from: string; to: string }) => apiRequest<DashboardReport>('/api/reports/dashboard', { query: range }),
  profitAndLoss: (range: { from: string; to: string }) => apiRequest<ProfitLossReport>('/api/reports/profit-loss', { query: range }),
  balanceSheet: (asOf: string) => apiRequest<BalanceSheetReport>('/api/reports/balance-sheet', { query: { asOf } }),
  trialBalance: (range: { from: string; to: string }) => apiRequest<TrialBalanceReport>('/api/reports/trial-balance', { query: range }),
  cashFlow: (range: { from: string; to: string }) => apiRequest<CashFlowReport>('/api/reports/cash-flow', { query: range }),
  receivables: () => apiRequest<ReceivableRow[]>('/api/reports/receivables'),
  payables: () => apiRequest<PayableRow[]>('/api/reports/payables'),
};

export const EXPORT_TABLES = [
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

/**
 * Category accounts offered by the income/expense form. Derived from the shared
 * chart of accounts so the app can never offer an account the server rejects.
 * Accounts that the system posts automatically (COGS, mortality loss, sales
 * revenue, discounts) are excluded from manual selection.
 */
const AUTO_POSTED = new Set(['5000', '5400', '4000', '4900', '4910']);

export function accountsByType(type: 'REVENUE' | 'EXPENSE'): readonly { code: string; name: string; nameBn: string }[] {
  return STANDARD_ACCOUNTS.filter((account) => account.type === type && !AUTO_POSTED.has(account.code)).map((account) => ({
    code: account.code,
    name: account.name,
    nameBn: account.nameBn ?? account.name,
  }));
}

export const CASH_ACCOUNTS = STANDARD_ACCOUNTS.filter((account) => ['1000', '1010', '1020'].includes(account.code));
