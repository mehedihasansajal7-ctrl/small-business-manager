import { useEffect, useState } from 'react';
import { SYNC_STATUS_LABEL, type SyncStatus } from '@sbm/domain';
import { getSyncCoordinator } from '../offline/sync';
import { useSyncState } from '../offline/useSync';
import { summarize } from '../offline/outbox';
import { AsyncState } from '../components/States';
import { DataTable, type Column } from '../components/DataTable';
import { DateTimeText } from '../components/MoneyText';
import { Badge, Button, Card, Notice, PageHeader, type Tone } from '../components/ui';
import { useApp, useT } from '../state/AppContext';
import type { ConflictRow } from '../api/types';

const STATUS_TONE: Readonly<Record<SyncStatus, Tone>> = {
  PENDING: 'warn',
  SYNCING: 'info',
  SYNCED: 'ok',
  NEEDS_ATTENTION: 'error',
  CONFLICT: 'error',
  REJECTED: 'error',
};

/** Sync status: queue, last success, per-event detail and conflict resolution. */
export function SyncScreen() {
  const { t, locale } = useT();
  const { outboxContext } = useApp();
  const { snapshot, syncNow, retryEvent } = useSyncState();
  const coordinator = getSyncCoordinator();
  const [conflicts, setConflicts] = useState<readonly ConflictRow[] | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!outboxContext) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    coordinator
      .loadConflicts()
      .then((rows) => {
        if (!cancelled) setConflicts(rows);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause : new Error(String(cause)));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [coordinator, outboxContext, snapshot.lastSyncedAt]);

  const summary = summarize(snapshot.outbox);

  const eventColumns: Column<(typeof snapshot.outbox)[number]>[] = [
    { id: 'when', header: t('sync.event'), cell: (row) => <DateTimeText value={row.occurredAt} /> },
    { id: 'type', header: t('farm.eventType'), cell: (row) => <span className="mono">{row.eventType}</span> },
    { id: 'status', header: t('common.status'), cell: (row) => <Badge tone={STATUS_TONE[row.status]}>{SYNC_STATUS_LABEL[row.status][locale === 'en' ? 'en' : 'bn']}</Badge> },
    { id: 'risk', header: t('sync.risk'), cell: (row) => <Badge tone={row.risk === 'HIGH' ? 'warn' : 'muted'}>{row.risk}</Badge> },
    { id: 'attempts', header: t('sync.attempts'), align: 'right', cell: (row) => row.attempts },
    { id: 'error', header: t('sync.lastError'), cell: (row) => row.lastError ?? '—' },
    {
      id: 'actions',
      header: t('common.actions'),
      cell: (row) =>
        row.status === 'SYNCED' ? (
          <span className="muted">{row.serverRevision !== null && row.serverRevision !== undefined ? `r${row.serverRevision}` : '—'}</span>
        ) : (
          <Button variant="ghost" disabled={busy} onClick={() => void retryEvent(row.id)}>
            {t('common.retry')}
          </Button>
        ),
    },
  ];

  return (
    <>
      <PageHeader
        title={t('sync.title')}
        subtitle={t('app.tagline')}
        actions={
          <Button
            variant="primary"
            disabled={busy || snapshot.flushing || snapshot.pulling}
            onClick={() => {
              setBusy(true);
              void syncNow().finally(() => setBusy(false));
            }}
          >
            {snapshot.flushing || snapshot.pulling ? t('sync.syncing') : t('sync.now')}
          </Button>
        }
      />

      <div className="kpis kpis--compact">
        <div className="kpi">
          <span className="kpi__label">{t('sync.queue')}</span>
          <span className="kpi__value">{snapshot.pending}</span>
        </div>
        <div className="kpi">
          <span className="kpi__label">{t('sync.openConflicts')}</span>
          <span className="kpi__value">{summary.conflicts}</span>
        </div>
        <div className="kpi">
          <span className="kpi__label">{t('sync.needsAttention')}</span>
          <span className="kpi__value">{summary.needsAttention}</span>
        </div>
        <div className="kpi">
          <span className="kpi__label">{t('sync.lastSuccess')}</span>
          <span className="kpi__value">
            {snapshot.lastSyncedAt ? <DateTimeText value={snapshot.lastSyncedAt} /> : t('sync.never')}
          </span>
        </div>
      </div>

      <Notice level={snapshot.online ? 'info' : 'warn'}>
        {locale === 'en' ? snapshot.banner.en : snapshot.banner.bn}
      </Notice>
      {snapshot.lastError ? <Notice level="warn">{snapshot.lastError}</Notice> : null}

      <Card title={t('sync.openConflicts')} subtitle={t('team.roleHint')}>
        <AsyncState loading={loading} error={error} data={conflicts ?? (loading ? null : [])} onRetry={() => setConflicts(null)} empty={(rows) => rows.length === 0}>
          {(rows) => (
            <ul className="list">
              {rows.map((row) => (
                <li key={row.id} className="list__item">
                  <div>
                    <strong className="mono">
                      {row.aggregate_type} · {row.aggregate_id.slice(0, 8)}
                    </strong>
                    <span className="muted">
                      <DateTimeText value={row.created_at} /> · {row.status} · r{row.base_revision ?? '—'} → r{row.server_revision ?? '—'}
                    </span>
                  </div>
                  {row.status === 'OPEN' ? (
                    <div className="row">
                      <Button
                        variant="secondary"
                        disabled={busy}
                        onClick={() => {
                          setBusy(true);
                          void coordinator.resolveConflict(row.id, 'LOCAL_WINS').finally(() => setBusy(false));
                        }}
                      >
                        {t('sync.resolveLocal')}
                      </Button>
                      <Button
                        variant="ghost"
                        disabled={busy}
                        onClick={() => {
                          setBusy(true);
                          void coordinator.resolveConflict(row.id, 'SERVER_WINS').finally(() => setBusy(false));
                        }}
                      >
                        {t('sync.resolveServer')}
                      </Button>
                    </div>
                  ) : (
                    <Badge tone="muted">{row.status}</Badge>
                  )}
                </li>
              ))}
            </ul>
          )}
        </AsyncState>
        {conflicts && conflicts.length === 0 ? <p className="muted">{t('sync.noConflicts')}</p> : null}
      </Card>

      <Card title={t('sync.queue')} subtitle={t('sync.localProposal')}>
        {snapshot.outbox.length === 0 ? (
          <p className="muted">{t('common.empty')}</p>
        ) : (
          <DataTable
            columns={eventColumns}
            rows={[...snapshot.outbox].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 200)}
            getKey={(row) => row.id}
            permissions={[]}
          />
        )}
      </Card>

      <Card title={t('sync.title')}>
        <ul className="list">
          {(['PENDING', 'SYNCING', 'SYNCED', 'NEEDS_ATTENTION', 'CONFLICT', 'REJECTED'] as SyncStatus[]).map((status) => (
            <li key={status} className="list__item">
              <Badge tone={STATUS_TONE[status]}>{SYNC_STATUS_LABEL[status][locale === 'en' ? 'en' : 'bn']}</Badge>
              <span>{snapshot.counts[status]}</span>
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}
