import * as Clipboard from 'expo-clipboard';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useCallback, useState } from 'react';
import { Share, Text, View } from 'react-native';

import { ROLES, canChangeMemberRole, canRemoveMember } from '@sbm/domain';
import type { Role } from '@sbm/domain';

import * as api from '../../api/endpoints';
import { describeError } from '../../api/client';
import { useAuth } from '../../auth/AuthProvider';
import { Button, Card, EmptyState, Field, ListRow, Notice, Screen, SectionTitle, Select, Tag } from '../../components';
import { useI18n } from '../../i18n';
import { useAsyncData, useReloadOnFocus } from '../../lib/useAsyncData';
import { useNetwork } from '../../lib/network';
import { useTheme } from '../../theme';
import type { MoreStackParamList } from '../../navigation/types';

type Props = NativeStackScreenProps<MoreStackParamList, 'Team'>;

/**
 * Team management.
 *
 * **Online only, on purpose.** The server refuses the two membership event types
 * from an offline queue (`member.role_change`, `member.invite` are in
 * `ONLINE_ONLY_EVENTS`), because a stale queue could otherwise grant someone
 * access after it was revoked. So this screen requires the connection and says so.
 *
 * The lock-out guardrails are not re-invented here: `canChangeMemberRole` and
 * `canRemoveMember` from `@sbm/domain` decide whether a button is enabled and,
 * when it is not, quote the server's own reason ("Cannot demote the only owner…").
 */
