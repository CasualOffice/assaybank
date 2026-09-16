/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The leak suite's first real question-bank assertions (P2 step 4, FR-12).
 *
 * `placeholder.test.ts` seeded the harness with a hand-written payload. This file drives
 * the *actual serialiser* — `toCandidateView` from `@assaybank/contracts` — over a record
 * carrying every answer-key field the schema defines, once per question kind, and asserts
 * that nothing which must not reach a candidate is in the result.
 *
 * The roadmap's phrasing for this phase:
 *
 * > Candidate-facing and author-facing serialisers are separate types, and the leak suite
 * > grows an assertion per kind: no `is_correct`, no reference solution, no hidden
 * > test-case content. This is the phase where that discipline is cheap to establish.
 *
 * ## Why this file exists when `packages/contracts` tests the same function
 *
 * Deliberate duplication, of the kind `candidate-scope.test.ts` already explains: the leak
 * suite is a separately named CI job (`pnpm test:leak`, docs/17 §8), so a failure here is
 * unambiguous in the pull-request checks and cannot be read as an incidental unit-test
 * break. This assertion is supposed to be hard to delete by accident.
 *
 * There is a second difference that is not duplication at all. This file asserts through
 * **two independent deny-lists** — the suite's own `forbidden-fields.ts`, which knows
 * nothing about `@assaybank/contracts`, and the contract package's `ANSWER_KEY_FIELDS` —
 * and it asserts that the first is a superset of the second. A serialiser author who adds
 * a field to the contract's list and forgets the suite's is caught; so is one who widens a
 * candidate type in a way the contract's compile-time predicate does not yet name.
 *
 * ## What the fixture is
 *
 * One version that is every kind at once: MCQ options with `is_correct` and rationales, a
 * coding spec with a reference solution and a custom checker, sample *and* hidden test
 * cases with their expectations, short-answer keys, and an explanation. It is not a
 * plausible question. A per-kind fixture carrying only the fields that kind uses would
 * prove that the serialiser drops what it was never given, which is not the property under
 * test.
 *
 * The imports are relative paths into the workspace sources rather than
 * `@assaybank/contracts`, because the leak suite is a root-level Vitest project and is not
 * itself a workspace with dependencies — and because reading the *source* means a stale
 * `dist/` cannot make this suite pass while the shipped code leaks.
 */

import { describe, expect, it } from 'vitest';

import {
  ANSWER_KEY_FIELDS,
  QUESTION_KINDS,
  QuestionIdSchema,
  QuestionVersionIdSchema,
  UserIdSchema,
  findAnswerKeyFields,
  toAuthorVersionView,
  toCandidateView,
  type QuestionKind,
  type QuestionVersionRecord,
} from '../../packages/contracts/src/index.js';
import { FORBIDDEN_CANDIDATE_FIELDS, findForbiddenFields } from './forbidden-fields.js';
import { findStaffShapedFields } from './staff-shaped-fields.js';

const QUESTION_ID = QuestionIdSchema.parse('7c1a2b3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d');
const VERSION_ID = QuestionVersionIdSchema.parse('1b2c3d4e-5f60-4718-9a2b-3c4d5e6f7a8b');
const AUTHOR_ID = UserIdSchema.parse('2f3e4d5c-6b7a-4980-9f1e-2d3c4b5a6978');

/** Injected, never the wall clock (ADR-006, docs/17 §8). */
const AT = new Date('2026-10-20T09:00:00.000Z');

/**
 * Every literal in the fixture that a candidate must never receive, whatever it is called.
 *
 * The field-name deny-lists catch a leak that kept its name. This catches one that was
 * renamed on the way out — a `hint` field that happens to contain the reference solution,
 * or an `examples` array built from the hidden cases. Asserting on the serialised string
 * is what makes the second kind visible.
 */
const SECRETS: readonly string[] = [
  'def solve(head): return reversed(head)',
  'assert out == expected',
  'The intended answer, which is the iterative one.',
  'A common distractor.',
  'Three pointers, and no extra allocation.',
  'sentinel-short-answer-pattern',
  'sample-case-stdin',
  'sample-case-expectation',
  'hidden-case-stdin',
  'hidden-case-expectation',
  'hidden-case-argument',
  'sample 1',
  'hidden 1',
];

