/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * @assaybank/core-domain — pure, deterministic domain logic. No I/O, ever.
 *
 * Owns: the attempt state machine (`transition`, `canTransition`), the question
 * lifecycle (`transitionQuestion`, ADR-003), server-computed deadlines
 * (`computeDeadline`, `isPastDeadline`, `secondsRemaining`), section-rule resolution and
 * the question draw (`resolveDraw`, `shuffleOptions`), and the per-skill roll-up
 * (`rollUpSkillScores`).
 *
 * No database client, no HTTP client, no filesystem and no clock read that was not
 * passed in as an argument (CODE-GRAPH L2, enforced by eslint). The draw is a function
 * of (rule, pool snapshot, rng) so the same inputs always produce the same served set
 * (ADR-004), and `finalised` is reachable only from `auto_graded` or `under_review`,
 * which is what stops an attempt being finalised before it has been scored.
 */

/**
 * The workspace's own package name. Exported so a bootstrap can name itself in a log
 * line or a span resource without a second source of truth, and so this module has a
 * real export from the first commit.
 */
export const WORKSPACE_NAME = '@assaybank/core-domain';

export { err, isErr, isOk, mapResult, ok, unwrapOr } from './result.js';
export type { Err, Ok, Result } from './result.js';

export { domainError } from './errors.js';
export type { DomainError, DomainErrorCode } from './errors.js';

export { ATTEMPT_STATUSES, canTransition, isTerminalStatus, transition } from './attempt-state.js';
export type { AttemptEvent, AttemptStatus } from './attempt-state.js';

export { computeDeadline, isPastDeadline, secondsRemaining } from './deadline.js';
export type { Clock } from './deadline.js';

export { QUESTION_KINDS, resolveDraw } from './draw.js';
export type { DrawCandidate, QuestionKind, SectionRule } from './draw.js';

export {
  QUESTION_EVENTS,
  QUESTION_LIFECYCLE_STATUSES,
  canTransitionQuestion,
  isServableStatus,
  isTerminalQuestionStatus,
  transitionQuestion,
} from './question-lifecycle.js';
export type { QuestionEvent, QuestionStatus } from './question-lifecycle.js';

export { shuffleOptions } from './shuffle.js';

export { rollUpSkillScores } from './skill-scores.js';
export type { QuestionSkillScore, SkillWeights } from './skill-scores.js';
