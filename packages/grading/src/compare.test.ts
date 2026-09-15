/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';

import {
  compareCase,
  GRADING_MODES,
  type CaseOutcomeReason,
  type CompareOptions,
  type GradingMode,
} from './compare.js';

type Row = {
  readonly mode: GradingMode;
  readonly expected: string;
  readonly actual: string;
  readonly opts?: CompareOptions;
  readonly passed: boolean;
  readonly reason: CaseOutcomeReason;
};

const ROWS: readonly Row[] = [
  // --- exact ---------------------------------------------------------------
  { mode: 'exact', expected: '42', actual: '42', passed: true, reason: 'match' },
  { mode: 'exact', expected: '42', actual: '43', passed: false, reason: 'mismatch' },
  { mode: 'exact', expected: '42', actual: '42\n', passed: false, reason: 'mismatch' },
  { mode: 'exact', expected: '42', actual: ' 42', passed: false, reason: 'mismatch' },
  { mode: 'exact', expected: 'Yes', actual: 'yes', passed: false, reason: 'mismatch' },
  { mode: 'exact', expected: '', actual: '', passed: true, reason: 'match' },
  { mode: 'exact', expected: 'a\tb', actual: 'a\tb', passed: true, reason: 'match' },

  // --- trimmed -------------------------------------------------------------
  { mode: 'trimmed', expected: '42', actual: '42\n', passed: true, reason: 'match' },
  { mode: 'trimmed', expected: '42', actual: '  42  ', passed: true, reason: 'match' },
  { mode: 'trimmed', expected: '42', actual: '\n\n42\n\n', passed: true, reason: 'match' },
  { mode: 'trimmed', expected: 'a\nb', actual: 'a\r\nb', passed: true, reason: 'match' },
  { mode: 'trimmed', expected: 'a\nb', actual: 'a   \nb\t', passed: true, reason: 'match' },
  { mode: 'trimmed', expected: 'a\nb', actual: 'a\nb\n', passed: true, reason: 'match' },
  { mode: 'trimmed', expected: 'a b', actual: 'a  b', passed: false, reason: 'mismatch' },
  { mode: 'trimmed', expected: 'a\nb', actual: 'b\na', passed: false, reason: 'mismatch' },
  { mode: 'trimmed', expected: 'Yes', actual: 'yes', passed: false, reason: 'mismatch' },
  { mode: 'trimmed', expected: '   ', actual: '', passed: true, reason: 'match' },

  // --- case_insensitive ----------------------------------------------------
  { mode: 'case_insensitive', expected: 'Yes', actual: 'yes', passed: true, reason: 'match' },
  { mode: 'case_insensitive', expected: 'YES', actual: 'yEs\n', passed: true, reason: 'match' },
  {
    mode: 'case_insensitive',
    expected: 'SELECT',
    actual: ' select ',
    passed: true,
    reason: 'match',
  },
  { mode: 'case_insensitive', expected: 'yes', actual: 'no', passed: false, reason: 'mismatch' },
  { mode: 'case_insensitive', expected: 'a b', actual: 'A  B', passed: false, reason: 'mismatch' },

  // --- numeric_tolerance ---------------------------------------------------
  { mode: 'numeric_tolerance', expected: '42', actual: '42', passed: true, reason: 'match' },
  { mode: 'numeric_tolerance', expected: '42', actual: '42.0', passed: true, reason: 'match' },
  { mode: 'numeric_tolerance', expected: '42', actual: ' 42 \n', passed: true, reason: 'match' },
  {
    mode: 'numeric_tolerance',
    expected: '0.3',
    actual: '0.30000000000000004',
    passed: true,
    reason: 'match',
  },
  { mode: 'numeric_tolerance', expected: '1e3', actual: '1000', passed: true, reason: 'match' },
  { mode: 'numeric_tolerance', expected: '-0', actual: '0', passed: true, reason: 'match' },
  {
    mode: 'numeric_tolerance',
    expected: '42',
    actual: '42.001',
    passed: false,
    reason: 'mismatch',
  },
  {
    mode: 'numeric_tolerance',
    expected: '42',
    actual: '42.001',
    opts: { absoluteTolerance: 0.01 },
    passed: true,
    reason: 'match',
  },
  {
    mode: 'numeric_tolerance',
    expected: '1000000',
    actual: '1000001',
    opts: { relativeTolerance: 1e-5 },
    passed: true,
    reason: 'match',
  },
  {
    mode: 'numeric_tolerance',
    expected: '1000000',
    actual: '1010000',
    opts: { relativeTolerance: 1e-5 },
    passed: false,
    reason: 'mismatch',
  },
  { mode: 'numeric_tolerance', expected: '1 2 3', actual: '1 2 3', passed: true, reason: 'match' },
  {
    mode: 'numeric_tolerance',
    expected: '1 2 3',
    actual: '1  2\n3',
    passed: true,
    reason: 'match',
  },
  {
    mode: 'numeric_tolerance',
    expected: '1 2 3',
    actual: '1 2',
    passed: false,
    reason: 'length_mismatch',
  },
  {
    mode: 'numeric_tolerance',
    expected: '42',
    actual: 'forty-two',
    passed: false,
    reason: 'not_a_number',
  },
  {
    mode: 'numeric_tolerance',
    expected: 'NaN',
    actual: 'NaN',
    passed: false,
    reason: 'not_a_number',
  },
  { mode: 'numeric_tolerance', expected: '', actual: '', passed: true, reason: 'match' },
  {
    mode: 'numeric_tolerance',
    expected: '1',
    actual: '1',
    opts: { absoluteTolerance: -1 },
    passed: false,
    reason: 'invalid_tolerance',
  },
  {
    mode: 'numeric_tolerance',
    expected: '1',
    actual: '1',
    opts: { relativeTolerance: Number.NaN },
    passed: false,
    reason: 'invalid_tolerance',
  },
  {
    mode: 'numeric_tolerance',
    expected: 'Infinity',
    actual: 'Infinity',
    passed: true,
    reason: 'match',
  },
  {
    mode: 'numeric_tolerance',
    expected: 'Infinity',
    actual: '-Infinity',
    passed: false,
    reason: 'mismatch',
  },
  {
    mode: 'numeric_tolerance',
    expected: 'Infinity',
    actual: '1e308',
    opts: { absoluteTolerance: 1e300 },
    passed: false,
    reason: 'mismatch',
  },
  {
    mode: 'numeric_tolerance',
    expected: '1',
    actual: '1',
    // An infinite tolerance would pass everything, so it is not a usable tolerance.
    opts: { absoluteTolerance: Number.POSITIVE_INFINITY },
    passed: false,
    reason: 'invalid_tolerance',
  },

  // --- regex ---------------------------------------------------------------
  { mode: 'regex', expected: '\\d+', actual: '12345', passed: true, reason: 'match' },
  { mode: 'regex', expected: '\\d+', actual: '12a45', passed: false, reason: 'mismatch' },
  { mode: 'regex', expected: 'yes|no', actual: 'no', passed: true, reason: 'match' },
  // Anchored: a pattern must describe the whole answer, not a fragment of it.
  { mode: 'regex', expected: 'yes', actual: 'yes indeed', passed: false, reason: 'mismatch' },
  { mode: 'regex', expected: '.*', actual: 'anything', passed: true, reason: 'match' },
  { mode: 'regex', expected: '\\d+', actual: ' 42 \n', passed: true, reason: 'match' },
  {
    mode: 'regex',
    expected: 'YES',
    actual: 'yes',
    opts: { regexFlags: 'i' },
    passed: true,
    reason: 'match',
  },
  { mode: 'regex', expected: '[', actual: 'x', passed: false, reason: 'invalid_pattern' },
  { mode: 'regex', expected: '(', actual: 'x', passed: false, reason: 'invalid_pattern' },
  { mode: 'regex', expected: '', actual: '', passed: false, reason: 'invalid_pattern' },
  {
    mode: 'regex',
    expected: 'a',
    actual: 'a',
    opts: { regexFlags: 'g' },
    passed: false,
    reason: 'invalid_pattern',
  },
  {
    mode: 'regex',
    expected: 'a',
    actual: 'a',
    opts: { regexFlags: 'y' },
    passed: false,
    reason: 'invalid_pattern',
  },
  {
    mode: 'regex',
    expected: 'a',
    actual: 'a',
    opts: { regexFlags: 'ii' },
    passed: false,
    reason: 'invalid_pattern',
  },
  {
    mode: 'regex',
    expected: 'a',
    actual: 'a',
    opts: { regexFlags: 'z' },
    passed: false,
    reason: 'invalid_pattern',
  },
  {
    mode: 'regex',
    expected: `a${'b'.repeat(5000)}`,
    actual: 'a',
    passed: false,
    reason: 'invalid_pattern',
  },
];

