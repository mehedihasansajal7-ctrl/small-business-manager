import { NavigationContainer, DarkTheme, DefaultTheme } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { ActivityIndicator, Text, View } from 'react-native';

import { useAuth } from '../auth/AuthProvider';
import { useI18n } from '../i18n';
import { useTheme } from '../theme';

import { AppNavigator } from './AppNavigator';
import { RegisterScreen } from '../screens/auth/RegisterScreen';
import { SignInScreen } from '../screens/auth/SignInScreen';
import { BusinessSwitcherScreen } from '../screens/onboarding/BusinessSwitcherScreen';
import { OnboardingScreen } from '../screens/onboarding/OnboardingScreen';
import type { AuthStackParamList, OnboardingStackParamList, RootStackParamList } from './types';

/**
 * Root navigator.
 *
 * Routing is driven by the auth/session state, not by the user's taps:
 *  - `loading`   → splash (reading the session from the keystore),
 *  - `signedOut` → the auth stack (sign in / register),
 *  - signed in with **no active business** → onboarding (name the business, invite
 *    the partners, or join with a code),
 *  - signed in with a business → the app shell.
 *
 * The navigation theme is derived from `src/theme` so the dark mode switch also
 * darkens headers and screen backgrounds.
 */

const RootStack = createNativeStackNavigator<RootStackParamList>();
const AuthStack = createNativeStackNavigator<AuthStackParamList>();
const OnboardingStack = createNativeStackNavigator<OnboardingStackParamList>();

function Splash() {
  const { colors, typography } = useTheme();
  const { t } = useI18n();
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background, gap: 12 }}>
      <ActivityIndicator color={colors.primary} />
      <Text style={[typography.heading, { color: colors.text }]}>{t('app.name')}</Text>
      <Text style={[typography.caption, { color: colors.textMuted }]}>{t('common.loading')}</Text>
    </View>
  );
}

function AuthNavigator() {
  const { colors } = useTheme();
  return (
    <AuthStack.Navigator
      screenOptions={{
        headerStyle: { backgroundColor: colors.surface },
        headerTintColor: colors.primary,
        contentStyle: { backgroundColor: colors.background },
        headerShown: false,
      }}
    >
      <AuthStack.Screen name="SignIn" component={SignInScreen} />
      <AuthStack.Screen name="Register" component={RegisterScreen} />
    </AuthStack.Navigator>
  );
}

function OnboardingNavigator() {
  const { colors } = useTheme();
  return (
    <OnboardingStack.Navigator
      screenOptions={{
        headerStyle: { backgroundColor: colors.surface },
        headerTintColor: colors.primary,
        contentStyle: { backgroundColor: colors.background },
        headerShown: false,
      }}
    >
      <OnboardingStack.Screen name="Onboarding" component={OnboardingScreen} />
      <OnboardingStack.Screen name="BusinessSwitcher" component={BusinessSwitcherScreen} />
    </OnboardingStack.Navigator>
  );
}

export function RootNavigator() {
  const { colors, scheme } = useTheme();
  const { status, businessId } = useAuth();

  const base = scheme === 'dark' ? DarkTheme : DefaultTheme;

  const navigationTheme = {
    ...base,
    colors: {
      ...base.colors,
      primary: colors.primary,
      background: colors.background,
      card: colors.surface,
      text: colors.text,
      border: colors.border,
      notification: colors.danger,
    },
  };

  return (
    <NavigationContainer theme={navigationTheme}>
      <RootStack.Navigator screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background } }}>
        {status === 'loading' ? (
          <RootStack.Screen name="Auth" component={Splash} />
        ) : status === 'signedOut' ? (
          <RootStack.Screen name="Auth" component={AuthNavigator} />
        ) : businessId ? (
          <RootStack.Screen name="App" component={AppNavigator} />
        ) : (
          <RootStack.Screen name="Onboarding" component={OnboardingNavigator} />
        )}
      </RootStack.Navigator>
    </NavigationContainer>
  );
}
