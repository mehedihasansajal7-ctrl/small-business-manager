import { addMoney, dec, money, mulMoney, subMoney, zeroMoney, type Money } from '@sbm/domain';

/**
 * Client-side document maths.
 *
 * This mirrors the server's `createSale` / `createPurchase` exactly and uses
 * `Money`/`Decimal` (never floating point), so the preview the user sees equals
 * what the server will post. It is only ever a PREVIEW — the server recomputes
 * everything and its numbers win.
 */

export interface DraftSaleLine {
  readonly productId: string;
  readonly description?: string;
  readonly quantity: string;
  readonly unit: string;
  readonly unitPrice: string;
  readonly discount?: string;
  readonly tax?: string;
}

export interface SaleTotals {
  readonly gross: Money;
  readonly discount: Money;
  readonly tax: Money;
  readonly net: Money;
  readonly cashReceived: Money;
  readonly receivable: Money;
}

export function computeSaleTotals(input: {
  readonly currency: string;
  readonly lines: readonly DraftSaleLine[];
  readonly headerDiscount?: string | undefined;
  readonly cashReceived?: string | undefined | null;
}): SaleTotals {
  const currency = input.currency;
  let gross = zeroMoney(currency);
  let lineDiscounts = zeroMoney(currency);
  let tax = zeroMoney(currency);

  for (const line of input.lines) {
    const quantity = dec(line.quantity || '0');
    const unitPrice = money(currency, line.unitPrice || '0');
    gross = addMoney(gross, mulMoney(unitPrice, quantity));
    lineDiscounts = addMoney(lineDiscounts, money(currency, line.discount || '0'));
    tax = addMoney(tax, money(currency, line.tax || '0'));
  }

  const headerDiscount = money(currency, input.headerDiscount || '0');
  const discount = addMoney(lineDiscounts, headerDiscount);
  const net = subMoney(addMoney(gross, tax), discount);
  const cashReceived = input.cashReceived === undefined || input.cashReceived === null || input.cashReceived === '' ? net : money(currency, input.cashReceived);
  const receivable = subMoney(net, cashReceived);

  return { gross, discount, tax, net, cashReceived, receivable };
}

export interface DraftPurchaseLine {
  readonly productId: string;
  readonly quantity: string;
  readonly unit: string;
  readonly unitCost: string;
  readonly tax?: string;
}

export interface PurchaseTotals {
  readonly inventoryValue: Money;
  readonly tax: Money;
  readonly total: Money;
  readonly paid: Money;
  readonly payable: Money;
}

export function computePurchaseTotals(input: {
  readonly currency: string;
  readonly lines: readonly DraftPurchaseLine[];
  readonly paid?: string | undefined;
}): PurchaseTotals {
  const currency = input.currency;
  let inventoryValue = zeroMoney(currency);
  let tax = zeroMoney(currency);
  for (const line of input.lines) {
    const quantity = dec(line.quantity || '0');
    const unitCost = money(currency, line.unitCost || '0');
    inventoryValue = addMoney(inventoryValue, mulMoney(unitCost, quantity));
    tax = addMoney(tax, money(currency, line.tax || '0'));
  }
  const total = addMoney(inventoryValue, tax);
  const paid = money(currency, input.paid || '0');
  return { inventoryValue, tax, total, paid, payable: subMoney(total, paid) };
}

/** Serializable form for the API payload (strings, exactly as the server expects). */
export function salePayload(input: {
  readonly documentDate: string;
  readonly currency: string;
  readonly customerId?: string | undefined;
  readonly locationId?: string | undefined;
  readonly lines: readonly DraftSaleLine[];
  readonly headerDiscount?: string | undefined;
  readonly cashReceived?: string | undefined;
  readonly accountCode?: string | undefined;
  readonly note?: string | undefined;
  readonly allowNegative?: boolean;
  readonly negativeReason?: string | undefined;
  readonly deviceId?: string | undefined;
}): Record<string, unknown> {
  return {
    documentDate: input.documentDate,
    currency: input.currency,
    ...(input.customerId ? { customerId: input.customerId } : {}),
    ...(input.locationId ? { locationId: input.locationId } : {}),
    ...(input.headerDiscount && input.headerDiscount !== '0' ? { discount: input.headerDiscount } : {}),
    ...(input.cashReceived !== undefined && input.cashReceived !== '' ? { cashReceived: input.cashReceived } : {}),
    ...(input.accountCode ? { accountCode: input.accountCode } : {}),
    ...(input.note ? { note: input.note } : {}),
    ...(input.allowNegative ? { allowNegative: true } : {}),
    ...(input.allowNegative && input.negativeReason ? { negativeReason: input.negativeReason } : {}),
    ...(input.deviceId ? { deviceId: input.deviceId } : {}),
    lines: input.lines.map((line) => ({
      productId: line.productId,
      ...(line.description ? { description: line.description } : {}),
      quantity: line.quantity,
      unit: line.unit,
      unitPrice: line.unitPrice,
      ...(line.discount ? { discount: line.discount } : {}),
      ...(line.tax ? { tax: line.tax } : {}),
    })),
  };
}

export function purchasePayload(input: {
  readonly documentDate: string;
  readonly currency: string;
  readonly supplierId?: string | undefined;
  readonly locationId?: string | undefined;
  readonly lines: readonly DraftPurchaseLine[];
  readonly paid?: string | undefined;
  readonly accountCode?: string | undefined;
  readonly note?: string | undefined;
  readonly deviceId?: string | undefined;
}): Record<string, unknown> {
  return {
    documentDate: input.documentDate,
    currency: input.currency,
    ...(input.supplierId ? { supplierId: input.supplierId } : {}),
    ...(input.locationId ? { locationId: input.locationId } : {}),
    ...(input.paid !== undefined && input.paid !== '' ? { paid: input.paid } : {}),
    ...(input.accountCode ? { accountCode: input.accountCode } : {}),
    ...(input.note ? { note: input.note } : {}),
    ...(input.deviceId ? { deviceId: input.deviceId } : {}),
    lines: input.lines.map((line) => ({
      productId: line.productId,
      quantity: line.quantity,
      unit: line.unit,
      unitCost: line.unitCost,
      ...(line.tax ? { tax: line.tax } : {}),
    })),
  };
}
