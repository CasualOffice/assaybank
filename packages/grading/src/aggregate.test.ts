/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';

import { compareCase } from './compare.js';
import { scoreSubmission, weightedTotal, type CaseResult } from './aggregate.js';

const pass: CaseResult = { passed: true };
const fail: CaseResult = { passed: false };

describe('scoreSubmission', () => {
  it.each([
    { label: 'all cases pass', results: [pass, pass, pass], weights: [1, 1, 1], expected: 1 },
    { label: 'no cases pass', results: [fail, fail, fail], weights: [1, 1, 1], expected: 0 },
    { label: 'half pass', results: [pass, fail], weights: [1, 1], expected: 0.5 },
    { label: 'one of three', results: [pass, fail, fail], weights: [1, 1, 1], expected: 0.333333 },
    {
      label: 'the heavy case carries the score',
      results: [pass, fail, fail],
      weights: [8, 1, 1],
      expected: 0.8,
    },
    {
      label: 'the heavy case is the one that failed',
      results: [fail, pass, pass],
      weights: [8, 1, 1],
      expected: 0.2,
    },
    { label: 'no cases at all', results: [], weights: [], expected: 0 },
    { label: 'every weight zero', results: [pass, pass], weights: [0, 0], expected: 0 },
    {
      label: 'a zero-weight case cannot earn anything',
      results: [pass, fail],
      weights: [0, 1],
      expected: 0,
    },
    {
      label: 'fractional weights',
      results: [pass, fail],
      weights: [0.25, 0.75],
      expected: 0.25,
    },
  ])('$label -> $expected', ({ results, weights, expected }) => {
    expect(scoreSubmission(results, weights)).toBe(expected);
  });

  it('always returns a value in [0, 1]', () => {
    expect(scoreSubmission([pass, fail, pass], [3, 5, 2])).toBeGreaterThanOrEqual(0);
    expect(scoreSubmission([pass, fail, pass], [3, 5, 2])).toBeLessThanOrEqual(1);
  });

  it('is deterministic — the defining property of a reproducible re-grade', () => {
    const results = [pass, fail, pass, pass, fail];
    const weights = [1, 2, 3, 1, 1];
    expect(scoreSubmission(results, weights)).toBe(scoreSubmission(results, weights));
  });

  it('accepts a CaseOutcome from compareCase directly', () => {
    const outcomes = [
      compareCase('trimmed', '42', '42\n'),
      compareCase('exact', '42', 'wrong'),
      compareCase('numeric_tolerance', '0.3', String(0.1 + 0.2)),
    ];
    expect(scoreSubmission(outcomes, [1, 1, 1])).toBe(0.666667);
  });

  it('throws when weights and results do not line up', () => {
    expect(() => scoreSubmission([pass, fail], [1])).toThrow(RangeError);
    expect(() => scoreSubmission([pass], [1, 1])).toThrow(RangeError);
  });

  it.each([
    { label: 'a negative weight', weights: [1, -1] },
    { label: 'a NaN weight', weights: [1, Number.NaN] },
    { label: 'an infinite weight', weights: [1, Number.POSITIVE_INFINITY] },
  ])('throws on $label', ({ weights }) => {
    expect(() => scoreSubmission([pass, pass], weights)).toThrow(RangeError);
  });

  it('does not mutate its arguments', () => {
    const results = [pass, fail];
    const weights = [1, 2];
    scoreSubmission(results, weights);
    expect(results).toStrictEqual([pass, fail]);
    expect(weights).toStrictEqual([1, 2]);
  });
});

describe('weightedTotal', () => {
  it.each([
    { label: 'no sections', sections: [], expected: 0 },
    { label: 'one section', sections: [{ score: 0.8, weight: 1 }], expected: 0.8 },
    {
      label: 'equal weights average',
      sections: [
        { score: 1, weight: 1 },
        { score: 0, weight: 1 },
      ],
      expected: 0.5,
    },
    {
      label: 'weights decide the mix',
      sections: [
        { score: 1, weight: 3 },
        { score: 0, weight: 1 },
      ],
      expected: 0.75,
    },
    {
      label: 'a zero-weight section contributes nothing',
      sections: [
        { score: 1, weight: 1 },
        { score: 0, weight: 0 },
      ],
      expected: 1,
    },
    {
      label: 'every weight zero',
      sections: [
        { score: 1, weight: 0 },
        { score: 0.5, weight: 0 },
      ],
      expected: 0,
    },
    {
      label: 'percentage-scaled sections stay on their own scale',
      sections: [
        { score: 90, weight: 2 },
        { score: 60, weight: 1 },
      ],
      expected: 80,
    },
    {
      label: 'a negatively marked section can pull a total down',
      sections: [
        { score: -2, weight: 1 },
        { score: 10, weight: 1 },
      ],
      expected: 4,
    },
  ])('$label -> $expected', ({ sections, expected }) => {
    expect(weightedTotal(sections)).toBe(expected);
  });

  it('is a mean, so adding an identical section changes nothing', () => {
    const one = weightedTotal([{ score: 0.6, weight: 1 }]);
    const two = weightedTotal([
      { score: 0.6, weight: 1 },
      { score: 0.6, weight: 1 },
    ]);
    expect(two).toBe(one);
  });

  it('does not surface floating-point noise', () => {
    expect(
      weightedTotal([
        { score: 0.1, weight: 1 },
        { score: 0.2, weight: 1 },
      ]),
    ).toBe(0.15);
  });

  it('is deterministic', () => {
    const sections = [
      { score: 0.81, weight: 2.5 },
      { score: 0.42, weight: 1.25 },
      { score: 1, weight: 0.25 },
    ];
    expect(weightedTotal(sections)).toBe(weightedTotal(sections));
  });

  it.each([
    { label: 'a negative weight', sections: [{ score: 1, weight: -1 }] },
    { label: 'a NaN weight', sections: [{ score: 1, weight: Number.NaN }] },
    { label: 'an infinite weight', sections: [{ score: 1, weight: Number.POSITIVE_INFINITY }] },
    { label: 'a NaN score', sections: [{ score: Number.NaN, weight: 1 }] },
    { label: 'an infinite score', sections: [{ score: Number.POSITIVE_INFINITY, weight: 1 }] },
  ])('throws on $label', ({ sections }) => {
    expect(() => weightedTotal(sections)).toThrow(RangeError);
  });

  it('does not mutate its argument', () => {
    const sections = [
      { score: 1, weight: 2 },
      { score: 0, weight: 1 },
    ];
    const snapshot = structuredClone(sections);
    weightedTotal(sections);
    expect(sections).toStrictEqual(snapshot);
  });
});
