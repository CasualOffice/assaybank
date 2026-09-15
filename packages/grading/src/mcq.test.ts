/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';

import { gradeMcq, type McqScoringOptions } from './mcq.js';

/**
 * Every combination of partial credit and negative marking, on single-answer and
 * multi-answer questions, including the two boundaries that decide whether the scheme
 * is fair: the unanswered question and the floor at zero.
 */

type Row = {
  readonly label: string;
  readonly selected: string[];
  readonly correct: string[];
  readonly opts: McqScoringOptions;
  readonly expected: number;
};

const strict: McqScoringOptions = { maxScore: 10, negativeScore: 0, partialCredit: false };
const strictNegative: McqScoringOptions = {
  maxScore: 10,
  negativeScore: 2.5,
  partialCredit: false,
};
const partial: McqScoringOptions = { maxScore: 9, negativeScore: 0, partialCredit: true };
const partialNegative: McqScoringOptions = { maxScore: 9, negativeScore: 3, partialCredit: true };
const partialNegativeUnclamped: McqScoringOptions = {
  maxScore: 9,
  negativeScore: 3,
  partialCredit: true,
  allowNegativeTotal: true,
};

const ROWS: readonly Row[] = [
  // --- single answer, no partial credit, no negative marking ---------------
  { label: 'single correct', selected: ['b'], correct: ['b'], opts: strict, expected: 10 },
  { label: 'single wrong', selected: ['a'], correct: ['b'], opts: strict, expected: 0 },
  { label: 'unanswered', selected: [], correct: ['b'], opts: strict, expected: 0 },
  {
    label: 'extra option alongside the right one',
    selected: ['a', 'b'],
    correct: ['b'],
    opts: strict,
    expected: 0,
  },

  // --- single answer, negative marking -------------------------------------
  {
    label: 'negative marking on a correct answer',
    selected: ['b'],
    correct: ['b'],
    opts: strictNegative,
    expected: 10,
  },
  {
    label: 'negative marking on a wrong answer, clamped at zero',
    selected: ['a'],
    correct: ['b'],
    opts: strictNegative,
    expected: 0,
  },
  {
    label: 'negative marking never punishes leaving it blank',
    selected: [],
    correct: ['b'],
    opts: strictNegative,
    expected: 0,
  },
  {
    label: 'negative marking below zero when explicitly configured',
    selected: ['a'],
    correct: ['b'],
    opts: { ...strictNegative, allowNegativeTotal: true },
    expected: -2.5,
  },

  // --- multi answer, partial credit ---------------------------------------
  {
    label: 'all three correct',
    selected: ['a', 'b', 'c'],
    correct: ['a', 'b', 'c'],
    opts: partial,
    expected: 9,
  },
  {
    label: 'two of three correct',
    selected: ['a', 'b'],
    correct: ['a', 'b', 'c'],
    opts: partial,
    expected: 6,
  },
  {
    label: 'one of three correct',
    selected: ['a'],
    correct: ['a', 'b', 'c'],
    opts: partial,
    expected: 3,
  },
  {
    label: 'two right and one wrong, no penalty configured',
    selected: ['a', 'b', 'z'],
    correct: ['a', 'b', 'c'],
    opts: partial,
    expected: 6,
  },
  {
    label: 'every option selected, no penalty configured',
    selected: ['a', 'b', 'c', 'z'],
    correct: ['a', 'b', 'c'],
    opts: partial,
    expected: 9,
  },

  // --- multi answer, partial credit plus negative marking ------------------
  {
    label: 'two right and one wrong, penalised',
    selected: ['a', 'b', 'z'],
    correct: ['a', 'b', 'c'],
    opts: partialNegative,
    expected: 3,
  },
  {
    label: 'one right and two wrong, penalised to the floor',
    selected: ['a', 'y', 'z'],
    correct: ['a', 'b', 'c'],
    opts: partialNegative,
    expected: 0,
  },
  {
    label: 'one right and two wrong, floor lifted',
    selected: ['a', 'y', 'z'],
    correct: ['a', 'b', 'c'],
    opts: partialNegativeUnclamped,
    expected: -3,
  },
  {
    label: 'selecting everything is not a strategy when wrong options are penalised',
    selected: ['a', 'b', 'c', 'x', 'y', 'z'],
    correct: ['a', 'b', 'c'],
    opts: partialNegative,
    expected: 0,
  },

  // --- true/false ----------------------------------------------------------
  { label: 'true/false right', selected: ['true'], correct: ['true'], opts: strict, expected: 10 },
  { label: 'true/false wrong', selected: ['false'], correct: ['true'], opts: strict, expected: 0 },

  // --- zero-mark question --------------------------------------------------
  {
    label: 'a question worth nothing scores nothing',
    selected: ['a'],
    correct: ['a'],
    opts: { maxScore: 0, negativeScore: 0, partialCredit: true },
    expected: 0,
  },
];

