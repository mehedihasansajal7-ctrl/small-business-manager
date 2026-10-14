import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useCallback, useMemo, useState } from 'react';
import { Text, View } from 'react-native';

import { ALLOCATION_BASES, allocateCost, dec, localDateString, money } from '@sbm/domain';

import * as api from '../../api/endpoints';
import { describeError } from '../../api/client';
import { useAuth } from '../../auth/AuthProvider';
import { useActor } from '../../auth/useActor';
import { Button, Card, EmptyState, Field, ListRow, MoneyText, Notice, NumberInput, OfflineCapabilityNote, Screen, SectionTitle, Select, Toggle } from '../../components';
import { allocateCostOffline, localCycles } from '../../offline/repository';
import { useI18n } from '../../i18n';
import { useAsyncData } from '../../lib/useAsyncData';
import { useNetwork } from '../../lib/network';
import { useSync } from '../../lib/useSync';
import { useTheme } from '../../theme';
import type { FarmingStackParamList } from '../../navigation/types';

type Props = NativeStackScreenProps<FarmingStackParamList, 'AllocationForm'>;

interface Target {
  readonly cycleId: string;
  readonly title: string;
  included: boolean;
  basisValue: string;
  manualPercent: string;
}

/**
 * Allocate a shared cost across cycles.
 *
 * The split is previewed with `@sbm/domain`'s `allocateCost` — the *same*
 * largest-remainder algorithm the server uses — so the preview cannot lose or
 * invent a poysha, and what the user sees is what will be posted.
 */
