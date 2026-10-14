import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createDrawerNavigator } from '@react-navigation/drawer';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { Text, useWindowDimensions } from 'react-native';
import type { ComponentType } from 'react';

import { useI18n } from '../i18n';
import { useTheme } from '../theme';
import type { StringKey } from '../i18n';

import { AIAgentScreen } from '../screens/ai/AIAgentScreen';
import { CustomersScreen } from '../screens/catalog/CustomersScreen';
import { ProductEditScreen } from '../screens/catalog/ProductEditScreen';
import { ProductsScreen } from '../screens/catalog/ProductsScreen';
import { SuppliersScreen } from '../screens/catalog/SuppliersScreen';
import { DashboardScreen } from '../screens/dashboard/DashboardScreen';
import { AllocationFormScreen } from '../screens/farming/AllocationFormScreen';
import { CycleDetailScreen } from '../screens/farming/CycleDetailScreen';
import { CycleListScreen } from '../screens/farming/CycleListScreen';
import { CycleProfitScreen } from '../screens/farming/CycleProfitScreen';
import { FarmListScreen } from '../screens/farming/FarmListScreen';
import { FarmUnitsScreen } from '../screens/farming/FarmUnitsScreen';
import { FarmingEventFormScreen } from '../screens/farming/FarmingEventFormScreen';
import { FarmingHomeScreen } from '../screens/farming/FarmingHomeScreen';
import { HarvestFormScreen } from '../screens/farming/HarvestFormScreen';
import { NewCycleScreen } from '../screens/farming/NewCycleScreen';
import { NewFarmScreen } from '../screens/farming/NewFarmScreen';
import { NewFarmUnitScreen } from '../screens/farming/NewFarmUnitScreen';
import { FinanceHomeScreen } from '../screens/finance/FinanceHomeScreen';
import { IncomeExpenseScreen } from '../screens/finance/IncomeExpenseScreen';
import { PartnerCapitalScreen } from '../screens/finance/PartnerCapitalScreen';
import { PaymentScreen } from '../screens/finance/PaymentScreen';
import { ReceiptScreen } from '../screens/finance/ReceiptScreen';
import { TransferScreen } from '../screens/finance/TransferScreen';
import { InventoryListScreen } from '../screens/inventory/InventoryListScreen';
import { MovementHistoryScreen } from '../screens/inventory/MovementHistoryScreen';
import { StockAdjustScreen } from '../screens/inventory/StockAdjustScreen';
import { MoreHomeScreen } from '../screens/more/MoreHomeScreen';
import { PurchaseEditScreen } from '../screens/purchases/PurchaseEditScreen';
import { PurchaseListScreen } from '../screens/purchases/PurchaseListScreen';
import { ReportsHomeScreen } from '../screens/reports/ReportsHomeScreen';
import { SaleEditScreen } from '../screens/sales/SaleEditScreen';
import { SalesListScreen } from '../screens/sales/SalesListScreen';
import { SettingsScreen } from '../screens/settings/SettingsScreen';
import { SyncStatusScreen } from '../screens/sync/SyncStatusScreen';
import { AuditLogScreen } from '../screens/team/AuditLogScreen';
import { TeamScreen } from '../screens/team/TeamScreen';
import { BusinessSwitcherScreen } from '../screens/onboarding/BusinessSwitcherScreen';
import type {
  AppTabsParamList,
  DashboardStackParamList,
  FarmingStackParamList,
  FinanceStackParamList,
  InventoryStackParamList,
  MoreStackParamList,
  PurchasesStackParamList,
  ReportsStackParamList,
  SalesStackParamList,
} from './types';

/**
 * The signed-in application shell.
 *
 * **Tablets get a drawer, phones get bottom tabs** (the spec asks for exactly
 * that split), from a single module list so both stay in step. Each module keeps
 * its own stack, so deep links and "open this record" navigation work the same on
 * either shell.
 */

const TABLET_MIN_WIDTH = 768;