describe('gradeMcq', () => {
  it.each(ROWS)('$label -> $expected', ({ selected, correct, opts, expected }) => {
    expect(gradeMcq(selected, correct, opts)).toBe(expected);
  });

  it('never scores below zero unless allowNegativeTotal is set', () => {
    for (const row of ROWS) {
      if (row.opts.allowNegativeTotal !== true) {
        expect(gradeMcq(row.selected, row.correct, row.opts)).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('never scores above maxScore', () => {
    for (const row of ROWS) {
      expect(gradeMcq(row.selected, row.correct, row.opts)).toBeLessThanOrEqual(row.opts.maxScore);
    }
  });

  it('is deterministic', () => {
    for (const row of ROWS) {
      expect(gradeMcq(row.selected, row.correct, row.opts)).toBe(
        gradeMcq(row.selected, row.correct, row.opts),
      );
    }
  });

  it('ignores the order options were selected in', () => {
    expect(gradeMcq(['c', 'a', 'b'], ['a', 'b', 'c'], partial)).toBe(
      gradeMcq(['a', 'b', 'c'], ['a', 'b', 'c'], partial),
    );
  });

  it('treats a repeated selection as one selection', () => {
    expect(gradeMcq(['a', 'a', 'a'], ['a', 'b', 'c'], partialNegative)).toBe(
      gradeMcq(['a'], ['a', 'b', 'c'], partialNegative),
    );
  });

  it('treats a repeated correct option as one correct option', () => {
    expect(gradeMcq(['a'], ['a', 'a'], partial)).toBe(9);
  });

  it('does not mutate its arguments', () => {
    const selected = ['a', 'b'];
    const correct = ['a', 'b', 'c'];
    gradeMcq(selected, correct, partialNegative);
    expect(selected).toStrictEqual(['a', 'b']);
    expect(correct).toStrictEqual(['a', 'b', 'c']);
  });

  it('rounds a thirds-based partial credit to a stable number', () => {
    const score = gradeMcq(['a'], ['a', 'b', 'c'], {
      maxScore: 10,
      negativeScore: 0,
      partialCredit: true,
    });
    expect(score).toBe(3.333333);
  });

  it('returns 0, not -0, when a penalty lands exactly on the floor', () => {
    const score = gradeMcq(['z'], ['a'], { maxScore: 10, negativeScore: 0, partialCredit: false });
    expect(Object.is(score, 0)).toBe(true);
  });

  it('throws when the question declares no correct option', () => {
    expect(() => gradeMcq(['a'], [], strict)).toThrow(RangeError);
  });

  it.each([
    { label: 'a negative maximum', opts: { maxScore: -1, negativeScore: 0, partialCredit: false } },
    {
      label: 'a NaN maximum',
      opts: { maxScore: Number.NaN, negativeScore: 0, partialCredit: false },
    },
    {
      label: 'a negative penalty',
      opts: { maxScore: 10, negativeScore: -1, partialCredit: false },
    },
    {
      label: 'an infinite penalty',
      opts: { maxScore: 10, negativeScore: Number.POSITIVE_INFINITY, partialCredit: true },
    },
  ])('throws on $label', ({ opts }) => {
    expect(() => gradeMcq(['a'], ['a'], opts)).toThrow(RangeError);
  });
});
