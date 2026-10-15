import { ErrorBoundary } from './components/ErrorBoundary';
import { Layout } from './components/Layout';
import { Loading } from './components/States';
import { cycleIdFromRoute, navigate, useRoute } from './state/router';
import { useApp } from './state/AppContext';
import { DashboardScreen } from './screens/Dashboard';
import { SalesScreen } from './screens/Sales';
import { PurchasesScreen } from './screens/Purchases';
import { InventoryScreen } from './screens/Inventory';
import { FinanceScreen } from './screens/Finance';
import { CatalogScreen } from './screens/Catalog';
import { ReportsScreen } from './screens/Reports';
import { FarmingScreen } from './screens/Farming';
import { CycleDetailScreen } from './screens/CycleDetail';
import { TeamScreen } from './screens/Team';
import { SettingsScreen } from './screens/Settings';
import { AiScreen } from './screens/AiAgent';
import { SyncScreen } from './screens/SyncStatus';
import { SignInScreen } from './screens/SignIn';
import { SetupScreen } from './screens/Setup';

/** Route → screen. Signed-out visitors only ever see sign-in. */
export function App() {
  const { ready, me, needsSetup } = useApp();
  const route = useRoute();

  if (!ready) return <Loading />;
  if (!me) return <SignInScreen />;
  if (needsSetup) return <SetupScreen />;

  const cycleId = cycleIdFromRoute(route);
  if (route.path.startsWith('/sign-in')) {
    navigate('/', { replace: true });
    return <Loading />;
  }

  // The boundary is keyed on the route so navigating away from a broken screen
  // clears the error instead of showing it on every page.
  return (
    <Layout>
      <ErrorBoundary key={route.path} scope={route.path}>
        {cycleId ? <CycleDetailScreen cycleId={cycleId} /> : renderScreen(route.path)}
      </ErrorBoundary>
    </Layout>
  );
}

function renderScreen(path: string) {
  switch (path) {
    case '/':
    case '':
      return <DashboardScreen />;
    case '/sales':
      return <SalesScreen />;
    case '/purchases':
      return <PurchasesScreen />;
    case '/inventory':
      return <InventoryScreen />;
    case '/finance':
      return <FinanceScreen />;
    case '/catalog':
      return <CatalogScreen />;
    case '/reports':
      return <ReportsScreen />;
    case '/farming':
      return <FarmingScreen />;
    case '/team':
      return <TeamScreen />;
    case '/settings':
      return <SettingsScreen />;
    case '/ai':
      return <AiScreen />;
    case '/sync':
      return <SyncScreen />;
    default:
      return <DashboardScreen />;
  }
}
