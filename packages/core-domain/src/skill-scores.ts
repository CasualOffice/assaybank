/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { type SkillId } from '@assaybank/contracts';

import { roundProportion } from './round.js';

/**
 * Per-skill roll-up — the "you scored 82% on SQL, 44% on concurrency" breakdown in the
 * report and in the `attempt.finalised` webhook.
 *
 * Arithmetic only. There is no model, no heuristic and no similarity measure anywhere
 * near this (ADR-011); a per-skill number is a weighted ratio of marks earned to marks
 * available, and nothing else.
 */

/**
 * One graded question's contribution. `skillIds` are the skills the question version is
 * tagged with; a question tagged with three skills contributes its full marks to each
 * of them, because the alternative — splitting marks across tags — makes a skill score
 * depend on how many *other* skills the author happened to tag.
 */
export type QuestionSkillScore = {
  readonly skillIds: readonly SkillId[];
  readonly score: number;
  readonly maxScore: number;
};

/** Per-skill weights. A skill absent from the map weighs 1. */
export type SkillWeights = ReadonlyMap<SkillId, number>;

function assertFiniteInRange(value: number, label: string, min: number, max?: number): void {
  if (!Number.isFinite(value) || value < min || (max !== undefined && value > max)) {
    throw new RangeError(`${label} is out of range, received ${String(value)}.`);
  }
}

/**
 * Rolls per-question marks up to a per-skill proportion in `[0, 1]`.
 *
 * A skill with no marks available — every question tagged with it was worth zero, or
 * carried weight zero — is omitted rather than reported as 0. "Scored nothing" and
 * "was never assessed" are different claims to make about a candidate, and only one of
 * them is true.
 *
 * Throws on malformed input: a score above its own maximum, a negative weight. Those
 * are storage or authoring bugs, not domain outcomes, and a report that quietly
 * normalised them would be wrong in a way nobody could see.
 */
export function rollUpSkillScores(
  perQuestion: readonly QuestionSkillScore[],
  weights: SkillWeights,
): Map<SkillId, number> {
  const earned = new Map<SkillId, number>();
  const available = new Map<SkillId, number>();

  for (const question of perQuestion) {
    assertFiniteInRange(question.maxScore, 'maxScore', 0);
    assertFiniteInRange(question.score, 'score', 0, question.maxScore);

    for (const skill of new Set(question.skillIds)) {
      const weight = weights.get(skill) ?? 1;
      assertFiniteInRange(weight, `weight for skill '${String(skill)}'`, 0);

      earned.set(skill, (earned.get(skill) ?? 0) + weight * question.score);
      available.set(skill, (available.get(skill) ?? 0) + weight * question.maxScore);
    }
  }

  const rolled = new Map<SkillId, number>();
  for (const [skill, availableMarks] of available) {
    if (availableMarks <= 0) {
      continue;
    }
    rolled.set(skill, roundProportion((earned.get(skill) ?? 0) / availableMarks));
  }
  return rolled;
}
