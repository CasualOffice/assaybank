/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  QUESTION_KINDS as CONTRACT_QUESTION_KINDS,
  type QuestionKind,
  type QuestionVersionId,
  type SkillId,
} from '@assaybank/contracts';

import { domainError, type DomainError } from './errors.js';
import { err, ok, type Result } from './result.js';
import { shuffleWith } from './shuffle.js';

/**
 * ADR-004 — the served question set is materialised once at attempt start.
 *
 * `resolveDraw` is the whole of the selection decision: a pure function of the rule,
 * the pool snapshot and the injected generator. It is called once, inside the attempt-
 * start transaction, and its output is written to `attempt_questions`. Nothing re-rolls
 * it afterwards — grading, reporting and appeals all read that table.
 *
 * The same function backs `POST /assessments/{id}/simulate`, which is why infeasibility
 * is a returned error rather than a throw or a short draw: an assessment whose rules
 * cannot be satisfied must fail at publish time, not in front of a candidate.
 */

/**
 * `question_kind` from docs/hiring_platform_schema.sql §4.
 *
 * Aliased from `@assaybank/contracts` rather than restated. The union is also a
 * PostgreSQL enum and a wire value, and a draw rule filtering on a kind the bank cannot
 * hold is a bug that surfaces as an assessment which silently fails to compose — so there
 * is one list, in the package both the server and the two browser bundles already read.
 */
export type { QuestionKind };

/** Every kind, for an exhaustive test or a filter default. */
export const QUESTION_KINDS: readonly QuestionKind[] = CONTRACT_QUESTION_KINDS;

/** Difficulty is `smallint CHECK (difficulty BETWEEN 1 AND 5)` in the schema. */
const MIN_DIFFICULTY = 1;
const MAX_DIFFICULTY = 5;

/**
 * One `section_rules` row: "5 questions, skill=python, difficulty 2–3, not seen in 90
 * days".
 *
 * An empty `skillIds` or `kinds` means "no filter on that dimension", matching the
 * `DEFAULT '{}'` columns in the schema. `excludeSeenDays` of 0 disables the
 * recently-seen exclusion.
 */
export type SectionRule = {
  readonly pickCount: number;
  readonly skillIds: readonly SkillId[];
  readonly kinds: readonly QuestionKind[];
  readonly minDifficulty: number;
  readonly maxDifficulty: number;
  readonly excludeSeenDays: number;
  readonly scorePerQuestion: number;
};

/**
 * A row of the pool the rule draws from.
 *
 * It carries no question *content* — not a stem, not an option, and above all not an
 * expectation or a reference solution. Selection needs metadata only, and a type that
 * cannot hold an answer key cannot leak one (FR-12).
 *
 * `lastSeenDaysAgo` absent means this candidate has never seen the version.
 */
export type DrawCandidate = {
  readonly questionVersionId: QuestionVersionId;
  readonly skillIds: readonly SkillId[];
  readonly kind: QuestionKind;
  readonly difficulty: number;
  readonly lastSeenDaysAgo?: number;
};

function validateRule(rule: SectionRule): DomainError | undefined {
  if (!Number.isInteger(rule.pickCount) || rule.pickCount <= 0) {
    return domainError('invalid_rule', 'pickCount must be a positive integer.', {
      pickCount: rule.pickCount,
    });
  }
  if (
    !Number.isInteger(rule.minDifficulty) ||
    !Number.isInteger(rule.maxDifficulty) ||
    rule.minDifficulty < MIN_DIFFICULTY ||
    rule.maxDifficulty > MAX_DIFFICULTY
  ) {
    return domainError(
      'invalid_rule',
      `Difficulty bounds must be integers between ${String(MIN_DIFFICULTY)} and ${String(MAX_DIFFICULTY)}.`,
      { minDifficulty: rule.minDifficulty, maxDifficulty: rule.maxDifficulty },
    );
  }
  if (rule.minDifficulty > rule.maxDifficulty) {
    return domainError('invalid_rule', 'minDifficulty must not exceed maxDifficulty.', {
      minDifficulty: rule.minDifficulty,
      maxDifficulty: rule.maxDifficulty,
    });
  }
  if (!Number.isInteger(rule.excludeSeenDays) || rule.excludeSeenDays < 0) {
    return domainError('invalid_rule', 'excludeSeenDays must be a non-negative integer.', {
      excludeSeenDays: rule.excludeSeenDays,
    });
  }
  if (!Number.isFinite(rule.scorePerQuestion) || rule.scorePerQuestion < 0) {
    return domainError('invalid_rule', 'scorePerQuestion must be a finite, non-negative number.', {
      scorePerQuestion: rule.scorePerQuestion,
    });
  }
  return undefined;
}

function matchesRule(rule: SectionRule, entry: DrawCandidate): boolean {
  if (!Number.isInteger(entry.difficulty)) {
    return false;
  }
  if (entry.difficulty < rule.minDifficulty || entry.difficulty > rule.maxDifficulty) {
    return false;
  }
  if (rule.kinds.length > 0 && !rule.kinds.includes(entry.kind)) {
    return false;
  }
  if (rule.skillIds.length > 0 && !entry.skillIds.some((skill) => rule.skillIds.includes(skill))) {
    return false;
  }
  if (rule.excludeSeenDays > 0 && entry.lastSeenDaysAgo !== undefined) {
    if (entry.lastSeenDaysAgo < rule.excludeSeenDays) {
      return false;
    }
  }
  return true;
}

/**
 * The eligible set, deduplicated by version id and ordered by version id.
 *
 * Sorting before the shuffle is what makes the draw a function of the eligible *set*
 * rather than of the order the database happened to return rows in. Two replays with
 * the same seed and the same bank snapshot then produce byte-identical served sets even
 * if one of them came back from a different index scan.
 */
function eligible(rule: SectionRule, pool: readonly DrawCandidate[]): DrawCandidate[] {
  const seen = new Set<QuestionVersionId>();
  const matched: DrawCandidate[] = [];
  for (const entry of pool) {
    if (seen.has(entry.questionVersionId) || !matchesRule(rule, entry)) {
      continue;
    }
    seen.add(entry.questionVersionId);
    matched.push(entry);
  }
  matched.sort((a, b) => {
    if (a.questionVersionId === b.questionVersionId) {
      return 0;
    }
    return a.questionVersionId < b.questionVersionId ? -1 : 1;
  });
  return matched;
}

/**
 * Resolves one section rule against a pool.
 *
 * Returns exactly `pickCount` candidates, or a `draw_infeasible` error. It never
 * short-draws: a section that silently served four questions where the rule said five
 * would score every candidate in that cohort out of a different denominator, and nobody
 * would notice until the appeal.
 *
 * Deterministic: the same rule, the same pool *as a set*, and the same `rng` sequence
 * always yield the same ordered result.
 */
export function resolveDraw(
  rule: SectionRule,
  pool: DrawCandidate[],
  rng: () => number,
): Result<DrawCandidate[], DomainError> {
  const invalid = validateRule(rule);
  if (invalid !== undefined) {
    return err(invalid);
  }

  const pickable = eligible(rule, pool);
  if (pickable.length < rule.pickCount) {
    return err(
      domainError(
        'draw_infeasible',
        `The rule needs ${String(rule.pickCount)} question(s) but only ${String(pickable.length)} in the pool match it.`,
        { pickCount: rule.pickCount, eligibleCount: pickable.length, poolSize: pool.length },
      ),
    );
  }

  return ok(shuffleWith(pickable, rng).slice(0, rule.pickCount));
}
