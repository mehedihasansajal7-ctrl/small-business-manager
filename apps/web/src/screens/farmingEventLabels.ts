import type { MessageKey } from '../i18n';
import type { FarmingEventType } from '../api/endpointsFarming';

/** Farming event type → UI string key, so the detail screen stays readable. */
export const EVENT_LABEL_KEYS: Readonly<Record<FarmingEventType, MessageKey>> = Object.freeze({
  INPUT_ISSUE: 'farm.inputIssue',
  DIRECT_LABOUR: 'farm.labour',
  MACHINERY_FUEL: 'farm.machineryFuel',
  VETERINARY: 'farm.veterinary',
  UTILITIES: 'farm.utilities',
  PACKAGING: 'farm.packaging',
  TRANSPORT: 'farm.transport',
  OVERHEAD: 'farm.overhead',
  INTERNAL_USE: 'farm.internalUse',
  OBSERVATION: 'farm.observation',
  MORTALITY: 'farm.mortality',
  WASTE: 'farm.waste',
});

export function eventTypeLabel(type: FarmingEventType, t: (key: MessageKey) => string): string {
  return t(EVENT_LABEL_KEYS[type]);
}

/** All selectable event types, in the order the form shows them. */
export const EVENT_TYPES: readonly FarmingEventType[] = Object.freeze([
  'INPUT_ISSUE',
  'DIRECT_LABOUR',
  'MACHINERY_FUEL',
  'VETERINARY',
  'UTILITIES',
  'PACKAGING',
  'TRANSPORT',
  'OVERHEAD',
  'INTERNAL_USE',
  'OBSERVATION',
  'MORTALITY',
  'WASTE',
]);

/** Event types that are recorded with a money amount rather than a quantity. */
export const COST_EVENT_TYPES: readonly FarmingEventType[] = Object.freeze([
  'DIRECT_LABOUR',
  'MACHINERY_FUEL',
  'VETERINARY',
  'UTILITIES',
  'PACKAGING',
  'TRANSPORT',
  'OVERHEAD',
  'INTERNAL_USE',
]);

/** Outbox event type used to replay each farming event offline. */
export function offlineEventTypeFor(type: FarmingEventType): string | null {
  if (type === 'INPUT_ISSUE') return 'farming.input_issue';
  if (type === 'OBSERVATION') return 'farming.observe';
  if (type === 'MORTALITY') return 'farming.mortality';
  if (type === 'WASTE') return null; // the sync API has no waste event type
  return 'farming.cost';
}