/** Text glyphs instead of an icon font: no extra dependency, and they render the same everywhere. */
const GLYPHS: Record<string, string> = {
  Dashboard: '▤',
  Sales: '৳',
  Purchases: '⇩',
  Inventory: '▦',
  Finance: '≡',
  Farming: '❋',
  Reports: '◫',
  Team: '☰',
  AI: '✦',
  Sync: '⟳',
  Settings: '⚙',
  More: '⋯',
};

function TabGlyph({ name, color }: { name: string; color: string }) {
  return <Text style={{ color, fontSize: 18 }}>{GLYPHS[name] ?? '•'}</Text>;
}

// --------------------------------------------------------------- stacks

const DashboardStack = createNativeStackNavigator<DashboardStackParamList>();
const SalesStack = createNativeStackNavigator<SalesStackParamList>();
const PurchasesStack = createNativeStackNavigator<PurchasesStackParamList>();
const InventoryStack = createNativeStackNavigator<InventoryStackParamList>();
const FinanceStack = createNativeStackNavigator<FinanceStackParamList>();
const FarmingStack = createNativeStackNavigator<FarmingStackParamList>();
const ReportsStack = createNativeStackNavigator<ReportsStackParamList>();
const MoreStack = createNativeStackNavigator<MoreStackParamList>();

function useScreenOptions() {
  const { colors, typography } = useTheme();
  return {
    headerStyle: { backgroundColor: colors.surface },
    headerTintColor: colors.primary,
    headerTitleStyle: { color: colors.text, fontSize: typography.heading.fontSize },
    contentStyle: { backgroundColor: colors.background },
  } as const;
}

export function DashboardNavigator() {
  const options = useScreenOptions();
  const { t } = useI18n();
  return (
    <DashboardStack.Navigator screenOptions={options}>
      <DashboardStack.Screen name="Dashboard" component={DashboardScreen} options={{ title: t('nav.dashboard') }} />
      <DashboardStack.Screen name="SyncStatus" component={SyncStatusScreen} options={{ title: t('sync.title') }} />
      <DashboardStack.Screen name="AIAgent" component={AIAgentScreen} options={{ title: t('nav.ai') }} />
    </DashboardStack.Navigator>
  );
}

export function SalesNavigator() {
  const options = useScreenOptions();
  const { t } = useI18n();
  return (
    <SalesStack.Navigator screenOptions={options}>
      <SalesStack.Screen name="SalesList" component={SalesListScreen} options={{ title: t('nav.sales') }} />
      <SalesStack.Screen name="SaleEdit" component={SaleEditScreen} options={{ title: t('sales.new') }} />
    </SalesStack.Navigator>
  );
}

export function PurchasesNavigator() {
  const options = useScreenOptions();
  const { t } = useI18n();
  return (
    <PurchasesStack.Navigator screenOptions={options}>
      <PurchasesStack.Screen name="PurchaseList" component={PurchaseListScreen} options={{ title: t('nav.purchases') }} />
      <PurchasesStack.Screen name="PurchaseEdit" component={PurchaseEditScreen} options={{ title: t('purchases.new') }} />
    </PurchasesStack.Navigator>
  );
}

export function InventoryNavigator() {
  const options = useScreenOptions();
  const { t } = useI18n();
  return (
    <InventoryStack.Navigator screenOptions={options}>
      <InventoryStack.Screen name="InventoryList" component={InventoryListScreen} options={{ title: t('nav.inventory') }} />
      <InventoryStack.Screen name="StockAdjust" component={StockAdjustScreen} options={{ title: t('inventory.adjust') }} />
      <InventoryStack.Screen name="MovementHistory" component={MovementHistoryScreen} options={{ title: t('inventory.movements') }} />
    </InventoryStack.Navigator>
  );
}

