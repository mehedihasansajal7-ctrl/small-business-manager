import { useMemo, useState } from 'react';
import { ALLOCATION_BASES, FARMING_TYPES, FARM_UNIT_KINDS } from '@sbm/domain';
import { members as membersApi } from '../api/endpoints';
import { farming as farmingApi } from '../api/endpointsFarming';
import { canViewFarmingCost, hasPermission } from '../api/permissions';
import { AsyncState, Restricted } from '../components/States';
import { DataTable, type Column } from '../components/DataTable';
import { DateText, MoneyText, QtyText } from '../components/MoneyText';
import { Badge, Card, Notice, PageHeader, Tabs } from '../components/ui';
import { VoucherForm, type VoucherSpec } from '../components/VoucherForm';
import { useApp, useT } from '../state/AppContext';
import { useResource, useSyncState } from '../offline/useSync';
import { navigate, cyclePath } from '../state/router';
import type { CycleRow, FarmRow, MemberRow } from '../api/types';

const text = (value: string | boolean | undefined): string => (typeof value === 'string' ? value.trim() : '');

const FARM_SPEC: VoucherSpec = {
  id: 'farm',
  titleKey: 'farm.newFarm',
  submitLabelKey: 'common.create',
  fields: [
    { name: 'name', labelKey: 'common.name', kind: 'text', required: true },
    { name: 'area', labelKey: 'farm.area', kind: 'money' },
    { name: 'areaUnit', labelKey: 'farm.areaUnit', kind: 'text', hintKey: 'setup.locationHint' },
    { name: 'address', labelKey: 'common.address', kind: 'textarea' },
  ],
  submit: (values) =>
    farmingApi.createFarm({
      name: text(values.name),
      ...(text(values.area) ? { area: text(values.area) } : {}),
      ...(text(values.areaUnit) ? { areaUnit: text(values.areaUnit) } : {}),
      ...(text(values.address) ? { address: text(values.address) } : {}),
    }),
};

const UNIT_SPEC: VoucherSpec = {
  id: 'unit',
  titleKey: 'farm.newUnit',
  submitLabelKey: 'common.create',
  fields: [
    { name: 'farmId', labelKey: 'farm.farms', kind: 'select', optionKey: 'farms', required: true },
    { name: 'kind', labelKey: 'farm.unitKind', kind: 'select', optionKey: 'unitKinds', required: true, defaultValue: 'PLOT' },
    { name: 'name', labelKey: 'common.name', kind: 'text', required: true },
    { name: 'capacity', labelKey: 'farm.capacity', kind: 'money' },
    { name: 'capacityUnit', labelKey: 'farm.capacityUnit', kind: 'text' },
  ],
  submit: (values) =>
    farmingApi.createUnit({
      farmId: text(values.farmId),
      kind: text(values.kind) || 'PLOT',
      name: text(values.name),
      ...(text(values.capacity) ? { capacity: text(values.capacity) } : {}),
      ...(text(values.capacityUnit) ? { capacityUnit: text(values.capacityUnit) } : {}),
    }),
};

const CYCLE_SPEC: VoucherSpec = {
  id: 'cycle',
  titleKey: 'farm.newCycle',
  submitLabelKey: 'common.create',
  fields: [
    { name: 'farmId', labelKey: 'farm.farms', kind: 'select', optionKey: 'farms', required: true },
    { name: 'unitId', labelKey: 'farm.units', kind: 'select', optionKey: 'units', required: true },
    { name: 'farmingType', labelKey: 'farm.farmingType', kind: 'select', optionKey: 'farmingTypes', required: true, defaultValue: 'CROP' },
    { name: 'title', labelKey: 'farm.title', kind: 'text', required: true },
    { name: 'cropOrSpecies', labelKey: 'farm.cropOrSpecies', kind: 'text' },
    { name: 'startDate', labelKey: 'farm.startDate', kind: 'date', required: true },
    { name: 'expectedEndDate', labelKey: 'farm.expectedEnd', kind: 'date' },
    { name: 'plannedOutput', labelKey: 'farm.plannedOutput', kind: 'money' },
    { name: 'plannedOutputUnit', labelKey: 'common.unit', kind: 'text' },
    { name: 'startingPopulation', labelKey: 'farm.startingPopulation', kind: 'money' },
    { name: 'responsibleMemberId', labelKey: 'farm.responsible', kind: 'select', optionKey: 'members' },
  ],
  submit: (values) =>
    farmingApi.createCycle({
      farmId: text(values.farmId),
      unitId: text(values.unitId),
      farmingType: text(values.farmingType) || 'CROP',
      title: text(values.title),
      startDate: text(values.startDate),
      ...(text(values.cropOrSpecies) ? { cropOrSpecies: text(values.cropOrSpecies) } : {}),
      ...(text(values.expectedEndDate) ? { expectedEndDate: text(values.expectedEndDate) } : {}),
      ...(text(values.plannedOutput) ? { plannedOutput: text(values.plannedOutput) } : {}),
      ...(text(values.plannedOutputUnit) ? { plannedOutputUnit: text(values.plannedOutputUnit) } : {}),
      ...(text(values.startingPopulation) ? { startingPopulation: text(values.startingPopulation) } : {}),
      ...(text(values.responsibleMemberId) ? { responsibleMemberId: text(values.responsibleMemberId) } : {}),
    }),
};

