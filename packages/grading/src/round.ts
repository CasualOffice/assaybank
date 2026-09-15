/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Six decimals. Scores are `numeric` in the database, never float (docs/17 §4); this is
 * the rounding that keeps the in-memory arithmetic from handing that column a value
 * like `3.3333333333333335` and from making two runs of identical inputs compare
 * unequal.
 *
 * Internal. Not re-exported from `src/index.ts` — rounding is an implementation detail
 * of scoring, not part of the grading surface.
 */
const SCALE = 6;

export function roundScore(value: number): number {
  if (!Number.isFinite(value)) {
    throw new RangeError(`Cannot round a non-finite score, received ${String(value)}.`);
  }
  return Number(value.toFixed(SCALE));
}

/** Guards an argument that must be a finite number at or above `min`. */
export function assertFiniteAtLeast(value: number, label: string, min: number): void {
  if (!Number.isFinite(value) || value < min) {
    throw new RangeError(
      `${label} must be a finite number of at least ${String(min)}, received ${String(value)}.`,
    );
  }
}