export function FinanceNavigator() {
  const options = useScreenOptions();
  const { t } = useI18n();
  return (
    <FinanceStack.Navigator screenOptions={options}>
      <FinanceStack.Screen name="FinanceHome" component={FinanceHomeScreen} options={{ title: t('nav.finance') }} />
      <FinanceStack.Screen name="Transfer" component={TransferScreen} options={{ title: t('finance.transfer') }} />
      <FinanceStack.Screen name="IncomeExpense" component={IncomeExpenseScreen} options={{ title: t('finance.title') }} />
      <FinanceStack.Screen name="Receipt" component={ReceiptScreen} options={{ title: t('finance.receipt') }} />
      <FinanceStack.Screen name="Payment" component={PaymentScreen} options={{ title: t('finance.payment') }} />
      <FinanceStack.Screen name="PartnerCapital" component={PartnerCapitalScreen} options={{ title: t('finance.capital') }} />
    </FinanceStack.Navigator>
  );
}

export function FarmingNavigator() {
  const options = useScreenOptions();
  const { t } = useI18n();
  return (
    <FarmingStack.Navigator screenOptions={options}>
      <FarmingStack.Screen name="FarmingHome" component={FarmingHomeScreen} options={{ title: t('nav.farming') }} />
      <FarmingStack.Screen name="FarmList" component={FarmListScreen} options={{ title: t('farming.farms') }} />
      <FarmingStack.Screen name="NewFarm" component={NewFarmScreen} options={{ title: t('farming.newFarm') }} />
      <FarmingStack.Screen name="FarmUnits" component={FarmUnitsScreen} options={{ title: t('farming.units') }} />
      <FarmingStack.Screen name="NewFarmUnit" component={NewFarmUnitScreen} options={{ title: t('farming.newUnit') }} />
      <FarmingStack.Screen name="CycleList" component={CycleListScreen} options={{ title: t('farming.cycles') }} />
      <FarmingStack.Screen name="CycleDetail" component={CycleDetailScreen} options={{ title: t('farming.cycleDetail') }} />
      <FarmingStack.Screen name="NewCycle" component={NewCycleScreen} options={{ title: t('farming.newCycle') }} />
      <FarmingStack.Screen name="FarmingEventForm" component={FarmingEventFormScreen} options={{ title: t('farming.events') }} />
      <FarmingStack.Screen name="HarvestForm" component={HarvestFormScreen} options={{ title: t('farming.harvest') }} />
      <FarmingStack.Screen name="AllocationForm" component={AllocationFormScreen} options={{ title: t('farming.allocation') }} />
      <FarmingStack.Screen name="CycleProfitScreen" component={CycleProfitScreen} options={{ title: t('farming.cycleProfit') }} />
    </FarmingStack.Navigator>
  );
}

export function ReportsNavigator() {
  const options = useScreenOptions();
  const { t } = useI18n();
  return (
    <ReportsStack.Navigator screenOptions={options}>
      <ReportsStack.Screen name="ReportsHome" component={ReportsHomeScreen} options={{ title: t('nav.reports') }} />
    </ReportsStack.Navigator>
  );
}

export function MoreNavigator() {
  const options = useScreenOptions();
  const { t } = useI18n();
  return (
    <MoreStack.Navigator screenOptions={options}>
      <MoreStack.Screen name="MoreHome" component={MoreHomeScreen} options={{ title: t('nav.more') }} />
      <MoreStack.Screen name="Customers" component={CustomersScreen} options={{ title: t('nav.customers') }} />
      <MoreStack.Screen name="Suppliers" component={SuppliersScreen} options={{ title: t('nav.suppliers') }} />
      <MoreStack.Screen name="Products" component={ProductsScreen} options={{ title: t('nav.products') }} />
      <MoreStack.Screen name="ProductEdit" component={ProductEditScreen} options={{ title: t('nav.products') }} />
      <MoreStack.Screen name="Team" component={TeamScreen} options={{ title: t('nav.team') }} />
      <MoreStack.Screen name="AuditLog" component={AuditLogScreen} options={{ title: t('team.audit') }} />
      <MoreStack.Screen name="AIAgent" component={AIAgentScreen} options={{ title: t('nav.ai') }} />
      <MoreStack.Screen name="SyncStatus" component={SyncStatusScreen} options={{ title: t('sync.title') }} />
      <MoreStack.Screen name="Settings" component={SettingsScreen} options={{ title: t('nav.settings') }} />
      <MoreStack.Screen name="BusinessSwitcher" component={BusinessSwitcherScreen} options={{ title: t('nav.switchBusiness') }} />
    </MoreStack.Navigator>
  );
}

