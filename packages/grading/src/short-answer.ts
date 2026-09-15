/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { compareCase, type CompareOptions, type GradingMode } from './compare.js';
import { assertFiniteAtLeast, roundScore } from './round.js';

/**
 * One accepted answer for a short-answer question.
 *
 * `score` defaults to the question's `maxScore`. A key scoring 0 is a useful thing to
 * write: it is how an author records a specific near-miss they want to catch and award
 * nothing for, ahead of a more generous later key.
 */
export type AnswerKey = {
  readonly mode: GradingMode;
  readonly expected: string;
  readonly score?: number;
  readonly options?: CompareOptions;
};

/**
 * Scores a short answer against an ordered list of keys.
 *
 * **First match wins**, in the order the author wrote the keys. That is the whole
 * algorithm. There is no similarity measure, no fuzzy match, no spell check and no model
 * (ADR-011): a short answer is either covered by a declared key or it is not, and an
 * answer nobody anticipated scores zero and is visible in the per-question analytics so
 * a human can add a key and re-grade.
 *
 * Deterministic and order-dependent by design: the same answer and the same key list
 * always produce the same mark, which is what makes the re-grade of a disputed attempt
 * reproducible a year later.
 *
 * Every key is validated before any of them is evaluated, so a malformed key late in the
 * list fails loudly rather than lying dormant until someone happens to match past it.
 */
export function gradeShortAnswer(
  answer: string,
  keys: readonly AnswerKey[],
  maxScore: number,
): number {
  assertFiniteAtLeast(maxScore, 'maxScore', 0);

  for (const [index, key] of keys.entries()) {
    if (key.score !== undefined) {
      assertFiniteAtLeast(key.score, `keys[${String(index)}].score`, 0);
    }
  }

  for (const key of keys) {
    const outcome = compareCase(key.mode, key.expected, answer, key.options);
    if (outcome.passed) {
      return roundScore(Math.min(maxScore, key.score ?? maxScore));
    }
  }

  return 0;
}
