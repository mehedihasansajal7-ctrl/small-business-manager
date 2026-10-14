import { describe, expect, it } from 'vitest';
import { dec } from '../src/decimal.js';
import { money } from '../src/money.js';
import {
  AccountingError,
  balanceSheet,
  buildCustomerReceiptPosting,
  buildDirectBatchCostPosting,
  buildHarvestPosting,
  buildIncomeExpensePosting,
  buildInputIssuePosting,
  buildInventoryLossPosting,
  buildPartnerCapitalPosting,
  buildPurchasePosting,
  buildReversal,
  buildSalePosting,
  buildSupplierPaymentPosting,
  buildTransferPosting,
  cashBasisOperatingResult,
  cashBalance,
  cashFlow,
  isBalanced,
  journalLine,
  partnerCapitalBalances,
  profitAndLoss,
  totalCredit,
  totalDebit,
  trialBalance,
  validateJournalEntry,
  type JournalEntry,
} from '../src/accounting.js';

const base = { businessId: 'biz-1', currency: 'BDT', postedBy: 'user-1', date: '2026-01-15' };

function ledger(): JournalEntry[] {
  return [
    buildPartnerCapitalPosting({ ...base, reference: 'CAP-1', amount: money('BDT', '100000'), partnerId: 'p1', kind: 'CONTRIBUTION', date: '2026-01-01' }),
    buildPurchasePosting({ ...base, reference: 'PUR-1', inventoryValue: money('BDT', '30000'), inputTax: money('BDT', 0), paid: money('BDT', '20000'), date: '2026-01-02' }),
    buildSalePosting({ ...base, reference: 'SAL-1', revenue: money('BDT', '15000'), discount: money('BDT', '500'), tax: money('BDT', 0), cashReceived: money('BDT', '8000'), cogs: money('BDT', '9000'), date: '2026-01-03' }),
    buildCustomerReceiptPosting({ ...base, reference: 'RCP-1', amount: money('BDT', '4000'), date: '2026-01-04' }),
    buildSupplierPaymentPosting({ ...base, reference: 'PAY-1', amount: money('BDT', '6000'), date: '2026-01-05' }),
    buildIncomeExpensePosting({ ...base, reference: 'EXP-1', amount: money('BDT', '1000'), categoryAccount: '5170', description: 'Shop rent', date: '2026-01-06' }),
  ];
}

describe('journal validation', () => {
  it('accepts a balanced entry', () => {
    const entry = buildTransferPosting({ ...base, reference: 'TR-1', amount: money('BDT', '500'), fromAccount: '1000', toAccount: '1010' });
    expect(validateJournalEntry(entry).ok).toBe(true);
  });

  it('rejects unbalanced entries, two-sided lines, negative amounts and unknown accounts', () => {
    const unbalanced = validateJournalEntry({
      ...base,
      reference: 'X',
      lines: [journalLine('1000', money('BDT', '10'), 'debit'), journalLine('4000', money('BDT', '9'), 'credit')],
    });
    expect(unbalanced.ok).toBe(false);
    expect(unbalanced.errors.join(' ')).toMatch(/not balanced/);

    const twoSided = validateJournalEntry({
      ...base,
      reference: 'X',
      lines: [
        { account: '1000', debit: money('BDT', '10'), credit: money('BDT', '10') },
        journalLine('4000', money('BDT', '0'), 'credit'),
      ],
    });
    expect(twoSided.ok).toBe(false);
    expect(twoSided.errors.join(' ')).toMatch(/exactly one of debit\/credit/);

    expect(() =>
      buildTransferPosting({ ...base, reference: 'T', amount: money('BDT', '1'), fromAccount: '9999', toAccount: '1010' }),
    ).toThrow(AccountingError);
  });

  it('requires at least two lines', () => {
    const result = validateJournalEntry({ ...base, reference: 'X', lines: [journalLine('1000', money('BDT', '10'), 'debit')] });
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/at least two lines/);
  });

  it('exposes balance totals', () => {
    const entry = buildCustomerReceiptPosting({ ...base, reference: 'RCP-X', amount: money('BDT', '250') });
    expect(totalDebit(entry.lines, 'BDT').amount.toString()).toBe('250.00');
    expect(totalCredit(entry.lines, 'BDT').amount.toString()).toBe('250.00');
    expect(isBalanced(entry.lines, 'BDT')).toBe(true);
  });
});

