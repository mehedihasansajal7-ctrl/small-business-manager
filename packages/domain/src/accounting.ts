import { Decimal, dec } from './decimal.js';
import { type Money, addMoney, money, subMoney, sumMoney, zeroMoney, negMoney } from './money.js';

/**
 * Double-entry accounting. The ledger is the single source of truth for
 * financial reports; dashboards only ever aggregate it.
 */

export type AccountType = 'ASSET' | 'LIABILITY' | 'EQUITY' | 'REVENUE' | 'EXPENSE';
export type NormalBalance = 'DEBIT' | 'CREDIT';

export interface Account {
  readonly code: string;
  readonly name: string;
  readonly nameBn?: string;
  readonly type: AccountType;
  readonly normal: NormalBalance;
  /** Contra accounts offset their parent (drawings, discounts, accum. depreciation). */
  readonly contra?: boolean;
}

/** Fixed chart of accounts. Codes are stable so history stays comparable. */
export const STANDARD_ACCOUNTS: readonly Account[] = Object.freeze([
  { code: '1000', name: 'Cash in Hand', nameBn: 'হাতে নগদ', type: 'ASSET', normal: 'DEBIT' },
  { code: '1010', name: 'Bank Account', nameBn: 'ব্যাংক হিসাব', type: 'ASSET', normal: 'DEBIT' },
  { code: '1020', name: 'Mobile Financial Service', nameBn: 'মোবাইল আর্থিক সেবা', type: 'ASSET', normal: 'DEBIT' },
  { code: '1100', name: 'Accounts Receivable', nameBn: 'প্রাপ্য হিসাব', type: 'ASSET', normal: 'DEBIT' },
  { code: '1200', name: 'Inventory - Inputs & Goods', nameBn: 'মজুদ - ইনপুট ও পণ্য', type: 'ASSET', normal: 'DEBIT' },
  { code: '1210', name: 'Inventory - Finished Output', nameBn: 'মজুদ - উৎপাদিত পণ্য', type: 'ASSET', normal: 'DEBIT' },
  { code: '1220', name: 'Livestock / Biological Assets', nameBn: 'পশুসম্পদ', type: 'ASSET', normal: 'DEBIT' },
  { code: '1300', name: 'Work in Progress - Production Batches', nameBn: 'চলমান উৎপাদন', type: 'ASSET', normal: 'DEBIT' },
  { code: '1400', name: 'Input Tax Receivable', nameBn: 'প্রদেয় কর সমন্বয়', type: 'ASSET', normal: 'DEBIT' },
  { code: '1500', name: 'Fixed Assets', nameBn: 'স্থায়ী সম্পদ', type: 'ASSET', normal: 'DEBIT' },
  { code: '1600', name: 'Accumulated Depreciation', nameBn: 'সঞ্চিত অবচয়', type: 'ASSET', normal: 'CREDIT', contra: true },
  { code: '2000', name: 'Accounts Payable', nameBn: 'প্রদেয় হিসাব', type: 'LIABILITY', normal: 'CREDIT' },
  { code: '2100', name: 'Loans Payable', nameBn: 'ঋণ', type: 'LIABILITY', normal: 'CREDIT' },
  { code: '2200', name: 'Tax Payable', nameBn: 'কর প্রদেয়', type: 'LIABILITY', normal: 'CREDIT' },
  { code: '2300', name: 'Accrued Expenses', nameBn: 'সঞ্চিত খরচ', type: 'LIABILITY', normal: 'CREDIT' },
  { code: '3000', name: 'Owner Capital', nameBn: 'মালিকের পুঁজি', type: 'EQUITY', normal: 'CREDIT' },
  { code: '3050', name: 'Opening Balance Equity', nameBn: 'প্রারম্ভিক জের', type: 'EQUITY', normal: 'CREDIT' },
  { code: '3100', name: 'Partner Contributions', nameBn: 'অংশীদারদের পুঁজি', type: 'EQUITY', normal: 'CREDIT' },
  { code: '3200', name: 'Retained Earnings', nameBn: 'সঞ্চিত মুনাফা', type: 'EQUITY', normal: 'CREDIT' },
  { code: '3300', name: 'Partner Drawings', nameBn: 'অংশীদারদের উত্তোলন', type: 'EQUITY', normal: 'DEBIT', contra: true },
  { code: '4000', name: 'Sales Revenue', nameBn: 'বিক্রয় আয়', type: 'REVENUE', normal: 'CREDIT' },
  { code: '4100', name: 'Other Income', nameBn: 'অন্যান্য আয়', type: 'REVENUE', normal: 'CREDIT' },
  { code: '4900', name: 'Sales Discounts', nameBn: 'বিক্রয় ছাড়', type: 'REVENUE', normal: 'DEBIT', contra: true },
  { code: '4910', name: 'Sales Returns', nameBn: 'বিক্রয় ফেরত', type: 'REVENUE', normal: 'DEBIT', contra: true },
  { code: '5000', name: 'Cost of Goods Sold', nameBn: 'বিক্রিত পণ্যের ব্যয়', type: 'EXPENSE', normal: 'DEBIT' },
  { code: '5100', name: 'Operating Expenses', nameBn: 'পরিচালন ব্যয়', type: 'EXPENSE', normal: 'DEBIT' },
  { code: '5110', name: 'Labour & Wages', nameBn: 'শ্রম ও মজুরি', type: 'EXPENSE', normal: 'DEBIT' },
  { code: '5120', name: 'Utilities', nameBn: 'বিদ্যুৎ ও পানি', type: 'EXPENSE', normal: 'DEBIT' },
  { code: '5130', name: 'Transport', nameBn: 'পরিবহন', type: 'EXPENSE', normal: 'DEBIT' },
  { code: '5140', name: 'Fuel & Machinery', nameBn: 'জ্বালানি ও যন্ত্রপাতি', type: 'EXPENSE', normal: 'DEBIT' },
  { code: '5150', name: 'Veterinary & Medicine (direct)', nameBn: 'পশুচিকিৎসা (সরাসরি)', type: 'EXPENSE', normal: 'DEBIT' },
  { code: '5160', name: 'Repairs & Maintenance', nameBn: 'মেরামত', type: 'EXPENSE', normal: 'DEBIT' },
  { code: '5170', name: 'Rent', nameBn: 'ভাড়া', type: 'EXPENSE', normal: 'DEBIT' },
  { code: '5180', name: 'Packaging', nameBn: 'মোড়ক', type: 'EXPENSE', normal: 'DEBIT' },
  { code: '5300', name: 'Inventory Shrinkage & Adjustments', nameBn: 'মজুদ ঘাটতি', type: 'EXPENSE', normal: 'DEBIT' },
  { code: '5400', name: 'Mortality & Production Loss', nameBn: 'মৃত্যু ও উৎপাদন ক্ষতি', type: 'EXPENSE', normal: 'DEBIT' },
  { code: '5500', name: 'Bad Debt', nameBn: 'অনাদায়ী পাওনা', type: 'EXPENSE', normal: 'DEBIT' },
  { code: '5600', name: 'Depreciation', nameBn: 'অবচয়', type: 'EXPENSE', normal: 'DEBIT' },
  { code: '5700', name: 'Interest Expense', nameBn: 'সুদ ব্যয়', type: 'EXPENSE', normal: 'DEBIT' },
]);