/** One version carrying every dangerous field the schema defines, all at once. */
function dangerousVersion(): QuestionVersionRecord {
  return {
    id: VERSION_ID,
    question_id: QUESTION_ID,
    version_no: 4,
    locale: 'en',
    prompt_md: 'Reverse a linked list in place.',
    explanation_md: 'Three pointers, and no extra allocation.',
    difficulty: 4,
    est_seconds: 900,
    max_score: 10,
    negative_score: 2.5,
    published_at: AT,
    created_by: AUTHOR_ID,
    created_at: AT,
    options: [
      {
        id: 'aa11bb22-cc33-4d44-8e55-ff6677889900',
        ordinal: 1,
        body_md: 'Iteratively, with three pointers',
        is_correct: true,
        score_delta: 10,
        rationale_md: 'The intended answer, which is the iterative one.',
      },
      {
        id: 'bb22cc33-dd44-4e55-9f66-001122334455',
        ordinal: 2,
        body_md: 'By sorting the list',
        is_correct: false,
        score_delta: null,
        rationale_md: 'A common distractor.',
      },
    ],
    coding_spec: {
      allowed_languages: ['python', 'go'],
      starter_code: { python: 'def solve(head):\n    ...\n' },
      solution_code: { python: 'def solve(head): return reversed(head)' },
      time_limit_ms: 3000,
      memory_limit_kb: 131_072,
      grading_mode: 'custom_checker',
      checker_code: 'assert out == expected',
      fixture_sql: 'CREATE TABLE nodes (id int);',
    },
    test_cases: [
      {
        id: 'cc33dd44-ee55-4f66-a077-112233445566',
        ordinal: 1,
        label: 'sample 1',
        stdin: 'sample-case-stdin',
        expected_stdout: 'sample-case-expectation',
        args: null,
        is_sample: true,
        weight: 0,
      },
      {
        id: 'dd44ee55-ff66-4077-b188-223344556677',
        ordinal: 2,
        label: 'hidden 1',
        stdin: 'hidden-case-stdin',
        expected_stdout: 'hidden-case-expectation',
        args: ['hidden-case-argument'],
        is_sample: false,
        weight: 1,
      },
      {
        id: 'ee55ff66-0077-4188-9299-334455667788',
        ordinal: 3,
        label: 'hidden 2',
        stdin: 'hidden-case-stdin',
        expected_stdout: 'hidden-case-expectation',
        args: null,
        is_sample: false,
        weight: 1,
      },
    ],
    answer_keys: [
      {
        id: 'ff660077-1188-4299-83aa-445566778899',
        match_type: 'ci',
        pattern: 'sentinel-short-answer-pattern',
        tolerance: null,
        score: 10,
      },
    ],
  };
}

/** The payload as it would cross the wire: through JSON, which is what a client receives. */
function served(kind: QuestionKind): unknown {
  return JSON.parse(JSON.stringify(toCandidateView(kind, dangerousVersion()))) as unknown;
}

describe('a candidate-scoped question carries no answer key, for every kind', () => {
  it('has kinds to iterate, so the cases below are not vacuous', () => {
    // A guard against the silent pass: if `QUESTION_KINDS` were ever empty, every
    // assertion in this file would succeed while proving nothing.
    expect(QUESTION_KINDS.length).toBe(8);
  });

  it.each(QUESTION_KINDS)('%s — no forbidden field name, at any depth', (kind) => {
    expect(findForbiddenFields(served(kind))).toStrictEqual([]);
  });

  it.each(QUESTION_KINDS)('%s — nothing the contract itself calls an answer key', (kind) => {
    expect(findAnswerKeyFields(served(kind))).toStrictEqual([]);
  });

  it.each(QUESTION_KINDS)('%s — no staff-shaped field either', (kind) => {
    // FR-12's other two clauses: not another candidate, not another organisation, and not
    // the staff surface. A candidate view carrying `created_by` would name an employee to
    // somebody with no account.
    expect(findStaffShapedFields(served(kind))).toStrictEqual([]);
  });

  it.each(QUESTION_KINDS)('%s — none of the fixture’s secrets, under any name', (kind) => {
    // The field-name lists catch a leak that kept its name. This catches one that was
    // renamed on the way out, which is the shape a well-meaning refactor produces.
    const serialised = JSON.stringify(served(kind));
    for (const secret of SECRETS) {
      expect(serialised, `${kind} leaked ${secret}`).not.toContain(secret);
    }
  });

  it.each(QUESTION_KINDS)('%s — not even a sample test case', (kind) => {
    // Stricter than FR-12 requires, and deliberately so. The obvious design serves
    // `is_sample = true` rows and filters the rest, which makes the guarantee a `.filter()`
    // anybody could widen. Serving neither makes the candidate type structurally incapable
    // of carrying test-case content, and costs nothing: FR-11 runs a candidate's code
    // against the samples on the server, and worked examples belong in `prompt_md`.
    const serialised = JSON.stringify(served(kind));
    expect(serialised).not.toContain('sample-case');
    expect(serialised).not.toContain('hidden-case');
  });
});