describe('sale posting', () => {
  it('recognises revenue once and books COGS against inventory', () => {
    const entry = buildSalePosting({
      ...base,
      reference: 'SAL-2',
      revenue: money('BDT', '1000'),
      discount: money('BDT', '50'),
      tax: money('BDT', '75'),
      cashReceived: money('BDT', '500'),
      cogs: money('BDT', '600'),
    });
    expect(validateJournalEntry(entry).ok).toBe(true);

    const revenueLines = entry.lines.filter((l) => l.account === '4000');
    expect(revenueLines).toHaveLength(1);
    expect(totalCredit(revenueLines, 'BDT').amount.toString()).toBe('1000.00');

    // receivable = 1000 + 75 - 50 - 500
    const receivable = entry.lines.find((l) => l.account === '1100')!;
    expect(receivable.debit.amount.toString()).toBe('525.00');

    // COGS moves inventory -> expense, it is not revenue
    const cogs = entry.lines.find((l) => l.account === '5000')!;
    const inventory = entry.lines.find((l) => l.account === '1200')!;
    expect(cogs.debit.amount.toString()).toBe('600.00');
    expect(inventory.credit.amount.toString()).toBe('600.00');
    expect(totalDebit(entry.lines, 'BDT').amount.eq(totalCredit(entry.lines, 'BDT').amount)).toBe(true);
  });

  it('refuses to post an unbalanced sale', () => {
    const entry = buildSalePosting({
      ...base,
      reference: 'SAL-BAD',
      revenue: money('BDT', '100'),
      discount: money('BDT', 0),
      tax: money('BDT', 0),
      cashReceived: money('BDT', '30'),
      cogs: money('BDT', 0),
    });
    // 30 cash + 70 receivable = 100 revenue, so it balances
    expect(validateJournalEntry(entry).ok).toBe(true);
  });
});

describe('purchase, receipt and payment rules', () => {
  it('treats a stock purchase as an asset, not an operating expense', () => {
    const entry = buildPurchasePosting({ ...base, reference: 'PUR-2', inventoryValue: money('BDT', '50000'), inputTax: money('BDT', '7500'), paid: money('BDT', '30000') });
    expect(entry.lines.some((l) => l.account === '5100')).toBe(false);
    expect(entry.lines.find((l) => l.account === '1200')!.debit.amount.toString()).toBe('50000.00');
    expect(entry.lines.find((l) => l.account === '2000')!.credit.amount.toString()).toBe('27500.00');
    expect(validateJournalEntry(entry).ok).toBe(true);
  });

  it('does not count a customer receipt as a second revenue', () => {
    const entry = buildCustomerReceiptPosting({ ...base, reference: 'RCP-2', amount: money('BDT', '900') });
    expect(entry.lines.some((l) => l.account === '4000')).toBe(false);
    expect(entry.lines.find((l) => l.account === '1100')!.credit.amount.toString()).toBe('900.00');
  });

  it('does not count a supplier payment as a second expense', () => {
    const entry = buildSupplierPaymentPosting({ ...base, reference: 'PAY-2', amount: money('BDT', '900') });
    expect(entry.lines.some((l) => l.account === '5100')).toBe(false);
    expect(entry.lines.find((l) => l.account === '2000')!.debit.amount.toString()).toBe('900.00');
  });
});

