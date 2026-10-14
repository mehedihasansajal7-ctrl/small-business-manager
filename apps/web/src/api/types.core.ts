/** Response shapes for this area of the API. */
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