describe('the author view is the other type, and it is not what a candidate gets', () => {
  it('carries the answer key, so the candidate assertions above are not testing an empty record', () => {
    // The control. If `toAuthorVersionView` were also clean, every assertion above would
    // be passing because the fixture is empty rather than because the serialiser works.
    const author = JSON.parse(JSON.stringify(toAuthorVersionView(dangerousVersion()))) as unknown;

    expect(findForbiddenFields(author).length).toBeGreaterThan(0);
    expect(findAnswerKeyFields(author).length).toBeGreaterThan(0);
    expect(JSON.stringify(author)).toContain('def solve(head): return reversed(head)');
    expect(JSON.stringify(author)).toContain('hidden-case-expectation');
  });

  it('is a different shape from the candidate view, not the same shape with fields removed', () => {
    const author = toAuthorVersionView(dangerousVersion());
    const candidate = toCandidateView('coding', dangerousVersion());

    // docs/17 §3: two types, never one type with a flag. Neither function takes an
    // audience parameter, and there is no third function that could take one.
    expect(Object.keys(author)).toContain('answer_keys');
    expect(Object.keys(author)).toContain('test_cases');
    expect(Object.keys(candidate)).not.toContain('answer_keys');
    expect(Object.keys(candidate)).not.toContain('test_cases');
    expect(Object.keys(candidate)).not.toContain('question_id');
  });
});

describe('the candidate still gets what they need to answer', () => {
  it('serves the prompt, the pacing and the cost of a wrong answer', () => {
    // A leak suite that only asserted absence would be satisfied by a serialiser that
    // returned `{}`, and nobody would notice until a candidate saw a blank screen.
    const view = toCandidateView('mcq_single', dangerousVersion());

    expect(view.prompt_md).toBe('Reverse a linked list in place.');
    expect(view.est_seconds).toBe(900);
    expect(view.max_score).toBe(10);
    expect(view.negative_score).toBe(2.5);
    expect(view.question_version_id).toBe(VERSION_ID);
  });

  it('serves the options to choose between, without saying which is right', () => {
    const view = toCandidateView('mcq_multi', dangerousVersion());
    expect('options' in view ? view.options : []).toStrictEqual([
      {
        id: 'aa11bb22-cc33-4d44-8e55-ff6677889900',
        ordinal: 1,
        body_md: 'Iteratively, with three pointers',
      },
      { id: 'bb22cc33-dd44-4e55-9f66-001122334455', ordinal: 2, body_md: 'By sorting the list' },
    ]);
  });

  it('serves the sandbox brief and case counts, so a coding runner can render', () => {
    const view = toCandidateView('coding', dangerousVersion());
    if (!('coding' in view)) throw new Error('coding should have been served as code');

    expect(view.coding.allowed_languages).toStrictEqual(['python', 'go']);
    expect(view.coding.starter_code).toStrictEqual({ python: 'def solve(head):\n    ...\n' });
    expect(view.coding.time_limit_ms).toBe(3000);
    // Counts, not content: "1 sample, 2 hidden" is what the runner has to say.
    expect(view.coding.sample_case_count).toBe(1);
    expect(view.coding.hidden_case_count).toBe(2);
  });

  it('serves the fixture schema for a SQL question, which is not an expectation', () => {
    // The one piece of the coding spec a candidate legitimately needs: the tables they are
    // querying. Withholding it would make the question unanswerable, and it says nothing
    // about what the answer is.
    const view = toCandidateView('sql', dangerousVersion());
    if (!('coding' in view)) throw new Error('sql should have been served as code');
    expect(view.coding.fixture_sql).toBe('CREATE TABLE nodes (id int);');
  });
});

describe('the two deny-lists agree', () => {
  it('keeps the suite’s list a superset of the contract package’s', () => {
    // Two independent lists, maintained in two packages, and this is what stops them
    // drifting: a name added to the contract's compile-time predicate and forgotten here
    // fails immediately, rather than leaving the standing suite quietly narrower than the
    // type system it is meant to back up.
    const suiteList = new Set(FORBIDDEN_CANDIDATE_FIELDS);
    const missing = ANSWER_KEY_FIELDS.filter((name) => !suiteList.has(name));

    expect(missing).toStrictEqual([]);
  });

  it('keeps both lists non-empty and frozen, so they can only grow deliberately', () => {
    expect(ANSWER_KEY_FIELDS.length).toBeGreaterThan(0);
    expect(FORBIDDEN_CANDIDATE_FIELDS.length).toBeGreaterThan(0);
    expect(Object.isFrozen(ANSWER_KEY_FIELDS)).toBe(true);
    expect(Object.isFrozen(FORBIDDEN_CANDIDATE_FIELDS)).toBe(true);
  });
});
