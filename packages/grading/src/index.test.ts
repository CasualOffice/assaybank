/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';

import * as grading from './index.js';

describe('@assaybank/grading', () => {
  it('names itself with the workspace name declared in package.json', () => {
    expect(grading.WORKSPACE_NAME).toBe('@assaybank/grading');
  });

  it('exports the whole public surface through src/index.ts and nothing more', () => {
    expect(Object.keys(grading).sort()).toStrictEqual(
      [
        'GRADING_MODES',
        'WORKSPACE_NAME',
        'compareCase',
        'gradeMcq',
        'gradeShortAnswer',
        'scoreSubmission',
        'weightedTotal',
      ].sort(),
    );
  });

  it('declares exactly the five grading modes', () => {
    expect([...grading.GRADING_MODES]).toStrictEqual([
      'exact',
      'trimmed',
      'case_insensitive',
      'numeric_tolerance',
      'regex',
    ]);
  });

  it('grades an end-to-end coding question without touching anything outside its arguments', () => {
    // A three-case coding question, weighted, then folded into a two-section total.
    const cases = [
      grading.compareCase('trimmed', '6', '6\n'),
      grading.compareCase('numeric_tolerance', '2.5', '2.500001', {
        absoluteTolerance: 0.001,
      }),
      grading.compareCase('exact', 'done', 'DONE'),
    ];
    const coding = grading.scoreSubmission(cases, [2, 2, 1]);
    expect(coding).toBe(0.8);

    const mcq = grading.gradeMcq(['a', 'b'], ['a', 'b', 'c'], {
      maxScore: 1,
      negativeScore: 0,
      partialCredit: true,
    });
    expect(mcq).toBe(0.666667);

    expect(
      grading.weightedTotal([
        { score: coding, weight: 3 },
        { score: mcq, weight: 1 },
      ]),
    ).toBe(0.766667);
  });
});
