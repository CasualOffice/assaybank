/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Copy-forward, proved without a database.
 *
 * ADR-003 makes every edit a new version, and copy-forward is what stops that invariant
 * from being paid for by the author. The property that matters is not "the merge works" —
 * it is that *nothing is lost*: a patch naming one field leaves a forty-option question
 * byte-identical apart from that field. So the central case here is a maximal prior
 * version put through a one-field patch, with the result compared against the prior in
 * full rather than field by field.
 *
 * Pure, so this runs in milliseconds with no container. That is the reason the merge lives
 * in its own module: the same behaviour tested through `createVersion` would need a
 * database, would be three assertions instead of twenty, and would be the first thing
 * somebody skipped.
 */

import { describe, expect, it } from 'vitest';

import {
  QuestionIdSchema,
  QuestionVersionIdSchema,
  UserIdSchema,
  type QuestionVersionInput,
  type QuestionVersionRecord,
} from '@assaybank/contracts';

import { mergeVersionContent, missingFirstVersionFields } from './version-content.js';

const QUESTION_ID = QuestionIdSchema.parse('7c1a2b3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d');
const VERSION_ID = QuestionVersionIdSchema.parse('1b2c3d4e-5f60-4718-9a2b-3c4d5e6f7a8b');
const AUTHOR_ID = UserIdSchema.parse('2f3e4d5c-6b7a-4980-9f1e-2d3c4b5a6978');
const AT = new Date('2026-10-20T09:00:00.000Z');

/** A version carrying something in every field a later version could inherit. */
function priorVersion(): QuestionVersionRecord {
  return {
    id: VERSION_ID,
    question_id: QUESTION_ID,
    version_no: 3,
    locale: 'en-GB',
    prompt_md: 'Reverse a linked list.',
    explanation_md: 'Three pointers.',
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
        body_md: 'Iteratively',
        is_correct: true,
        score_delta: 10,
        rationale_md: 'The intended answer.',
      },
      {
        id: 'bb22cc33-dd44-4e55-9f66-001122334455',
        ordinal: 2,
        body_md: 'By sorting',
        is_correct: false,
        score_delta: null,
        rationale_md: null,
      },
    ],
    coding_spec: {
      allowed_languages: ['python', 'go'],
      starter_code: { python: 'def solve(): ...' },
      solution_code: { python: 'def solve(): return 1' },
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
        label: 'sample',
        stdin: '1 2 3',
        expected_stdout: '3 2 1',
        args: null,
        assertion_code: null,
        is_sample: true,
        weight: 0,
      },
      {
        id: 'dd44ee55-ff66-4077-b188-223344556677',
        ordinal: 2,
        label: 'hidden',
        stdin: '9 8 7',
        expected_stdout: '7 8 9',
        args: ['--fast'],
        assertion_code: 'assert solve([9, 8, 7]) == [7, 8, 9]',
        is_sample: false,
        weight: 1.5,
      },
    ],
    answer_keys: [
      {
        id: 'ff660077-1188-4299-83aa-445566778899',
        match_type: 'ci',
        pattern: 'iteratively',
        tolerance: null,
        score: 10,
      },
    ],
  };
}

describe('missingFirstVersionFields', () => {
  it('names both required fields when a question has no version and the body has neither', () => {
    expect(missingFirstVersionFields(undefined, {})).toStrictEqual(['prompt_md', 'difficulty']);
  });

  it('names only what is actually missing', () => {
    expect(missingFirstVersionFields(undefined, { prompt_md: 'Why?' })).toStrictEqual([
      'difficulty',
    ]);
  });

  it('is satisfied by a complete first version', () => {
    expect(
      missingFirstVersionFields(undefined, { prompt_md: 'Why?', difficulty: 2 }),
    ).toStrictEqual([]);
  });

  it('requires nothing at all once there is a version to copy forward from', () => {
    expect(missingFirstVersionFields(priorVersion(), {})).toStrictEqual([]);
  });
});

describe('mergeVersionContent — the first version', () => {
  it('applies the schema’s own defaults for everything the body did not name', () => {
    expect(mergeVersionContent(undefined, { prompt_md: 'Why?', difficulty: 2 })).toStrictEqual({
      locale: 'en',
      promptMd: 'Why?',
      explanationMd: null,
      difficulty: 2,
      estSeconds: 120,
      maxScore: 1,
      negativeScore: 0,
      options: [],
      codingSpec: null,
      testCases: [],
      answerKeys: [],
    });
  });

  it('refuses to invent a prompt or a difficulty', () => {
    // A programmer error by this point: the caller is expected to have asked
    // `missingFirstVersionFields` and answered 422. It throws rather than returning a
    // value that would have to be checked at a second site and could be ignored at both.
    expect(() => mergeVersionContent(undefined, { difficulty: 2 })).toThrow(/prompt_md/u);
    expect(() => mergeVersionContent(undefined, { prompt_md: 'Why?' })).toThrow(/difficulty/u);
  });

  it('builds a coding spec over the schema defaults when the body names only one field', () => {
    const content = mergeVersionContent(undefined, {
      prompt_md: 'Reverse it.',
      difficulty: 3,
      coding_spec: { allowed_languages: ['python'] },
    });

    expect(content.codingSpec).toStrictEqual({
      allowedLanguages: ['python'],
      starterCode: {},
      solutionCode: {},
      timeLimitMs: 5000,
      memoryLimitKb: 262_144,
      gradingMode: 'test_cases',
      checkerCode: null,
      fixtureSql: null,
    });
  });
});