describe('compareCase', () => {
  it.each(ROWS)(
    '$mode: $expected vs $actual -> $reason',
    ({ mode, expected, actual, opts, passed, reason }) => {
      const outcome = compareCase(mode, expected, actual, opts);
      expect(outcome).toStrictEqual({ passed, mode, reason });
    },
  );

  it('covers every declared mode', () => {
    const covered = new Set(ROWS.map((row) => row.mode));
    expect([...covered].sort()).toStrictEqual([...GRADING_MODES].sort());
  });

  it('reports passed exactly when the reason is match', () => {
    for (const row of ROWS) {
      const outcome = compareCase(row.mode, row.expected, row.actual, row.opts);
      expect(outcome.passed).toBe(outcome.reason === 'match');
    }
  });

  it('echoes back the mode it was asked for', () => {
    for (const mode of GRADING_MODES) {
      expect(compareCase(mode, 'x', 'x').mode).toBe(mode);
    }
  });

  it('is deterministic — the same inputs always give the same outcome', () => {
    for (const row of ROWS) {
      const first = compareCase(row.mode, row.expected, row.actual, row.opts);
      const second = compareCase(row.mode, row.expected, row.actual, row.opts);
      expect(first).toStrictEqual(second);
    }
  });

  it('never throws, for any mode and any input', () => {
    const nasty = ['', ' ', '\0', '\\', '(((', '\u{1F600}', 'a'.repeat(10_000)];
    for (const mode of GRADING_MODES) {
      for (const expected of nasty) {
        for (const actual of nasty) {
          expect(() => compareCase(mode, expected, actual)).not.toThrow();
        }
      }
    }
  });

  it('returns an outcome that cannot carry the expectation', () => {
    const outcome = compareCase('exact', 'the-hidden-expected-value', 'wrong');
    expect(JSON.stringify(outcome)).not.toContain('hidden');
    expect(Object.keys(outcome).sort()).toStrictEqual(['mode', 'passed', 'reason']);
  });

  it('does not use a stateful regex — repeated calls give the same answer', () => {
    for (let i = 0; i < 5; i += 1) {
      expect(compareCase('regex', '\\d+', '42').passed).toBe(true);
    }
  });

  it('handles floats without an epsilon dance at the call site', () => {
    const sum = String(0.1 + 0.2);
    expect(compareCase('numeric_tolerance', '0.3', sum).passed).toBe(true);
    expect(compareCase('exact', '0.3', sum).passed).toBe(false);
  });

  it('treats a tolerance of zero as exact numeric equality', () => {
    const opts: CompareOptions = { absoluteTolerance: 0 };
    expect(compareCase('numeric_tolerance', '1', '1.0', opts).passed).toBe(true);
    expect(compareCase('numeric_tolerance', '1', '1.0000001', opts).passed).toBe(false);
  });
});
