/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';

import {
  ATTEMPT_STATUSES,
  canTransition,
  isTerminalStatus,
  transition,
  type AttemptEvent,
  type AttemptStatus,
} from './attempt-state.js';
import { type DomainErrorCode } from './errors.js';

/**
 * The table below is the specification, not a sample of it. Every one of the eight
 * states is crossed with every event shape, including both branches of
 * `grade_complete` and a `void` with an empty reason — sixty-four rows, each naming
 * either the resulting state or the error code.
 *
 * A transition table tested by example is a transition table with holes in it, and the
 * holes are where an attempt ends up in a state nobody designed.
 */

const EVENTS = {
  start: { type: 'start' },
  submit: { type: 'submit' },
  expire: { type: 'expire' },
  grade_needs_review: { type: 'grade_complete', needsHumanReview: true },
  grade_clean: { type: 'grade_complete', needsHumanReview: false },
  review_complete: { type: 'review_complete' },
  void_with_reason: { type: 'void', reason: 'Fire alarm; centre evacuated.' },
  void_blank_reason: { type: 'void', reason: '   \t\n ' },
} as const satisfies Record<string, AttemptEvent>;

type EventKey = keyof typeof EVENTS;

const EVENT_KEYS = Object.keys(EVENTS) as EventKey[];

/** Either the state reached, or the `DomainErrorCode` that rejected the event. */
type Expectation = AttemptStatus | DomainErrorCode;

const ILLEGAL: DomainErrorCode = 'illegal_transition';
const BLANK: DomainErrorCode = 'void_reason_required';

const TABLE: Readonly<Record<AttemptStatus, Readonly<Record<EventKey, Expectation>>>> = {
  created: {
    start: 'in_progress',
    submit: ILLEGAL,
    expire: ILLEGAL,
    grade_needs_review: ILLEGAL,
    grade_clean: ILLEGAL,
    review_complete: ILLEGAL,
    void_with_reason: 'voided',
    void_blank_reason: BLANK,
  },
  in_progress: {
    start: ILLEGAL,
    submit: 'submitted',
    expire: 'expired',
    grade_needs_review: ILLEGAL,
    grade_clean: ILLEGAL,
    review_complete: ILLEGAL,
    void_with_reason: 'voided',
    void_blank_reason: BLANK,
  },
  submitted: {
    start: ILLEGAL,
    submit: ILLEGAL,
    expire: ILLEGAL,
    grade_needs_review: 'auto_graded',
    grade_clean: 'auto_graded',
    review_complete: ILLEGAL,
    void_with_reason: 'voided',
    void_blank_reason: BLANK,
  },
  expired: {
    start: ILLEGAL,
    submit: ILLEGAL,
    expire: ILLEGAL,
    grade_needs_review: 'auto_graded',
    grade_clean: 'auto_graded',
    review_complete: ILLEGAL,
    void_with_reason: 'voided',
    void_blank_reason: BLANK,
  },
  auto_graded: {
    start: ILLEGAL,
    submit: ILLEGAL,
    expire: ILLEGAL,
    grade_needs_review: 'under_review',
    grade_clean: 'finalised',
    review_complete: ILLEGAL,
    void_with_reason: 'voided',
    void_blank_reason: BLANK,
  },
  under_review: {
    start: ILLEGAL,
    submit: ILLEGAL,
    expire: ILLEGAL,
    grade_needs_review: ILLEGAL,
    grade_clean: ILLEGAL,
    review_complete: 'finalised',
    void_with_reason: 'voided',
    void_blank_reason: BLANK,
  },
  finalised: {
    start: ILLEGAL,
    submit: ILLEGAL,
    expire: ILLEGAL,
    grade_needs_review: ILLEGAL,
    grade_clean: ILLEGAL,
    review_complete: ILLEGAL,
    void_with_reason: 'voided',
    void_blank_reason: BLANK,
  },
  voided: {
    start: ILLEGAL,
    submit: ILLEGAL,
    expire: ILLEGAL,
    grade_needs_review: ILLEGAL,
    grade_clean: ILLEGAL,
    review_complete: ILLEGAL,
    void_with_reason: 'already_voided',
    void_blank_reason: BLANK,
  },
};

