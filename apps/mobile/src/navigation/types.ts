import type { NavigatorScreenParams } from '@react-navigation/native';

/**
 * Navigation type map.
 *
 * One stack per module (mirroring the server's module list) so a deep link or a
 * dashboard tile can address a specific record, and so the drawer/tab shell can
 * be swapped per screen size without touching a single screen file.
 */

export type AuthStackParamList = {
  SignIn: undefined;
  Register: undefined;
};

export type OnboardingStackParamList = {
  Onboarding: undefined;
  BusinessSwitcher: undefined;
};

export type DashboardStackParamList = {
  Dashboard: undefined;
  SyncStatus: undefined;
  AIAgent: undefined;
};

export type SalesStackParamList = {
  SalesList: undefined;
  SaleEdit: { saleId?: string } | undefined;
};

export type PurchasesStackParamList = {
  PurchaseList: undefined;
  PurchaseEdit: undefined;
};

export type InventoryStackParamList = {
  InventoryList: undefined;
  StockAdjust: { itemId?: string } | undefined;
  MovementHistory: { itemId?: string } | undefined;
};

export type FinanceStackParamList = {
  FinanceHome: undefined;
  Transfer: undefined;
  IncomeExpense: { kind: 'INCOME' | 'EXPENSE' };
  Receipt: undefined;
  Payment: undefined;
  PartnerCapital: undefined;
};

export type FarmingStackParamList = {
  FarmingHome: undefined;
  FarmList: undefined;
  NewFarm: undefined;
  FarmUnits: { farmId: string; farmName: string };
  NewFarmUnit: { farmId: string };
  CycleList: { farmId?: string } | undefined;
  CycleDetail: { cycleId: string; title?: string };
  NewCycle: { farmId?: string; unitId?: string } | undefined;
  FarmingEventForm: { cycleId: string; eventType: string; title: string };
  HarvestForm: { cycleId: string };
  AllocationForm: undefined;
  CycleProfitScreen: { cycleId: string };
};

export type ReportsStackParamList = {
  ReportsHome: undefined;
};

export type MoreStackParamList = {
  MoreHome: undefined;
  Customers: undefined;
  Suppliers: undefined;
  Products: undefined;
  ProductEdit: { productId?: string } | undefined;
  Team: undefined;
  AuditLog: undefined;
  AIAgent: undefined;
  SyncStatus: undefined;
  Settings: undefined;
  BusinessSwitcher: undefined;
};

export type AppTabsParamList = {
  DashboardTab: NavigatorScreenParams<DashboardStackParamList>;
  SalesTab: NavigatorScreenParams<SalesStackParamList>;
  InventoryTab: NavigatorScreenParams<InventoryStackParamList>;
  FinanceTab: NavigatorScreenParams<FinanceStackParamList>;
  FarmingTab: NavigatorScreenParams<FarmingStackParamList>;
  ReportsTab: NavigatorScreenParams<ReportsStackParamList>;
  MoreTab: NavigatorScreenParams<MoreStackParamList>;
};

export type RootStackParamList = {
  Auth: NavigatorScreenParams<AuthStackParamList>;
  Onboarding: NavigatorScreenParams<OnboardingStackParamList>;
  App: NavigatorScreenParams<AppTabsParamList>;
};
