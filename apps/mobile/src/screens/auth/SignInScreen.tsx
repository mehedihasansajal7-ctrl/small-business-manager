import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { useAuth, authErrorMessage } from '../../auth/AuthProvider';
import { Button, Card, Field, Notice, Screen, Segmented } from '../../components';
import { APP_INFO } from '../../config/env';
import { BUILD_TIME_API_URL, getApiBaseUrl, probeServer, resetApiBaseUrl, setApiBaseUrl } from '../../config/server-url';
import { useI18n, type AppLocale } from '../../i18n';
import { useNetwork } from '../../lib/network';
import { useTheme } from '../../theme';
import type { AuthStackParamList } from '../../navigation/types';

type Props = NativeStackScreenProps<AuthStackParamList, 'SignIn'>;

/**
 * Sign in.
 *
 * The server authenticates with an HttpOnly cookie and offers no bearer-token
 * fallback, so this screen is the only place a session can be created — and it
 * needs the internet. The UI says so plainly instead of failing silently.
 *
 * It also owns the "which server?" question: a sideloaded APK can be pointed at
 * any address (a PC on the office LAN, or a self-hosted box) so that one file can
 * be shared with several businesses. The address is tested before it is saved,
 * so a typo is caught here rather than looking like a wrong password.
 */
export function SignInScreen({ navigation }: Props) {
  const { colors, spacing, typography } = useTheme();
  const { t, locale, setLocale } = useI18n();
  const { signIn } = useAuth();
  const { online } = useNetwork();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [serverUrl, setServerUrl] = useState(getApiBaseUrl());
  const [serverNotice, setServerNotice] = useState<string | null>(null);
  const [serverBusy, setServerBusy] = useState(false);

  const submit = async () => {
    setError(null);
    if (!email.trim() || !password) {
      setError(t('auth.passwordProblems'));
      return;
    }
    setBusy(true);
    try {
      await signIn(email, password);
    } catch (caught) {
      setError(authErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const testAndSaveServer = async () => {
    setServerBusy(true);
    setServerNotice(null);
    try {
      const probe = await probeServer(serverUrl);
      if (!probe.ok) {
        setServerNotice(probe.detail);
        return;
      }
      const saved = await setApiBaseUrl(serverUrl);
      setServerUrl(saved);
      setServerNotice(`${t('signin.serverOk')} ${probe.detail}`);
    } finally {
      setServerBusy(false);
    }
  };

  const restoreBuildDefault = async () => {
    const restored = await resetApiBaseUrl();
    setServerUrl(restored);
    setServerNotice(t('signin.serverReset'));
  };

  return (
    <Screen title={t('app.name')} subtitle={t('app.tagline')}>
      {/*
        The language switcher lives HERE, on the pre-login screen, and not only in
        Settings: a partner who cannot read the current language could otherwise
        never find the setting that changes it, because Settings is behind sign-in.
      */}
      <Segmented
        options={[
          { value: 'bn-BD' as AppLocale, label: 'বাংলা' },
          { value: 'en' as AppLocale, label: 'English' },
        ]}
        value={locale}
        onChange={(value) => void setLocale(value)}
      />

      {!online ? <Notice tone="warning" body={t('auth.needInternet')} /> : null}
      {error ? <Notice tone="danger" body={error} /> : null}

      <Card>
        <Field label={t('auth.email')} value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none" required testID="signin-email" />
        <Field label={t('auth.password')} value={password} onChangeText={setPassword} secureTextEntry autoCapitalize="none" required testID="signin-password" />
        <Button label={t('auth.signIn')} onPress={() => void submit()} loading={busy} disabled={!online} fullWidth />
        <View style={{ height: spacing.md }} />
        <Button label={t('auth.signUp')} variant="secondary" onPress={() => navigation.navigate('Register')} fullWidth />
      </Card>

      <Card>
        <Text style={[typography.body, { color: colors.text, fontWeight: '700' }]}>{t('signin.advanced')}</Text>
        <Field
          label={t('settings.server')}
          value={serverUrl}
          onChangeText={setServerUrl}
          autoCapitalize="none"
          keyboardType="url"
          note={t('signin.serverHint')}
          testID="signin-server"
        />
        {serverNotice ? <Notice tone="info" body={serverNotice} /> : null}
        <Button label={t('signin.serverTest')} variant="secondary" onPress={() => void testAndSaveServer()} loading={serverBusy} disabled={!online} fullWidth />
        <View style={{ height: spacing.sm }} />
        <Button label={t('signin.serverReset')} variant="ghost" onPress={() => void restoreBuildDefault()} fullWidth />
      </Card>

      <Text style={[typography.caption, { color: colors.textMuted, marginTop: spacing.lg }]}>{t('auth.needInternet')}</Text>
      <Text style={[typography.caption, { color: colors.textMuted, marginTop: spacing.sm }]}>
        {t('settings.server')}: {getApiBaseUrl()}
      </Text>
      <Text style={[typography.caption, { color: colors.textMuted }]}>
        {APP_INFO.name} {APP_INFO.version} (built for {BUILD_TIME_API_URL})
      </Text>
    </Screen>
  );
}

export const signInStyles = StyleSheet.create({
  footer: { marginTop: 16 },
});
