/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';

import type { QuestionKind } from '@assaybank/contracts';

import { QUESTION_KINDS } from './draw.js';
import { validateKindContent, type KindContentShape } from './kind-content.js';

const EMPTY: KindContentShape = {
  optionCount: 0,
  correctOptionCount: 0,
  hasCodingSpec: false,
  hasFixtureSql: false,
  testCaseCount: 0,
  hiddenTestCaseCount: 0,
  answerKeyCount: 0,
};

/** The minimal content that makes each kind publishable. */
const COMPLETE: Record<QuestionKind, KindContentShape> = {
  mcq_single: { ...EMPTY, optionCount: 4, correctOptionCount: 1 },
  mcq_multi: { ...EMPTY, optionCount: 4, correctOptionCount: 2 },
  true_false: { ...EMPTY, optionCount: 2, correctOptionCount: 1 },
  short_answer: { ...EMPTY, answerKeyCount: 1 },
  coding: { ...EMPTY, hasCodingSpec: true, testCaseCount: 3, hiddenTestCaseCount: 2 },
  sql: {
    ...EMPTY,
    hasCodingSpec: true,
    hasFixtureSql: true,
    testCaseCount: 1,
    hiddenTestCaseCount: 1,
  },
  subjective: EMPTY,
  system_design: EMPTY,
};

describe('validateKindContent', () => {
  it('covers every kind in the schema enum, so a new kind cannot go unchecked', () => {
    expect(Object.keys(COMPLETE).sort()).toEqual([...QUESTION_KINDS].sort());
  });

  describe.each(QUESTION_KINDS)('%s', (kind) => {
    it('accepts its complete content at publish', () => {
      expect(validateKindContent(kind, COMPLETE[kind], 'publish')).toEqual([]);
    });

    it('accepts empty content as a draft — nothing is wrong, only unfinished', () => {
      expect(validateKindContent(kind, EMPTY, 'draft')).toEqual([]);
    });
  });

  // Every (kind, field) pair where the field is foreign to the kind. Built from the kinds
  // rather than listed, so the table cannot drift from the rule.
  const foreign: Array<[QuestionKind, keyof KindContentShape, string]> = [];
  for (const kind of QUESTION_KINDS) {
    if (!['mcq_single', 'mcq_multi', 'true_false'].includes(kind)) {
      foreign.push([kind, 'optionCount', 'options']);
    }
    if (!['coding', 'sql'].includes(kind)) {
      foreign.push([kind, 'testCaseCount', 'test_cases']);
    }
    if (kind !== 'short_answer') {
      foreign.push([kind, 'answerKeyCount', 'answer_keys']);
    }
  }

  it.each(foreign)('%s refuses %s as wrong_kind, even in a draft', (kind, key, field) => {
    const shape: KindContentShape = { ...COMPLETE[kind], [key]: 2 };
    const issues = validateKindContent(kind, shape, 'draft');
    expect(issues).toContainEqual(expect.objectContaining({ severity: 'wrong_kind', field }));
  });

  it('refuses a coding_spec on a non-code kind in a draft', () => {
    for (const kind of ['mcq_single', 'short_answer', 'subjective'] as const) {
      const issues = validateKindContent(kind, { ...EMPTY, hasCodingSpec: true }, 'draft');
      expect(issues).toContainEqual(
        expect.objectContaining({ severity: 'wrong_kind', field: 'coding_spec' }),
      );
    }
  });

  it('refuses fixture_sql on a coding question, which would leak unused content to candidates', () => {
    const issues = validateKindContent(
      'coding',
      { ...COMPLETE.coding, hasFixtureSql: true },
      'draft',
    );
    expect(issues).toContainEqual(expect.objectContaining({ field: 'coding_spec' }));
  });

  describe('publish', () => {
    it('refuses a coding question whose only cases are samples — a visible case can be hardcoded', () => {
      const issues = validateKindContent(
        'coding',
        { ...COMPLETE.coding, testCaseCount: 3, hiddenTestCaseCount: 0 },
        'publish',
      );
      expect(issues).toContainEqual(
        expect.objectContaining({ severity: 'incomplete', field: 'test_cases' }),
      );
    });

    it('refuses a unit-test question with a case that has no assertion (ADR-024)', () => {
      // The assertion *is* the case in this mode. A row without one is a case the harness
      // cannot run, and an unrunnable case scores a silent zero for every candidate rather
      // than failing loudly — which is the failure nobody notices until a dispute.
      const issues = validateKindContent(
        'coding',
        { ...COMPLETE.coding, gradingMode: 'unit_tests', casesWithoutAssertion: 1 },
        'publish',
      );

      expect(issues).toContainEqual(
        expect.objectContaining({ severity: 'incomplete', field: 'test_cases' }),
      );
    });

    it('accepts a unit-test question whose every case carries one', () => {
      const issues = validateKindContent(
        'coding',
        { ...COMPLETE.coding, gradingMode: 'unit_tests', casesWithoutAssertion: 0 },
        'publish',
      );

      expect(issues).toEqual([]);
    });

    it('does not ask for an assertion in the mode that has no use for one', () => {
      // A stdin/stdout question has no assertion_code by design, and demanding one would
      // make every coding question already in the bank unpublishable.
      const issues = validateKindContent(
        'coding',
        { ...COMPLETE.coding, gradingMode: 'test_cases', casesWithoutAssertion: 3 },
        'publish',
      );

      expect(issues).toEqual([]);
    });

    it('says nothing at draft, because an author saves before the tests are written', () => {
      const issues = validateKindContent(
        'coding',
        { ...COMPLETE.coding, gradingMode: 'unit_tests', casesWithoutAssertion: 3 },
        'draft',
      );

      expect(issues).toEqual([]);
    });

    it('refuses an sql question with no fixture database', () => {
      const issues = validateKindContent(
        'sql',
        { ...COMPLETE.sql, hasFixtureSql: false },
        'publish',
      );
      expect(issues).toContainEqual(expect.objectContaining({ field: 'coding_spec' }));
    });

    it('refuses a single-answer question with two correct options', () => {
      const issues = validateKindContent(
        'mcq_single',
        { ...COMPLETE.mcq_single, correctOptionCount: 2 },
        'publish',
      );
      expect(issues).toContainEqual(expect.objectContaining({ field: 'options' }));
    });

    it('refuses a true_false question with three options', () => {
      const issues = validateKindContent(
        'true_false',
        { ...COMPLETE.true_false, optionCount: 3 },
        'publish',
      );
      expect(issues).toContainEqual(expect.objectContaining({ field: 'options' }));
    });

    it('refuses a short_answer question with no key, which could never be graded', () => {
      expect(validateKindContent('short_answer', EMPTY, 'publish')).toContainEqual(
        expect.objectContaining({ field: 'answer_keys' }),
      );
    });

    it('reports every problem at once rather than the first', () => {
      const issues = validateKindContent('sql', EMPTY, 'publish');
      // no spec, no hidden case, no fixture
      expect(issues.length).toBeGreaterThanOrEqual(3);
    });
  });

  it('does not report incomplete problems in a draft — mid-authoring is not an error', () => {
    for (const kind of QUESTION_KINDS) {
      const issues = validateKindContent(kind, EMPTY, 'draft');
      expect(issues.filter((i) => i.severity === 'incomplete')).toEqual([]);
    }
  });
});
