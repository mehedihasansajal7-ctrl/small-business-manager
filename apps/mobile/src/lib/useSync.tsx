import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { useAuth } from '../auth/AuthProvider';
import { flushAttachments, pendingAttachmentCount } from '../offline/attachments';
import { outboxSummary } from '../offline/outbox';
import { syncNow as runSync, type SyncOptions, type SyncSummary } from '../offline/sync';
import { useNetwork } from './network';

/**
 * Sync controller.
 *
 * One place decides *when* the device talks to the server, so the header banner,
 * the Sync screen and every list agree:
 *  - when a business becomes active,
 *  - when connectivity returns (the moment a partner walks back into signal),
 *  - every few minutes while something is still pending,
 *  - whenever the user taps "Sync now".
 *
 * The engine itself (`src/offline/sync.ts`) owns *how*: push in batches, pull
 * since the stored cursor, and let `@sbm/domain` decide when an event should be
 * retried, parked for a human, or dropped as permanently rejected.
 */

export interface SyncValue {
  readonly summary: SyncSummary | null;
  readonly syncing: boolean;
  readonly attachmentsPending: number;
  syncNow(options?: SyncOptions): Promise<SyncSummary | null>;
  refresh(): Promise<void>;
}

const SyncContext = createContext<SyncValue | null>(null);

const IDLE_INTERVAL_MS = 5 * 60_000;

export function SyncProvider({ children }: { children: ReactNode }) {
  const { businessId } = useAuth();
  const { online } = useNetwork();
  const [summary, setSummary] = useState<SyncSummary | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [attachmentsPending, setAttachmentsPending] = useState(0);
  const previousOnline = useRef(online);
  const inFlight = useRef(false);

  const refresh = useCallback(async () => {
    if (!businessId) {
      setSummary(null);
      setAttachmentsPending(0);
      return;
    }
    const local = await outboxSummary(businessId);
    setAttachmentsPending(await pendingAttachmentCount(businessId));
    setSummary((current) => ({
      pushed: current?.pushed ?? 0,
      synced: current?.synced ?? 0,
      conflicts: local.counts.CONFLICT,
      rejected: local.counts.REJECTED,
      needsAttention: local.counts.NEEDS_ATTENTION,
      pulled: current?.pulled ?? 0,
      conflictsOpen: local.conflicts,
      pending: local.pending,
      lastSyncedAt: current?.lastSyncedAt ?? null,
      error: current?.error ?? null,
      offline: !online,
    }));
  }, [businessId, online]);

  const syncNow = useCallback(
    async (options: SyncOptions = {}) => {
      if (!businessId || inFlight.current) return summary;
      if (!online && !options.pullOnly) {
        // Nothing to do without a connection, but keep the pending count honest.
        await refresh();
        return summary;
      }
      inFlight.current = true;
      setSyncing(true);
      try {
        const result = await runSync(businessId, options);
        // Photos are uploaded after the business events, never before: the
        // transaction is what matters, the image is evidence.
        if (!options.pullOnly) {
          const flushed = await flushAttachments(businessId);
          setAttachmentsPending(flushed.pending);
        }
        setSummary(result);
        return result;
      } finally {
        inFlight.current = false;
        setSyncing(false);
      }
    },
    [businessId, online, refresh, summary],
  );

  // Establish the baseline whenever the active business changes.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Coming back online is the highest-value trigger: sync immediately.
  useEffect(() => {
    const wasOffline = previousOnline.current === false;
    previousOnline.current = online;
    if (online && wasOffline && businessId) void syncNow({ pullOnly: false });
  }, [online, businessId, syncNow]);

  // Keep pushing while something is outstanding, even if the user never taps.
  useEffect(() => {
    if (!businessId) return;
    const timer = setInterval(() => {
      if (online && (summary?.pending ?? 0) > 0) void syncNow();
    }, IDLE_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [businessId, online, summary?.pending, syncNow]);

  const value = useMemo<SyncValue>(
    () => ({ summary, syncing, attachmentsPending, syncNow, refresh }),
    [summary, syncing, attachmentsPending, syncNow, refresh],
  );

  return <SyncContext.Provider value={value}>{children}</SyncContext.Provider>;
}

export function useSync(): SyncValue {
  const context = useContext(SyncContext);
  if (!context) throw new Error('useSync must be used inside <SyncProvider>');
  return context;
}