export function AllocationFormScreen({ navigation }: Props) {
  const { t } = useI18n();
  const { business, can } = useAuth();
  const actor = useActor();
  const { online } = useNetwork();
  const { syncNow } = useSync();
  const { colors, typography, spacing } = useTheme();

  const currency = business?.currency ?? 'BDT';
  const timezone = business?.timezone ?? 'Asia/Dhaka';

  const [amount, setAmount] = useState('0');
  const [basis, setBasis] = useState('AREA');
  const [incurredOn, setIncurredOn] = useState(localDateString(new Date(), timezone));
  const [note, setNote] = useState('');
  const [targets, setTargets] = useState<Target[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loader = useCallback(async () => {
    const cycles = await localCycles();
    const active = cycles.filter((cycle) => cycle.status !== 'CLOSED' && cycle.status !== 'CANCELLED');
    setTargets(
      active.map((cycle) => ({ cycleId: cycle.id, title: cycle.title, included: false, basisValue: '0', manualPercent: '0' })),
    );
    return active;
  }, []);

  const { data: cycles } = useAsyncData(loader, [loader]);

  const included = useMemo(() => targets.filter((target) => target.included), [targets]);

  /** Preview only — never persisted; the server recomputes on apply. */
  const preview = useMemo(() => {
    if (included.length === 0 || !dec(amount).isPositive()) return null;
    try {
      const result = allocateCost(
        money(currency, amount),
        included.map((target) => ({
          cycleId: target.cycleId,
          basisValue: dec(target.basisValue === '' ? '0' : target.basisValue),
          ...(basis === 'MANUAL_PERCENT' ? { manualPercent: dec(target.manualPercent === '' ? '0' : target.manualPercent) } : {}),
        })),
        basis as never,
      );
      return {
        shares: result.shares.map((share) => ({ cycleId: share.cycleId, amount: share.amount.amount.toString(), ratio: share.shareRatio.toString() })),
        allocatedTotal: result.allocatedTotal.amount.toString(),
        unallocated: result.unallocated.amount.toString(),
      };
    } catch {
      return null;
    }
  }, [included, amount, basis, currency]);

  const submit = async () => {
    setError(null);
    if (!actor) return;
    if (included.length === 0 || !dec(amount).isPositive()) {
      setError(t('farming.targets'));
      return;
    }
    setBusy(true);
    try {
      await allocateCostOffline(actor, {
        currency,
        amount,
        basis,
        incurredOn,
        note: note.trim() || undefined,
        targets: included.map((target) => ({
          cycleId: target.cycleId,
          basisValue: target.basisValue,
          ...(basis === 'MANUAL_PERCENT' ? { manualPercent: target.manualPercent } : {}),
        })),
      });
      if (online) void syncNow();
      navigation.goBack();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('common.error'));
    } finally {
      setBusy(false);
    }
  };

  const refreshFromServer = async () => {
    if (!online) {
      setError(t('auth.needInternet'));
      return;
    }
    try {
      await api.farmingDashboard();
    } catch (caught) {
      setError(describeError(caught).message);
    }
  };

  return (
    <Screen title={t('farming.allocation')} subtitle={business?.name}>
      {!online ? <OfflineCapabilityNote /> : null}
      {error ? <Notice tone="danger" body={error} /> : null}

      <Card>
        <NumberInput label={t('common.amount')} value={amount} onChange={(value) => setAmount(value ?? '0')} mode="money" currency={currency} required />
        <Select
          label={t('farming.basis')}
          value={basis}
          options={ALLOCATION_BASES.map((entry) => ({ value: entry.basis, label: entry.name, note: entry.description }))}
          onChange={setBasis}
          required
        />
        <Field label={t('common.date')} value={incurredOn} onChangeText={setIncurredOn} note="YYYY-MM-DD" required />
        <Field label={t('common.notes')} value={note} onChangeText={setNote} multiline note="A written reason is required — this is an audit trail" />
      </Card>

      <SectionTitle title={t('farming.targets')} />
      <Card>
        {targets.length > 0 ? (
          targets.map((target) => (
            <View key={target.cycleId} style={{ marginBottom: spacing.sm }}>
              <Toggle
                label={target.title}
                value={target.included}
                onChange={(value) => setTargets((current) => current.map((entry) => (entry.cycleId === target.cycleId ? { ...entry, included: value } : entry)))}
              />
              {target.included ? (
                <>
                  <NumberInput
                    label={t('farming.basisValue')}
                    value={target.basisValue}
                    onChange={(value) => setTargets((current) => current.map((entry) => (entry.cycleId === target.cycleId ? { ...entry, basisValue: value ?? '0' } : entry)))}
                    mode="quantity"
                  />
                  {basis === 'MANUAL_PERCENT' ? (
                    <NumberInput
                      label="%"
                      value={target.manualPercent}
                      onChange={(value) => setTargets((current) => current.map((entry) => (entry.cycleId === target.cycleId ? { ...entry, manualPercent: value ?? '0' } : entry)))}
                      mode="quantity"
                    />
                  ) : null}
                </>
              ) : null}
            </View>
          ))
        ) : (
          <EmptyState title={t('common.none')} body={t('offline.coreWorksOffline')} />
        )}
      </Card>

      <SectionTitle title={t('farming.allocation')} />
      <Card>
        {preview ? (
          <>
            {preview.shares.map((share) => (
              <ListRow
                key={share.cycleId}
                title={targets.find((target) => target.cycleId === share.cycleId)?.title ?? share.cycleId}
                subtitle={`${t('farming.basisValue')} → ${share.ratio}`}
                right={<MoneyText value={share.amount} currency={currency} />}
              />
            ))}
            <ListRow title={t('farming.allocatedTotal')} right={<MoneyText value={preview.allocatedTotal} currency={currency} />} />
            <ListRow title={t('farming.unallocated')} right={<MoneyText value={preview.unallocated} currency={currency} />} />
          </>
        ) : (
          <Text style={[typography.caption, { color: colors.textMuted }]}>{t('farming.basisValue')}</Text>
        )}
      </Card>

      <Button label={t('common.save')} onPress={() => void submit()} loading={busy} disabled={!can('farming.setup')} fullWidth />
      <View style={{ height: spacing.sm }} />
      <Button label={t('sync.pullOnly')} variant="ghost" onPress={() => void refreshFromServer()} disabled={!online} fullWidth />
      <Text style={[typography.caption, { color: colors.textMuted, marginTop: spacing.md }]}>
        {cycles?.length ?? 0} • {t('offline.coreWorksOffline')}
      </Text>
    </Screen>
  );
}
