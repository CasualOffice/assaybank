/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The deny-list the standing leak suite is built around (FR-12, docs/17 §5).
 *
 * These are field names that must never appear anywhere inside a candidate-scoped
 * response body, at any depth, in any casing convention the serialisation layer
 * happens to use. The list is deliberately field names rather than types: the suite
 * runs against real serialiser output, and a type that has been widened by accident
 * still produces a field with one of these names.
 *
 * Adding a name here is cheap. Removing one requires an argument about why a
 * candidate may now see it.
 */
export const FORBIDDEN_CANDIDATE_FIELDS: readonly string[] = Object.freeze([
  'is_correct',
  'isCorrect',
  'correct_option_ids',
  'correctOptionIds',
  'answer_key',
  'answerKey',
  'reference_solution',
  'referenceSolution',
  'expected_output',
  'expectedOutput',
  'expected_stdout',
  'expectedStdout',
  /** `test_cases.assertion_code` — the unit test itself, which names the expected value (ADR-024). */
  'assertion_code',
  'assertionCode',
  'hidden_cases',
  'hiddenCases',
  'test_case_expected',
  'testCaseExpected',
  'grading_notes',
  'gradingNotes',
  'rubric_internal',
  'rubricInternal',
  'integrity_verdict',
  'integrityVerdict',

  // --- P2: the question bank's own answer-key columns -----------------------
  //
  // Added with the question-bank serialisers (P2 step 4). Each is a column
  // `packages/db/src/schema/question-bank.ts` marks as answer-key material, in both the
  // snake_case the wire uses and the camelCase a Drizzle row carries — a serialiser that
  // forwarded a row object rather than building a view would leak the camel spelling, so
  // both are refused.
  //
  // `question-bank.test.ts` asserts that this list stays a superset of the contract
  // package's own `ANSWER_KEY_FIELDS`, which is what keeps the two from drifting: a name
  // added to the compile-time predicate and forgotten here would leave the standing suite
  // quietly narrower than the type system it exists to back up.
  'answer_keys',
  'answerKeys',
  /** `mcq_options.score_delta` — the credit an option carries, which names the right one. */
  'score_delta',
  'scoreDelta',
  /** `mcq_options.rationale_md` — why an option is right or wrong. */
  'rationale_md',
  'rationaleMd',
  /** `coding_specs.solution_code` — the reference solution. Never leaves the server. */
  'solution_code',
  'solutionCode',
  /** `coding_specs.checker_code` — a custom checker reveals the shape of the answer. */
  'checker_code',
  'checkerCode',
  // The whole of a `short_answer_keys` row. `pattern` and `tolerance` are generic words,
  // and banning them costs a candidate-facing type the right to use them for something
  // innocent. That is the correct trade: the innocent use can be renamed, and an answer
  // key reaching a candidate cannot be taken back.
  'match_type',
  'matchType',
  'pattern',
  'tolerance',
  /** `question_versions.explanation_md` — the worked answer, written for the review screen. */
  'explanation_md',
  'explanationMd',
]);

const FORBIDDEN = new Set(FORBIDDEN_CANDIDATE_FIELDS);

/**
 * Walks an already-serialised payload and returns the dotted path of every forbidden
 * field it carries. An empty array means the payload is clean.
 *
 * The payload is `unknown` because that is what it is: the suite is asserting on the
 * shape that actually crossed the boundary, not on the shape the handler claimed to
 * return. Filtering in the client is explicitly not a defence — by then the data has
 * already left the server (docs/17 §12).
 */
export function findForbiddenFields(payload: unknown, path = '$'): string[] {
  if (Array.isArray(payload)) {
    return payload.flatMap((entry, index) => findForbiddenFields(entry, `${path}[${index}]`));
  }

  if (typeof payload !== 'object' || payload === null) {
    return [];
  }

  const found: string[] = [];

  for (const [key, value] of Object.entries(payload)) {
    const here = `${path}.${key}`;
    if (FORBIDDEN.has(key)) {
      found.push(here);
    }
    found.push(...findForbiddenFields(value, here));
  }

  return found;
}
