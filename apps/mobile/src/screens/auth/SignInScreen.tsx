import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { useAuth, authErrorMessage } from '../../auth/AuthProvider';
import { Button, Card, Field, Notice, Screen } from '../../components';
import { APP_INFO, API_BASE_URL } from '../../config/env';
import { useI18n } from '../../i18n';
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
 */
export function SignInScreen({ navigation }: Props) {
  const { colors, spacing, typography } = useTheme();
  const { t } = useI18n();
  const { signIn } = useAuth();
  const { online } = useNetwork();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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

  return (
    <Screen title={t('app.name')} subtitle={t('app.tagline')}>
      {!online ? <Notice tone="warning" body={t('auth.needInternet')} /> : null}
      {error ? <Notice tone="danger" body={error} /> : null}

      <Card>
        <Field label={t('auth.email')} value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none" required testID="signin-email" />
        <Field label={t('auth.password')} value={password} onChangeText={setPassword} secureTextEntry autoCapitalize="none" required testID="signin-password" />
        <Button label={t('auth.signIn')} onPress={() => void submit()} loading={busy} disabled={!online} fullWidth />
        <View style={{ height: spacing.md }} />
        <Button label={t('auth.signUp')} variant="secondary" onPress={() => navigation.navigate('Register')} fullWidth />
      </Card>

      <Text style={[typography.caption, { color: colors.textMuted, marginTop: spacing.lg }]}>{t('auth.needInternet')}</Text>
      <Text style={[typography.caption, { color: colors.textMuted, marginTop: spacing.sm }]}>
        {t('settings.server')}: {API_BASE_URL}
      </Text>
      <Text style={[typography.caption, { color: colors.textMuted }]}>
        {APP_INFO.name} {APP_INFO.version}
      </Text>
    </Screen>
  );
}

export const signInStyles = StyleSheet.create({
  footer: { marginTop: 16 },
});
