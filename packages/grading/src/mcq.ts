/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { assertFiniteAtLeast, roundScore } from './round.js';

export type McqScoringOptions = {
  /** Marks for a fully correct answer. */
  readonly maxScore: number;
  /** Penalty per incorrectly selected option. Zero disables negative marking. */
  readonly negativeScore: number;
  /** When true, each correct option selected earns its share of `maxScore`. */
  readonly partialCredit: boolean;
  /**
   * Whether the penalty may push this question below zero. Default `false`.
   *
   * Negative marking that can produce a negative *question* score has to be a deliberate
   * configuration choice, because it changes what a total means: without it a candidate
   * cannot be dragged below zero on one question by a single confident guess.
   */
  readonly allowNegativeTotal?: boolean;
};

/**
 * Scores an MCQ or true/false answer.
 *
 * Pure set arithmetic — the option identifiers are opaque strings and nothing here
 * inspects their content, so no property of the *text* of an option can influence a
 * score (ADR-011).
 *
 * Two rules that are fairness decisions rather than implementation details:
 *
 * 1. **An unanswered question is never penalised.** Selecting nothing scores zero, never
 *    a negative. Otherwise negative marking punishes running out of time.
 * 2. **The floor is zero unless `allowNegativeTotal` says otherwise**, so a penalty can
 *    cancel partial credit within a question but cannot create a debt that eats marks
 *    earned elsewhere.
 *
 * Throws on a malformed question — no correct options, a negative maximum — because that
 * is an authoring bug that must surface at publish time, not a score of zero for the
 * candidate who happened to receive it.
 */
export function gradeMcq(
  selected: readonly string[],
  correct: readonly string[],
  opts: McqScoringOptions,
): number {
  assertFiniteAtLeast(opts.maxScore, 'maxScore', 0);
  assertFiniteAtLeast(opts.negativeScore, 'negativeScore', 0);

  const correctSet = new Set(correct);
  if (correctSet.size === 0) {
    throw new RangeError('An MCQ must declare at least one correct option.');
  }

  const selectedSet = new Set(selected);
  if (selectedSet.size === 0) {
    return 0;
  }

  let hits = 0;
  for (const option of selectedSet) {
    if (correctSet.has(option)) {
      hits += 1;
    }
  }
  const misses = selectedSet.size - hits;
  const floor = opts.allowNegativeTotal === true ? Number.NEGATIVE_INFINITY : 0;

  if (!opts.partialCredit) {
    const exact = misses === 0 && hits === correctSet.size;
    return roundScore(exact ? opts.maxScore : Math.max(floor, -opts.negativeScore));
  }

  const perCorrectOption = opts.maxScore / correctSet.size;
  const raw = perCorrectOption * hits - opts.negativeScore * misses;
  return roundScore(Math.min(opts.maxScore, Math.max(floor, raw)));
}
