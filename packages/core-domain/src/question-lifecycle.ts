/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { QUESTION_STATUSES, type QuestionStatus } from '@assaybank/contracts';

import { domainError, type DomainError } from './errors.js';
import { err, ok, type Result } from './result.js';

/**
 * ADR-003 and FR-1, as pure logic: the authoring lifecycle of a question.
 *
 * ```
 *   draft ──submit_for_review──▶ review ──publish──▶ published ──retire──▶ retired
 *     ▲                             │                    │
 *     └────────request_changes──────┘                    └──publish──┐
 *                                                             ▲      │
 *                                                             └──────┘
 *                                             (a further version of a live question)
 * ```
 *
 * Two levels of state exist and confusing them is the mistake this module is shaped to
 * prevent.
 *
 * **The version** carries `published_at`, and that is the freeze line. Non-null means the
 * row is immutable, enforced by the trigger migration 0001 installs and answered as
 * `409 version_immutable` at the API. Nothing here can unset it; there is no event for it
 * and no code path that could ask for one.
 *
 * **The question** carries the status this module transitions. It is the *circulation*
 * state of the item as a whole — is it being written, is it being reviewed, may an
 * assessment draw it, has it been withdrawn — and it is coarser than the version state on
 * purpose, because an author fixing a typo in a live question is editing a draft version
 * of a question that is still published and still being served.
 *
 * ## Why `publish` is legal from `published`
 *
 * It is the second-version case above, and it is the *ordinary* case once a bank is a few
 * months old. Publishing version 4 of a live question does not change the question's
 * circulation state — it was published and it still is — so the transition is a
 * self-edge rather than a special case the API has to remember not to ask about. Making
 * it illegal would force every caller to branch on the current status before publishing,
 * which is the branch somebody eventually gets wrong.
 *
 * What it is *not* is a way to unfreeze anything. `publish` here is the question-level
 * consequence of a version being published; the version it names is a different row, and
 * that row goes from unpublished to published exactly once.
 *
 * ## Why `retired` is terminal
 *
 * FR-4 says the system flags questions that exceed an exposure threshold *for
 * retirement*. Retirement is therefore what happens to an item that has been seen too
 * often to measure anything — in the limit, one that has leaked. Reinstating such an item
 * is re-introducing a compromised question to a live bank, and it would be one API call
 * away from being done by somebody tidying a list. An organisation that wants the content
 * back writes a new question from it; that costs a few minutes and leaves a record of the
 * decision.
 *
 * Retiring is not deleting. Nothing is removed, every version survives, and every attempt
 * that referenced one keeps referencing it — which is the whole reason `retired` is a
 * status rather than a `DELETE` (ADR-003). Soft deletion is a separate axis:
 * `questions.archived_at`, set by `DELETE /questions/{id}`, and orthogonal to this
 * machine.
 *
 * ## Why publishing is not a status somebody can assign
 *
 * docs/03 §4: *"Publishing is a distinct action requiring `question.publish`"*. So
 * `PATCH /questions/{id}` cannot express `published` — see `PATCHABLE_STATUSES` in
 * `@assaybank/contracts` — and the only caller that raises {@link QuestionEvent} `publish`
 * is the publish route. A permission gate that a sibling endpoint routes around is not a
 * gate.
 *
 * Pure, like everything in this package: no clock, no database, no I/O. The instant a
 * version is frozen at is the server's, applied by the caller (ADR-006).
 */

/** The authoring lifecycle state of a question. Re-exported from the contract vocabulary. */
export type { QuestionStatus };

/**
 * Every status, in lifecycle order. Exported so a table test can be exhaustive.
 *
 * Aliased from `@assaybank/contracts` rather than restated: the enum is also a
 * PostgreSQL type and a wire value, and three copies of a four-member list is three
 * chances for them to disagree about what `retired` means.
 */
export const QUESTION_LIFECYCLE_STATUSES: readonly QuestionStatus[] = QUESTION_STATUSES;

/**
 * What can happen to a question.
 *
 * Deliberately small, and deliberately without an `unretire`, an `unpublish` or a
 * `force_status`. Each absent event is a decision recorded in the module comment; an
 * event added here is a change to the invariant and should be reviewed as one.
 *
 * `publish` is raised only by `POST /questions/{id}/versions/{v}/publish`, which requires
 * the `question.publish` permission. Nothing in this union can be raised by an import, a
 * statistics job or a heuristic — the bank moves through its lifecycle because a person
 * with a permission asked it to.
 */
