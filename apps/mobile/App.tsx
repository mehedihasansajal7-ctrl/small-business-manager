import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { loadApiBaseUrl } from './src/config/server-url';
import { AuthProvider } from './src/auth/AuthProvider';
import { I18nProvider } from './src/i18n';
import { NetworkProvider } from './src/lib/network';
import { SyncProvider } from './src/lib/useSync';
import { RootNavigator } from './src/navigation/RootNavigator';
import { ThemeProvider, useTheme } from './src/theme';
import { useEffect, useState } from 'react';

/**
 * Provider order matters:
 *
 *  1. `GestureHandlerRootView` — required by the drawer navigator;
 *  2. `SafeAreaProvider` — insets for every screen;
 *  3. `ThemeProvider` / `I18nProvider` — pure preferences, needed by everything else;
 *  4. `NetworkProvider` — connectivity, used by the auth and sync layers;
 *  5. `AuthProvider` — session + permissions (falls back to a cached snapshot offline);
 *  6. `SyncProvider` — the outbox/push/pull controller, scoped to the active business.
 */
function AppShell() {
  const { scheme } = useTheme();
  return (
    <>
      <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
      <AuthProvider>
        <SyncProvider>
          <RootNavigator />
        </SyncProvider>
      </AuthProvider>
    </>
  );
}

export default function App() {
  // The server address is a persisted preference, so it must be resolved before
  // the first request goes out - otherwise the very first launch would call the
  // build-time default instead of the address the user saved last time.
  const [configReady, setConfigReady] = useState(false);
  useEffect(() => {
    void loadApiBaseUrl().finally(() => setConfigReady(true));
  }, []);

  if (!configReady) return null;

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <ThemeProvider>
          <I18nProvider>
            <NetworkProvider>
              <AppShell />
            </NetworkProvider>
          </I18nProvider>
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