const ALLOCATION_SPEC: VoucherSpec = {
  id: 'allocation',
  titleKey: 'farm.allocate',
  submitLabelKey: 'common.save',
  fields: [
    { name: 'incurredOn', labelKey: 'farm.occurredOn', kind: 'date', required: true },
    { name: 'amount', labelKey: 'common.amount', kind: 'money', required: true },
    { name: 'basis', labelKey: 'farm.allocationBasis', kind: 'select', optionKey: 'bases', required: true, defaultValue: 'AREA' },
    { name: 'cycleA', labelKey: 'farm.cycles', kind: 'select', optionKey: 'cycles', required: true },
    { name: 'basisValueA', labelKey: 'farm.targets', kind: 'money', required: true },
    { name: 'cycleB', labelKey: 'farm.cycles', kind: 'select', optionKey: 'cycles', required: true },
    { name: 'basisValueB', labelKey: 'farm.targets', kind: 'money', required: true },
    { name: 'note', labelKey: 'common.note', kind: 'textarea' },
  ],
  submit: (values) =>
    farmingApi.allocate({
      amount: text(values.amount),
      basis: text(values.basis) || 'AREA',
      incurredOn: text(values.incurredOn),
      ...(text(values.note) ? { note: text(values.note) } : {}),
      targets: [
        { cycleId: text(values.cycleA), basisValue: text(values.basisValueA) },
        { cycleId: text(values.cycleB), basisValue: text(values.basisValueB) },
      ],
    }),
};

