/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { assertFiniteAtLeast, roundScore } from './round.js';

/**
 * One test case's verdict. Structurally satisfied by a `CaseOutcome`, so the output of
 * `compareCase` feeds straight in, and deliberately narrow: aggregation needs to know
 * whether a case passed and nothing else. It cannot carry hidden test-case content
 * because it has nowhere to put it (FR-12).
 */
export type CaseResult = {
  readonly passed: boolean;
};

/** One section's contribution to an attempt total. */
export type WeightedSection = {
  readonly score: number;
  readonly weight: number;
};

/**
 * The proportion of a coding submission's weighted test cases that passed, in `[0, 1]`.
 *
 * The caller multiplies by the question's marks. Keeping this as a proportion means the
 * same submission re-graded against a re-weighted case set produces a number that is
 * still comparable, and it keeps the marks scheme out of the comparison logic.
 *
 * A submission with no cases, or with every weight zero, scores 0 rather than 1: "no
 * evidence" is not "passed everything". Weights and results must line up exactly —
 * a length mismatch is a caller bug that would otherwise silently drop a case.
 */
export function scoreSubmission(
  results: readonly CaseResult[],
  weights: readonly number[],
): number {
  if (results.length !== weights.length) {
    throw new RangeError(
      `results and weights must be the same length, received ${String(results.length)} and ${String(weights.length)}.`,
    );
  }

  let totalWeight = 0;
  let earnedWeight = 0;

  for (const [index, result] of results.entries()) {
    const weight = weights[index];
    if (weight === undefined) {
      throw new RangeError(`weights[${String(index)}] is missing.`);
    }
    assertFiniteAtLeast(weight, `weights[${String(index)}]`, 0);

    totalWeight += weight;
    if (result.passed) {
      earnedWeight += weight;
    }
  }

  if (totalWeight === 0) {
    return 0;
  }
  return roundScore(earnedWeight / totalWeight);
}

/**
 * The weighted mean of section scores.
 *
 * A mean rather than a sum, so a total is on the same scale as the sections that
 * produced it and adding a section does not silently inflate everyone's total. Sections
 * are weighted by their declared weight; zero-weight sections are carried but contribute
 * nothing, and an assessment whose weights are all zero totals 0.
 *
 * Section scores may be negative — negative marking is allowed to reduce a section — but
 * a weight may not be. A negative weight would invert the meaning of a score.
 */
export function weightedTotal(sections: readonly WeightedSection[]): number {
  let totalWeight = 0;
  let weightedSum = 0;

  for (const [index, section] of sections.entries()) {
    if (!Number.isFinite(section.score)) {
      throw new RangeError(
        `sections[${String(index)}].score must be finite, received ${String(section.score)}.`,
      );
    }
    assertFiniteAtLeast(section.weight, `sections[${String(index)}].weight`, 0);

    totalWeight += section.weight;
    weightedSum += section.score * section.weight;
  }

  if (totalWeight === 0) {
    return 0;
  }
  return roundScore(weightedSum / totalWeight);
}
