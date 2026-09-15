/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Deterministic shuffling.
 *
 * `Math.random()` never appears in this package. Randomness arrives as an injected
 * `rng: () => number`, so a served question set and an option order can be reproduced
 * from (rule, pool, seed) a year later when a candidate disputes a result (ADR-004).
 */

/**
 * Maps an rng draw onto `[0, length)`. A generator that returns exactly 1, a negative
 * number or a non-finite number cannot push the index out of bounds — the domain does
 * not get to crash because someone supplied a sloppy generator.
 */
function boundedIndex(draw: number, length: number): number {
  if (!Number.isFinite(draw) || draw < 0) {
    return 0;
  }
  const index = Math.floor(draw * length);
  if (index >= length) {
    return length - 1;
  }
  return index;
}

/**
 * Selection-sampling shuffle: repeatedly draw a position from the remaining pool.
 * Uniform when `rng` is uniform, deterministic for a given draw sequence, and never
 * mutates its input.
 *
 * `splice` rather than an indexed swap because `noUncheckedIndexedAccess` types
 * `array[i]` as possibly `undefined`, and the honest way round that is not to index —
 * a non-null assertion in draw-resolution code is exactly what docs/17 §1 forbids.
 */
export function shuffleWith<T>(items: readonly T[], rng: () => number): T[] {
  const pool = items.slice();
  const out: T[] = [];
  while (pool.length > 0) {
    const picked = pool.splice(boundedIndex(rng(), pool.length), 1);
    out.push(...picked);
  }
  return out;
}

/**
 * The option order written to `attempt_questions.option_order` at attempt start.
 * Materialised once and never re-rolled, so MCQ option-distribution analytics can say
 * which physical position a candidate actually clicked (ADR-004).
 */
export function shuffleOptions<T>(options: T[], rng: () => number): T[] {
  return shuffleWith(options, rng);
}
