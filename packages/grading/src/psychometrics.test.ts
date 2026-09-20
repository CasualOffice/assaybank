/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';

import {
  computeItemStatistics,
  MIN_RESPONSES_FOR_STATS,
  type ItemResponse,
} from './psychometrics.js';

// Expected values below were computed independently, in Python, with a hand-written Pearson
// correlation over the same rows — not by running this module and pasting its output.
//
//   A: 40 responses, dichotomous item, totals out of 20.
//      p_value 0.75 · uncorrected r (vs total) 0.3233 · corrected r (vs rest) 0.2531 · mean 49.5 s
//   B: 32 responses, partial-credit item out of 4.
//      p_value 0.5 · corrected r 0.735

type Row = readonly [itemScore: number, itemMax: number, totalScore: number, seconds: number];

const A: readonly Row[] = [
  [1, 1, 12, 30],
  [0, 1, 5, 31],
  [1, 1, 17, 32],
  [1, 1, 2, 33],
  [1, 1, 2, 34],
  [1, 1, 12, 35],
  [1, 1, 18, 36],
  [1, 1, 12, 37],
  [1, 1, 17, 38],
  [0, 1, 2, 39],
  [1, 1, 17, 40],
  [1, 1, 20, 41],
  [1, 1, 19, 42],
  [0, 1, 8, 43],
  [1, 1, 3, 44],
  [1, 1, 4, 45],
  [1, 1, 12, 46],
  [1, 1, 8, 47],
  [1, 1, 11, 48],
  [1, 1, 14, 49],
  [1, 1, 20, 50],
  [0, 1, 15, 51],
  [1, 1, 4, 52],
  [1, 1, 9, 53],
  [1, 1, 19, 54],
  [0, 1, 7, 55],
  [1, 1, 6, 56],
  [0, 1, 7, 57],
  [1, 1, 12, 58],
  [1, 1, 8, 59],
  [0, 1, 4, 60],
  [1, 1, 8, 61],
  [1, 1, 20, 62],
  [1, 1, 19, 63],
  [1, 1, 13, 64],
  [1, 1, 13, 65],
  [0, 1, 11, 66],
  [0, 1, 3, 67],
  [0, 1, 16, 68],
  [1, 1, 11, 69],
];

const B: readonly Row[] = [
  [3, 4, 17, 60],
  [1, 4, 8, 60],
  [1, 4, 4, 60],
  [3, 4, 13, 60],
  [4, 4, 15, 60],
  [1, 4, 11, 60],
  [2, 4, 14, 60],
  [2, 4, 14, 60],
  [1, 4, 8, 60],
  [2, 4, 12, 60],
  [4, 4, 19, 60],
  [1, 4, 7, 60],
  [2, 4, 5, 60],
  [0, 4, 5, 60],
  [2, 4, 9, 60],
  [0, 4, 2, 60],
  [0, 4, 7, 60],
  [2, 4, 13, 60],
  [3, 4, 13, 60],
  [2, 4, 9, 60],
  [3, 4, 19, 60],
  [0, 4, 0, 60],
  [3, 4, 14, 60],
  [2, 4, 7, 60],
  [2, 4, 6, 60],
  [4, 4, 14, 60],
  [4, 4, 20, 60],
  [4, 4, 16, 60],
  [1, 4, 8, 60],
  [0, 4, 5, 60],
  [2, 4, 6, 60],
  [3, 4, 14, 60],
];

const responses = (rows: readonly Row[]): ItemResponse[] =>
  rows.map(([itemScore, itemMax, totalScore, seconds]) => ({
    itemScore,
    itemMax,
    totalScore,
    seconds,
  }));

describe('computeItemStatistics', () => {
  it('matches the independently computed values for a dichotomous item', () => {
    expect(computeItemStatistics(responses(A))).toEqual({
      n: 40,
      pValue: 0.75,
      discrimination: 0.2531,
      meanSeconds: 49.5,
    });
  });

  it('matches the independently computed values for a partial-credit item', () => {
    const stats = computeItemStatistics(responses(B));
    expect(stats.pValue).toBe(0.5);
    expect(stats.discrimination).toBe(0.735);
  });

  it('correlates against the rest score, not the total — the total contains the item', () => {
    // 0.3233 is what the uncorrected total gives on fixture A. Getting it would mean the item
    // is being correlated partly with itself, and every question would look better than it is.
    expect(computeItemStatistics(responses(A)).discrimination).not.toBe(0.3233);
  });

  it('is identical for the same responses in any order, to the bit', () => {
    const forward = computeItemStatistics(responses(A));
    const reversed = computeItemStatistics(responses([...A].reverse()));
    const shuffled = computeItemStatistics(
      responses([...A].sort((x, y) => ((x[3] * 7919) % 97) - ((y[3] * 7919) % 97))),
    );
    expect(reversed).toStrictEqual(forward);
    expect(shuffled).toStrictEqual(forward);
  });

  it(`records nothing below ${String(MIN_RESPONSES_FOR_STATS)} responses — a number over too few is misleading`, () => {
    const few = responses(A.slice(0, MIN_RESPONSES_FOR_STATS - 1));
    expect(computeItemStatistics(few)).toEqual({
      n: MIN_RESPONSES_FOR_STATS - 1,
      pValue: null,
      discrimination: null,
      meanSeconds: null,
    });
  });

  it('computes at exactly the threshold', () => {
    const exact = computeItemStatistics(responses(A.slice(0, MIN_RESPONSES_FOR_STATS)));
    expect(exact.pValue).not.toBeNull();
  });

  it('answers null, not NaN or 0, when everyone scored the same on the item', () => {
    const allCorrect: Row[] = A.map(([, max, total, s]) => [1, max, total, s]);
    const stats = computeItemStatistics(responses(allCorrect));
    expect(stats.pValue).toBe(1);
    // No variance in the item: "we cannot tell", which a 0 would misreport as "does not discriminate".
    expect(stats.discrimination).toBeNull();
  });

  it('answers null when every rest score is identical', () => {
    const flatRest: Row[] = A.map(([item, max, , s]) => [item, max, item + 10, s]);
    expect(computeItemStatistics(responses(flatRest)).discrimination).toBeNull();
  });

  it('excludes responses with no available score rather than dividing by zero', () => {
    const withZeroMax = [...responses(A), { itemScore: 0, itemMax: 0, totalScore: 5, seconds: 10 }];
    const stats = computeItemStatistics(withZeroMax);
    expect(stats.n).toBe(40);
    expect(Number.isFinite(stats.pValue ?? Number.NaN)).toBe(true);
  });

  it('never produces a value outside the column’s range', () => {
    // question_stats.p_value and .discrimination are numeric(5,4): |x| < 10, 4 dp.
    for (const set of [A, B]) {
      const { pValue, discrimination } = computeItemStatistics(responses(set));
      expect(pValue).toBeGreaterThanOrEqual(0);
      expect(pValue).toBeLessThanOrEqual(1);
      expect(Math.abs(discrimination ?? 0)).toBeLessThanOrEqual(1);
    }
  });
});
