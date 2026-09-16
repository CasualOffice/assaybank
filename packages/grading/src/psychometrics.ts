/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Item statistics for one question version (FR-5).
 *
 * Two numbers decide whether a question is earning its place in the bank:
 *
 * - **p-value** — how hard it is: the mean proportion of the available score candidates
 *   earned. The useful band is roughly 0.2–0.8; outside it the question separates nobody.
 * - **discrimination** — whether it measures the same thing as the rest of the test: the
 *   correlation between a candidate's score on this item and their score on everything else.
 *   Below about 0.2 the question is noise.
 *
 * ## The correction that matters
 *
 * Discrimination is computed against the **rest score** — the attempt total *minus this item* —
 * not against the total. The total contains the item, so correlating the two partly correlates
 * the item with itself and inflates the result. How much depends on test length: on a short test
 * the item is a large share of the total, and the inflation can lift a genuinely weak question
 * over the 0.2 bar. The fixture in the test shows 0.3233 uncorrected against 0.2531 corrected.
 *
 * For a dichotomous item this Pearson correlation *is* the point-biserial; for a partial-credit
 * item it is the corrected item-total correlation, which is the same idea generalised.
 *
 * ## When the answer is "not yet"
 *
 * Below {@link MIN_RESPONSES_FOR_STATS} responses, and when either variable has no variance,
 * the statistic is `null` — never `NaN`, never `0`. A correlation over twelve candidates is a
 * number that looks meaningful and is not, and a zero would read as "this question does not
 * discriminate" when the truth is "we cannot tell".
 *
 * This is descriptive statistics over recorded scores. It infers nothing, ranks no candidate and
 * recommends nothing (ADR-011); it tells a person which questions to look at.
 *
 * Pure and deterministic: responses are sorted before any summation, so the same set in any
 * order yields bit-identical results (invariant 3).
 */

/** FR-5: statistics are computed once a version has at least this many responses. */
export const MIN_RESPONSES_FOR_STATS = 30;

/** One candidate's result on one question version, within one finalised attempt. */
export interface ItemResponse {
  /** Score earned on this item. */
  readonly itemScore: number;
  /** Score available on this item, as served (`attempt_questions.max_score`). */
  readonly itemMax: number;
  /** The attempt's total score, including this item. */
  readonly totalScore: number;
  /** Time spent on this item. */
  readonly seconds: number;
}

export interface ItemStatistics {
  /** Responses that contributed — those with a positive `itemMax`. */
  readonly n: number;
  /** Mean proportion of available score earned, 4 dp. `null` below the threshold. */
  readonly pValue: number | null;
  /** Corrected item-total correlation, 4 dp. `null` below the threshold or with no variance. */
  readonly discrimination: number | null;
  /** Mean seconds on the item, 2 dp. `null` below the threshold. */
  readonly meanSeconds: number | null;
}

const round = (value: number, places: number): number => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

/**
 * Pearson correlation, or `null` when either variable is constant.
 *
 * A constant variable has zero variance and no defined correlation. Returning `null` rather than
 * letting `0 / 0` produce `NaN` keeps a numeric column from holding a value no query can compare.
 */
function pearson(xs: readonly number[], ys: readonly number[]): number | null {
  const n = xs.length;
  let sumX = 0;
  let sumY = 0;
  for (let i = 0; i < n; i += 1) {
    sumX += xs[i] ?? 0;
    sumY += ys[i] ?? 0;
  }
  const meanX = sumX / n;
  const meanY = sumY / n;

  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = (xs[i] ?? 0) - meanX;
    const dy = (ys[i] ?? 0) - meanY;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx === 0 || syy === 0) return null;
  return sxy / Math.sqrt(sxx * syy);
}

export function computeItemStatistics(responses: readonly ItemResponse[]): ItemStatistics {
  // An item served with no available score contributes nothing to difficulty and cannot be
  // divided by. Excluded rather than counted as zero.
  const usable = responses
    .filter((r) => r.itemMax > 0)
    // Sorted before summation so the result does not depend on the order rows arrived in:
    // floating-point addition is not associative, and a re-run must match to the bit.
    .slice()
    .sort(
      (a, b) =>
        a.itemScore - b.itemScore ||
        a.itemMax - b.itemMax ||
        a.totalScore - b.totalScore ||
        a.seconds - b.seconds,
    );

  const n = usable.length;
  if (n < MIN_RESPONSES_FOR_STATS) {
    return { n, pValue: null, discrimination: null, meanSeconds: null };
  }

  const proportions = usable.map((r) => r.itemScore / r.itemMax);
  const restScores = usable.map((r) => r.totalScore - r.itemScore);

  let proportionSum = 0;
  let secondsSum = 0;
  for (let i = 0; i < n; i += 1) {
    proportionSum += proportions[i] ?? 0;
    secondsSum += usable[i]?.seconds ?? 0;
  }

  const discrimination = pearson(proportions, restScores);

  return {
    n,
    pValue: round(proportionSum / n, 4),
    discrimination: discrimination === null ? null : round(discrimination, 4),
    meanSeconds: round(secondsSum / n, 2),
  };
}
