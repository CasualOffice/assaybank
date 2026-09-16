/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * @assaybank/grading — pure comparison and weighted scoring. No I/O, ever.
 *
 * Owns: `compareCase(mode, expected, actual)` and the `GradingMode` union, `gradeMcq`,
 * `gradeShortAnswer`, `scoreSubmission(cases, weights)` and `weightedTotal(sections)` —
 * partial credit and optional negative marking included.
 *
 * Every function here is a total, deterministic function of its arguments: identical
 * inputs always produce an identical score, which is what makes a re-grade reproducible
 * (ADR-008) and a dispute answerable a year later. Comparison happens in this package
 * and never inside the sandbox, so escaping the sandbox reveals nothing about a hidden
 * case (ADR-002). No model call, no heuristic ranking and no similarity scoring sits
 * anywhere in this package (ADR-011).
 */

/**
 * The workspace's own package name. Exported so a bootstrap can name itself in a log
 * line or a span resource without a second source of truth, and so this module has a
 * real export from the first commit.
 */
export const WORKSPACE_NAME = '@assaybank/grading';

export { compareCase, GRADING_MODES } from './compare.js';
export type { CaseOutcome, CaseOutcomeReason, CompareOptions, GradingMode } from './compare.js';

export { gradeMcq } from './mcq.js';
export type { McqScoringOptions } from './mcq.js';

export { gradeShortAnswer } from './short-answer.js';
export type { AnswerKey } from './short-answer.js';

export { scoreSubmission, weightedTotal } from './aggregate.js';
export type { CaseResult, WeightedSection } from './aggregate.js';

export { computeItemStatistics, MIN_RESPONSES_FOR_STATS } from './psychometrics.js';
export type { ItemResponse, ItemStatistics } from './psychometrics.js';
