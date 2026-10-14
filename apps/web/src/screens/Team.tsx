import { useMemo, useState } from 'react';
import { ROLES } from '@sbm/domain';
import { members as memberApi } from '../api/endpoints';
import { ApiError } from '../api/client';
import { hasPermission } from '../api/permissions';
import { AsyncState, Restricted } from '../components/States';
import { DataTable, type Column } from '../components/DataTable';
import { DateText, DateTimeText } from '../components/MoneyText';
import { Badge, Button, Card, CopyButton, Notice, PageHeader, SelectInput, Tabs, TextInput } from '../components/ui';
import { useApp, useT } from '../state/AppContext';
import { useResource } from '../offline/useSync';
import type { AuditRow, CreatedInvite, InviteRow, MemberRow } from '../api/types';

/** Team: members, invitations, role changes and the audit log. */
export function TeamScreen() {
  const { permissions, me, notify, acceptInvite } = useApp();
  const { t, locale } = useT();
  const [tab, setTab] = useState('members');
  const [role, setRole] = useState('manager');
  const [email, setEmail] = useState('');
  const [ttlHours, setTtlHours] = useState('72');
  const [createdInvite, setCreatedInvite] = useState<CreatedInvite | null>(null);
  const [joinCode, setJoinCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const members = useResource(() => memberApi.list(), []);
  const invites = useResource(() => (hasPermission(permissions, 'member.invite') ? memberApi.invites() : Promise.resolve([] as InviteRow[])), [permissions.join(',')]);
  const audit = useResource(() => (hasPermission(permissions, 'audit.view') ? memberApi.audit(100) : Promise.resolve([] as AuditRow[])), [permissions.join(',')]);

  const canInvite = hasPermission(permissions, 'member.invite');
  const canManage = hasPermission(permissions, 'member.manage');

  const roleOptions = useMemo(() => ROLES.map((row) => ({ value: row.role, label: locale === 'en' ? row.name : row.nameBn })), [locale]);

  const run = (action: () => Promise<void>) => {
    setError(null);
    setBusy(true);
    action()
      .catch((cause: unknown) => setError(cause instanceof ApiError ? cause.message : cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setBusy(false));
  };

  const memberColumns: Column<MemberRow>[] = [
    { id: 'name', header: t('common.name'), cell: (row) => row.displayName },
    { id: 'email', header: t('common.email'), cell: (row) => row.email },
    { id: 'role', header: t('common.role'), cell: (row) => (locale === 'en' ? row.role : (ROLES.find((role2) => role2.role === row.role)?.nameBn ?? row.role)) },
    { id: 'status', header: t('common.status'), cell: (row) => <Badge tone={row.status === 'active' ? 'ok' : 'warn'}>{row.status}</Badge> },
    { id: 'joined', header: t('team.joinedAt'), cell: (row) => <DateText value={row.joinedAt} /> },
    {
      id: 'actions',
      header: t('common.actions'),
      cell: (row) => (
        <div className="row">
          {canManage ? (
            <SelectInput
              label={t('team.changeRole')}
              value={row.role}
              onValueChange={(value) => run(async () => {
                await memberApi.update(row.id, { role: value });
                notify(t('common.saved'), 'success');
                members.reload();
              })}
              options={roleOptions}
            />
          ) : null}
          {canManage && row.status === 'active' && row.userId !== me?.user.id ? (
            <Button variant="ghost" disabled={busy} onClick={() => run(async () => {
              await memberApi.update(row.id, { status: 'suspended' });
              members.reload();
            })}>
              {t('team.suspend')}
            </Button>
          ) : null}
          {canManage && row.status !== 'active' ? (
            <Button variant="ghost" disabled={busy} onClick={() => run(async () => {
              await memberApi.update(row.id, { status: 'active' });
              members.reload();
            })}>
              {t('team.reactivate')}
            </Button>
          ) : null}
        </div>
      ),
    },
  ];

  return (
    <>
      <PageHeader title={t('nav.team')} subtitle={t('team.partnerGuidance')} />
      <Tabs
        tabs={[
          { id: 'members', label: t('team.members') },
          { id: 'invites', label: t('team.invites') },
          { id: 'audit', label: t('team.audit') },
          { id: 'join', label: t('team.joinByCode') },
        ]}
        active={tab}
        onChange={setTab}
      />

      {error ? <Notice level="error">{error}</Notice> : null}

      {tab === 'members' ? (
        <Card title={t('team.members')} subtitle={t('team.roleHint')}>
          <AsyncState loading={members.loading} error={members.error} data={members.data} onRetry={members.reload}>
            {(rows) => <DataTable columns={memberColumns} rows={rows} getKey={(row) => row.id} permissions={permissions} />}
          </AsyncState>
        </Card>
      ) : null}

      {tab === 'invites' ? (
        canInvite ? (
          <>
            <Card
              title={t('team.invite')}
              actions={
                <Button
                  variant="primary"
                  disabled={busy}
                  onClick={() =>
                    run(async () => {
                      const invite = await memberApi.createInvite({
                        role,
                        ...(email.trim() ? { email: email.trim() } : {}),
                        ttlHours: Number(ttlHours) || 72,
                      });
                      setCreatedInvite(invite);
                      setEmail('');
                      invites.reload();
                    })
                  }
                >
                  {t('common.create')}
                </Button>
              }
            >
              <div className="grid grid--2">
                <SelectInput label={t('common.role')} value={role} onValueChange={setRole} options={roleOptions} />
                <TextInput label={t('team.inviteEmail')} type="email" value={email} onValueChange={setEmail} hint={t('team.emailNotRequired')} />
                <TextInput label={t('team.inviteTtl')} inputMode="numeric" value={ttlHours} onValueChange={setTtlHours} />
              </div>
              {createdInvite ? (
                <Notice level="success">
                  <div className="row">
                    <code className="code code--lg">{createdInvite.code}</code>
                    <CopyButton text={createdInvite.code} />
                  </div>
                  <p>{t('team.inviteCodeOnce')}</p>
                </Notice>
              ) : null}
            </Card>

            <Card title={t('team.invites')}>
              <AsyncState loading={invites.loading} error={invites.error} data={invites.data} onRetry={invites.reload}>
                {(rows) => (
                  <DataTable
                    columns={[
                      { id: 'prefix', header: t('auth.inviteCode'), cell: (row: InviteRow) => <span className="mono">{row.codePrefix}••••</span> },
                      { id: 'role', header: t('common.role'), cell: (row: InviteRow) => row.role },
                      { id: 'email', header: t('common.email'), cell: (row: InviteRow) => row.email ?? '—' },
                      { id: 'status', header: t('common.status'), cell: (row: InviteRow) => <Badge tone={row.status === 'open' ? 'ok' : 'muted'}>{row.status}</Badge> },
                      { id: 'expires', header: t('common.date'), cell: (row: InviteRow) => <DateTimeText value={row.expiresAt} /> },
                      {
                        id: 'actions',
                        header: t('common.actions'),
                        cell: (row: InviteRow) =>
                          row.status === 'open' ? (
                            <Button
                              variant="ghost"
                              disabled={busy}
                              onClick={() =>
                                run(async () => {
                                  await memberApi.revokeInvite(row.id);
                                  invites.reload();
                                })
                              }
                            >
                              {t('team.revoke')}
                            </Button>
                          ) : (
                            '—'
                          ),
                      },
                    ]}
                    rows={rows}
                    getKey={(row) => row.id}
                    permissions={permissions}
                  />
                )}
              </AsyncState>
            </Card>
          </>
        ) : (
          <Restricted permission="member.invite" />
        )
      ) : null}

      {tab === 'audit' ? (
        hasPermission(permissions, 'audit.view') ? (
          <Card title={t('team.audit')}>
            <AsyncState loading={audit.loading} error={audit.error} data={audit.data} onRetry={audit.reload}>
              {(rows) => (
                <DataTable
                  columns={[
                    { id: 'at', header: t('common.date'), cell: (row: AuditRow) => <DateTimeText value={row.at} /> },
                    { id: 'actor', header: t('common.name'), cell: (row: AuditRow) => row.actor ?? '—' },
                    { id: 'action', header: t('common.status'), cell: (row: AuditRow) => <span className="mono">{row.action}</span> },
                    { id: 'entity', header: t('common.details'), cell: (row: AuditRow) => `${row.entityType}${row.entityId ? ` · ${row.entityId.slice(0, 8)}` : ''}` },
                  ]}
                  rows={rows}
                  getKey={(row) => row.id}
                  permissions={permissions}
                />
              )}
            </AsyncState>
          </Card>
        ) : (
          <Restricted permission="audit.view" />
        )
      ) : null}

      {tab === 'join' ? (
        <Card title={t('team.joinByCode')}>
          <TextInput label={t('auth.inviteCode')} required value={joinCode} onValueChange={setJoinCode} hint={t('team.emailNotRequired')} />
          <Button
            variant="primary"
            disabled={busy || !me}
            onClick={() =>
              run(async () => {
                await acceptInvite(joinCode.trim().toUpperCase());
                notify(t('auth.joined'), 'success');
                members.reload();
              })
            }
          >
            {t('team.joinByCode')}
          </Button>
        </Card>
      ) : null}
    </>
  );
}