describe('transfers and partner capital are not profit', () => {
  it('a transfer is neither income nor expense', () => {
    const entry = buildTransferPosting({ ...base, reference: 'TR-2', amount: money('BDT', '2500'), fromAccount: '1000', toAccount: '1020' });
    expect(entry.lines.some((l) => ['4000', '4100', '5000', '5100'].includes(l.account))).toBe(false);
    expect(entry.lines.find((l) => l.account === '1020')!.debit.amount.toString()).toBe('2500.00');
    expect(entry.lines.find((l) => l.account === '1000')!.credit.amount.toString()).toBe('2500.00');
  });

  it('refuses a transfer to the same account', () => {
    expect(() => buildTransferPosting({ ...base, reference: 'TR-3', amount: money('BDT', '10'), fromAccount: '1000', toAccount: '1000' })).toThrow(/same account/);
  });

  it('records contributions and withdrawals as equity', () => {
    const contribution = buildPartnerCapitalPosting({ ...base, reference: 'CAP-2', amount: money('BDT', '5000'), partnerId: 'p2', kind: 'CONTRIBUTION' });
    expect(contribution.lines.find((l) => l.account === '3100')!.credit.amount.toString()).toBe('5000.00');
    expect(contribution.lines.every((l) => l.partnerId === 'p2')).toBe(true);
    expect(contribution.lines.some((l) => ['4000', '5000'].includes(l.account))).toBe(false);

    const withdrawal = buildPartnerCapitalPosting({ ...base, reference: 'CAP-3', amount: money('BDT', '1500'), partnerId: 'p2', kind: 'WITHDRAWAL' });
    expect(withdrawal.lines.find((l) => l.account === '3300')!.debit.amount.toString()).toBe('1500.00');
    expect(withdrawal.lines.find((l) => l.account === '1000')!.credit.amount.toString()).toBe('1500.00');

    const balances = partnerCapitalBalances([contribution, withdrawal], 'BDT');
    expect(balances).toHaveLength(1);
    expect(balances[0]!.partnerId).toBe('p2');
    expect(balances[0]!.contributions.amount.toString()).toBe('5000.00');
    expect(balances[0]!.withdrawals.amount.toString()).toBe('1500.00');
    expect(balances[0]!.net.amount.toString()).toBe('3500.00');
  });
});

describe('farming account postings', () => {
  it('input purchase does not become a batch expense until it is issued', () => {
    const purchase = buildPurchasePosting({ ...base, reference: 'PUR-F1', inventoryValue: money('BDT', '20000'), inputTax: money('BDT', 0), paid: money('BDT', '20000') });
    expect(purchase.lines.find((l) => l.account === '1300')).toBeUndefined();

    const issue = buildInputIssuePosting({ ...base, reference: 'ISS-1', cost: money('BDT', '12000'), batchReference: 'CYC-1' });
    expect(issue.lines.find((l) => l.account === '1300')!.debit.amount.toString()).toBe('12000.00');
    expect(issue.lines.find((l) => l.account === '1200')!.credit.amount.toString()).toBe('12000.00');
    // The issue must not create another cash payment.
    expect(issue.lines.some((l) => ['1000', '1010', '1020', '2000'].includes(l.account))).toBe(false);
  });

  it('direct batch cost is recorded once, with no inventory leg', () => {
    const entry = buildDirectBatchCostPosting({ ...base, reference: 'DIR-1', cost: money('BDT', '3000'), expenseAccount: '5110', batchReference: 'CYC-1' });
    expect(entry.lines.find((l) => l.account === '1300')!.debit.amount.toString()).toBe('3000.00');
    expect(entry.lines.some((l) => l.account === '1200')).toBe(false);
  });

  it('harvest moves cost out of work-in-progress, recognising no profit', () => {
    const entry = buildHarvestPosting({ ...base, reference: 'HARV-1', costBasis: money('BDT', '15000') });
    expect(entry.lines.find((l) => l.account === '1210')!.debit.amount.toString()).toBe('15000.00');
    expect(entry.lines.find((l) => l.account === '1300')!.credit.amount.toString()).toBe('15000.00');
    expect(entry.lines.some((l) => ['4000', '5000'].includes(l.account))).toBe(false);
  });

  it('mortality is a separate loss account with a reason', () => {
    const entry = buildInventoryLossPosting({ ...base, reference: 'MOR-1', amount: money('BDT', '2200'), reason: '8 birds died - heat stress', kind: 'MORTALITY' });
    expect(entry.lines.find((l) => l.account === '5400')!.debit.amount.toString()).toBe('2200.00');
    expect(entry.description).toMatch(/heat stress/);
  });
});