export const ACCOUNT = Object.freeze(
  Object.fromEntries(STANDARD_ACCOUNTS.map((a) => [a.code, a])) as Record<string, Account>,
);

export function accountByCode(code: string, extra: readonly Account[] = []): Account {
  const all = [...STANDARD_ACCOUNTS, ...extra];
  const found = all.find((a) => a.code === code);
  if (!found) throw new AccountingError('UNKNOWN_ACCOUNT', `Unknown account code: ${code}`);
  return found;
}

export type AccountingErrorCode =
  | 'UNKNOWN_ACCOUNT'
  | 'UNBALANCED_ENTRY'
  | 'INVALID_LINE'
  | 'CURRENCY_MISMATCH'
  | 'INVALID_ENTRY'
  | 'NEGATIVE_AMOUNT';

export class AccountingError extends Error {
  readonly code: AccountingErrorCode;
  constructor(code: AccountingErrorCode, message: string) {
    super(message);
    this.name = 'AccountingError';
    this.code = code;
  }
}

export interface JournalLine {
  readonly account: string;
  readonly debit: Money;
  readonly credit: Money;
  readonly memo?: string;
  readonly businessId?: string;
  /** Optional tenant-scoped dimension for reporting. */
  readonly partnerId?: string;
  readonly costCenter?: string;
}

export interface JournalEntry {
  readonly id: string;
  readonly businessId: string;
  /** ISO date (business timezone) the entry belongs to. */
  readonly date: string;
  readonly reference: string;
  readonly description: string;
  readonly sourceType: string;
  readonly sourceId: string;
  readonly lines: readonly JournalLine[];
  readonly currency: string;
  readonly postedBy: string;
  readonly deviceId?: string;
  readonly eventId?: string;
  readonly createdAt: string;
  /** Points at the entry this one reverses, if any. */
  readonly reversalOf?: string | null;
}

export function journalLine(account: string, amount: Money, side: 'debit' | 'credit', memo?: string): JournalLine {
  const zero = zeroMoney(amount.currency);
  return side === 'debit'
    ? { account, debit: amount, credit: zero, ...(memo ? { memo } : {}) }
    : { account, debit: zero, credit: amount, ...(memo ? { memo } : {}) };
}

export function totalDebit(lines: readonly JournalLine[], currency: string): Money {
  return sumMoney(lines.map((l) => l.debit), currency);
}

export function totalCredit(lines: readonly JournalLine[], currency: string): Money {
  return sumMoney(lines.map((l) => l.credit), currency);
}

