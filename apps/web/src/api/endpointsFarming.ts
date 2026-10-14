import { apiRequest } from './client';
import type { CycleProfitReport, CycleRow, FarmRow, FarmingDashboard, FarmingEventRow } from './types';

/** Farming endpoints: farms, units, cycles, events, harvest and costing. */

export type FarmingEventType =
  | 'INPUT_ISSUE'
  | 'DIRECT_LABOUR'
  | 'MACHINERY_FUEL'
  | 'VETERINARY'
  | 'UTILITIES'
  | 'PACKAGING'
  | 'TRANSPORT'
  | 'OVERHEAD'
  | 'OBSERVATION'
  | 'MORTALITY'
  | 'INTERNAL_USE'
  | 'WASTE';

export interface FarmingEventInput {
  readonly eventType: FarmingEventType;
  readonly occurredOn: string;
  readonly productId?: string;
  readonly quantity?: string;
  readonly unit?: string;
  readonly amount?: string;
  readonly accountCode?: string;
  readonly paymentAccount?: string;
  readonly paid?: boolean;
  readonly reason?: string;
  readonly bookValue?: string;
  readonly kind?: string;
  readonly value?: string;
  readonly notes?: string;
  readonly currency?: string;
  readonly deviceId?: string;
}

export const farming = {
  farms: () => apiRequest<FarmRow[]>('/api/farming/farms'),
  createFarm: (body: { name: string; address?: string; area?: string; areaUnit?: string; locationId?: string; notes?: string }) =>
    apiRequest<{ id: string }>('/api/farming/farms', { method: 'POST', body }),
  createUnit: (body: { farmId: string; kind: string; name: string; area?: string; areaUnit?: string; capacity?: string; capacityUnit?: string }) =>
    apiRequest<{ id: string }>('/api/farming/units', { method: 'POST', body }),
  cycles: (status?: string) => apiRequest<CycleRow[]>('/api/farming/cycles', { query: { status } }),
  createCycle: (body: {
    farmId: string;
    unitId: string;
    farmingType: string;
    title: string;
    startDate: string;
    cropOrSpecies?: string;
    varietyOrBreed?: string;
    season?: string;
    expectedEndDate?: string;
    plannedOutput?: string;
    plannedOutputUnit?: string;
    startingPopulation?: string;
    responsibleMemberId?: string;
    notes?: string;
    reference?: string;
  }) => apiRequest<{ id: string; reference: string; status: string }>('/api/farming/cycles', { method: 'POST', body }),
  recordEvent: (cycleId: string, body: FarmingEventInput) =>
    apiRequest<{ eventType: string; cost?: string; quantity?: string; abnormal?: boolean; escalation?: string | null; costToDate?: string }>(
      `/api/farming/cycles/${encodeURIComponent(cycleId)}/events`,
      { method: 'POST', body },
    ),
  harvest: (
    cycleId: string,
    body: { occurredOn: string; quantity: string; unit: string; productId?: string; locationId?: string; lotNo?: string; method?: 'PLANNED_YIELD_PRORATA' | 'CLOSING_REMAINDER'; grade?: string; notes?: string; currency?: string; deviceId?: string },
  ) =>
    apiRequest<{ harvestId: string; quantity: string; unitCost: string; costBasis: string; capped: boolean; costToDate: string; remainingCostInBatch: string; currency: string; note: string }>(
      `/api/farming/cycles/${encodeURIComponent(cycleId)}/harvest`,
      { method: 'POST', body },
    ),
  closeCycle: (cycleId: string, body: { closedOn?: string; remainingQuantity?: string; harvestRemainingCost?: boolean }) =>
    apiRequest<{ cycleId: string; status: string; releasedToFinishedStock: string }>(`/api/farming/cycles/${encodeURIComponent(cycleId)}/close`, { method: 'POST', body }),
  profit: (cycleId: string) => apiRequest<CycleProfitReport>(`/api/farming/cycles/${encodeURIComponent(cycleId)}/profit`),
  allocate: (body: {
    amount: string;
    basis: string;
    incurredOn: string;
    note?: string;
    currency?: string;
    targets: readonly { cycleId: string; basisValue?: string; manualPercent?: string }[];
  }) =>
    apiRequest<{ costSourceId: string; basis: string; currency: string; totalCost: string; shares: readonly { cycleId: string; amount: string; ratio: string }[]; allocatedTotal: string; unallocated: string }>(
      '/api/farming/allocations',
      { method: 'POST', body },
    ),
  dashboard: () => apiRequest<FarmingDashboard>('/api/farming/dashboard'),
  events: () => apiRequest<FarmingEventRow[]>('/api/farming/events'),
};

/** Event types that carry a monetary cost (the rest carry quantity/observations). */
export const COST_EVENT_TYPES: readonly FarmingEventType[] = [
  'DIRECT_LABOUR',
  'MACHINERY_FUEL',
  'VETERINARY',
  'UTILITIES',
  'PACKAGING',
  'TRANSPORT',
  'OVERHEAD',
  'INTERNAL_USE',
];