describe('reversal keeps history intact', () => {
  it('produces an exact mirror entry', () => {
    const original = buildSalePosting({
      ...base,
      reference: 'SAL-3',
      revenue: money('BDT', '500'),
      discount: money('BDT', 0),
      tax: money('BDT', 0),
      cashReceived: money('BDT', '500'),
      cogs: money('BDT', '300'),
    });
    const reversal = buildReversal(original, { id: 'rev-1', date: '2026-01-20', reference: 'SAL-3-REV', postedBy: 'user-2', reason: 'Customer returned goods' });
    expect(validateJournalEntry(reversal).ok).toBe(true);
    expect(reversal.reversalOf).toBe(original.id);

    const combined = [...original.lines, ...reversal.lines];
    expect(totalDebit(combined, 'BDT').amount.eq(totalCredit(combined, 'BDT').amount)).toBe(true);

    // Every account nets to zero across the pair.
    const rows = new Map<string, { debit: number; credit: number }>();
    for (const line of combined) {
      const row = rows.get(line.account) ?? { debit: 0, credit: 0 };
      row.debit += line.debit.amount.toNumber();
      row.credit += line.credit.amount.toNumber();
      rows.set(line.account, row);
    }
    for (const row of rows.values()) expect(row.debit).toBeCloseTo(row.credit, 6);

    expect(() => buildReversal(reversal, { id: 'rev-2', date: '2026-01-21', reference: 'X', postedBy: 'u', reason: 'y' })).toThrow(/Cannot reverse a reversal/);
  });
});

describe('reports reconcile', () => {
  it('trial balance always balances', () => {
    const balance = trialBalance(ledger(), 'BDT');
    expect(balance.balanced).toBe(true);
    expect(balance.totalDebit.amount.toString()).toBe(balance.totalCredit.amount.toString());
  });

  it('profit and loss separates revenue, COGS and expenses', () => {
    const pnl = profitAndLoss(ledger(), { from: '2026-01-01', to: '2026-01-31', currency: 'BDT' });
    expect(pnl.revenue.amount.toString()).toBe('15000.00');
    expect(pnl.contraRevenue.amount.toString()).toBe('500.00');
    expect(pnl.netRevenue.amount.toString()).toBe('14500.00');
    expect(pnl.costOfGoodsSold.amount.toString()).toBe('9000.00');
    expect(pnl.grossProfit.amount.toString()).toBe('5500.00');
    expect(pnl.operatingExpenses.amount.toString()).toBe('1000.00');
    expect(pnl.netProfit.amount.toString()).toBe('4500.00');
    expect(pnl.basis).toBe('ACCRUAL');
  });

  it('excludes out-of-period entries', () => {
    const pnl = profitAndLoss(ledger(), { from: '2026-02-01', to: '2026-02-28', currency: 'BDT' });
    expect(pnl.netProfit.amount.isZero()).toBe(true);
  });

  it('the balance sheet balances once the unclosed result is included', () => {
    const sheet = balanceSheet(ledger(), { asOf: '2026-01-31', currency: 'BDT' });
    expect(sheet.balanced).toBe(true);
    expect(sheet.totalAssets.amount.toString()).toBe('108500.00');
    expect(sheet.totalLiabilities.amount.toString()).toBe('4000.00');
    expect(sheet.totalEquity.amount.toString()).toBe('100000.00');
    // 100,000 capital + 4,500 unclosed profit
    expect(sheet.totalEquityIncludingResult.amount.toString()).toBe('104500.00');
  });

  it('cash flow tracks the cash accounts only', () => {
    const flow = cashFlow(ledger(), { from: '2026-01-01', to: '2026-01-31', currency: 'BDT' });
    expect(flow.inflows.amount.toString()).toBe('112000.00'); // 100,000 capital + 8,000 sale cash + 4,000 receipt
    expect(flow.outflows.amount.toString()).toBe('27000.00'); // 20,000 + 6,000 + 1,000
    expect(flow.netChange.amount.toString()).toBe('85000.00');
    expect(flow.closing.amount.toString()).toBe('85000.00');
    expect(cashBalance(ledger(), 'BDT').amount.toString()).toBe('85000.00');
  });

  it('cash-basis result counts only cash actually received against revenue/expense', () => {
    const result = cashBasisOperatingResult(ledger(), { from: '2026-01-01', to: '2026-01-31', currency: 'BDT' });
    expect(result.amount.toString()).toBe('7000.00'); // 8,000 cash sale - 1,000 rent
  });

  it('profit is not the same as cash', () => {
    const pnl = profitAndLoss(ledger(), { from: '2026-01-01', to: '2026-01-31', currency: 'BDT' });
    const flow = cashFlow(ledger(), { from: '2026-01-01', to: '2026-01-31', currency: 'BDT' });
    expect(pnl.netProfit.amount.toString()).toBe('4500.00');
    expect(flow.netChange.amount.toString()).toBe('85000.00');
  });
});
