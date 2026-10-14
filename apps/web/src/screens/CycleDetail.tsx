import { useMemo, useState } from 'react';
import { dec } from '@sbm/domain';
import { ApiError } from '../api/client';
import { catalog } from '../api/endpoints';
import { farming as farmingApi, type FarmingEventType } from '../api/endpointsFarming';
import { canViewFarmingCost, hasPermission } from '../api/permissions';
import { cachedList } from '../offline/cachedList';
import { deviceId, newLocalId, saveLocally } from '../offline/localStorage';
import { useOnline } from '../offline/useSync';
import { AsyncState, Restricted } from '../components/States';
import { DataTable, type Column } from '../components/DataTable';
import { DateText, MoneyText, QtyText } from '../components/MoneyText';
import { Badge, Button, Card, CheckboxInput, Notice, PageHeader, SelectInput, TextAreaInput, TextInput, TotalRow, Totals } from '../components/ui';
import { useApp, useT } from '../state/AppContext';
import { useResource } from '../offline/useSync';
import { navigate } from '../state/router';
import { COST_EVENT_TYPES, EVENT_TYPES, eventTypeLabel, offlineEventTypeFor } from './farmingEventLabels';
import type { FarmingEventRow, ProductRow } from '../api/types';

/** Cycle detail: events, harvest, profit report and cycle close. */
export function CycleDetailScreen({ cycleId }: { readonly cycleId: string }) {
  const { business, permissions, me, notify } = useApp();
  const { t } = useT();
  const online = useOnline();
  const currency = business?.currency ?? 'BDT';
  const showCost = canViewFarmingCost(permissions);

  const cycles = useResource(() => farmingApi.cycles(), []);
  const profit = useResource(() => farmingApi.profit(cycleId), [cycleId]);
  const events = useResource(() => farmingApi.events(), [cycleId]);
  const products = useResource(() => cachedList<ProductRow>('products', () => catalog.products()), []);

  const cycle = cycles.data?.find((row) => row.id === cycleId) ?? null;

  const [eventType, setEventType] = useState<FarmingEventType>('INPUT_ISSUE');
  const [occurredOn, setOccurredOn] = useState(new Date().toISOString().slice(0, 10));
  const [productId, setProductId] = useState('');
  const [quantity, setQuantity] = useState('');
  const [unit, setUnit] = useState('');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [bookValue, setBookValue] = useState('');
  const [observationKind, setObservationKind] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [escalation, setEscalation] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [harvestQuantity, setHarvestQuantity] = useState('');
  const [harvestUnit, setHarvestUnit] = useState('');
  const [outputProductId, setOutputProductId] = useState('');
  const [harvestMethod, setHarvestMethod] = useState<'PLANNED_YIELD_PRORATA' | 'CLOSING_REMAINDER'>('PLANNED_YIELD_PRORATA');
  const [closedOn, setClosedOn] = useState(new Date().toISOString().slice(0, 10));
  const [remainingQuantity, setRemainingQuantity] = useState('');
  const [harvestRemainder, setHarvestRemainder] = useState(true);

  const inputProducts = (products.data ?? []).filter((row) => row.kind === 'INPUT' || row.kind === 'PRODUCT');
  const outputProducts = (products.data ?? []).filter((row) => row.kind === 'OUTPUT' || row.kind === 'LIVESTOCK' || row.kind === 'PRODUCT');

  const cycleEvents = useMemo(
    () => (events.data ?? []).filter((row) => row.cycleId === cycleId),
    [events.data, cycleId],
  );

  const eventColumns: Column<FarmingEventRow>[] = useMemo(
    () => [
      { id: 'date', header: t('farm.occurredOn'), cell: (row) => <DateText value={row.occurredOn} /> },
      { id: 'type', header: t('farm.eventType'), cell: (row) => <Badge tone={row.eventType === 'MORTALITY' ? 'error' : 'muted'}>{row.eventType}</Badge> },
      { id: 'quantity', header: t('common.quantity'), align: 'right', cell: (row) => <QtyText value={row.quantity} unit={row.unit} /> },
      { id: 'amount', header: t('common.amount'), align: 'right', cell: (row) => <MoneyText value={row.amount} currency={row.currency ?? currency} /> },
      { id: 'notes', header: t('common.note'), cell: (row) => row.notes ?? '—' },
    ],
    [t, currency],
  );

  const queueIt = async (eventTypeName: string, payload: Record<string, unknown>, recordId: string): Promise<void> => {
    if (!business || !me) throw new Error(t('sync.unsupported'));
    await saveLocally(
      {
        eventType: eventTypeName,
        aggregateId: recordId,
        payload: { ...payload, cycleId },
        store: 'cycles',
        record: { id: recordId, reference: cycle?.reference ?? '', title: cycle?.title ?? '', status: 'ACTIVE', farmingType: cycle?.farmingType ?? 'CROP' },
      },
      { businessId: business.id, actorId: me.user.id, deviceId: deviceId() },
    );
    notify(t('common.savedOffline'), 'warn');
  };

  const submitEvent = () => {
    setError(null);
    setEscalation(null);
    const payload: Record<string, unknown> = { cycleId, eventType, occurredOn };
    if (eventType === 'INPUT_ISSUE') {
      if (!productId || !dec(quantity || '0').isPositive()) {
        setError(t('common.requiredFields'));
        return;
      }
      Object.assign(payload, { productId, quantity, unit: unit || 'pcs' });
    } else if (eventType === 'OBSERVATION') {
      if (!observationKind) {
        setError(t('common.requiredFields'));
        return;
      }
      Object.assign(payload, { kind: observationKind, value: quantity || undefined, unit: unit || undefined, notes: notes || undefined });
    } else if (eventType === 'MORTALITY' || eventType === 'WASTE') {
      if (!dec(quantity || '0').isPositive() || reason.trim().length < 3) {
        setError(t('common.requiredFields'));
        return;
      }
      Object.assign(payload, { quantity, unit: unit || 'pcs', reason: reason.trim(), bookValue: bookValue || undefined });
    } else {
      if (!dec(amount || '0').isPositive()) {
        setError(t('common.requiredFields'));
        return;
      }
      Object.assign(payload, { amount, notes: notes || undefined });
    }

    setBusy(true);
    void (async () => {
      try {
        if (online) {
          const result = await farmingApi.recordEvent(cycleId, payload as never);
          if (result.abnormal) setEscalation(result.escalation ?? t('farm.mortalityEscalation'));
          notify(t('common.saved'), 'success');
          events.reload();
          profit.reload();
        } else {
          const offlineEvent = offlineEventTypeFor(eventType);
          if (!offlineEvent) throw new Error(t('sync.unsupported'));
          await queueIt(offlineEvent, payload, newLocalId());
        }
        setQuantity('');
        setAmount('');
        setReason('');
        setNotes('');
        setObservationKind('');
        setBookValue('');
      } catch (cause) {
        setError(cause instanceof ApiError ? cause.message : cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(false);
      }
    })();
  };

  const submitHarvest = () => {
    setError(null);
    if (!dec(harvestQuantity || '0').isPositive()) {
      setError(t('common.requiredFields'));
      return;
    }
    const payload = {
      cycleId,
      occurredOn,
      quantity: harvestQuantity,
      unit: harvestUnit || cycle?.plannedOutputUnit || 'kg',
      ...(outputProductId ? { productId: outputProductId } : {}),
      method: harvestMethod,
    };
    setBusy(true);
    void (async () => {
      try {
        if (online) {
          await farmingApi.harvest(cycleId, payload as never);
          notify(t('farm.harvest'), 'success');
          events.reload();
          profit.reload();
        } else {
          await queueIt('harvest.post', payload, newLocalId());
        }
        setHarvestQuantity('');
      } catch (cause) {
        setError(cause instanceof ApiError ? cause.message : cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(false);
      }
    })();
  };

  const submitClose = () => {
    setError(null);
    const payload = { cycleId, closedOn, harvestRemainingCost: harvestRemainder, ...(remainingQuantity ? { remainingQuantity } : {}) };
    setBusy(true);
    void (async () => {
      try {
        if (online) {
          await farmingApi.closeCycle(cycleId, payload);
          notify(t('farm.closed'), 'success');
        } else {
          await queueIt('cycle.close', payload, newLocalId());
        }
        cycles.reload();
        profit.reload();
      } catch (cause) {
        setError(cause instanceof ApiError ? cause.message : cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(false);
      }
    })();
  };

  return (
    <>
      <PageHeader
        title={cycle ? `${cycle.reference} · ${cycle.title}` : t('farm.cycles')}
        subtitle={cycle ? `${cycle.farmingType} · ${cycle.startDate} → ${cycle.expectedEndDate ?? '—'}` : undefined}
        actions={
          <Button variant="ghost" onClick={() => navigate('/farming')}>
            {t('common.back')}
          </Button>
        }
      />

      {escalation ? <Notice level="error">{escalation}</Notice> : null}
      {error ? <Notice level="error">{error}</Notice> : null}
      {!online ? <Notice level="warn">{t('common.offline')}</Notice> : null}

      <Card
        title={t('farm.profit')}
        actions={cycle ? <Badge tone={cycle.status === 'ACTIVE' ? 'ok' : 'muted'}>{cycle.status}</Badge> : null}
      >
        {showCost ? (
          <AsyncState loading={profit.loading} error={profit.error} data={profit.data} onRetry={profit.reload}>
            {(data) =>
              data === null ? null : (
                <>
                  <Totals>
                    <TotalRow label={t('farm.costToDate')} value={<MoneyText value={data.costToDate} currency={currency} />} />
                    <TotalRow label={t('farm.assignedToStock')} value={<MoneyText value={data.assignedToFinishedStock} currency={currency} />} />
                    <TotalRow label={t('farm.costRemaining')} value={<MoneyText value={data.costRemainingInBatch} currency={currency} />} />
                    <TotalRow label={t('farm.revenue')} value={<MoneyText value={data.revenue} currency={currency} />} />
                    <TotalRow label={t('sales.cogs')} value={<MoneyText value={data.cogs} currency={currency} />} />
                    <TotalRow label={t('farm.grossProfit')} value={<MoneyText value={data.grossProfit} currency={currency} signed />} strong />
                    <TotalRow label={t('farm.costInUnsoldOutput')} value={<MoneyText value={data.costInUnsoldOutput} currency={currency} />} />
                  </Totals>
                  <p className="muted">{data.note}</p>
                  <DataTable
                    columns={[
                      { id: 'kind', header: t('farm.costBreakdown'), cell: (row: { kind: string }) => row.kind },
                      { id: 'amount', header: t('common.amount'), align: 'right', cell: (row: { amount: string }) => <MoneyText value={row.amount} currency={currency} /> },
                    ]}
                    rows={[...data.costBreakdown]}
                    getKey={(row) => row.kind}
                    permissions={permissions}
                  />
                </>
              )
            }
          </AsyncState>
        ) : (
          <Restricted permission="farming.cost.view" />
        )}
      </Card>

      {hasPermission(permissions, 'farming.operations') ? (
        <Card title={t('farm.addEvent')} actions={<Button variant="primary" onClick={submitEvent} disabled={busy}>{t('common.save')}</Button>}>
          <div className="grid grid--2">
            <TextInput label={t('farm.occurredOn')} type="date" required value={occurredOn} onValueChange={setOccurredOn} />
            <SelectInput
              label={t('farm.eventType')}
              value={eventType}
              onValueChange={(value) => setEventType(value as FarmingEventType)}
              options={EVENT_TYPES.map((value) => ({ value, label: eventTypeLabel(value, t) }))}
            />

            {eventType === 'INPUT_ISSUE' ? (
              <>
                <SelectInput
                  label={t('farm.inputIssue')}
                  required
                  value={productId}
                  onValueChange={(value) => {
                    setProductId(value);
                    setUnit(inputProducts.find((row) => row.id === value)?.unit ?? '');
                  }}
                  placeholder={t('sales.product')}
                  options={inputProducts.map((row) => ({ value: row.id, label: `${row.name} (${row.onHand} ${row.unit})` }))}
                />
                <TextInput label={t('common.quantity')} inputMode="decimal" required value={quantity} onValueChange={setQuantity} />
                <TextInput label={t('common.unit')} value={unit} onValueChange={setUnit} />
              </>
            ) : null}

            {eventType === 'OBSERVATION' ? (
              <>
                <TextInput label={t('farm.observationKind')} required value={observationKind} onValueChange={setObservationKind} />
                <TextInput label={t('farm.observationValue')} value={quantity} onValueChange={setQuantity} />
                <TextInput label={t('common.unit')} value={unit} onValueChange={setUnit} />
              </>
            ) : null}

            {eventType === 'MORTALITY' || eventType === 'WASTE' ? (
              <>
                <TextInput label={t('common.quantity')} inputMode="decimal" required value={quantity} onValueChange={setQuantity} />
                <TextInput label={t('common.unit')} value={unit} onValueChange={setUnit} />
                <TextInput label={t('farm.mortalityReason')} required value={reason} onValueChange={setReason} />
                <TextInput label={t('farm.bookValue')} inputMode="decimal" value={bookValue} onValueChange={setBookValue} />
              </>
            ) : null}

            {COST_EVENT_TYPES.includes(eventType) ? (
              <TextInput label={t('common.amount')} inputMode="decimal" required value={amount} onValueChange={setAmount} />
            ) : null}

            <TextAreaInput label={t('common.note')} value={notes} onValueChange={setNotes} rows={2} />
          </div>
        </Card>
      ) : (
        <Restricted permission="farming.operations" />
      )}

      {hasPermission(permissions, 'farming.harvest') ? (
        <Card title={t('farm.harvest')} actions={<Button variant="primary" onClick={submitHarvest} disabled={busy}>{t('common.save')}</Button>}>
          <div className="grid grid--2">
            <TextInput label={t('farm.occurredOn')} type="date" required value={occurredOn} onValueChange={setOccurredOn} />
            <TextInput label={t('common.quantity')} inputMode="decimal" required value={harvestQuantity} onValueChange={setHarvestQuantity} />
            <TextInput label={t('common.unit')} value={harvestUnit} onValueChange={setHarvestUnit} />
            <SelectInput
              label={t('farm.outputProduct')}
              value={outputProductId}
              onValueChange={setOutputProductId}
              placeholder={t('common.optional')}
              options={outputProducts.map((row) => ({ value: row.id, label: row.name }))}
            />
            <SelectInput
              label={t('farm.harvestMethod')}
              value={harvestMethod}
              onValueChange={(value) => setHarvestMethod(value === 'CLOSING_REMAINDER' ? 'CLOSING_REMAINDER' : 'PLANNED_YIELD_PRORATA')}
              options={[
                { value: 'PLANNED_YIELD_PRORATA', label: 'PLANNED_YIELD_PRORATA' },
                { value: 'CLOSING_REMAINDER', label: 'CLOSING_REMAINDER' },
              ]}
            />
          </div>
          <p className="muted">{t('farm.harvestNote')}</p>
        </Card>
      ) : null}

      {hasPermission(permissions, 'farming.close_cycle') && cycle?.status !== 'CLOSED' ? (
        <Card title={t('farm.closeCycle')} actions={<Button variant="danger" onClick={submitClose} disabled={busy}>{t('farm.closeCycle')}</Button>}>
          <div className="grid grid--2">
            <TextInput label={t('farm.closed')} type="date" value={closedOn} onValueChange={setClosedOn} />
            <TextInput label={t('farm.remainingQuantity')} inputMode="decimal" value={remainingQuantity} onValueChange={setRemainingQuantity} />
          </div>
          <CheckboxInput label={t('farm.costRemaining')} checked={harvestRemainder} onCheckedChange={setHarvestRemainder} />
        </Card>
      ) : null}

      <Card title={t('farm.events')}>
        <AsyncState loading={events.loading} error={events.error} data={events.data} onRetry={events.reload}>
          {() => <DataTable columns={eventColumns} rows={cycleEvents} getKey={(row) => row.id} permissions={permissions} />}
        </AsyncState>
      </Card>
    </>
  );
}
