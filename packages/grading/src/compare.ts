/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Test-case and answer-key comparison.
 *
 * Comparison happens **here**, in the grading process, and never inside the sandbox
 * (ADR-002). The adapter runs code and returns stdout; the expectation never crosses
 * into the execution environment, so escaping the sandbox reveals nothing about a
 * hidden case.
 *
 * There is no model, no embedding, no edit distance and no "close enough" heuristic
 * anywhere in this file (ADR-011). Five declared modes, each a total function of
 * (expected, actual, options). If a mode cannot decide, it returns `passed: false` with
 * a reason — it never guesses.
 */

export type GradingMode = 'exact' | 'trimmed' | 'case_insensitive' | 'numeric_tolerance' | 'regex';

/** Every mode, so a table test can be exhaustive over the union. */
export const GRADING_MODES: readonly GradingMode[] = [
  'exact',
  'trimmed',
  'case_insensitive',
  'numeric_tolerance',
  'regex',
];

export type CompareOptions = {
  /** `numeric_tolerance`: absolute tolerance. Defaults to 1e-9. */
  readonly absoluteTolerance?: number;
  /** `numeric_tolerance`: tolerance relative to the larger magnitude. Defaults to 0. */
  readonly relativeTolerance?: number;
  /** `regex`: flags to compile the pattern with. Only `i`, `m`, `s` and `u` are allowed. */
  readonly regexFlags?: string;
};

/** Why a comparison came out the way it did. */
export type CaseOutcomeReason =
  | 'match'
  | 'mismatch'
  /** `numeric_tolerance`: the two sides had different token counts. */
  | 'length_mismatch'
  /** `numeric_tolerance`: a token on either side was not a number. */
  | 'not_a_number'
  /** `numeric_tolerance`: the configured tolerance was negative or non-finite. */
  | 'invalid_tolerance'
  /** `regex`: the pattern or its flags would not compile, or the pattern was too long. */
  | 'invalid_pattern';

/**
 * The verdict on one case.
 *
 * Deliberately carries neither the expectation nor the observed output. A `CaseOutcome`
 * is what a candidate-facing response is built from, and a type that cannot hold hidden
 * test-case content cannot leak it (FR-12).
 */
export type CaseOutcome = {
  readonly passed: boolean;
  readonly mode: GradingMode;
  readonly reason: CaseOutcomeReason;
};

/** Longer than any legitimate answer key, and a cheap ceiling on pathological patterns. */
const MAX_PATTERN_LENGTH = 4096;

const DEFAULT_ABSOLUTE_TOLERANCE = 1e-9;
const DEFAULT_RELATIVE_TOLERANCE = 0;

const ALLOWED_REGEX_FLAGS = new Set(['i', 'm', 's', 'u']);

function outcome(mode: GradingMode, reason: CaseOutcomeReason): CaseOutcome {
  return { passed: reason === 'match', mode, reason };
}

/**
 * Whitespace normalisation shared by `trimmed` and `case_insensitive`.
 *
 * Line endings collapse to `\n`, each line is trimmed at both ends, and leading and
 * trailing blank lines are dropped. Internal spacing inside a line is preserved, so
 * `"a  b"` and `"a b"` still differ — the mode forgives the formatting a terminal adds,
 * not the formatting the candidate chose.
 */
function normalise(text: string): string {
  return text
    .replace(/\r\n?/gu, '\n')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/^\n+/u, '')
    .replace(/\n+$/u, '');
}

function tokenise(text: string): string[] {
  const normalised = normalise(text).replace(/\s+/gu, ' ');
  return normalised.length === 0 ? [] : normalised.split(' ');
}

/** `undefined` when the token is not a number. `Number('')` is 0, hence the length guard. */
function parseNumber(token: string): number | undefined {
  if (token.length === 0) {
    return undefined;
  }
  const value = Number(token);
  return Number.isNaN(value) ? undefined : value;
}

