/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { domainError, type DomainError } from './errors.js';
import { err, ok, type Result } from './result.js';

/**
 * The attempt lifecycle from docs/03-API-spec.md §8. Eight states, no others.
 *
 * ```
 *   created ──start──▶ in_progress ──submit──▶ submitted ─┐
 *                            │                            ├─grade_complete─▶ auto_graded
 *                            └──expire──▶ expired ────────┘                       │
 *                                                                needs human? ────┤
 *                                            under_review ◀──────yes──────────────┤
 *                                                  │                              │
 *                                                  └──review_complete──▶ finalised ◀──no
 *
 *   any state except voided ──void(reason)──▶ voided
 * ```
 */
export type AttemptStatus =
  | 'created'
  | 'in_progress'
  | 'submitted'
  | 'expired'
  | 'auto_graded'
  | 'under_review'
  | 'finalised'
  | 'voided';

/** Every status, in lifecycle order. Exported so a table test can be exhaustive. */
export const ATTEMPT_STATUSES: readonly AttemptStatus[] = [
  'created',
  'in_progress',
  'submitted',
  'expired',
  'auto_graded',
  'under_review',
  'finalised',
  'voided',
];

/**
 * What can happen to an attempt.
 *
 * `expire` is raised by the server-side sweep, never by a client (ADR-006). `void`
 * carries a reason because voiding is audited and a void without a stated cause is not
 * reviewable. Note that no event originates from a proctoring or AI signal: nothing in
 * this union can be raised by an integrity heuristic, which is how ADR-007 and ADR-017
 * are enforced structurally rather than by policy.
 */
export type AttemptEvent =
  | { type: 'start' }
  | { type: 'submit' }
  | { type: 'expire' }
  | { type: 'grade_complete'; needsHumanReview: boolean }
  | { type: 'review_complete' }
  | { type: 'void'; reason: string };

/**
 * The legal edges, as a graph. `canTransition` reads it directly and `transition`
 * produces only targets that appear in it — the two cannot drift apart because the
 * table test below asserts that every `transition` success is an edge in this map.
 *
 * `finalised` has exactly two predecessors, `auto_graded` and `under_review`: an
 * attempt cannot be finalised before grading has produced a score for it.
 */
const EDGES: Readonly<Record<AttemptStatus, readonly AttemptStatus[]>> = {
  created: ['in_progress', 'voided'],
  in_progress: ['submitted', 'expired', 'voided'],
  submitted: ['auto_graded', 'voided'],
  expired: ['auto_graded', 'voided'],
  auto_graded: ['under_review', 'finalised', 'voided'],
  under_review: ['finalised', 'voided'],
  finalised: ['voided'],
  voided: [],
};

/** True when `from → to` is an edge of the lifecycle. Self-transitions are never edges. */
export function canTransition(from: AttemptStatus, to: AttemptStatus): boolean {
  return EDGES[from].includes(to);
}

/** True for a state no event can leave. `voided` is the only one. */
export function isTerminalStatus(status: AttemptStatus): boolean {
  return EDGES[status].length === 0;
}

function illegal(
  from: AttemptStatus,
  event: AttemptEvent['type'],
): Result<AttemptStatus, DomainError> {
  return err(
    domainError('illegal_transition', `Attempt in '${from}' cannot handle '${event}'.`, {
      from,
      event,
    }),
  );
}

/**
 * Applies an event to a state, returning the next state or a `DomainError`.
 *
 * Every combination not named below is rejected — the default is "no", so a state or
 * event added later is illegal until someone writes the edge deliberately.
 *
 * `grade_complete` appears twice on purpose, mirroring the diagram in docs/03 §8: the
 * grading run finishing moves `submitted`/`expired` to `auto_graded`, and the
 * human-review determination then moves `auto_graded` to `under_review` or `finalised`.
 * Passing through `auto_graded` is what makes "the scores exist" a recorded state
 * rather than an inference.
 */
export function transition(
  from: AttemptStatus,
  ev: AttemptEvent,
): Result<AttemptStatus, DomainError> {
  if (ev.type === 'void') {
    if (ev.reason.trim().length === 0) {
      return err(
        domainError('void_reason_required', 'Voiding an attempt requires a non-empty reason.', {
          from,
        }),
      );
    }
    if (from === 'voided') {
      return err(domainError('already_voided', 'The attempt is already voided.', { from }));
    }
    return ok('voided');
  }

  switch (ev.type) {
    case 'start':
      return from === 'created' ? ok('in_progress') : illegal(from, ev.type);

    case 'submit':
      return from === 'in_progress' ? ok('submitted') : illegal(from, ev.type);

    case 'expire':
      return from === 'in_progress' ? ok('expired') : illegal(from, ev.type);

    case 'grade_complete':
      if (from === 'submitted' || from === 'expired') {
        return ok('auto_graded');
      }
      if (from === 'auto_graded') {
        return ok(ev.needsHumanReview ? 'under_review' : 'finalised');
      }
      return illegal(from, ev.type);

    case 'review_complete':
      return from === 'under_review' ? ok('finalised') : illegal(from, ev.type);
  }
}
