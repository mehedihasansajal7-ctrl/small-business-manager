import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useState } from 'react';
import { Text } from 'react-native';

import { describeError } from '../../api/client';
import { useAuth } from '../../auth/AuthProvider';
import { Button, Card, EmptyState, Field, ListRow, Notice, Screen, Tag } from '../../components';
import { useI18n } from '../../i18n';
import { useNetwork } from '../../lib/network';
import { useSync } from '../../lib/useSync';
import { useTheme } from '../../theme';
import type { MoreStackParamList, OnboardingStackParamList } from '../../navigation/types';

type Props = NativeStackScreenProps<OnboardingStackParamList & MoreStackParamList, 'BusinessSwitcher'>;

/**
 * Business switcher.
 *
 * Switching is a **server** action: the session cookie carries the active
 * business, and the sync push/pull endpoints are scoped by it. So this screen
 * requires the internet and says so, rather than pretending the switch happened
 * and then syncing one business's records into another.
 */
export function BusinessSwitcherScreen({ navigation }: Props) {
  const { colors, typography, spacing } = useTheme();
  const { t } = useI18n();
  const { businesses, business, switchBusiness, joinWithCode, refresh } = useAuth();
  const { online } = useNetwork();
  const { syncNow } = useSync();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const onSwitch = async (businessId: string) => {
    setError(null);
    setBusy(businessId);
    try {
      await switchBusiness(businessId);
      await syncNow({ pullOnly: true });
      navigation.goBack();
    } catch (caught) {
      setError(describeError(caught).message);
    } finally {
      setBusy(null);
    }
  };

  const onJoin = async () => {
    setError(null);
    setBusy('join');
    try {
      await joinWithCode(code.trim());
      await refresh();
      setCode('');
    } catch (caught) {
      setError(describeError(caught).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Screen title={t('nav.switchBusiness')} subtitle={`${businesses.length} workspace(s)`}>
      {!online ? <Notice tone="warning" body={t('auth.needInternet')} /> : null}
      {error ? <Notice tone="danger" body={error} /> : null}

      <Card>
        {businesses.length === 0 ? (
          <EmptyState title={t('common.none')} body={t('auth.businessNameHint')} />
        ) : (
          businesses.map((entry) => (
            <ListRow
              key={entry.businessId}
              title={entry.name ?? entry.slug ?? entry.businessId}
              subtitle={entry.businessId}
              badge={entry.businessId === business?.id ? <Tag text={t('common.today')} tone="primary" /> : <Tag text={entry.role} />}
              right={entry.businessId === business?.id ? undefined : <Text style={[typography.caption, { color: colors.primary }]}>{t('nav.switchBusiness')}</Text>}
              onPress={entry.businessId === business?.id ? undefined : () => void onSwitch(entry.businessId)}
            />
          ))
        )}
      </Card>

      <Text style={[typography.label, { color: colors.textMuted, marginTop: spacing.lg }]}>{t('auth.joinWithCode')}</Text>
      <Card>
        <Field label={t('auth.inviteCode')} value={code} onChangeText={setCode} autoCapitalize="characters" />
        <Button label={t('auth.joinWithCode')} variant="secondary" loading={busy === 'join'} disabled={!online} onPress={() => void onJoin()} fullWidth />
      </Card>

      {/* Leaving onboarding is a local navigation: the shell swaps when a business
          becomes active, so there is nothing to persist here. */}
      <Text style={[typography.caption, { color: colors.textMuted, marginTop: spacing.lg }]} onPress={() => navigation.goBack()}>
        {t('common.back')}
      </Text>
    </Screen>
  );
}