const isStatus = (value: Expectation): value is AttemptStatus =>
  (ATTEMPT_STATUSES as readonly string[]).includes(value);

describe('transition', () => {
  const rows = ATTEMPT_STATUSES.flatMap((from) =>
    EVENT_KEYS.map((eventKey) => ({ from, eventKey, expected: TABLE[from][eventKey] })),
  );

  it('covers every state crossed with every event', () => {
    expect(rows).toHaveLength(ATTEMPT_STATUSES.length * EVENT_KEYS.length);
    expect(rows).toHaveLength(64);
  });

  it.each(rows)('$from + $eventKey -> $expected', ({ from, eventKey, expected }) => {
    const result = transition(from, EVENTS[eventKey]);

    if (isStatus(expected)) {
      expect(result).toStrictEqual({ ok: true, value: expected });
    } else {
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(expected);
        expect(result.error.message.length).toBeGreaterThan(0);
      }
    }
  });

  it('never produces a target that canTransition rejects', () => {
    for (const { from, eventKey } of rows) {
      const result = transition(from, EVENTS[eventKey]);
      if (result.ok) {
        expect(canTransition(from, result.value)).toBe(true);
      }
    }
  });

  it('reaches finalised only from auto_graded or under_review', () => {
    const predecessors = ATTEMPT_STATUSES.filter((from) => canTransition(from, 'finalised'));
    expect(predecessors).toStrictEqual(['auto_graded', 'under_review']);
  });

  it('reaches voided from every state except voided itself', () => {
    const predecessors = ATTEMPT_STATUSES.filter((from) => canTransition(from, 'voided'));
    expect(predecessors).toStrictEqual([
      'created',
      'in_progress',
      'submitted',
      'expired',
      'auto_graded',
      'under_review',
      'finalised',
    ]);
  });

  it('carries the offending state and event in the error details', () => {
    const result = transition('finalised', { type: 'submit' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.details).toStrictEqual({ from: 'finalised', event: 'submit' });
    }
  });

  it('refuses a void whose reason is only whitespace', () => {
    const result = transition('in_progress', { type: 'void', reason: '' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('void_reason_required');
    }
  });

  it('is a pure function of its arguments', () => {
    const first = transition('auto_graded', { type: 'grade_complete', needsHumanReview: true });
    const second = transition('auto_graded', { type: 'grade_complete', needsHumanReview: true });
    expect(first).toStrictEqual(second);
  });
});

describe('canTransition', () => {
  it('rejects every self-transition', () => {
    for (const status of ATTEMPT_STATUSES) {
      expect(canTransition(status, status)).toBe(false);
    }
  });

  it('rejects skipping grading entirely', () => {
    expect(canTransition('in_progress', 'finalised')).toBe(false);
    expect(canTransition('submitted', 'finalised')).toBe(false);
    expect(canTransition('expired', 'finalised')).toBe(false);
    expect(canTransition('created', 'submitted')).toBe(false);
  });

  it('rejects every backward edge', () => {
    expect(canTransition('submitted', 'in_progress')).toBe(false);
    expect(canTransition('finalised', 'under_review')).toBe(false);
    expect(canTransition('auto_graded', 'submitted')).toBe(false);
    expect(canTransition('voided', 'in_progress')).toBe(false);
  });

  it('declares exactly eight states', () => {
    expect(ATTEMPT_STATUSES).toHaveLength(8);
    expect(new Set(ATTEMPT_STATUSES).size).toBe(8);
  });
});

describe('isTerminalStatus', () => {
  it('treats voided as the only terminal state', () => {
    const terminal = ATTEMPT_STATUSES.filter(isTerminalStatus);
    expect(terminal).toStrictEqual(['voided']);
  });
});
