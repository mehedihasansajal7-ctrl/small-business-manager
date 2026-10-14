/**
 * Permission helpers for the UI.
 *
 * The SERVER is the authority — these only decide what to render, and every
 * hidden field is also redacted by the API for the same role. Pure functions so
 * they can be unit-tested without a DOM.
 */

export type PermissionSet = readonly string[];

export function hasPermission(permissions: PermissionSet, permission: string): boolean {
  return permissions.includes(permission);
}

export function hasAnyPermission(permissions: PermissionSet, required: readonly string[]): boolean {
  return required.some((permission) => permissions.includes(permission));
}

export function hasAllPermissions(permissions: PermissionSet, required: readonly string[]): boolean {
  return required.every((permission) => permissions.includes(permission));
}

/** Purchase cost, margin and stock valuation detail. */
export function canViewCost(permissions: PermissionSet): boolean {
  return hasPermission(permissions, 'purchase.cost.view');
}

/** Full financial statements (P&L, balance sheet, trial balance). */
export function canViewFinancialReports(permissions: PermissionSet): boolean {
  return hasPermission(permissions, 'financial_reports.view');
}

export function canViewPartnerCapital(permissions: PermissionSet): boolean {
  return hasPermission(permissions, 'partner_capital.view');
}

export function canViewFarmingCost(permissions: PermissionSet): boolean {
  return hasPermission(permissions, 'farming.cost.view');
}

/** A column that is only shown when the caller may see the permission it needs. */
export interface GatedColumn {
  readonly permission?: string;
  readonly permissions?: readonly string[];
}

export function visibleColumns<Column extends GatedColumn>(columns: readonly Column[], permissions: PermissionSet): Column[] {
  return columns.filter((column) => {
    if (column.permissions) return hasAllPermissions(permissions, column.permissions);
    if (column.permission) return hasPermission(permissions, column.permission);
    return true;
  });
}

/**
 * Remove sensitive fields from a row before it reaches the screen. Used for
 * values the API already redacts, so a cached/stale copy can never leak them
 * either. Returns the row unchanged when the caller is allowed.
 */
export function redactFields<T extends Record<string, unknown>>(row: T, fields: readonly string[], allowed: boolean): T {
  if (allowed) return row;
  const clone: Record<string, unknown> = { ...row };
  for (const field of fields) delete clone[field];
  return clone as T;
}

/** Cost-related fields on a product row. */
export const PRODUCT_COST_FIELDS = ['purchasePrice', 'taxRate'] as const;
/** Cost-related fields on an inventory row. */
export const INVENTORY_COST_FIELDS = ['unitCost', 'value'] as const;
/** Cost-related fields on a sale row. */
export const SALE_COST_FIELDS = ['cogs', 'grossProfit'] as const;
/** Cost-related fields on a purchase row. */
export const PURCHASE_COST_FIELDS = ['subtotal', 'tax'] as const;
/** Cost fields on a production cycle row. */
export const CYCLE_COST_FIELDS = ['costToDate', 'revenue', 'cogs', 'grossProfit'] as const;

export function redactProductCost<T extends Record<string, unknown>>(row: T, permissions: PermissionSet): T {
  return redactFields(row, PRODUCT_COST_FIELDS, canViewCost(permissions));
}

export function redactInventoryCost<T extends Record<string, unknown>>(row: T, permissions: PermissionSet): T {
  return redactFields(row, INVENTORY_COST_FIELDS, canViewCost(permissions));
}

export function redactSaleCost<T extends Record<string, unknown>>(row: T, permissions: PermissionSet): T {
  return redactFields(row, SALE_COST_FIELDS, canViewCost(permissions));
}

export function redactPurchaseCost<T extends Record<string, unknown>>(row: T, permissions: PermissionSet): T {
  return redactFields(row, PURCHASE_COST_FIELDS, canViewCost(permissions));
}

export function redactCycleCost<T extends Record<string, unknown>>(row: T, permissions: PermissionSet): T {
  return redactFields(row, CYCLE_COST_FIELDS, canViewFarmingCost(permissions));
}