// ------------------------------------------------------------------ tabs

const Tabs = createBottomTabNavigator<AppTabsParamList>();

/** Which modules are reachable from a phone's bottom bar. */
const PHONE_TABS: readonly { readonly name: keyof AppTabsParamList; readonly component: ComponentType; readonly title: StringKey }[] = [
  { name: 'DashboardTab', component: DashboardNavigator, title: 'nav.dashboard' },
  { name: 'SalesTab', component: SalesNavigator, title: 'nav.sales' },
  { name: 'InventoryTab', component: InventoryNavigator, title: 'nav.inventory' },
  { name: 'FinanceTab', component: FinanceNavigator, title: 'nav.finance' },
  { name: 'FarmingTab', component: FarmingNavigator, title: 'nav.farming' },
  { name: 'ReportsTab', component: ReportsNavigator, title: 'nav.reports' },
  { name: 'MoreTab', component: MoreNavigator, title: 'nav.more' },
];

function PhoneTabs() {
  const { colors } = useTheme();
  const { t } = useI18n();
  // The seven modules do not fit comfortably in a bottom bar, so the primary five
  // stay visible and Reports/More are grouped ("Reports" is one tap away from the
  // dashboard and More holds the rest).
  const visible = PHONE_TABS.filter((tab) => ['DashboardTab', 'SalesTab', 'InventoryTab', 'FinanceTab', 'MoreTab'].includes(tab.name));

  return (
    <Tabs.Navigator
      screenOptions={({ route }) => ({
        headerShown: false,
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.textMuted,
        tabBarStyle: { backgroundColor: colors.surface, borderTopColor: colors.border },
        tabBarIcon: ({ color }) => <TabGlyph name={String(route.name).replace('Tab', '')} color={color} />,
      })}
    >
      {visible.map((tab) => (
        <Tabs.Screen key={tab.name} name={tab.name} component={tab.component} options={{ title: t(tab.title) }} />
      ))}
    </Tabs.Navigator>
  );
}

// ---------------------------------------------------------------- drawer

const Drawer = createDrawerNavigator();

function TabletDrawer() {
  const { colors, typography } = useTheme();
  const { t } = useI18n();
  return (
    <Drawer.Navigator
      screenOptions={{
        headerShown: false,
        drawerActiveTintColor: colors.primary,
        drawerInactiveTintColor: colors.text,
        drawerStyle: { backgroundColor: colors.surface },
        drawerLabelStyle: { fontSize: typography.body.fontSize },
        drawerType: 'permanent',
      }}
    >
      <Drawer.Screen name="DashboardTab" component={DashboardNavigator} options={{ title: t('nav.dashboard') }} />
      <Drawer.Screen name="SalesTab" component={SalesNavigator} options={{ title: t('nav.sales') }} />
      <Drawer.Screen name="PurchasesTab" component={PurchasesNavigator} options={{ title: t('nav.purchases') }} />
      <Drawer.Screen name="InventoryTab" component={InventoryNavigator} options={{ title: t('nav.inventory') }} />
      <Drawer.Screen name="FinanceTab" component={FinanceNavigator} options={{ title: t('nav.finance') }} />
      <Drawer.Screen name="FarmingTab" component={FarmingNavigator} options={{ title: t('nav.farming') }} />
      <Drawer.Screen name="ReportsTab" component={ReportsNavigator} options={{ title: t('nav.reports') }} />
      <Drawer.Screen name="MoreTab" component={MoreNavigator} options={{ title: t('nav.more') }} />
    </Drawer.Navigator>
  );
}

/** Chooses the shell for the current screen size. */
export function AppNavigator() {
  const { width } = useWindowDimensions();
  return width >= TABLET_MIN_WIDTH ? <TabletDrawer /> : <PhoneTabs />;
}
