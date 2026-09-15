/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { type SkillId } from '@assaybank/contracts';
import { describe, expect, it } from 'vitest';

import { rollUpSkillScores, type QuestionSkillScore } from './skill-scores.js';

const skill = (name: string): SkillId => name as SkillId;

const PYTHON = skill('python');
const SQL = skill('sql');
const CONCURRENCY = skill('concurrency');

const NO_WEIGHTS: ReadonlyMap<SkillId, number> = new Map();

describe('rollUpSkillScores', () => {
  it('returns an empty map for no questions', () => {
    expect(rollUpSkillScores([], NO_WEIGHTS).size).toBe(0);
  });

  it('reports a full mark as 1', () => {
    const rolled = rollUpSkillScores([{ skillIds: [PYTHON], score: 10, maxScore: 10 }], NO_WEIGHTS);
    expect(rolled.get(PYTHON)).toBe(1);
  });

  it('reports a zero as 0 rather than omitting the skill', () => {
    const rolled = rollUpSkillScores([{ skillIds: [PYTHON], score: 0, maxScore: 10 }], NO_WEIGHTS);
    expect(rolled.get(PYTHON)).toBe(0);
    expect(rolled.has(PYTHON)).toBe(true);
  });

  it('sums marks across questions sharing a skill', () => {
    const perQuestion: QuestionSkillScore[] = [
      { skillIds: [PYTHON], score: 10, maxScore: 10 },
      { skillIds: [PYTHON], score: 5, maxScore: 10 },
    ];
    expect(rollUpSkillScores(perQuestion, NO_WEIGHTS).get(PYTHON)).toBe(0.75);
  });

  it('credits a multi-skill question to every one of its skills', () => {
    const rolled = rollUpSkillScores(
      [{ skillIds: [PYTHON, SQL], score: 4, maxScore: 8 }],
      NO_WEIGHTS,
    );
    expect(rolled.get(PYTHON)).toBe(0.5);
    expect(rolled.get(SQL)).toBe(0.5);
  });

  it('counts a repeated skill tag once per question', () => {
    const duplicated = rollUpSkillScores(
      [{ skillIds: [PYTHON, PYTHON], score: 3, maxScore: 10 }],
      NO_WEIGHTS,
    );
    const single = rollUpSkillScores([{ skillIds: [PYTHON], score: 3, maxScore: 10 }], NO_WEIGHTS);
    expect(duplicated.get(PYTHON)).toBe(single.get(PYTHON));
  });

  it('keeps skills independent of one another', () => {
    const rolled = rollUpSkillScores(
      [
        { skillIds: [PYTHON], score: 10, maxScore: 10 },
        { skillIds: [SQL], score: 0, maxScore: 10 },
        { skillIds: [CONCURRENCY], score: 7, maxScore: 10 },
      ],
      NO_WEIGHTS,
    );
    expect([...rolled.entries()].sort()).toStrictEqual([
      [CONCURRENCY, 0.7],
      [PYTHON, 1],
      [SQL, 0],
    ]);
  });

  it('applies per-skill weights', () => {
    // Weighting changes nothing when a skill has one question: it scales numerator and
    // denominator alike. It matters when the questions carrying a skill differ.
    const perQuestion: QuestionSkillScore[] = [
      { skillIds: [PYTHON], score: 10, maxScore: 10 },
      { skillIds: [PYTHON], score: 0, maxScore: 10 },
    ];
    expect(rollUpSkillScores(perQuestion, NO_WEIGHTS).get(PYTHON)).toBe(0.5);
  });

  it('weights a skill relative to the questions it appears in', () => {
    const perQuestion: QuestionSkillScore[] = [
      { skillIds: [PYTHON, SQL], score: 10, maxScore: 10 },
      { skillIds: [SQL], score: 0, maxScore: 30 },
    ];
    const weights = new Map<SkillId, number>([
      [PYTHON, 2],
      [SQL, 0.5],
    ]);
    const rolled = rollUpSkillScores(perQuestion, weights);
    // python: (2*10)/(2*10) = 1. sql: (0.5*10 + 0.5*0)/(0.5*10 + 0.5*30) = 5/20 = 0.25.
    expect(rolled.get(PYTHON)).toBe(1);
    expect(rolled.get(SQL)).toBe(0.25);
  });

  it('defaults an unweighted skill to weight 1', () => {
    const weights = new Map<SkillId, number>([[SQL, 3]]);
    const rolled = rollUpSkillScores([{ skillIds: [PYTHON], score: 2, maxScore: 8 }], weights);
    expect(rolled.get(PYTHON)).toBe(0.25);
  });

  it('omits a skill with no marks available rather than reporting it as zero', () => {
    const rolled = rollUpSkillScores([{ skillIds: [PYTHON], score: 0, maxScore: 0 }], NO_WEIGHTS);
    expect(rolled.has(PYTHON)).toBe(false);
  });

  it('omits a skill whose weight is zero', () => {
    const weights = new Map<SkillId, number>([[PYTHON, 0]]);
    const rolled = rollUpSkillScores([{ skillIds: [PYTHON], score: 5, maxScore: 10 }], weights);
    expect(rolled.has(PYTHON)).toBe(false);
  });

  it('does not surface floating-point noise', () => {
    const perQuestion: QuestionSkillScore[] = [
      { skillIds: [PYTHON], score: 0.1, maxScore: 1 },
      { skillIds: [PYTHON], score: 0.2, maxScore: 1 },
    ];
    expect(rollUpSkillScores(perQuestion, NO_WEIGHTS).get(PYTHON)).toBe(0.15);
  });

  it('is deterministic — a re-grade a year later gives the same number', () => {
    const perQuestion: QuestionSkillScore[] = [
      { skillIds: [PYTHON, SQL], score: 7, maxScore: 9 },
      { skillIds: [PYTHON], score: 1, maxScore: 3 },
    ];
    const weights = new Map<SkillId, number>([[PYTHON, 1.5]]);
    expect(rollUpSkillScores(perQuestion, weights)).toStrictEqual(
      rollUpSkillScores(perQuestion, weights),
    );
  });

  it('never returns a value outside [0, 1]', () => {
    const rolled = rollUpSkillScores(
      [
        { skillIds: [PYTHON], score: 0, maxScore: 10 },
        { skillIds: [PYTHON], score: 10, maxScore: 10 },
        { skillIds: [SQL], score: 10, maxScore: 10 },
      ],
      NO_WEIGHTS,
    );
    for (const value of rolled.values()) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });

  it.each([
    { label: 'a score above its own maximum', question: { score: 11, maxScore: 10 } },
    { label: 'a negative score', question: { score: -1, maxScore: 10 } },
    { label: 'a negative maximum', question: { score: 0, maxScore: -10 } },
    { label: 'a NaN score', question: { score: Number.NaN, maxScore: 10 } },
    { label: 'an infinite maximum', question: { score: 1, maxScore: Number.POSITIVE_INFINITY } },
  ])('throws on $label', ({ question }) => {
    expect(() => rollUpSkillScores([{ skillIds: [PYTHON], ...question }], NO_WEIGHTS)).toThrow(
      RangeError,
    );
  });

  it('throws on a negative weight', () => {
    const weights = new Map<SkillId, number>([[PYTHON, -1]]);
    expect(() =>
      rollUpSkillScores([{ skillIds: [PYTHON], score: 1, maxScore: 2 }], weights),
    ).toThrow(RangeError);
  });

  it('throws on a non-finite weight', () => {
    const weights = new Map<SkillId, number>([[PYTHON, Number.POSITIVE_INFINITY]]);
    expect(() =>
      rollUpSkillScores([{ skillIds: [PYTHON], score: 1, maxScore: 2 }], weights),
    ).toThrow(RangeError);
  });

  it('ignores a question with no skill tags', () => {
    const rolled = rollUpSkillScores([{ skillIds: [], score: 5, maxScore: 10 }], NO_WEIGHTS);
    expect(rolled.size).toBe(0);
  });
});
