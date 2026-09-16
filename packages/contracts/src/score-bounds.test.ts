/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';

import { hasAtMostTwoDecimals, MAX_SCORE_VALUE, QuestionVersionInputSchema } from './questions.js';

describe('score and weight bounds follow the numeric columns', () => {
  it('refuses 10000, which overflows numeric(6,2), and accepts 9999.99', () => {
    expect(QuestionVersionInputSchema.safeParse({ max_score: 10_000 }).success).toBe(false);
    expect(QuestionVersionInputSchema.safeParse({ max_score: MAX_SCORE_VALUE }).success).toBe(true);
  });

  it('refuses a third decimal place rather than letting PostgreSQL round it away', () => {
    expect(QuestionVersionInputSchema.safeParse({ max_score: 0.125 }).success).toBe(false);
    expect(
      QuestionVersionInputSchema.safeParse({
        test_cases: [{ stdin: '', weight: 1.005 }],
      }).success,
    ).toBe(false);
    expect(
      QuestionVersionInputSchema.safeParse({
        options: [{ body_md: 'a', score_delta: -0.25 }],
      }).success,
    ).toBe(true);
  });

  it('counts hundredths without being fooled by binary floating point', () => {
    for (const ok of [0.07, 0.29, 1.1, 2.35, 9999.99, -0.01, 0]) {
      expect(hasAtMostTwoDecimals(ok), String(ok)).toBe(true);
    }
    for (const bad of [0.001, 0.125, 1.005, 3.14159]) {
      expect(hasAtMostTwoDecimals(bad), String(bad)).toBe(false);
    }
  });
});