export type QuestionEvent =
  /** An author has finished a draft and wants it reviewed. */
  | { type: 'submit_for_review' }
  /** A reviewer wants changes before this can be published. */
  | { type: 'request_changes' }
  /** A version of this question has been published (`question.publish`). */
  | { type: 'publish' }
  /** The question is withdrawn from circulation. Irreversible; nothing is deleted. */
  | { type: 'retire' };

/** Every event, for an exhaustive table test. */
export const QUESTION_EVENTS: readonly QuestionEvent['type'][] = [
  'submit_for_review',
  'request_changes',
  'publish',
  'retire',
];

/**
 * The legal edges, as a graph. {@link canTransitionQuestion} reads it directly and
 * {@link transitionQuestion} produces only targets that appear in it — the two cannot
 * drift apart, because the table test asserts that every success is an edge in this map.
 *
 * `published → published` is a genuine edge (the second-version case above), which is why
 * this map is read with `includes` rather than with a "self-transitions are never edges"
 * rule borrowed from the attempt machine. `retired` has no outgoing edge at all.
 */
const EDGES: Readonly<Record<QuestionStatus, readonly QuestionStatus[]>> = {
  draft: ['review'],
  review: ['draft', 'published'],
  published: ['published', 'retired'],
  retired: [],
};

/** True when `from → to` is an edge of the question lifecycle. */
export function canTransitionQuestion(from: QuestionStatus, to: QuestionStatus): boolean {
  return EDGES[from].includes(to);
}

/** True for a status no event can leave. `retired` is the only one. */
export function isTerminalQuestionStatus(status: QuestionStatus): boolean {
  return EDGES[status].length === 0;
}

/**
 * True when a question in this status may be drawn into an assessment.
 *
 * One published status, and the reason it is a function rather than an `=== 'published'`
 * scattered through the composer: "which questions may a candidate be served" is a
 * product rule, and a rule expressed eleven times is a rule that will be expressed
 * differently in one of them. A draft is unfinished, a version in review is unapproved,
 * and a retired question has been withdrawn — none of the three may reach a candidate.
 */
export function isServableStatus(status: QuestionStatus): boolean {
  return status === 'published';
}

function illegal(
  from: QuestionStatus,
  event: QuestionEvent['type'],
): Result<QuestionStatus, DomainError> {
  return err(
    domainError('illegal_transition', `A question in '${from}' cannot handle '${event}'.`, {
      from,
      event,
    }),
  );
}

/**
 * Applies an event to a question status, returning the next status or a `DomainError`.
 *
 * Every combination not named below is rejected — the default is "no", so a status or an
 * event added later is illegal until somebody writes the edge deliberately. That is the
 * opposite of the usual default and it is the right one here: the cost of a missing edge
 * is an author filing a bug, and the cost of an accidental edge is a retired question
 * back in front of a candidate.
 *
 * The failure is a value rather than a throw, per `./result.ts`: an author clicking
 * "publish" on a draft that nobody has reviewed is an expected outcome of a legitimate
 * request, which the API turns into a `409`, not a programmer error.
 *
 * `details` carries the status and the event and nothing else — no prompt, no identifier,
 * no answer key. An error envelope is a place leaks hide (docs/14).
 */
export function transitionQuestion(
  from: QuestionStatus,
  event: QuestionEvent,
): Result<QuestionStatus, DomainError> {
  switch (event.type) {
    case 'submit_for_review':
      return from === 'draft' ? ok('review') : illegal(from, event.type);

    case 'request_changes':
      return from === 'review' ? ok('draft') : illegal(from, event.type);

    // From `review` this is the first publication and moves the question into
    // circulation. From `published` it is a further version of a question that is already
    // in circulation, and the status is unchanged — see the module comment. A draft has
    // not been reviewed, and a retired question has been withdrawn; neither may publish.
    case 'publish':
      return from === 'review' || from === 'published'
        ? ok('published')
        : illegal(from, event.type);

    // Only from `published`. Withdrawing something that was never in circulation is not
    // retirement — an unfinished draft is archived (`DELETE /questions/{id}`), which is a
    // different axis and a different word.
    case 'retire':
      return from === 'published' ? ok('retired') : illegal(from, event.type);
  }
}