export function isBalanced(lines: readonly JournalLine[], currency: string): boolean {
  return totalDebit(lines, currency).amount.eq(totalCredit(lines, currency).amount);
}

export interface EntryValidation {
  readonly ok: boolean;
  readonly errors: readonly string[];
}

/** Full validation of an entry before it is persisted/posted. */
export function validateJournalEntry(entry: Pick<JournalEntry, 'businessId' | 'lines' | 'currency' | 'date' | 'reference'>, extraAccounts: readonly Account[] = []): EntryValidation {
  const errors: string[] = [];
  if (!entry.businessId) errors.push('businessId is required');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.date)) errors.push(`date must be YYYY-MM-DD, got ${JSON.stringify(entry.date)}`);
  if (!entry.reference) errors.push('reference is required');
  if (!entry.currency) errors.push('currency is required');
  if (entry.lines.length < 2) errors.push('a journal entry needs at least two lines');

  entry.lines.forEach((line, index) => {
    const hasDebit = line.debit.amount.isPositive();
    const hasCredit = line.credit.amount.isPositive();
    if (line.debit.amount.isNegative() || line.credit.amount.isNegative()) {
      errors.push(`line ${index}: amounts must not be negative (use the other side instead)`);
    }
    if (hasDebit === hasCredit) {
      errors.push(`line ${index}: exactly one of debit/credit must be positive (debit=${line.debit.amount.toString()}, credit=${line.credit.amount.toString()})`);
    }
    if (line.debit.currency !== entry.currency || line.credit.currency !== entry.currency) {
      errors.push(`line ${index}: currency must be ${entry.currency}`);
    }
    if (line.debit.currency !== line.credit.currency) {
      errors.push(`line ${index}: debit and credit currency differ`);
    }
    try {
      accountByCode(line.account, extraAccounts);
    } catch {
      errors.push(`line ${index}: unknown account ${line.account}`);
    }
  });

  if (errors.length === 0 && !isBalanced(entry.lines, entry.currency)) {
    errors.push(
      `entry is not balanced: debit ${totalDebit(entry.lines, entry.currency).amount.toString()} vs credit ${totalCredit(entry.lines, entry.currency).amount.toString()}`,
    );
  }
  return { ok: errors.length === 0, errors };
}

export function assertValidEntry(entry: Parameters<typeof validateJournalEntry>[0], extraAccounts: readonly Account[] = []): void {
  const result = validateJournalEntry(entry, extraAccounts);
  if (!result.ok) throw new AccountingError('INVALID_ENTRY', `Invalid journal entry: ${result.errors.join('; ')}`);
}

/** A user-editable draft of the legs for a business event. */
export interface SalePostingInput {
  readonly businessId: string;
  readonly date: string;
  readonly reference: string;
  readonly description?: string;
  readonly currency: string;
  /** Gross line total before discount and tax. */
  readonly revenue: Money;
  readonly discount: Money;
  readonly tax: Money;
  readonly cashReceived: Money;
  readonly cogs: Money;
  readonly cashAccount?: string;
  readonly postedBy: string;
  readonly deviceId?: string;
  readonly eventId?: string;
}

/**
 * Sale posting.
 *   Dr Cash / Dr Accounts Receivable / Dr Sales Discounts
 *      Cr Sales Revenue / Cr Tax Payable
 *   Dr COGS / Cr Inventory
 * Revenue is recognised exactly once, and COGS uses the inventory cost layer.
 */
export function buildSalePosting(input: SalePostingInput): JournalEntry {
  const currency = input.currency;
  const cashAccount = input.cashAccount ?? '1000';
  const receivable = subMoney(subMoney(addMoney(input.revenue, input.tax), input.discount), input.cashReceived);
  const lines: JournalLine[] = [];
  if (input.cashReceived.amount.isPositive()) lines.push(journalLine(cashAccount, money(currency, input.cashReceived.amount), 'debit', 'Cash received'));
  if (receivable.amount.isPositive()) lines.push(journalLine('1100', receivable, 'debit', 'On credit'));
  if (receivable.amount.isNegative()) lines.push(journalLine('1100', negMoney(receivable), 'credit', 'Overpayment / advance'));
  if (input.discount.amount.isPositive()) lines.push(journalLine('4900', input.discount, 'debit', 'Discount allowed'));
  lines.push(journalLine('4000', input.revenue, 'credit', 'Sales revenue'));
  if (input.tax.amount.isPositive()) lines.push(journalLine('2200', input.tax, 'credit', 'Tax payable'));
  if (input.cogs.amount.isPositive()) {
    lines.push(journalLine('5000', input.cogs, 'debit', 'Cost of goods sold'));
    lines.push(journalLine('1200', input.cogs, 'credit', 'Inventory released'));
  }
  const entry: JournalEntry = {
    id: input.eventId ?? `SALE:${input.reference}`,
    businessId: input.businessId,
    date: input.date,
    reference: input.reference,
    description: input.description ?? 'Sale',
    sourceType: 'SALE',
    sourceId: input.reference,
    lines,
    currency,
    postedBy: input.postedBy,
    createdAt: new Date().toISOString(),
    ...(input.deviceId ? { deviceId: input.deviceId } : {}),
    ...(input.eventId ? { eventId: input.eventId } : {}),
  };
  assertValidEntry(entry);
  return entry;
}