/** Farming: farms, units, cycles, shared-cost allocation and the cycle drill-down. */
export function FarmingScreen() {
  const { business, permissions } = useApp();
  const { t, locale } = useT();
  const { snapshot } = useSyncState();
  const currency = business?.currency ?? 'BDT';
  const [tab, setTab] = useState('cycles');
  const showCost = canViewFarmingCost(permissions);

  const farms = useResource(() => farmingApi.farms(), [snapshot.lastSyncedAt]);
  const cycles = useResource(() => farmingApi.cycles(), [snapshot.lastSyncedAt]);
  const dashboard = useResource(() => farmingApi.dashboard(), [snapshot.lastSyncedAt]);
  const members = useResource(() => membersApi.list(), []);

  const options = useMemo(() => {
    const units = (farms.data ?? []).flatMap((farm: FarmRow) =>
      farm.units.map((unit) => ({ value: unit.id, label: `${farm.name} · ${unit.name}` })),
    );
    return {
      farms: (farms.data ?? []).map((farm) => ({ value: farm.id, label: farm.name })),
      units,
      cycles: (cycles.data ?? []).map((cycle) => ({ value: cycle.id, label: `${cycle.reference} · ${cycle.title}` })),
      farmingTypes: FARMING_TYPES.map((row) => ({ value: row.type, label: locale === 'en' ? row.name : row.nameBn })),
      unitKinds: FARM_UNIT_KINDS.map((row) => ({ value: row.kind, label: locale === 'en' ? row.name : row.nameBn })),
      bases: ALLOCATION_BASES.map((row) => ({ value: row.basis, label: row.name })),
      members: (members.data ?? []).map((row: MemberRow) => ({ value: row.id, label: row.displayName })),
    };
  }, [farms.data, cycles.data, members.data, locale]);

  const cycleColumns: Column<CycleRow>[] = useMemo(
    () => [
      {
        id: 'reference',
        header: t('common.reference'),
        cell: (row) => (
          <button type="button" className="link" onClick={() => navigate(cyclePath(row.id))}>
            {row.reference}
          </button>
        ),
      },
      { id: 'title', header: t('farm.title'), cell: (row) => row.title },
      { id: 'type', header: t('farm.farmingType'), cell: (row) => <Badge tone="muted">{row.farmingType}</Badge> },
      { id: 'start', header: t('farm.startDate'), cell: (row) => <DateText value={row.startDate} /> },
      { id: 'status', header: t('common.status'), cell: (row) => <Badge tone={row.status === 'ACTIVE' ? 'ok' : 'muted'}>{row.status}</Badge> },
      { id: 'harvested', header: t('farm.harvested'), align: 'right', cell: (row) => <QtyText value={row.harvestedQuantity} /> },
      { id: 'cost', header: t('farm.costToDate'), align: 'right', permission: 'farming.cost.view', cell: (row) => <MoneyText value={row.costToDate} currency={currency} /> },
      { id: 'profit', header: t('farm.grossProfit'), align: 'right', permission: 'farming.cost.view', cell: (row) => <MoneyText value={row.grossProfit} currency={currency} /> },
    ],
    [t, currency],
  );

  const tabs = [
    { id: 'cycles', label: t('farm.cycles') },
    { id: 'farms', label: t('farm.farms') },
    { id: 'allocate', label: t('farm.allocate') },
  ];

  return (
    <>
      <PageHeader title={t('nav.farming')} subtitle={business?.name} />

      {dashboard.data && dashboard.data.mortalityAlerts > 0 ? <Notice level="error">{t('farm.mortalityEscalation')}</Notice> : null}

      <Tabs tabs={tabs} active={tab} onChange={setTab} />

      {tab === 'cycles' ? (
        <>
          {hasPermission(permissions, 'farming.setup') ? (
            <VoucherForm spec={CYCLE_SPEC} options={options} onPosted={cycles.reload} />
          ) : (
            <Restricted permission="farming.setup" />
          )}
          <Card title={t('farm.cycles')}>
            <AsyncState
              loading={cycles.loading}
              error={cycles.error}
              data={cycles.data}
              onRetry={cycles.reload}
              empty={(rows) => rows.length === 0}
            >
              {(rows) => <DataTable columns={cycleColumns} rows={rows} getKey={(row) => row.id} permissions={permissions} />}
            </AsyncState>
          </Card>
        </>
      ) : null}

      {tab === 'farms' ? (
        <>
          {hasPermission(permissions, 'farming.setup') ? (
            <>
              <VoucherForm spec={FARM_SPEC} options={options} onPosted={farms.reload} />
              <VoucherForm spec={UNIT_SPEC} options={options} onPosted={farms.reload} />
            </>
          ) : (
            <Restricted permission="farming.setup" />
          )}
          <Card title={t('farm.farms')}>
            <AsyncState loading={farms.loading} error={farms.error} data={farms.data} onRetry={farms.reload} empty={(rows) => rows.length === 0}>
              {(rows) => (
                <ul className="list">
                  {rows.map((farm) => (
                    <li key={farm.id} className="list__item">
                      <strong>{farm.name}</strong>
                      <span className="muted">
                        {farm.units.length > 0 ? farm.units.map((unit) => `${unit.name} (${unit.kind})`).join(', ') : t('farm.noFarms')}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </AsyncState>
          </Card>
        </>
      ) : null}

      {tab === 'allocate' ? (
        hasPermission(permissions, 'farming.setup') ? (
          <VoucherForm spec={ALLOCATION_SPEC} options={options} onPosted={() => cycles.reload()} />
        ) : (
          <Restricted permission="farming.setup" />
        )
      ) : null}

      {!showCost ? <Notice level="info">{t('common.restrictedHint')}</Notice> : null}
    </>
  );
}