function withinTolerance(
  expected: number,
  actual: number,
  absolute: number,
  relative: number,
): boolean {
  if (expected === actual) {
    // Covers matching infinities, and -0 against 0.
    return true;
  }
  if (!Number.isFinite(expected) || !Number.isFinite(actual)) {
    return false;
  }
  const difference = Math.abs(expected - actual);
  if (difference <= absolute) {
    return true;
  }
  if (relative > 0) {
    return difference <= relative * Math.max(Math.abs(expected), Math.abs(actual));
  }
  return false;
}

function compareNumeric(expected: string, actual: string, opts?: CompareOptions): CaseOutcome {
  const absolute = opts?.absoluteTolerance ?? DEFAULT_ABSOLUTE_TOLERANCE;
  const relative = opts?.relativeTolerance ?? DEFAULT_RELATIVE_TOLERANCE;

  if (!Number.isFinite(absolute) || absolute < 0 || !Number.isFinite(relative) || relative < 0) {
    return outcome('numeric_tolerance', 'invalid_tolerance');
  }

  const expectedTokens = tokenise(expected);
  const actualTokens = tokenise(actual);
  if (expectedTokens.length !== actualTokens.length) {
    return outcome('numeric_tolerance', 'length_mismatch');
  }

  for (const [index, expectedToken] of expectedTokens.entries()) {
    const actualToken = actualTokens[index];
    if (actualToken === undefined) {
      return outcome('numeric_tolerance', 'length_mismatch');
    }
    const expectedValue = parseNumber(expectedToken);
    const actualValue = parseNumber(actualToken);
    if (expectedValue === undefined || actualValue === undefined) {
      return outcome('numeric_tolerance', 'not_a_number');
    }
    if (!withinTolerance(expectedValue, actualValue, absolute, relative)) {
      return outcome('numeric_tolerance', 'mismatch');
    }
  }

  return outcome('numeric_tolerance', 'match');
}

function compareRegex(expected: string, actual: string, opts?: CompareOptions): CaseOutcome {
  const flags = opts?.regexFlags ?? '';

  if (expected.length === 0 || expected.length > MAX_PATTERN_LENGTH) {
    return outcome('regex', 'invalid_pattern');
  }
  // `g` and `y` are stateful through `lastIndex` and would make an identical re-grade
  // depend on call order. They are not allowed.
  const flagList = [...flags];
  if (new Set(flagList).size !== flagList.length) {
    return outcome('regex', 'invalid_pattern');
  }
  for (const flag of flagList) {
    if (!ALLOWED_REGEX_FLAGS.has(flag)) {
      return outcome('regex', 'invalid_pattern');
    }
  }

  let pattern: RegExp;
  try {
    // Anchored: the pattern describes the whole output, not a fragment of it. An
    // unanchored key would pass any answer that merely contained the right substring.
    pattern = new RegExp(`^(?:${expected})$`, flags);
  } catch {
    return outcome('regex', 'invalid_pattern');
  }

  return outcome('regex', pattern.test(normalise(actual)) ? 'match' : 'mismatch');
}

/**
 * Compares one expectation against one observed value.
 *
 * - `exact` — byte-for-byte string equality.
 * - `trimmed` — equality after whitespace normalisation (see `normalise`).
 * - `case_insensitive` — `trimmed`, then locale-independent case folding.
 * - `numeric_tolerance` — token-wise numeric equality within a tolerance.
 * - `regex` — the expectation is an anchored pattern matched against normalised output.
 *
 * Total: it never throws, for any input. A malformed pattern or tolerance comes back as
 * a failed outcome with a reason, because a grading worker that throws on one bad answer
 * key would leave a whole cohort ungraded.
 */
export function compareCase(
  mode: GradingMode,
  expected: string,
  actual: string,
  opts?: CompareOptions,
): CaseOutcome {
  switch (mode) {
    case 'exact':
      return outcome('exact', expected === actual ? 'match' : 'mismatch');

    case 'trimmed':
      return outcome('trimmed', normalise(expected) === normalise(actual) ? 'match' : 'mismatch');

    case 'case_insensitive':
      return outcome(
        'case_insensitive',
        normalise(expected).toLowerCase() === normalise(actual).toLowerCase()
          ? 'match'
          : 'mismatch',
      );

    case 'numeric_tolerance':
      return compareNumeric(expected, actual, opts);

    case 'regex':
      return compareRegex(expected, actual, opts);
  }
}