export interface PurchasePostingInput {
  readonly businessId: string;
  readonly date: string;
  readonly reference: string;
  readonly currency: string;
  /** Value that becomes inventory (excludes input tax). */
  readonly inventoryValue: Money;
  readonly inputTax: Money;
  readonly paid: Money;
  readonly cashAccount?: string;
  readonly inventoryAccount?: string;
  readonly postedBy: string;
  readonly deviceId?: string;
  readonly eventId?: string;
  readonly description?: string;
}

/** Purchase: inventory goes up, cash/payable goes up. NOT an immediate expense. */
export function buildPurchasePosting(input: PurchasePostingInput): JournalEntry {
  const currency = input.currency;
  const inventoryAccount = input.inventoryAccount ?? '1200';
  const payable = subMoney(addMoney(input.inventoryValue, input.inputTax), input.paid);
  const lines: JournalLine[] = [journalLine(inventoryAccount, input.inventoryValue, 'debit', 'Inventory received')];
  if (input.inputTax.amount.isPositive()) lines.push(journalLine('1400', input.inputTax, 'debit', 'Input tax'));
  if (input.paid.amount.isPositive()) lines.push(journalLine(input.cashAccount ?? '1000', input.paid, 'credit', 'Paid'));
  if (payable.amount.isPositive()) lines.push(journalLine('2000', payable, 'credit', 'Supplier payable'));
  if (payable.amount.isNegative()) lines.push(journalLine('2000', negMoney(payable), 'debit', 'Advance to supplier'));
  return {
    id: input.eventId ?? `PURCHASE:${input.reference}`,
    businessId: input.businessId,
    date: input.date,
    reference: input.reference,
    description: input.description ?? 'Purchase',
    sourceType: 'PURCHASE',
    sourceId: input.reference,
    lines,
    currency,
    postedBy: input.postedBy,
    createdAt: new Date().toISOString(),
  } as JournalEntry;
}

/** Customer receipt: reduces receivable, increases cash. NOT a second revenue. */
export function buildCustomerReceiptPosting(input: {
  businessId: string;
  date: string;
  reference: string;
  currency: string;
  amount: Money;
  cashAccount?: string;
  postedBy: string;
  eventId?: string;
}): JournalEntry {
  return simpleEntry(input.businessId, input.date, input.reference, input.currency, input.postedBy, 'RECEIPT', 'Customer receipt', [
    journalLine(input.cashAccount ?? '1000', input.amount, 'debit', 'Cash received'),
    journalLine('1100', input.amount, 'credit', 'Receivable cleared'),
  ], input.eventId);
}

/** Supplier payment: reduces payable, decreases cash. NOT a second expense. */
export function buildSupplierPaymentPosting(input: {
  businessId: string;
  date: string;
  reference: string;
  currency: string;
  amount: Money;
  cashAccount?: string;
  postedBy: string;
  eventId?: string;
}): JournalEntry {
  return simpleEntry(input.businessId, input.date, input.reference, input.currency, input.postedBy, 'PAYMENT', 'Supplier payment', [
    journalLine('2000', input.amount, 'debit', 'Payable settled'),
    journalLine(input.cashAccount ?? '1000', input.amount, 'credit', 'Cash paid'),
  ], input.eventId);
}

/** Account transfer: not income and not expense. */
export function buildTransferPosting(input: {
  businessId: string;
  date: string;
  reference: string;
  currency: string;
  amount: Money;
  fromAccount: string;
  toAccount: string;
  postedBy: string;
  eventId?: string;
}): JournalEntry {
  if (input.fromAccount === input.toAccount) throw new AccountingError('INVALID_ENTRY', 'Transfer source and destination are the same account');
  return simpleEntry(input.businessId, input.date, input.reference, input.currency, input.postedBy, 'TRANSFER', 'Funds transfer', [
    journalLine(input.toAccount, input.amount, 'debit', 'Transfer in'),
    journalLine(input.fromAccount, input.amount, 'credit', 'Transfer out'),
  ], input.eventId);
}

