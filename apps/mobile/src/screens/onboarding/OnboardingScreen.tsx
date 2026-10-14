import * as Clipboard from 'expo-clipboard';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useState } from 'react';
import { Pressable, Share, Text, View } from 'react-native';

import { CURRENCIES, ROLES, partnerCountGuidance } from '@sbm/domain';

import * as api from '../../api/endpoints';
import { describeError } from '../../api/client';
import { authErrorMessage, useAuth } from '../../auth/AuthProvider';
import { Button, Card, Field, Notice, Screen, SectionTitle, Select } from '../../components';
import { useI18n } from '../../i18n';
import { useNetwork } from '../../lib/network';
import { useSync } from '../../lib/useSync';
import { useTheme } from '../../theme';
import type { OnboardingStackParamList } from '../../navigation/types';

type Props = NativeStackScreenProps<OnboardingStackParamList, 'Onboarding'>;

/**
 * Onboarding: name the business, then invite the other partners.
 *
 * The whole app is built around 2-5 partners sharing one workspace, so the invite
 * step is part of the setup flow rather than hidden in settings. Invite codes are
 * generated **on the server** (the code itself is never stored, only its hash),
 * which is why this step needs the internet — and says so.
 */
export function OnboardingScreen({ navigation }: Props) {
  const { colors, spacing, typography } = useTheme();
  const { t, language } = useI18n();
  const { business, businesses, createBusiness, joinWithCode, refresh } = useAuth();
  const { online } = useNetwork();
  const { syncNow } = useSync();

  const [name, setName] = useState('');
  const [currency, setCurrency] = useState('BDT');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [inviteRole, setInviteRole] = useState('manager');
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteCode, setInviteCode] = useState<string | null>(null);
  const [inviting, setInviting] = useState(false);

  const [joinCode, setJoinCode] = useState('');
  const [joining, setJoining] = useState(false);

  const roleOptions = ROLES.filter((role) => role.role !== 'owner').map((role) => ({
    value: role.role,
    label: `${role.name} — ${role[language === 'bn' ? 'nameBn' : 'name']}`,
    note: role.description,
  }));

  const submitBusiness = async () => {
    setError(null);
    if (name.trim().length < 2) {
      setError(t('common.required'));
      return;
    }
    setCreating(true);
    try {
      await createBusiness({ name: name.trim(), currency });
      await refresh();
      void syncNow();
    } catch (caught) {
      setError(authErrorMessage(caught));
    } finally {
      setCreating(false);
    }
  };

  const submitInvite = async () => {
    setError(null);
    if (!online) {
      setError(t('team.needsInternet'));
      return;
    }
    setInviting(true);
    try {
      const created = await api.createInvite(inviteRole, inviteEmail.trim() || undefined);
      setInviteCode(created.code);
      setInviteEmail('');
    } catch (caught) {
      setError(describeError(caught).message);
    } finally {
      setInviting(false);
    }
  };

  const submitJoin = async () => {
    setError(null);
    if (!online) {
      setError(t('auth.inviteNeedsInternet'));
      return;
    }
    setJoining(true);
    try {
      await joinWithCode(joinCode.trim());
      await refresh();
      void syncNow();
      navigation.navigate('BusinessSwitcher');
    } catch (caught) {
      setError(describeError(caught).message);
    } finally {
      setJoining(false);
    }
  };

  const guidance = partnerCountGuidance(businesses.length);

  return (
    <Screen title={t('auth.createFirstBusiness')} subtitle={t('app.tagline')}>
      {!online ? <Notice tone="warning" body={t('auth.needInternet')} /> : null}
      {error ? <Notice tone="danger" body={error} /> : null}

      {!business ? (
        <Card>
          <Field label={t('auth.businessName')} value={name} onChangeText={setName} required testID="onboarding-business-name" />
          <Select
            label={t('common.currency')}
            value={currency}
            options={Object.values(CURRENCIES).map((definition) => ({ value: definition.code, label: `${definition.symbol} ${definition.code} — ${definition.name}` }))}
            onChange={setCurrency}
            required
          />
          <Button label={t('common.create')} onPress={() => void submitBusiness()} loading={creating} fullWidth />
        </Card>
      ) : (
        <>
          <Card>
            <Text style={[typography.subheading, { color: colors.text }]}>{business.name}</Text>
            <Text style={[typography.caption, { color: colors.textMuted }]}>
              {business.currency} • {business.timezone} • {business.member.role}
            </Text>
            <View style={{ height: spacing.md }} />
            <Text style={[typography.body, { color: colors.textMuted }]}>{guidance.message}</Text>
          </Card>

          <SectionTitle title={t('auth.invitePartners')} />
          <Text style={[typography.body, { color: colors.textMuted, marginBottom: spacing.md }]}>{t('auth.invitePartnersBlurb')}</Text>

          {inviteCode ? (
            <Card>
              <Text style={[typography.label, { color: colors.textMuted }]}>{t('auth.inviteCode')}</Text>
              <Pressable
                accessibilityRole="button"
                onPress={() => void Clipboard.setStringAsync(inviteCode)}
                style={{ paddingVertical: spacing.sm }}
              >
                <Text style={[typography.title, { color: colors.primary, letterSpacing: 2 }]}>{inviteCode}</Text>
              </Pressable>
              <View style={{ flexDirection: 'row', gap: spacing.sm }}>
                <Button label={t('common.copy')} variant="secondary" compact onPress={() => void Clipboard.setStringAsync(inviteCode)} />
                <Button label={t('common.share')} variant="ghost" compact onPress={() => void Share.share({ message: `${t('auth.inviteCode')}: ${inviteCode}` })} />
              </View>
              <Text style={[typography.caption, { color: colors.textMuted, marginTop: spacing.sm }]}>{t('team.inviteHint')}</Text>
            </Card>
          ) : null}

          <Card>
            <Select label={t('common.role')} value={inviteRole} options={roleOptions} onChange={setInviteRole} />
            <Field label={t('team.inviteeEmail')} value={inviteEmail} onChangeText={setInviteEmail} keyboardType="email-address" autoCapitalize="none" />
            <Button label={t('team.inviteMember')} onPress={() => void submitInvite()} loading={inviting} disabled={!online} fullWidth />
            <Text style={[typography.caption, { color: colors.textMuted, marginTop: spacing.sm }]}>{t('team.needsInternet')}</Text>
          </Card>
        </>
      )}

      <SectionTitle title={t('auth.joinWithCode')} />
      <Card>
        <Field label={t('auth.inviteCode')} value={joinCode} onChangeText={setJoinCode} autoCapitalize="characters" />
        <Button label={t('auth.joinWithCode')} variant="secondary" onPress={() => void submitJoin()} loading={joining} disabled={!online} fullWidth />
        <Text style={[typography.caption, { color: colors.textMuted, marginTop: spacing.sm }]}>{t('auth.inviteNeedsInternet')}</Text>
      </Card>

      {business ? (
        <>
          <View style={{ height: spacing.lg }} />
          <Button label={t('common.saveAndClose')} onPress={() => void syncNow()} fullWidth />
        </>
      ) : null}
    </Screen>
  );
}