describe('mergeVersionContent — copying forward', () => {
  it('changes one field and leaves every other one byte-identical', () => {
    const prior = priorVersion();
    const untouched = mergeVersionContent(prior, {});
    const patched = mergeVersionContent(prior, { prompt_md: 'Reverse a singly linked list.' });

    expect(patched).toStrictEqual({ ...untouched, promptMd: 'Reverse a singly linked list.' });
  });

  it('carries every child collection across when the body names none of them', () => {
    const content = mergeVersionContent(priorVersion(), { difficulty: 5 });

    expect(content.options).toHaveLength(2);
    expect(content.options[0]).toStrictEqual({
      bodyMd: 'Iteratively',
      isCorrect: true,
      scoreDelta: 10,
      rationaleMd: 'The intended answer.',
    });
    expect(content.testCases).toHaveLength(2);
    expect(content.testCases[1]).toStrictEqual({
      label: 'hidden',
      stdin: '9 8 7',
      expectedStdout: '7 8 9',
      args: ['--fast'],
      assertionCode: 'assert solve([9, 8, 7]) == [7, 8, 9]',
      isSample: false,
      weight: 1.5,
    });
    expect(content.answerKeys).toHaveLength(1);
    expect(content.codingSpec?.solutionCode).toStrictEqual({ python: 'def solve(): return 1' });
  });

  it('carries the locale across, so an edit does not silently re-language a question', () => {
    expect(mergeVersionContent(priorVersion(), {}).locale).toBe('en-GB');
  });

  it('replaces a named collection wholesale rather than merging row by row', () => {
    const content = mergeVersionContent(priorVersion(), {
      options: [{ body_md: 'Only one now', is_correct: true }],
    });

    expect(content.options).toStrictEqual([
      { bodyMd: 'Only one now', isCorrect: true, scoreDelta: null, rationaleMd: null },
    ]);
    // And the other collections are untouched by that.
    expect(content.testCases).toHaveLength(2);
  });

  it('empties a collection when the body names it as empty', () => {
    // The distinction that makes "replace wholesale" usable: `[]` has to mean something
    // different from omitting the field, or an author could never delete the last option.
    expect(mergeVersionContent(priorVersion(), { options: [] }).options).toStrictEqual([]);
    expect(mergeVersionContent(priorVersion(), { test_cases: [] }).testCases).toStrictEqual([]);
  });

  it('merges the coding spec per field, because it is a row and not a collection', () => {
    const content = mergeVersionContent(priorVersion(), {
      coding_spec: { allowed_languages: ['python'], time_limit_ms: 10_000 },
    });

    expect(content.codingSpec).toStrictEqual({
      allowedLanguages: ['python'],
      // Raising a time limit must not mean restating the starter files and the solution.
      starterCode: { python: 'def solve(): ...' },
      solutionCode: { python: 'def solve(): return 1' },
      timeLimitMs: 10_000,
      memoryLimitKb: 131_072,
      gradingMode: 'custom_checker',
      checkerCode: 'assert out == expected',
      fixtureSql: 'CREATE TABLE nodes (id int);',
    });
  });

  it('removes the coding spec on an explicit null, and only on an explicit null', () => {
    expect(mergeVersionContent(priorVersion(), { coding_spec: null }).codingSpec).toBeNull();
    expect(mergeVersionContent(priorVersion(), {}).codingSpec).not.toBeNull();
  });

  it('tells null from absent for every nullable scalar', () => {
    // `??` would read a deliberate null as an absence and refuse to clear anything, which
    // is why the merge is written field by field rather than as a spread.
    expect(mergeVersionContent(priorVersion(), { explanation_md: null }).explanationMd).toBeNull();
    expect(mergeVersionContent(priorVersion(), {}).explanationMd).toBe('Three pointers.');
  });

  it('accepts a zero it would be easy to treat as absent', () => {
    // `negative_score: 0` is an author turning negative marking off. A `||` or a `??` over
    // a falsy check would silently keep the old 2.5 and change how candidates are scored.
    expect(mergeVersionContent(priorVersion(), { negative_score: 0 }).negativeScore).toBe(0);
    expect(mergeVersionContent(priorVersion(), { max_score: 0 }).maxScore).toBe(0);
  });

  it('refuses a difficulty outside the column’s CHECK rather than aborting a transaction', () => {
    const impossible = { ...priorVersion(), difficulty: 9 };
    expect(() => mergeVersionContent(impossible, {})).toThrow(/difficulty/u);
  });

  it('is a pure function of its arguments and mutates neither of them', () => {
    const prior = priorVersion();
    const snapshot = JSON.stringify(prior);
    const input: QuestionVersionInput = { options: [{ body_md: 'New', is_correct: false }] };

    mergeVersionContent(prior, input);

    expect(JSON.stringify(prior)).toBe(snapshot);
    expect(input).toStrictEqual({ options: [{ body_md: 'New', is_correct: false }] });
  });

  it('does not alias the prior version’s arrays into the new content', () => {
    // A shared array would make an edit to version 4 rewrite version 3 in memory, which
    // would be invisible until two versions were held at once.
    const prior = priorVersion();
    const content = mergeVersionContent(prior, {});
    expect(content.options).not.toBe(prior.options);
    expect(content.codingSpec?.starterCode).not.toBe(prior.coding_spec?.starter_code);
  });
});