/** Income or expense paid from / received into an account. */
export function buildIncomeExpensePosting(input: {
  businessId: string;
  date: string;
  reference: string;
  currency: string;
  amount: Money;
  /** e.g. 5100 operating expenses or 4100 other income. */
  categoryAccount: string;
  cashAccount?: string;
  paid?: boolean;
  postedBy: string;
  eventId?: string;
  description?: string;
}): JournalEntry {
  const account = accountByCode(input.categoryAccount);
  const isExpense = account.type === 'EXPENSE';
  const cashAccount = input.cashAccount ?? '1000';
  const lines: JournalLine[] = isExpense
    ? [
        journalLine(input.categoryAccount, input.amount, 'debit', input.description ?? 'Expense'),
        journalLine(input.paid === false ? '2000' : cashAccount, input.amount, 'credit', input.paid === false ? 'Accrued' : 'Paid'),
      ]
    : [
        journalLine(input.paid === false ? '1100' : cashAccount, input.amount, 'debit', input.paid === false ? 'Accrued income' : 'Received'),
        journalLine(input.categoryAccount, input.amount, 'credit', input.description ?? 'Income'),
      ];
  return simpleEntry(input.businessId, input.date, input.reference, input.currency, input.postedBy, 'INCOME_EXPENSE', input.description ?? 'Income/expense', lines, input.eventId);
}

/**
 * Partner capital movement. Equity, never revenue or expense.
 * Account 3100 = contributions, 3300 = drawings (contra equity).
 */
export function buildPartnerCapitalPosting(input: {
  businessId: string;
  date: string;
  reference: string;
  currency: string;
  amount: Money;
  partnerId: string;
  cashAccount?: string;
  kind: 'CONTRIBUTION' | 'WITHDRAWAL';
  postedBy: string;
  eventId?: string;
}): JournalEntry {
  const cashAccount = input.cashAccount ?? '1000';
  const lines: JournalLine[] =
    input.kind === 'CONTRIBUTION'
      ? [
          journalLine(cashAccount, input.amount, 'debit', 'Partner contribution'),
          journalLine('3100', input.amount, 'credit', 'Partner capital'),
        ]
      : [
          journalLine('3300', input.amount, 'debit', 'Partner withdrawal'),
          journalLine(cashAccount, input.amount, 'credit', 'Cash paid to partner'),
        ];
  const entry = simpleEntry(
    input.businessId,
    input.date,
    input.reference,
    input.currency,
    input.postedBy,
    input.kind === 'CONTRIBUTION' ? 'PARTNER_CONTRIBUTION' : 'PARTNER_WITHDRAWAL',
    input.kind === 'CONTRIBUTION' ? 'Partner capital contribution' : 'Partner withdrawal',
    lines,
    input.eventId,
  );
  return {
    ...entry,
    lines: entry.lines.map((l) => ({ ...l, partnerId: input.partnerId })),
  };
}

/**
 * Opening balance for an asset (cash, bank, mobile wallet or inventory) when a
 * business is first set up or migrated in.
 *
 * The balancing leg is Opening Balance Equity (3050) - deliberately EQUITY, not
 * revenue: bringing your own cash or stock onto the books must never show up as
 * profit.
 */
export function buildOpeningBalancePosting(input: {
  businessId: string;
  date: string;
  reference: string;
  currency: string;
  assetAccount?: string;
  amount: Money;
  postedBy: string;
  description?: string;
  eventId?: string;
}): JournalEntry {
  const assetAccount = input.assetAccount ?? '1000';
  const lines: JournalLine[] =
    input.amount.amount.isPositive()
      ? [
          journalLine(assetAccount, input.amount, 'debit', 'Opening balance'),
          journalLine('3050', input.amount, 'credit', 'Opening balance equity'),
        ]
      : [
          journalLine('3050', negMoney(input.amount), 'debit', 'Opening balance equity'),
          journalLine(assetAccount, negMoney(input.amount), 'credit', 'Opening balance'),
        ];
  return simpleEntry(
    input.businessId,
    input.date,
    input.reference,
    input.currency,
    input.postedBy,
    'OPENING_BALANCE',
    input.description ?? 'Opening balance',
    lines,
    input.eventId,
  );
}

/** Stock write-off / shrinkage / mortality. */
export function buildInventoryLossPosting(input: {
  businessId: string;
  date: string;
  reference: string;
  currency: string;
  amount: Money;
  reason: string;
  kind?: 'SHRINKAGE' | 'MORTALITY';
  inventoryAccount?: string;
  postedBy: string;
  eventId?: string;
}): JournalEntry {
  const expenseAccount = input.kind === 'MORTALITY' ? '5400' : '5300';
  return simpleEntry(
    input.businessId,
    input.date,
    input.reference,
    input.currency,
    input.postedBy,
    input.kind === 'MORTALITY' ? 'MORTALITY_LOSS' : 'INVENTORY_ADJUSTMENT',
    input.reason,
    [
      journalLine(expenseAccount, input.amount, 'debit', input.reason),
      journalLine(input.inventoryAccount ?? '1200', input.amount, 'credit', 'Inventory written off'),
    ],
    input.eventId,
  );
}

/**
 * Harvest / production completion. Moves accumulated batch cost out of WIP into
 * finished-goods inventory. No profit is recognised at this point.
 */
