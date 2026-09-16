/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The API edge of the kind-content rule.
 *
 * The rule itself — what each question kind may and must carry — is `validateKindContent` in
 * `@assaybank/core-domain`, pure and table-tested. This file does only the two things that
 * need the API: reduce whatever content representation is at hand to the counts the rule reads,
 * and turn the rule's findings into a `422 validation_failed` that names each field.
 *
 * Two representations reach it. Version **creation** holds the merged `VersionContent` (the
 * body copied forward over the prior version), and the check runs on that merge — not on the
 * raw body — because an author who omits `options` is keeping the previous ones, and a check on
 * the body alone would miss options that were already wrong. Version **publication** holds the
 * stored `QuestionVersionRecord`.
 */

import type { QuestionKind, QuestionVersionRecord } from '@assaybank/contracts';
import { ApiError } from '@assaybank/contracts';
import {
  validateKindContent,
  type KindContentShape,
  type KindContentStage,
} from '@assaybank/core-domain';
import type { VersionContent } from '@assaybank/db';

export function shapeOfContent(content: VersionContent): KindContentShape {
  return {
    optionCount: content.options.length,
    correctOptionCount: content.options.filter((o) => o.isCorrect).length,
    hasCodingSpec: content.codingSpec !== null,
    hasFixtureSql: (content.codingSpec?.fixtureSql ?? '').trim() !== '',
    testCaseCount: content.testCases.length,
    hiddenTestCaseCount: content.testCases.filter((c) => !c.isSample).length,
    answerKeyCount: content.answerKeys.length,
  };
}

export function shapeOfRecord(version: QuestionVersionRecord): KindContentShape {
  return {
    optionCount: version.options.length,
    correctOptionCount: version.options.filter((o) => o.is_correct).length,
    hasCodingSpec: version.coding_spec !== null,
    hasFixtureSql: (version.coding_spec?.fixture_sql ?? '').trim() !== '',
    testCaseCount: version.test_cases.length,
    hiddenTestCaseCount: version.test_cases.filter((c) => !c.is_sample).length,
    answerKeyCount: version.answer_keys.length,
  };
}

/**
 * Refuses content the kind cannot carry, or — at publish — content the kind still lacks.
 *
 * Every problem is reported at once, so an author fixes the form in one pass.
 */
export function assertKindContent(
  kind: QuestionKind,
  shape: KindContentShape,
  stage: KindContentStage,
): void {
  const issues = validateKindContent(kind, shape, stage);
  if (issues.length === 0) return;

  const message =
    stage === 'publish'
      ? `This ${kind} question is not ready to publish: ${issues.map((i) => i.message).join('; ')}.`
      : `This content does not belong on a ${kind} question: ${issues.map((i) => i.message).join('; ')}.`;

  throw ApiError.validationFailed(message, {
    details: {
      kind,
      stage,
      fields: issues.map((i) => ({
        field: `body/${i.field}`,
        rule: i.severity,
        message: i.message,
      })),
    },
  });
}
