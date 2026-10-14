/** Response shapes for this area of the API. */
export interface FarmUnitSummary {
  readonly id: string;
  readonly kind: string;
  readonly name: string;
  readonly area: string | null;
  readonly area_unit: string | null;
  readonly capacity: string | null;
  readonly capacity_unit: string | null;
}
export interface FarmRow {
  readonly id: string;
  readonly name: string;
  readonly address: string | null;
  readonly area: string | null;
  readonly areaUnit: string | null;
  readonly units: readonly FarmUnitSummary[];
}
export interface CycleRow {
  readonly id: string;
  readonly reference: string;
  readonly farmingType: string;
  readonly title: string;
  readonly cropOrSpecies: string | null;
  readonly varietyOrBreed: string | null;
  readonly status: string;
  readonly farmId: string;
  readonly unitId: string;
  readonly startDate: string;
  readonly expectedEndDate: string | null;
  readonly plannedOutput: string | null;
  readonly plannedOutputUnit: string | null;
  readonly startingPopulation: string | null;
  readonly harvestedQuantity: string;
  readonly costToDate?: string;
  readonly revenue?: string;
  readonly cogs?: string;
  readonly grossProfit?: string;
  readonly costVisibility?: 'restricted';
}
export interface CycleProfitReport {
  readonly cycleId: string;
  readonly reference: string;
  readonly title: string;
  readonly farmingType: string;
  readonly currency: string;
  readonly costToDate: string;
  readonly costBreakdown: readonly { readonly kind: string; readonly amount: string }[];
  readonly harvestedQuantity: string;
  readonly outputUnit: string;
  readonly assignedToFinishedStock: string;
  readonly costRemainingInBatch: string;
  readonly revenue: string;
  readonly cogs: string;
  readonly grossProfit: string;
  readonly costInUnsoldOutput: string;
  readonly note: string;
}
export interface FarmingEventRow {
  readonly id: string;
  readonly cycleId: string;
  readonly cycleReference: string;
  readonly eventType: string;
  readonly occurredOn: string;
  readonly quantity: string | null;
  readonly unit: string | null;
  readonly amount: string | null;
  readonly currency: string | null;
  readonly notes: string | null;
}
export interface FarmingDashboard {
  readonly currency: string;
  readonly activeCycles: number;
  readonly closedCycles: number;
  readonly totalCostToDate: string;
  readonly revenue: string;
  readonly grossProfit: string;
  readonly mortalityAlerts: number;
  readonly mortalityRecords: number;
  readonly cycles: readonly CycleRow[];
}