export function buildHarvestPosting(input: {
  businessId: string;
  date: string;
  reference: string;
  currency: string;
  /** Cost basis assigned to this harvest (never the whole batch repeatedly). */
  costBasis: Money;
  fromAccount?: string;
  toAccount?: string;
  postedBy: string;
  eventId?: string;
}): JournalEntry {
  return simpleEntry(input.businessId, input.date, input.reference, input.currency, input.postedBy, 'HARVEST', 'Harvest to finished stock', [
    journalLine(input.toAccount ?? '1210', input.costBasis, 'debit', 'Finished output value'),
    journalLine(input.fromAccount ?? '1300', input.costBasis, 'credit', 'Batch cost released'),
  ], input.eventId);
}

/** Input issued from store into a production batch: cost moves to WIP once. */
export function buildInputIssuePosting(input: {
  businessId: string;
  date: string;
  reference: string;
  currency: string;
  cost: Money;
  batchReference: string;
  postedBy: string;
  eventId?: string;
}): JournalEntry {
  return simpleEntry(input.businessId, input.date, input.reference, input.currency, input.postedBy, 'INPUT_ISSUE', `Input issued to batch ${input.batchReference}`, [
    journalLine('1300', input.cost, 'debit', 'Batch input cost'),
    journalLine('1200', input.cost, 'credit', 'Input stock released'),
  ], input.eventId);
}

/** Direct (non-stock) batch cost, e.g. hired labour paid in cash. */
export function buildDirectBatchCostPosting(input: {
  businessId: string;
  date: string;
  reference: string;
  currency: string;
  cost: Money;
  expenseAccount: string;
  cashAccount?: string;
  paid?: boolean;
  batchReference: string;
  postedBy: string;
  eventId?: string;
}): JournalEntry {
  return simpleEntry(input.businessId, input.date, input.reference, input.currency, input.postedBy, 'DIRECT_BATCH_COST', `Direct cost for batch ${input.batchReference}`, [
    journalLine('1300', input.cost, 'debit', 'Batch direct cost'),
    journalLine(input.paid === false ? '2000' : input.cashAccount ?? '1000', input.cost, 'credit', input.paid === false ? 'Payable' : 'Cash paid'),
  ], input.eventId);
}

/** Build a reversal that exactly cancels an existing posted entry. */
export function buildReversal(entry: JournalEntry, context: { id: string; date: string; reference: string; postedBy: string; reason: string }): JournalEntry {
  if (entry.reversalOf) throw new AccountingError('INVALID_ENTRY', 'Cannot reverse a reversal entry');
  return {
    ...entry,
    id: context.id,
    // A reversal is its OWN posting event: it must never inherit the original
    // event id, otherwise an idempotency check would treat it as a duplicate.
    eventId: context.id,
    date: context.date,
    reference: context.reference,
    description: `Reversal of ${entry.reference}: ${context.reason}`,
    sourceType: 'REVERSAL',
    sourceId: entry.id,
    postedBy: context.postedBy,
    lines: entry.lines.map((line) => ({ ...line, debit: line.credit, credit: line.debit })),
    reversalOf: entry.id,
    createdAt: new Date().toISOString(),
  };
}

