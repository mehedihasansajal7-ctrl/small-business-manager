import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useState } from 'react';
import { Text } from 'react-native';

import { isAcceptablePassword, passwordProblems } from '@sbm/domain';

import { authErrorMessage, useAuth } from '../../auth/AuthProvider';
import { Button, Card, Field, Notice, Screen, Segmented } from '../../components';
import { useI18n, type AppLocale } from '../../i18n';
import { useNetwork } from '../../lib/network';
import { useTheme } from '../../theme';
import type { AuthStackParamList } from '../../navigation/types';

type Props = NativeStackScreenProps<AuthStackParamList, 'Register'>;

/**
 * Create an account (and, optionally, the business at the same time).
 *
 * Password rules come from `@sbm/domain`'s `passwordProblems`, which is the same
 * function the server uses, so the user is never told "valid" by the phone and
 * "invalid" by the API.
 */
export function RegisterScreen({ navigation }: Props) {
  const { colors, typography, spacing } = useTheme();
  const { t, locale, setLocale } = useI18n();
  const { register } = useAuth();
  const { online } = useNetwork();
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [businessName, setBusinessName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const problems = password === '' ? [] : passwordProblems(password);

  const submit = async () => {
    setError(null);
    if (!email.trim() || !displayName.trim()) {
      setError(t('common.required'));
      return;
    }
    if (!isAcceptablePassword(password)) {
      setError(`${t('auth.passwordProblems')} (${problems.join(', ')})`);
      return;
    }
    setBusy(true);
    try {
      await register({ email: email.trim(), password, displayName: displayName.trim(), ...(businessName.trim() ? { businessName: businessName.trim() } : {}) });
    } catch (caught) {
      setError(authErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen title={t('auth.signUp')} subtitle={t('app.name')}>
      {/* Same reason as the sign-in screen: the language must be changeable before signing in. */}
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
        <Field label={t('auth.displayName')} value={displayName} onChangeText={setDisplayName} required testID="register-name" />
        <Field label={t('auth.email')} value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none" required testID="register-email" />
        <Field
          label={t('auth.password')}
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          autoCapitalize="none"
          required
          error={problems.length > 0 ? problems.join(', ') : null}
          note={t('auth.passwordProblems')}
          testID="register-password"
        />
        <Field label={t('auth.businessName')} value={businessName} onChangeText={setBusinessName} note={t('auth.businessNameHint')} testID="register-business" />
        <Button label={t('auth.signUp')} onPress={() => void submit()} loading={busy} disabled={!online} fullWidth />
        <Text style={[typography.caption, { color: colors.textMuted, marginTop: spacing.md }]} onPress={() => navigation.goBack()}>
          {t('auth.signIn')}
        </Text>
      </Card>
    </Screen>
  );
}
