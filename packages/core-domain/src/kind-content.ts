/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What each question kind may and must carry.
 *
 * A version's body does not state its kind — the question does — so a request schema alone
 * cannot tell that `options` on a coding question is wrong. Before this module existed, it was
 * accepted: the options were stored, never served, never graded, and silently present in every
 * export. This is the rule that refuses it.
 *
 * ## Two severities, deliberately applied at different moments
 *
 * **`wrong_kind`** — content the kind can never use: options on a coding question, test cases
 * on a subjective one. There is no draft in which that is a step towards something valid, so it
 * is refused on every write.
 *
 * **`incomplete`** — content the kind needs but does not have yet: a coding question with no
 * hidden test case. That is the normal state of a draft; an author saves before they have written
 * the cases. It is refused only at **publish**, because publishing is the irreversible act
 * (ADR-003). Refusing it earlier would make authoring an all-at-once form, which is the thing
 * the PRD says authors will abandon the tool over.
 *
 * Pure: it receives counts, not rows, so it needs no database and no content type from
 * `packages/db`, and it can be table-tested over every kind.
 */

import type { QuestionKind } from '@assaybank/contracts';

/** What the rule needs to know about a version's content. Counts, not rows. */
export interface KindContentShape {
  readonly optionCount: number;
  readonly correctOptionCount: number;
  readonly hasCodingSpec: boolean;
  /** A non-empty `coding_spec.fixture_sql`. Meaningful only for `sql`. */
  readonly hasFixtureSql: boolean;
  readonly testCaseCount: number;
  readonly hiddenTestCaseCount: number;
  readonly answerKeyCount: number;
}

export type KindContentSeverity = 'wrong_kind' | 'incomplete';

export interface KindContentIssue {
  readonly severity: KindContentSeverity;
  /** The request field the problem is about, as the client named it. */
  readonly field: 'options' | 'coding_spec' | 'test_cases' | 'answer_keys';
  readonly message: string;
}

/** `draft` checks what can never be right; `publish` also checks what is still missing. */
export type KindContentStage = 'draft' | 'publish';

const CHOICE: ReadonlySet<QuestionKind> = new Set(['mcq_single', 'mcq_multi', 'true_false']);
const CODE: ReadonlySet<QuestionKind> = new Set(['coding', 'sql']);

/**
 * Every problem with this content for this kind at this stage. Empty means acceptable.
 *
 * All problems are returned rather than the first, so an author fixes a form once instead of
 * resubmitting it once per mistake.
 */
export function validateKindContent(
  kind: QuestionKind,
  shape: KindContentShape,
  stage: KindContentStage,
): KindContentIssue[] {
  const issues: KindContentIssue[] = [];
  const wrong = (field: KindContentIssue['field'], message: string): void => {
    issues.push({ severity: 'wrong_kind', field, message });
  };
  const missing = (field: KindContentIssue['field'], message: string): void => {
    if (stage === 'publish') issues.push({ severity: 'incomplete', field, message });
  };

  const isChoice = CHOICE.has(kind);
  const isCode = CODE.has(kind);
  const isShortAnswer = kind === 'short_answer';

  // ---- content the kind can never carry ------------------------------------------------
  if (!isChoice && shape.optionCount > 0) {
    wrong('options', `a ${kind} question has no options; only choice questions do`);
  }
  if (!isCode && shape.hasCodingSpec) {
    wrong('coding_spec', `a ${kind} question has no execution spec; only coding and sql do`);
  }
  if (!isCode && shape.testCaseCount > 0) {
    wrong('test_cases', `a ${kind} question has no test cases; only coding and sql do`);
  }
  if (!isShortAnswer && shape.answerKeyCount > 0) {
    wrong('answer_keys', `a ${kind} question has no answer keys; only short_answer does`);
  }
  if (kind === 'coding' && shape.hasFixtureSql) {
    // A fixture database is served to the candidate for sql questions. On a coding question it
    // would be stored, exported and never used — and it is candidate-visible content, so an
    // author who put something sensitive there would find it in the candidate payload.
    wrong('coding_spec', 'fixture_sql belongs to sql questions; a coding question has none');
  }

  // ---- content the kind needs, checked only when it is about to become immutable ------
  if (kind === 'true_false') {
    if (shape.optionCount !== 2) {
      missing('options', `a true_false question has exactly two options, not ${String(shape.optionCount)}`);
    }
    if (shape.correctOptionCount !== 1) {
      missing('options', 'a true_false question has exactly one correct option');
    }
  } else if (kind === 'mcq_single') {
    if (shape.optionCount < 2) {
      missing('options', 'a single-answer question needs at least two options');
    }
    if (shape.correctOptionCount !== 1) {
      missing(
        'options',
        `a single-answer question has exactly one correct option, not ${String(shape.correctOptionCount)}`,
      );
    }
  } else if (kind === 'mcq_multi') {
    if (shape.optionCount < 2) {
      missing('options', 'a multiple-answer question needs at least two options');
    }
    if (shape.correctOptionCount < 1) {
      missing('options', 'a multiple-answer question needs at least one correct option');
    }
  } else if (isShortAnswer) {
    if (shape.answerKeyCount < 1) {
      missing('answer_keys', 'a short_answer question needs at least one answer key to be graded');
    }
  } else if (isCode) {
    if (!shape.hasCodingSpec) {
      missing('coding_spec', `a ${kind} question needs an execution spec`);
    }
    if (shape.hiddenTestCaseCount < 1) {
      // Sample cases are shown to the candidate in full. A question graded only on those can be
      // passed by printing the expected output — so at least one hidden case is what makes the
      // score mean anything.
      missing(
        'test_cases',
        `a ${kind} question needs at least one hidden test case; sample cases are visible to the candidate`,
      );
    }
    if (kind === 'sql' && !shape.hasFixtureSql) {
      missing('coding_spec', 'an sql question needs fixture_sql — the database the query runs against');
    }
  }
  // subjective and system_design are human-graded and need no machine-checkable content.

  return issues;
}