export function TeamScreen({ navigation }: Props) {
  const { colors, typography, spacing } = useTheme();
  const { t, language } = useI18n();
  const { business, memberId, can } = useAuth();
  const { online } = useNetwork();

  const [role, setRole] = useState('manager');
  const [email, setEmail] = useState('');
  const [createdCode, setCreatedCode] = useState<string | null>(null);
  const [joinCode, setJoinCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const membersLoader = useCallback(async () => (online ? api.listMembers() : []), [online]);
  const invitesLoader = useCallback(async () => (online ? api.listInvites() : []), [online]);
  const { data: members, reload: reloadMembers } = useAsyncData(membersLoader, [membersLoader]);
  const { data: invites, reload: reloadInvites } = useAsyncData(invitesLoader, [invitesLoader]);
  useReloadOnFocus(() => {
    reloadMembers();
    reloadInvites();
  });

  const ownerCount = (members ?? []).filter((member) => member.role === 'owner' && member.status === 'active').length;
  const actorRole = (business?.member.role ?? 'viewer') as Role;

  const invite = async () => {
    setError(null);
    setNotice(null);
    setBusy('invite');
    try {
      const created = await api.createInvite(role, email.trim() || undefined);
      setCreatedCode(created.code);
      setEmail('');
      reloadInvites();
    } catch (caught) {
      setError(describeError(caught).message);
    } finally {
      setBusy(null);
    }
  };

  const patchMember = async (id: string, patchBody: { role?: string; status?: string }) => {
    setError(null);
    setNotice(null);
    setBusy(id);
    try {
      await api.updateMember(id, patchBody);
      reloadMembers();
      setNotice(t('common.save'));
    } catch (caught) {
      setError(describeError(caught).message);
    } finally {
      setBusy(null);
    }
  };

  const join = async () => {
    setError(null);
    setBusy('join');
    try {
      await api.acceptInvite(joinCode.trim());
      setJoinCode('');
      reloadMembers();
      setNotice(t('common.save'));
    } catch (caught) {
      setError(describeError(caught).message);
    } finally {
      setBusy(null);
    }
  };

  const roleOptions = ROLES.map((entry) => ({ value: entry.role, label: language === 'bn' ? `${entry.nameBn} (${entry.role})` : `${entry.name} (${entry.role})`, note: entry.description }));

  return (
    <Screen title={t('nav.team')} subtitle={business?.name}>
      {!online ? <Notice tone="warning" body={t('team.needsInternet')} /> : null}
      {error ? <Notice tone="danger" body={error} /> : null}
      {notice ? <Notice tone="success" body={notice} /> : null}
      {!can('member.manage') ? <Notice tone="info" body={t('common.restrictedBody')} /> : null}

      <SectionTitle title={t('team.members')} />
      <Card>
        {members && members.length > 0 ? (
          members.map((member) => {
            const isSelf = member.id === memberId;
            const roleCheck = canChangeMemberRole({ actorRole, targetCurrentRole: member.role as Role, newRole: 'manager', ownerCount, actorIsTarget: isSelf });
            const removeCheck = canRemoveMember({ targetRole: member.role as Role, ownerCount, actorRole, actorIsTarget: isSelf });
            const suspended = member.status !== 'active';
            return (
              <View key={member.id} style={{ borderBottomWidth: 1, borderBottomColor: colors.border, paddingVertical: spacing.sm }}>
                <ListRow
                  title={member.displayName}
                  subtitle={`${member.email} • ${member.role}`}
                  badge={<Tag text={member.status} tone={member.status === 'active' ? 'success' : 'warning'} />}
                />
                {isSelf ? (
                  <Text style={[typography.caption, { color: colors.textMuted }]}>{t('auth.signedInAs')}</Text>
                ) : (
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.sm }}>
                    {roleCheck.ok ? (
                      <Button
                        label={t('team.changeRole')}
                        compact
                        variant="secondary"
                        loading={busy === member.id}
                        onPress={() => void patchMember(member.id, { role: member.role === 'admin' ? 'manager' : 'admin' })}
                      />
                    ) : null}
                    <Button
                      label={suspended ? t('team.reactivate') : t('team.suspend')}
                      compact
                      variant="ghost"
                      loading={busy === member.id}
                      onPress={() => void patchMember(member.id, { status: suspended ? 'active' : 'suspended' })}
                    />
                    {removeCheck.ok ? (
                      <Button label={t('team.remove')} compact variant="danger" loading={busy === member.id} onPress={() => void patchMember(member.id, { status: 'removed' })} />
                    ) : null}
                    {!roleCheck.ok && roleCheck.reason ? (
                      <Text style={[typography.caption, { color: colors.textMuted, flexBasis: '100%' }]}>{roleCheck.reason}</Text>
                    ) : null}
                    {!removeCheck.ok && removeCheck.reason ? (
                      <Text style={[typography.caption, { color: colors.textMuted, flexBasis: '100%' }]}>{removeCheck.reason}</Text>
                    ) : null}
                  </View>
                )}
              </View>
            );
          })
        ) : (
          <EmptyState title={t('common.none')} body={t('team.needsInternet')} />
        )}
      </Card>

      {can('member.invite') ? (
        <>
          <SectionTitle title={t('team.inviteMember')} />
          <Card>
            <Select label={t('common.role')} value={role} options={roleOptions.filter((option) => option.value !== 'owner')} onChange={setRole} />
            <Field label={t('team.inviteeEmail')} value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none" />
            <Button label={t('team.inviteMember')} onPress={() => void invite()} loading={busy === 'invite'} disabled={!online} fullWidth />

            {createdCode ? (
              <View style={{ marginTop: spacing.md }}>
                <Text style={[typography.label, { color: colors.textMuted }]}>{t('auth.inviteCode')}</Text>
                <Text style={[typography.title, { color: colors.primary, letterSpacing: 2 }]}>{createdCode}</Text>
                <View style={{ flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm }}>
                  <Button label={t('common.copy')} compact variant="secondary" onPress={() => void Clipboard.setStringAsync(createdCode)} />
                  <Button label={t('common.share')} compact variant="ghost" onPress={() => void Share.share({ message: `${t('auth.inviteCode')}: ${createdCode}` })} />
                </View>
                <Text style={[typography.caption, { color: colors.textMuted, marginTop: spacing.sm }]}>{t('team.inviteHint')}</Text>
              </View>
            ) : null}
          </Card>

          <SectionTitle title={t('team.invites')} />
          <Card>
            {invites && invites.length > 0 ? (
              invites.map((inviteRow) => (
                <ListRow
                  key={inviteRow.id}
                  title={`${inviteRow.role} • ${inviteRow.codePrefix}…`}
                  subtitle={`${inviteRow.status} • ${t('team.expiresAt')} ${inviteRow.expiresAt.slice(0, 10)}${inviteRow.email ? ` • ${inviteRow.email}` : ''}`}
                  right={
                    inviteRow.status === 'open' ? (
                      <Button
                        label={t('team.revoke')}
                        compact
                        variant="ghost"
                        onPress={() =>
                          void api
                            .revokeInvite(inviteRow.id)
                            .then(reloadInvites)
                            .catch((caught) => setError(describeError(caught).message))
                        }
                      />
                    ) : undefined
                  }
                />
              ))
            ) : (
              <Text style={[typography.caption, { color: colors.textMuted }]}>{t('common.none')}</Text>
            )}
          </Card>
        </>
      ) : null}

      <SectionTitle title={t('auth.joinWithCode')} />
      <Card>
        <Field label={t('auth.inviteCode')} value={joinCode} onChangeText={setJoinCode} autoCapitalize="characters" />
        <Button label={t('auth.joinWithCode')} variant="secondary" onPress={() => void join()} loading={busy === 'join'} disabled={!online} fullWidth />
        <Text style={[typography.caption, { color: colors.textMuted, marginTop: spacing.sm }]}>{t('auth.inviteNeedsInternet')}</Text>
      </Card>

      <View style={{ marginTop: spacing.lg }}>
        <Button label={t('team.audit')} variant="secondary" onPress={() => navigation.navigate('AuditLog')} fullWidth />
      </View>
    </Screen>
  );
}
