/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Decimal places kept on a rolled-up proportion. Six is far finer than any report. */
const SCALE = 6;

/**
 * Rounds to a fixed number of decimals so a roll-up does not surface
 * `0.30000000000000004` in a candidate report, and so two runs of the same inputs
 * compare equal without an epsilon.
 *
 * Deliberately internal: this module is not re-exported from `src/index.ts`. Rounding
 * is an implementation detail of the roll-up, not part of the domain surface.
 */
export function roundProportion(value: number): number {
  if (!Number.isFinite(value)) {
    throw new RangeError(`Cannot round a non-finite value, received ${String(value)}.`);
  }
  return Number(value.toFixed(SCALE));
}
