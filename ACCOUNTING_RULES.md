# ACCOUNTING_RULES.md — the posting rules this system actually implements

This document describes the accounting behaviour that is **implemented and unit-tested**
in `packages/domain/src/accounting.ts` (tested by `packages/domain/test/accounting.test.ts`,
24 tests) and persisted by `apps/api/src/repository.ts`.

Everything here is derived from the code. Where a rule is a *documented convention* rather
than a law of accounting, it is labelled as such.

> ### ⚠️ Not formal tax or accounting advice
> This software implements a **plain double-entry bookkeeping model** for small-business
> internal management. It makes **no claim of compliance** with the Income Tax Act 2023,
> the VAT Act 2012, BFRS, IFRS, IAS 41 (agriculture) or any other standard or regulator.
> It does not produce statutory returns, VAT returns, audited statements or anything
> suitable for filing. Use a qualified accountant for anything that has legal or fiscal
> consequence. The chart of accounts is a *management* chart of accounts.

---

## 1. Chart of accounts

Fixed, stable codes so that history stays comparable across years. Source of truth:
`STANDARD_ACCOUNTS` in `packages/domain/src/accounting.ts`.

`code · name · nameBn · type · normal balance` — `contra` marks an account that offsets its
parent (it is entered on the opposite side of its type's normal balance).

| Code | Name | বাংলা | Type | Normal | Contra? |
|---|---|---|---|---|---|
| 1000 | Cash in Hand | হাতে নগদ | ASSET | DEBIT | |
| 1010 | Bank Account | ব্যাংক হিসাব | ASSET | DEBIT | |
| 1020 | Mobile Financial Service | মোবাইল আর্থিক সেবা | ASSET | DEBIT | |
| 1100 | Accounts Receivable | প্রাপ্য হিসাব | ASSET | DEBIT | |
| 1200 | Inventory – Inputs & Goods | মজুদ – ইনপুট ও পণ্য | ASSET | DEBIT | |
| 1210 | Inventory – Finished Output | মজুদ – উৎপাদিত পণ্য | ASSET | DEBIT | |
| 1220 | Livestock / Biological Assets | পশুসম্পদ | ASSET | DEBIT | |
| 1300 | Work in Progress – Production Batches | চলমান উৎপাদন | ASSET | DEBIT | |
| 1400 | Input Tax Receivable | প্রদেয় কর সমন্বয় | ASSET | DEBIT | |
| 1500 | Fixed Assets | স্থায়ী সম্পদ | ASSET | DEBIT | |
| 1600 | Accumulated Depreciation | সঞ্চিত অবচয় | ASSET | CREDIT | ✔ |
| 2000 | Accounts Payable | প্রদেয় হিসাব | LIABILITY | CREDIT | |
| 2100 | Loans Payable | ঋণ | LIABILITY | CREDIT | |
| 2200 | Tax Payable | কর প্রদেয় | LIABILITY | CREDIT | |
| 2300 | Accrued Expenses | সঞ্চিত খরচ | LIABILITY | CREDIT | |
| 3000 | Owner Capital | মালিকের পুঁজি | EQUITY | CREDIT | |
| 3100 | Partner Contributions | অংশীদারদের পুঁজি | EQUITY | CREDIT | |
| 3200 | Retained Earnings | সঞ্চিত মুনাফা | EQUITY | CREDIT | |
| 3300 | Partner Drawings | অংশীদারদের উত্তোলন | EQUITY | DEBIT | ✔ |
| 4000 | Sales Revenue | বিক্রয় আয় | REVENUE | CREDIT | |
| 4100 | Other Income | অন্যান্য আয় | REVENUE | CREDIT | |
| 4900 | Sales Discounts | বিক্রয় ছাড় | REVENUE | DEBIT | ✔ |
| 4910 | Sales Returns | বিক্রয় ফেরত | REVENUE | DEBIT | ✔ |
| 5000 | Cost of Goods Sold | বিক্রিত পণ্যের ব্যয় | EXPENSE | DEBIT | |
| 5100 | Operating Expenses | পরিচালন ব্যয় | EXPENSE | DEBIT | |
| 5110 | Labour & Wages | শ্রম ও মজুরি | EXPENSE | DEBIT | |
| 5120 | Utilities | বিদ্যুৎ ও পানি | EXPENSE | DEBIT | |
| 5130 | Transport | পরিবহন | EXPENSE | DEBIT | |
| 5140 | Fuel & Machinery | জ্বালানি ও যন্ত্রপাতি | EXPENSE | DEBIT | |
| 5150 | Veterinary & Medicine (direct) | পশুচিকিৎসা (সরাসরি) | EXPENSE | DEBIT | |
| 5160 | Repairs & Maintenance | মেরামত | EXPENSE | DEBIT | |
| 5170 | Rent | ভাড়া | EXPENSE | DEBIT | |
| 5180 | Packaging | মোড়ক | EXPENSE | DEBIT | |
| 5300 | Inventory Shrinkage & Adjustments | মজুদ ঘাটতি | EXPENSE | DEBIT | |
| 5400 | Mortality & Production Loss | মৃত্যু ও উৎপাদন ক্ষতি | EXPENSE | DEBIT | |
| 5500 | Bad Debt | অনাদায়ী পাওনা | EXPENSE | DEBIT | |
| 5600 | Depreciation | অবচয় | EXPENSE | DEBIT | |
| 5700 | Interest Expense | সুদ ব্যয় | EXPENSE | DEBIT | |

**Cash accounts** are `1000`, `1010`, `1020` — the set hard-coded as `CASH_ACCOUNTS` and
exposed through `isCashAccount()`. Cash-flow and cash-basis reports read *only* these three.

Accounts that the chart defines but that the **current API does not post to** and no UI
exposes (honest list): `1400`, `1500`, `1600`, `2100`, `2200`¹, `2300`, `3000`, `3200`,
`5500`, `5600`, `5700`. They exist so the chart is complete and so future features
(VAT, loans, depreciation, bad debt) have a home without a migration. ¹`2200` *is* posted
by `buildSalePosting` when a sale line carries tax.

---

## 2. The one invariant

Every entry is validated by `validateJournalEntry()` before it is written:

- `businessId`, ISO `date`, `reference`, `currency` all required;
- **at least two lines**;
- on each line **exactly one** of debit/credit is positive (never both, never neither);
- amounts are **never negative** — use the other side instead;
- every account code must exist in the chart;
- `totalDebit == totalCredit` **exactly** (exact decimal comparison, not a float epsilon).

`assertValidEntry()` throws `AccountingError('INVALID_ENTRY')` if any of these fail, and
`repository.postJournal()` re-validates and refuses to persist an unbalanced entry with
HTTP `400 UNBALANCED_ENTRY`. A dashboard formula is **never** the authoritative record.

Posting is **idempotent by event id**: `journal_entries.event_id` is `UNIQUE` and
`postJournal()` returns the existing row instead of inserting a duplicate. That is what
makes sync retries safe.

---

## 3. Journal template per business event

Notation: `Dr` = debit, `Cr` = credit. Only non-zero legs are emitted.

### 3.1 Sale — `buildSalePosting()` — source type `SALE`

```
Dr  1000/1010/1020  Cash received               (if > 0)
Dr  1100            Accounts Receivable         (if net > cash)     ← credit sale
Cr  1100            Accounts Receivable         (if cash > net)     ← overpayment / advance
Dr  4900            Sales Discounts             (if discount > 0)
    Cr  4000        Sales Revenue                                   (gross, before discount & tax)
    Cr  2200        Tax Payable                 (if tax > 0)

Dr  5000            Cost of Goods Sold          (if cogs > 0)
    Cr  1200        Inventory released
```

Revenue is recognised **once**. `cogs` comes from the weighted-average cost layer at the
moment of sale (see §6), never recomputed later. A `SERVICE` product contributes no stock
movement and no COGS.

### 3.2 Purchase — `buildPurchasePosting()` — source type `PURCHASE`

```
Dr  1200            Inventory (input/goods value, EXCLUDES tax)
Dr  1400            Input Tax Receivable         (if input tax > 0)
    Cr  1000/1010/1020  Cash paid                 (if paid > 0)
    Cr  2000            Accounts Payable           (if payable > 0)
Dr  2000            Accounts Payable             (if paid > total → advance to supplier)
```

**A stock purchase is an asset swap, not an operating expense.** Buying 500 kg of rice does
not reduce profit; profit falls when the rice is *sold* and COGS is recognised.

### 3.3 Customer receipt — `buildCustomerReceiptPosting()` — `RECEIPT`

```
Dr  1000/1010/1020  Cash received
    Cr  1100        Accounts Receivable cleared
```

No revenue leg. **Incorrectly treating this as revenue would double-count the sale.**

### 3.4 Supplier payment — `buildSupplierPaymentPosting()` — `PAYMENT`

```
Dr  2000            Accounts Payable settled
    Cr  1000/1010/1020  Cash paid
```

No expense leg. **Incorrectly treating this as an expense would double-count the purchase.**

### 3.5 Account transfer — `buildTransferPosting()` — `TRANSFER`

```
Dr  <toAccount>     Transfer in
    Cr  <fromAccount>   Transfer out
```

Neither income nor expense. `fromAccount === toAccount` throws
`AccountingError('INVALID_ENTRY')` — a transfer to itself is refused.

### 3.6 Income / expense — `buildIncomeExpensePosting()` — `INCOME_EXPENSE`

Category account must be a REVENUE account for income and an EXPENSE account for expense;
the API rejects a mismatch with `400 VALIDATION`.

```
EXPENSE, paid:                  EXPENSE, unpaid (accrued):
Dr  <category>   amount         Dr  <category>   amount
    Cr  <cash>       amount         Cr  2000           amount

INCOME, received:               INCOME, not yet received:
Dr  <cash>       amount         Dr  1100         amount
    Cr  <category>   amount         Cr  <category>   amount
```

### 3.7 Partner capital — `buildPartnerCapitalPosting()` — `PARTNER_CONTRIBUTION` / `PARTNER_WITHDRAWAL`

```
CONTRIBUTION (equity up):        WITHDRAWAL (equity down, contra):
Dr  <cash>        amount         Dr  3300  Partner Drawings   amount
    Cr  3100  Partner Contributions           Cr  <cash>      amount
```

Every line is tagged with `partnerId` (the member's display name), so
`partnerCapitalBalances()` can report contributions / withdrawals / net per partner.
**These are equity movements, not sales revenue and not operating expense** — a
contribution must never inflate profit, and a drawing must never reduce it.

### 3.8 Inventory shrinkage / mortality — `buildInventoryLossPosting()` — `INVENTORY_ADJUSTMENT` / `MORTALITY_LOSS`

```
Dr  5300 (shrinkage)  or  5400 (mortality)   amount
    Cr  1200 (or the given inventory account)   amount
```

The write-off reason is part of the description and the audit detail. Mortality is a
**separate loss account** from generic shrinkage, deliberately, so it can be watched.

### 3.9 Input issued to a production batch — `buildInputIssuePosting()` — `INPUT_ISSUE`

```
Dr  1300            Work in Progress — batch input cost
    Cr  1200        Input stock released
```

This is the **only** moment a bought input becomes a batch cost. The input was already an
asset (1200) from the purchase; issuing it moves value from store to WIP. **No second cash
payment, no second ordinary expense.**

### 3.10 Direct (non-stock) batch cost — `buildDirectBatchCostPosting()` — `DIRECT_BATCH_COST`

```
Paid:                            Unpaid (accrued):
Dr  1300  WIP     cost           Dr  1300  WIP     cost
    Cr  <cash>        cost           Cr  2000          cost
```

Used for hired labour, machinery/fuel, veterinary, utilities, packaging, transport and
overhead that never sat in inventory. **A cost must go through 3.9 xor 3.10 — never both**,
or the batch is charged twice.

### 3.11 Harvest / production completion — `buildHarvestPosting()` — `HARVEST`

```
Dr  1210            Inventory — Finished Output   (cost basis assigned to THIS harvest)
    Cr  1300        Batch cost released
```

**No profit is recognised at harvest.** Profit appears only when the output is sold (3.1).
If the harvest's `costBasis` is zero, no entry is written at all — the harvest record still
exists and unsold stock is still in inventory.

### 3.12 Reversal — `buildReversal()` — `REVERSAL`

```
lines = original lines with debit and credit SWAPPED
sourceId   = the original entry id
reversalOf = the original entry id
```

The original entry is **never edited or deleted**. The reversal is a new, dated, referenced,
balanced entry. Reversing a reversal throws `AccountingError('INVALID_ENTRY')`.

### 3.13 Not implemented (be honest)

`buildIncomeExpensePosting` and the chart cover the *shape* of these, but there is **no**
code path today for: sales returns (`4910`), purchase returns, bad debt (`5500`),
depreciation (`5600`), loan principal/interest (`2100`/`5700`), opening balances
(`finance.opening_balance` is a permission with no endpoint), or period closing to
`3200 Retained Earnings`. The `sales`/`purchases` tables have no `status = RETURNED` flow.
Adding them needs a documented policy per item — do **not** fake them with a journal entry.

---

## 4. Cash movement is not accrual profit

Two different questions, two different reports, both from the same ledger.

| | Accrual | Cash basis |
|---|---|---|
| Function | `profitAndLoss()` | `cashBasisOperatingResult()` + `cashFlow()` |
| Basis field | `basis: 'ACCRUAL'` | reported as a separate line alongside |
| Sale on credit | full net revenue + COGS recognised | only the cash actually received counts |
| Supplier payment next month | no effect (bill already booked) | counted when the cash leaves |
| Stock purchase | asset, no expense | cash out, shown in `cashFlow` outflows |
| Partner capital / drawings | equity, not profit | **excluded by construction** |
| Account transfer | not profit | net zero across cash accounts |

### 4.1 `profitAndLoss()` — the accrual figure

- `grossRevenue` = Σ over REVENUE accounts that are **not** contra of `credit − debit`
- `contraRevenue` = Σ over REVENUE **contra** accounts (`4900`, `4910`) of `debit − credit`
- `netRevenue = grossRevenue − contraRevenue`
- `costOfGoodsSold` = account `5000` only
- `grossProfit = netRevenue − cogs`
- `operatingExpenses` = every other EXPENSE account, itemised in `expensesByAccount`
- `otherIncome` = account `4100`
- `netProfit = grossProfit + otherIncome − operatingExpenses`
- Entries are filtered by `date` inside `[from, to]` inclusive, in the **business timezone**'s
  calendar dates (`APP_TIMEZONE`, default `Asia/Dhaka`) — not UTC.

### 4.2 `cashBasisOperatingResult()` — the documented definition

Quoted from the implementation, because the definition *is* the documentation:

> **Definition used here (documented, deliberately simple and reproducible):** net movement
> of the cash / bank / MFS accounts in those entries that **RECOGNISE revenue or expense**.
> So a sale paid partly on credit counts only the cash actually received, and a supplier
> payment of a stock bill the following month does not count again.
>
> **Excluded by construction:** partner capital, drawings, loans, account transfers, and
> cash tied up in still-owned inventory.

Mechanically: for each entry in range, keep it only if **some** line's account type is
REVENUE or EXPENSE; then add `debit − credit` for every cash-account line.
Unit test `'profit is not the same as cash'` asserts that the two figures differ for a
credit sale — i.e. the distinction is tested, not merely claimed.

### 4.3 `balanceSheet()` and `trialBalance()`

`balanceSheet(asOf)`: assets are `debit − credit`, liabilities/equity are `credit − debit`,
so contra accounts subtract automatically. `balanced` **includes the unclosed current-period
result**, because this system reports the result from the ledger instead of posting a
closing entry. That is a documented modelling choice, not a rounding trick — and the
balance-sheet unit test asserts `balanced === true` including it.

`trialBalance()` sums every account's debits and credits and asserts equality; the
`'trial balance always balances'` test plus the API test
`trial.body.totalDebit === trial.body.totalCredit` both check it.

---

## 5. Inventory valuation — weighted average, with a snapshot rule

`weightedAverageValuation()` in `packages/domain/src/inventory.ts`.

- Movements are **sorted chronologically** (`occurredAt`, then `createdAt`, then `id`) so a
  late-arriving offline event cannot silently re-value history out of order.
- On **IN**: `quantity += qty`, `value += qty × unitCost`.
- On **OUT**: the issue is valued at the **average in force at that moment**
  (`average = value / quantityBefore`), then `quantity -= qty`,
  `value -= qty × average`.
- Therefore **historical COGS never changes when a later purchase is more expensive** —
  the outbound movement is *snapshotted*. The test
  `'values an issue at the average in force at that moment, and never changes history'`
  proves exactly this.
- Outbound quantity greater than stock throws `StockError('NEGATIVE_STOCK')` — the
  valuation function itself refuses to go negative.
- Mixing currencies on one item throws `MIXED_CURRENCY`; mixing units throws `UNIT_MISMATCH`.
- `unitCost` at zero quantity is a zero `Money`, never `NaN` or a divide-by-zero.

**Only `WEIGHTED_AVERAGE` exists.** `ValuationMethod` is a union with a single member. FIFO
is *not* offered for valuation; FIFO/FEFO exist **only** as lot *selection* strategies
(`planLotIssue`, `LotStrategy = 'FIFO' | 'FEFO'`), which is a different question.

### 5.1 The snapshot rule

Every `stock_movements` row stores `unit_cost` and `currency` **at the time of the
movement**. Nothing recomputes a past movement's cost. This is why:

- an offline sale recorded on Monday but uploaded on Friday still carries Monday's cost;
- deleting a later purchase cannot retroactively change earlier COGS (and deletes are not
  offered anyway — see §7).

`movementValue(mv) = quantity × unitCost` — the stored snapshot, never a fresh lookup.

### 5.2 Lots

`stock_lots` records `lot_no`, `unit_cost`, `received_at`, `expiry_date` per lot when
`products.track_lots = 1`. `planLotIssue()` picks lots **FEFO** (earliest expiry first,
`null` expiry sorted last via a `9999-12-31` sentinel) or **FIFO** (earliest receipt), and
returns `shortfall` rather than over-issuing. Lots are tracked and selectable, but the
**GL valuation is still weighted-average** — lot costs are used by the lot-planning helper,
not by the balance-sheet valuation. This asymmetry is deliberate and is stated here so no
one assumes FIFO COGS.

---

## 6. Batch (production-cycle) costing

Implemented in `packages/domain/src/farming.ts`, tested by `farming.test.ts` (13 tests) and
proven end-to-end by the API test `'runs input purchase → issue → labour → harvest → sale'`.

### 6.1 What may become a batch cost — and at most once

| Source | How it enters the batch | Backing event |
|---|---|---|
| Input consumed from store | valued at the weighted-average cost at issue | `INPUT_ISSUE` |
| Direct labour | direct batch cost | `DIRECT_LABOUR` |
| Machinery / fuel | direct batch cost | `MACHINERY_FUEL` |
| Veterinary / medicine (not from stock) | direct batch cost | `VETERINARY` |
| Utilities, packaging, transport | direct batch cost | `UTILITIES`/`PACKAGING`/`TRANSPORT` |
| Allocated shared overhead | `allocateCost()` shares | `ALLOCATION` |

`CostKind` enumerates these: `INPUT_ISSUE`, `DIRECT_LABOUR`, `MACHINERY_FUEL`,
`VETERINARY`, `UTILITIES`, `PACKAGING`, `TRANSPORT`, `OVERHEAD`, `OTHER_DIRECT`.

`cycleCostToDate()` = Σ non-shared `cost_sources` for the cycle **+** Σ `cost_allocations`
for the cycle. A shared `cost_sources` row has `cycle_id = NULL` and `shared = 1`, so it is
never counted twice: once as the pool and once as the share.

### 6.2 Allocation bases

`AllocationBasis` = `ACTUAL_USAGE | AREA | TIME | OUTPUT_QTY | ANIMAL_COUNT | BIOMASS |
MANUAL_PERCENT`. Stored per share in `cost_allocations.basis` and `basis_value`, with
`share_ratio` and the approver (`created_by`) and timestamp.

### 6.3 The rounding-residual rule (deterministic, documented)

`allocateCost()` converts each target's weight and then calls `Decimal.allocate()`, which
implements the **largest-remainder method**:

1. Each share is computed exactly, then rounded **down** (`FLOOR`) to the currency's minor
   unit.
2. The leftover minor units are handed out **in descending order of fractional remainder**;
   **ties go to the earlier index**, i.e. to the target with the larger basis value, and
   where those are equal, to the **lower `cycleId`** (shares are re-sorted by
   `cycleId` ascending before returning, so the order is stable and reproducible).
3. Shares therefore **always sum exactly to the allocated total** — no poysha is lost or
   invented. Test: `'rounding residual is deterministic (largest weight, then lowest cycle
   id)'`, and the API test asserts
   `[...shares].reduce((a,b)=>a+b,0) === 1000` for a 1/3 : 2/3 split of ৳1,000.
4. If the method is `MANUAL_PERCENT` and the percentages total **less than 100**, the
   remainder is returned as an explicit **`unallocated`** amount — a cost can never
   disappear silently. `unallocated` is reported back to the caller and shown in the API
   response. If shares would exceed the cost, `FarmingError('OVER_ALLOCATION')` is thrown.
5. Zero total weight → `ZERO_BASIS`; no targets → `NO_TARGETS`; negative basis →
   `INVALID_QUANTITY`; a manual percent outside 0–100 → `INVALID_PERCENT`.

### 6.4 Partial-harvest costing

`assignHarvestCost()` with two documented methods:

| Method | Formula | When to use |
|---|---|---|
| `PLANNED_YIELD_PRORATA` | `costPerUnit = costToDate / plannedOutput`; `assigned = costPerUnit × thisHarvestQty` | while the cycle is still producing |
| `CLOSING_REMAINDER` | `assigned = costToDate − assignedCostToDate` (everything left) | the final harvest / cycle close |

Guard rails, in this order:

- `thisHarvestQuantity` must be `> 0` → else `INVALID_QUANTITY`;
- `PLANNED_YIELD_PRORATA` requires `plannedOutput > 0` → else `INVALID_QUANTITY`;
- the assignment is **capped** at `remainingCost = costToDate − assignedCostToDate` and
  `capped: true` is returned when the cap bit;
- a negative assignment is clamped to zero with `capped: true`;
- `nextState.assignedCostToDate` accumulates, so **the whole batch cost can never land on a
  partial harvest**. Test: `'never assigns the whole batch cost to a partial harvest'`.

The API end-to-end test shows the arithmetic: cost-to-date ৳9,000 over a planned 1,000 kg →
৳9.00/kg → a 500 kg harvest is assigned ৳4,500, `capped === false`, and ৳4,500 remains in the
batch.

### 6.5 `cycleProfit()` — where the profit actually is

```
grossProfit          = revenue − cogs            ← accrual profit on what was SOLD
costInUnsoldOutput   = assignedCostToFinishedStock − costReleasedWithSales
costRemainingInBatch = costToDate − assignedCostToFinishedStock
unsoldQuantity       = harvestedQuantity − soldQuantity
marginPercent        = grossProfit / revenue × 100   (0 when revenue is zero)
```

Both "cost still sitting in unsold stock" and "cost still in the growing batch" are clamped
at zero if they would go negative. The report is therefore **not** inflated by unsold
harvest and does not divide by zero on a zero-revenue cycle — both are tested.

`cycleCostLedger()` groups every cost assigned to a cycle **exactly once** (non-shared
`cost_sources` plus allocated shares) and returns per-kind subtotals with each kind's
percentage share of the batch total.

### 6.6 Mortality / loss

`summarizeMortality()` returns total loss, live population, `mortalityPercent`
(= loss / starting population × 100, 0 when the population is zero), the book value of the
loss, a count of `abnormal` events, and `alert` when the percentage exceeds the warning
threshold (default **10%**, overridable). The API marks a loss `abnormal` when the recorded
quantity is **≥ 25** units and returns an escalation string telling the user to contact a
licensed veterinarian or the extension officer. Journal side: `5400 Mortality & Production
Loss` (see 3.8) — separate from `5300` shrinkage.

### 6.7 Breeding, milk/egg yield, biological-asset revaluation

`feedConversionRatio()` (`feed / weightGained`), `yieldPerArea()`, `outputPerAnimal()` and
the `1220 Livestock / Biological Assets` account exist. But **there is no IAS 41 fair-value
model, no biological-asset growth revaluation, and no automatic offspring/birth accounting**
implemented. Livestock is costed as a batch like any other cycle. If you need that, define
the policy first, then build it — do not approximate it with a journal entry.

---

## 7. Add-only history: reversal, never mutation

- `journal_entries` and `journal_lines` are **append-only** in practice: no code path
  `UPDATE`s or `DELETE`s a posted line or entry. The only mutation is
  `sync_conflicts` bookkeeping and `production_cycles.status`.
- `stock_movements` is an append-only ledger. There is no API to edit a movement; the only
  sanctioned correction is an `ADJUSTMENT` movement (with a mandatory reason of ≥5
  characters) or a `REVERSAL` pair, both audited.
- Corrections therefore always leave a **visible trail**: you can always see both the
  original and the correction, and both are dated.
- `deleted_at` soft-delete exists **only** on `products` (master data) and
  `ai_conversations`. `products.deleted_at` is not currently set by any endpoint —
  deactivation uses `is_active = 0` — so in practice soft delete is used for AI
  conversations only. **Financial and stock records are never deleted.**
- `ON DELETE CASCADE` is declared on parent→child FKs (e.g. `journal_lines.entry_id`,
  `sale_lines.sale_id`). In practice nothing deletes a business or a posted document, so
  the cascade is a safety net, not a workflow.

---

## 8. Tests that prove these rules

`packages/domain/test/accounting.test.ts` (24 tests) — full list:

- journal validation: accepts balanced; rejects unbalanced / two-sided lines / negative
  amounts / unknown accounts; requires ≥ 2 lines; exposes balance totals
- sale posting: recognises revenue once and books COGS against inventory; refuses to post
  an unbalanced sale
- purchase / receipt / payment: purchase is an asset not an expense; a receipt is **not** a
  second revenue; a payment is **not** a second expense
- transfers & partner capital: a transfer is neither income nor expense; a transfer to the
  same account is refused; contributions and withdrawals are equity
- farming postings: input purchase is not a batch expense until issued; a direct batch cost
  has no inventory leg; harvest recognises no profit; mortality has its own loss account and
  a reason
- reversal produces an exact mirror entry
- reports: trial balance balances; P&L separates revenue/COGS/expenses; out-of-period entries
  excluded; balance sheet balances including the unclosed result; cash flow tracks the cash
  accounts only; cash-basis result counts only cash received against revenue/expense;
  **profit is not the same as cash**

`apps/api/test/api.test.ts` proves the wiring: a purchase + sale + receipt + expense weeks
apart produce `netRevenue 3300.00`, `cogs 2900.00`, `netProfit −600.00`, `payables 3800.00`,
a balancing trial balance and a balancing balance sheet.
