/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The standing leak suite, seeded (P0 step 13).
 *
 * Its single job is to assert that nothing a candidate must not see can reach a
 * candidate-scoped response: answer keys, correct-answer flags, reference solutions,
 * hidden test-case content, other candidates, other organisations (FR-12, ADR-002).
 *
 * It starts here with the harness and one real assertion, because there is barely an
 * API yet. **It grows an assertion every time a candidate-facing response is added.**
 * That is the point of seeding it now rather than writing it in P4: "add the leak
 * assertion" becomes part of how a candidate-facing endpoint gets built, instead of a
 * retrofit after a near miss. Concretely, a pull request that adds a route under
 * `/attempt/*`, `/candidate/*` or the candidate SSE stream adds a case here that feeds
 * the real serialiser a row carrying every forbidden field and asserts the output is
 * clean.
 *
 * It runs as its own named CI job (`pnpm test:leak`, vitest project "leak") so a
 * failure is unambiguous in the pull request checks and cannot be mistaken for a
 * flaky integration test.
 */

import { describe, expect, it } from 'vitest';

import { FORBIDDEN_CANDIDATE_FIELDS, findForbiddenFields } from './forbidden-fields.js';

describe('candidate-scoped responses', () => {
  it('flags a forbidden field wherever it is nested in a payload', () => {
    // The shape a coding question would take if a handler returned the database row
    // instead of going through the typed serialiser — the habit docs/17 §12 names as
    // the one that eventually ships is_correct to a candidate.
    const unfilteredQuestion = {
      id: '0f1b8a1c-7f3e-4a2b-9c5d-1e2f3a4b5c6d',
      prompt_markdown: 'Reverse a linked list.',
      test_cases: [
        { label: 'sample 1', input: '1 2 3', expected_output: '3 2 1' },
        { label: 'hidden 1', input: '9 8 7', expected_output: '7 8 9' },
      ],
      reference_solution: 'def solve(xs): return xs[::-1]',
    };

    expect(findForbiddenFields(unfilteredQuestion)).toEqual([
      '$.test_cases[0].expected_output',
      '$.test_cases[1].expected_output',
      '$.reference_solution',
    ]);
  });

  it('passes a payload that carries only what a candidate may see', () => {
    // The same question after the candidate-facing serialiser. Hidden cases survive
    // as a label and a pass/fail only; the expectation never leaves the server.
    const candidateQuestion = {
      id: '0f1b8a1c-7f3e-4a2b-9c5d-1e2f3a4b5c6d',
      prompt_markdown: 'Reverse a linked list.',
      sample_cases: [{ label: 'sample 1', input: '1 2 3' }],
      hidden_case_count: 1,
      server_time: '2026-09-21T09:00:00Z',
    };

    expect(findForbiddenFields(candidateQuestion)).toEqual([]);
  });

  it('keeps the deny-list non-empty and frozen so it can only ever grow deliberately', () => {
    expect(FORBIDDEN_CANDIDATE_FIELDS.length).toBeGreaterThan(0);
    expect(Object.isFrozen(FORBIDDEN_CANDIDATE_FIELDS)).toBe(true);
  });
});
