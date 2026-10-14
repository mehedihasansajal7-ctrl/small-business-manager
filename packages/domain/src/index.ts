/**
 * @sbm/domain - framework-free business + farming domain logic.
 *
 * Everything here is pure: no I/O, no database, no framework. That is what lets
 * the same rules run in the Android app, the browser PWA and the server, and it
 * is what makes the accounting and costing behaviour unit-testable.
 */

export * from './decimal.js';
export * from './money.js';
export * from './units.js';
export * from './inventory.js';
export * from './accounting.js';
export * from './farming.js';
export * from './permissions.js';
export * from './sync.js';
export * from './tenancy.js';
export * from './validation.js';
export { sha256Bytes, sha256Hex } from './hash.js';
