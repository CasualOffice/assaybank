/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';

import { gradeShortAnswer, type AnswerKey } from './short-answer.js';

const EXACT_KEY: AnswerKey = { mode: 'exact', expected: 'O(n log n)' };

describe('gradeShortAnswer', () => {
  it('awards the full mark on an exact match', () => {
    expect(gradeShortAnswer('O(n log n)', [EXACT_KEY], 5)).toBe(5);
  });

  it('awards nothing when no key matches', () => {
    expect(gradeShortAnswer('O(n^2)', [EXACT_KEY], 5)).toBe(0);
  });

  it('awards nothing when there are no keys at all', () => {
    expect(gradeShortAnswer('anything', [], 5)).toBe(0);
  });

  it('accepts a trimmed answer through a trimmed key', () => {
    const keys: AnswerKey[] = [{ mode: 'trimmed', expected: 'O(n log n)' }];
    expect(gradeShortAnswer('  O(n log n)\n', keys, 5)).toBe(5);
  });

  it('accepts any casing through a case-insensitive key', () => {
    const keys: AnswerKey[] = [{ mode: 'case_insensitive', expected: 'SELECT' }];
    expect(gradeShortAnswer('select', keys, 4)).toBe(4);
  });

  it('accepts a float through a numeric-tolerance key', () => {
    const keys: AnswerKey[] = [
      { mode: 'numeric_tolerance', expected: '3.14159', options: { absoluteTolerance: 0.001 } },
    ];
    expect(gradeShortAnswer('3.1416', keys, 2)).toBe(2);
    expect(gradeShortAnswer('3.2', keys, 2)).toBe(0);
  });

  it('accepts a pattern through a regex key', () => {
    const keys: AnswerKey[] = [
      { mode: 'regex', expected: '(?:12|twelve)', options: { regexFlags: 'i' } },
    ];
    expect(gradeShortAnswer('Twelve', keys, 3)).toBe(3);
    expect(gradeShortAnswer('thirteen', keys, 3)).toBe(0);
  });

  it('takes the first matching key, in the order the author wrote them', () => {
    const keys: AnswerKey[] = [
      { mode: 'exact', expected: 'partly right', score: 1 },
      { mode: 'case_insensitive', expected: 'PARTLY RIGHT', score: 4 },
    ];
    expect(gradeShortAnswer('partly right', keys, 5)).toBe(1);
  });

  it('lets an earlier key deliberately award nothing for a known near-miss', () => {
    const keys: AnswerKey[] = [
      { mode: 'exact', expected: 'nlogn', score: 0 },
      { mode: 'case_insensitive', expected: 'nlogn', score: 5 },
    ];
    expect(gradeShortAnswer('nlogn', keys, 5)).toBe(0);
    expect(gradeShortAnswer('NLOGN', keys, 5)).toBe(5);
  });

  it('awards a partial mark from a key that declares one', () => {
    const keys: AnswerKey[] = [
      { mode: 'exact', expected: 'quicksort', score: 5 },
      { mode: 'exact', expected: 'a sorting algorithm', score: 2 },
    ];
    expect(gradeShortAnswer('a sorting algorithm', keys, 5)).toBe(2);
  });

  it('caps a key score at the question maximum', () => {
    const keys: AnswerKey[] = [{ mode: 'exact', expected: 'x', score: 100 }];
    expect(gradeShortAnswer('x', keys, 5)).toBe(5);
  });

  it('never scores below zero', () => {
    const keys: AnswerKey[] = [{ mode: 'exact', expected: 'x', score: 0 }];
    expect(gradeShortAnswer('x', keys, 5)).toBe(0);
    expect(gradeShortAnswer('y', keys, 5)).toBe(0);
  });

  it('is deterministic — the re-grade a year later gives the same mark', () => {
    const keys: AnswerKey[] = [
      { mode: 'numeric_tolerance', expected: '2.5' },
      { mode: 'case_insensitive', expected: 'two point five' },
    ];
    for (const answer of ['2.50', 'TWO POINT FIVE', 'nope']) {
      expect(gradeShortAnswer(answer, keys, 3)).toBe(gradeShortAnswer(answer, keys, 3));
    }
  });

  it('does no fuzzy matching — a near miss is not a match (ADR-011)', () => {
    const keys: AnswerKey[] = [{ mode: 'exact', expected: 'quicksort' }];
    expect(gradeShortAnswer('quiksort', keys, 5)).toBe(0);
    expect(gradeShortAnswer('quick sort', keys, 5)).toBe(0);
    expect(gradeShortAnswer('QUICKSORT', keys, 5)).toBe(0);
  });

  it('skips a key whose pattern will not compile rather than throwing', () => {
    const keys: AnswerKey[] = [
      { mode: 'regex', expected: '[' },
      { mode: 'exact', expected: 'fallback' },
    ];
    expect(gradeShortAnswer('fallback', keys, 5)).toBe(5);
  });

  it('validates every key before evaluating any of them', () => {
    const keys: AnswerKey[] = [
      { mode: 'exact', expected: 'hit' },
      { mode: 'exact', expected: 'later', score: -1 },
    ];
    expect(() => gradeShortAnswer('hit', keys, 5)).toThrow(RangeError);
  });

  it.each([
    { label: 'a negative maximum', maxScore: -1 },
    { label: 'a NaN maximum', maxScore: Number.NaN },
    { label: 'an infinite maximum', maxScore: Number.POSITIVE_INFINITY },
  ])('throws on $label', ({ maxScore }) => {
    expect(() => gradeShortAnswer('x', [EXACT_KEY], maxScore)).toThrow(RangeError);
  });

  it('handles a zero-mark question', () => {
    expect(gradeShortAnswer('O(n log n)', [EXACT_KEY], 0)).toBe(0);
  });

  it('does not mutate the key list', () => {
    const keys: AnswerKey[] = [{ mode: 'exact', expected: 'x', score: 2 }];
    const snapshot = structuredClone(keys);
    gradeShortAnswer('x', keys, 5);
    expect(keys).toStrictEqual(snapshot);
  });
});