function simpleEntry(
  businessId: string,
  date: string,
  reference: string,
  currency: string,
  postedBy: string,
  sourceType: string,
  description: string,
  lines: readonly JournalLine[],
  eventId?: string,
): JournalEntry {
  const entry: JournalEntry = {
    id: eventId ?? `${sourceType}:${reference}`,
    businessId,
    date,
    reference,
    description,
    sourceType,
    sourceId: reference,
    lines: lines.map((l) => ({ ...l, businessId })),
    currency,
    postedBy,
    createdAt: new Date().toISOString(),
    ...(eventId ? { eventId } : {}),
  };
  assertValidEntry(entry);
  return entry;
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

export function inDateRange(entry: Pick<JournalEntry, 'date'>, from: string, to: string): boolean {
  return entry.date >= from && entry.date <= to;
}

export interface AccountTotals {
  readonly account: string;
  readonly name: string;
  readonly type: AccountType;
  readonly debit: Money;
  readonly credit: Money;
  /** debit - credit (signed, before applying the normal balance). */
  readonly net: Money;
}

export function accountTotals(entries: readonly JournalEntry[], currency: string, extraAccounts: readonly Account[] = []): AccountTotals[] {
  const byAccount = new Map<string, { debit: Money; credit: Money }>();
  for (const entry of entries) {
    for (const line of entry.lines) {
      const current = byAccount.get(line.account) ?? { debit: zeroMoney(currency), credit: zeroMoney(currency) };
      byAccount.set(line.account, {
        debit: addMoney(current.debit, line.debit),
        credit: addMoney(current.credit, line.credit),
      });
    }
  }
  return [...byAccount.entries()]
    .map(([account, totals]) => {
      const def = accountByCode(account, extraAccounts);
      return {
        account,
        name: def.name,
        type: def.type,
        debit: totals.debit,
        credit: totals.credit,
        net: subMoney(totals.debit, totals.credit),
      };
    })
    .sort((a, b) => a.account.localeCompare(b.account));
}

/** Natural balance for an account: positive when the normal side has grown. */
export function naturalBalance(totals: AccountTotals, currency: string): Money {
  const def = accountByCode(totals.account);
  const raw = totals.debit.amount.sub(totals.credit.amount);
  return money(currency, def.normal === 'DEBIT' ? raw : raw.neg());
}

export interface TrialBalance {
  readonly rows: readonly AccountTotals[];
  readonly totalDebit: Money;
  readonly totalCredit: Money;
  readonly balanced: boolean;
}

export function trialBalance(entries: readonly JournalEntry[], currency: string): TrialBalance {
  const rows = accountTotals(entries, currency);
  const totalDebits = sumMoney(rows.map((r) => r.debit), currency);
  const totalCredits = sumMoney(rows.map((r) => r.credit), currency);
  return { rows, totalDebit: totalDebits, totalCredit: totalCredits, balanced: totalDebits.amount.eq(totalCredits.amount) };
}

export interface ProfitAndLoss {
  readonly from: string;
  readonly to: string;
  readonly currency: string;
  readonly revenue: Money;
  readonly contraRevenue: Money;
  readonly netRevenue: Money;
  readonly costOfGoodsSold: Money;
  readonly grossProfit: Money;
  readonly operatingExpenses: Money;
  readonly otherIncome: Money;
  readonly expensesByAccount: readonly { account: string; name: string; amount: Money }[];
  readonly netProfit: Money;
  readonly basis: 'ACCRUAL';
}

/** Accrual profit: matches revenue with COGS and period expenses. */
export function profitAndLoss(entries: readonly JournalEntry[], opts: { from: string; to: string; currency: string }): ProfitAndLoss {
  const inRange = entries.filter((e) => inDateRange(e, opts.from, opts.to));
  const rows = accountTotals(inRange, opts.currency);

  const grossRevenue = sumMoney(
    rows.filter((r) => r.type === 'REVENUE' && !accountByCode(r.account).contra).map((r) => money(opts.currency, r.credit.amount.sub(r.debit.amount))),
    opts.currency,
  );
  const contraRevenue = sumMoney(
    rows.filter((r) => r.type === 'REVENUE' && accountByCode(r.account).contra).map((r) => money(opts.currency, r.debit.amount.sub(r.credit.amount))),
    opts.currency,
  );
  const netRevenue = subMoney(grossRevenue, contraRevenue);
  const cogs = sumMoney(
    rows.filter((r) => r.account === '5000').map((r) => money(opts.currency, r.debit.amount.sub(r.credit.amount))),
    opts.currency,
  );
  const otherIncome = sumMoney(
    rows.filter((r) => r.account === '4100').map((r) => money(opts.currency, r.credit.amount.sub(r.debit.amount))),
    opts.currency,
  );
  const expenseRows = rows.filter((r) => r.type === 'EXPENSE' && r.account !== '5000');
  const expensesByAccount = expenseRows.map((r) => ({ account: r.account, name: r.name, amount: money(opts.currency, r.debit.amount.sub(r.credit.amount)) }));
  const operatingExpenses = sumMoney(expensesByAccount.map((e) => e.amount), opts.currency);
  const grossProfit = subMoney(netRevenue, cogs);
  const netProfit = subMoney(addMoney(grossProfit, otherIncome), operatingExpenses);

  return {
    from: opts.from,
    to: opts.to,
    currency: opts.currency,
    revenue: grossRevenue,
    contraRevenue,
    netRevenue,
    costOfGoodsSold: cogs,
    grossProfit,
    operatingExpenses,
    otherIncome,
    expensesByAccount,
    netProfit,
    basis: 'ACCRUAL',
  };
}

export interface CashFlowSummary {
  readonly opening: Money;
  readonly closing: Money;
  readonly netChange: Money;
  readonly inflows: Money;
  readonly outflows: Money;
}

const CASH_ACCOUNTS = new Set(['1000', '1010', '1020']);

export function isCashAccount(code: string): boolean {
  return CASH_ACCOUNTS.has(code);
}

/** Movement of the cash/bank/MFS accounts over a period. */
export function cashFlow(entries: readonly JournalEntry[], opts: { from: string; to: string; currency: string }): CashFlowSummary {
  const opening = cashBalance(entries.filter((e) => e.date < opts.from), opts.currency);
  const inRange = entries.filter((e) => inDateRange(e, opts.from, opts.to));
  let inflows = zeroMoney(opts.currency);
  let outflows = zeroMoney(opts.currency);
  for (const entry of inRange) {
    for (const line of entry.lines) {
      if (!isCashAccount(line.account)) continue;
      inflows = addMoney(inflows, line.debit);
      outflows = addMoney(outflows, line.credit);
    }
  }
  const netChange = subMoney(inflows, outflows);
  return { opening, closing: addMoney(opening, netChange), netChange, inflows, outflows };
}

export function cashBalance(entries: readonly JournalEntry[], currency: string): Money {
  let balance = zeroMoney(currency);
  for (const entry of entries) {
    for (const line of entry.lines) {
      if (!isCashAccount(line.account)) continue;
      balance = addMoney(balance, subMoney(line.debit, line.credit));
    }
  }
  return balance;
}

/**
 * Cash-basis operating result.
 *
 * Definition used here (documented, deliberately simple and reproducible):
 * net movement of the cash / bank / MFS accounts in those entries that
 * RECOGNISE revenue or expense. So a sale paid partly on credit counts only the
 * cash actually received, and a supplier payment of a stock bill the following
 * month does not count again.
 *
 * Excluded by construction: partner capital, drawings, loans, account
 * transfers, and cash tied up in still-owned inventory.
 */
export function cashBasisOperatingResult(entries: readonly JournalEntry[], opts: { from: string; to: string; currency: string }): Money {
  let total = zeroMoney(opts.currency);
  for (const entry of entries) {
    if (!inDateRange(entry, opts.from, opts.to)) continue;
    const recognisesResult = entry.lines.some((line) => {
      const type = accountByCode(line.account).type;
      return type === 'REVENUE' || type === 'EXPENSE';
    });
    if (!recognisesResult) continue;
    for (const line of entry.lines) {
      if (!isCashAccount(line.account)) continue;
      total = addMoney(total, subMoney(line.debit, line.credit));
    }
  }
  return total;
}

/** Balance sheet snapshot (assets, liabilities, equity) with an equity check. */
export interface BalanceSheet {
  readonly asOf: string;
  readonly currency: string;
  readonly assets: readonly AccountTotals[];
  readonly liabilities: readonly AccountTotals[];
  readonly equity: readonly AccountTotals[];
  readonly totalAssets: Money;
  readonly totalLiabilities: Money;
  /** Partner/owner equity accounts only (excludes current-period result). */
  readonly totalEquity: Money;
  /** Equity including the unclosed current-period result. */
  readonly totalEquityIncludingResult: Money;
  readonly balanced: boolean;
}

/**
 * Balance sheet. Assets are `debit - credit`, liabilities/equity are
 * `credit - debit`, which makes contra accounts (drawings, accumulated
 * depreciation, discounts) subtract automatically.
 *
 * `balanced` includes the unclosed profit for the period, because this system
 * reports the result from the ledger rather than posting a closing entry.
 */
export function balanceSheet(entries: readonly JournalEntry[], opts: { asOf: string; currency: string }): BalanceSheet {
  const relevant = entries.filter((e) => e.date <= opts.asOf);
  const rows = accountTotals(relevant, opts.currency);
  const debitSign = (r: AccountTotals) => money(opts.currency, r.debit.amount.sub(r.credit.amount));
  const creditSign = (r: AccountTotals) => money(opts.currency, r.credit.amount.sub(r.debit.amount));

  const assets = rows.filter((r) => r.type === 'ASSET');
  const liabilities = rows.filter((r) => r.type === 'LIABILITY');
  const equity = rows.filter((r) => r.type === 'EQUITY');

  const totalAssets = sumMoney(assets.map(debitSign), opts.currency);
  const totalLiabilities = sumMoney(liabilities.map(creditSign), opts.currency);
  const totalEquity = sumMoney(equity.map(creditSign), opts.currency);

  const revenueTotal = sumMoney(rows.filter((r) => r.type === 'REVENUE').map(creditSign), opts.currency);
  const expenseTotal = sumMoney(rows.filter((r) => r.type === 'EXPENSE').map(debitSign), opts.currency);
  const result = subMoney(revenueTotal, expenseTotal);
  const totalEquityIncludingResult = addMoney(totalEquity, result);
  const rhs = addMoney(totalLiabilities, totalEquityIncludingResult);

  return {
    asOf: opts.asOf,
    currency: opts.currency,
    assets,
    liabilities,
    equity,
    totalAssets,
    totalLiabilities,
    totalEquity,
    totalEquityIncludingResult,
    balanced: totalAssets.amount.eq(rhs.amount),
  };
}

/** Net equity change from partner capital movements, per partner. */
export function partnerCapitalBalances(entries: readonly JournalEntry[], currency: string): { partnerId: string; contributions: Money; withdrawals: Money; net: Money }[] {
  const map = new Map<string, { contributions: Money; withdrawals: Money }>();
  for (const entry of entries) {
    for (const line of entry.lines) {
      if (!line.partnerId) continue;
      const current = map.get(line.partnerId) ?? { contributions: zeroMoney(currency), withdrawals: zeroMoney(currency) };
      if (line.account === '3100') current.contributions = addMoney(current.contributions, line.credit);
      if (line.account === '3300') current.withdrawals = addMoney(current.withdrawals, line.debit);
      map.set(line.partnerId, current);
    }
  }
  return [...map.entries()]
    .map(([partnerId, v]) => ({ partnerId, contributions: v.contributions, withdrawals: v.withdrawals, net: subMoney(v.contributions, v.withdrawals) }))
    .sort((a, b) => a.partnerId.localeCompare(b.partnerId));
}
