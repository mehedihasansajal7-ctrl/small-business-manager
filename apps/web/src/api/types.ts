/**
 * Response shapes for the endpoints the web app calls.
 *
 * IMPORTANT: every money and quantity value is a STRING (exact decimals). Never
 * run `Number()` on them — use `dec` / `money` from `@sbm/domain`.
 *
 * Split by area so each file stays small; this barrel keeps imports stable.
 */
export type * from './types.core';
export type * from './types.finance';
export type * from './types.farming';
export type * from './types.team';
export type * from './types.ai';
