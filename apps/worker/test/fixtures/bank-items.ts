/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * One bank, used by the codec round trips and by the database round trip alike, so both prove
 * the same content survives.
 *
 * The text is chosen to break the formats between the database and a file: a carriage return
 * (normalised by any conforming XML parser), SOH and ESC (not representable in XML 1.0), CDATA
 * terminators, markup that must stay text, astral-plane characters, and whitespace at both ends.
 * It carries nothing PostgreSQL `text` cannot store — U+0000 and unpaired surrogates are refused by
 * `checkBankItem`, and that refusal has its own test.
 */

import { QUESTION_KINDS, type QuestionKind } from '@assaybank/contracts';

import type { BankItem, BankVersion } from '../../src/interchange/bank-item.js';

/** Built from char codes so no control character sits literally in this source file. */
const SOH = String.fromCharCode(1);
const ESC = String.fromCharCode(27);
const CR = String.fromCharCode(13);
export const NASTY = `  leading and trailing  ${CR}\nline two\ttab ]]> <script>&amp;</script> "q" 'a' é 🚀 ${SOH}${ESC}\n`;
export const MARKUP = '<div class="assaybank-prompt">not a real element</div> & &lt;';

export const EXACT = new Date('2026-10-20T09:00:00.000Z');

function version(overrides: Partial<BankVersion>): BankVersion {
  return {
    version_no: 1,
    published: true,
    locale: 'en',
    prompt_md: `Prompt ${MARKUP}`,
    explanation_md: null,
    difficulty: 3,
    est_seconds: 120,
    max_score: 1,
    negative_score: 0,
    options: [],
    coding_spec: null,
    test_cases: [],
    answer_keys: [],
    ...overrides,
  };
}

function item(
  kind: BankItem['kind'],
  versions: BankVersion[],
  extra: Partial<BankItem> = {},
): BankItem {
  return {
    ref: `q-${kind}`,
    kind,
    status: versions.some((v) => v.published) ? 'published' : 'draft',
    source_license: null,
    external_ref: null,
    skills: [],
    versions,
    ...extra,
  };
}

/** One valid item per kind, each carrying as much of what its kind allows as possible. */
export const FIXTURES: Record<QuestionKind, BankItem> = {
  mcq_single: item(
    'mcq_single',
    [
      version({
        version_no: 1,
        prompt_md: 'first draft of the prompt',
        options: [
          { body_md: 'a', is_correct: true, score_delta: null, rationale_md: null },
          { body_md: 'b', is_correct: false, score_delta: null, rationale_md: null },
        ],
      }),
      version({
        version_no: 2,
        prompt_md: NASTY,
        explanation_md: NASTY,
        max_score: 2.5,
        negative_score: 0.25,
        options: [
          { body_md: NASTY, is_correct: false, score_delta: -0.5, rationale_md: '' },
          { body_md: MARKUP, is_correct: true, score_delta: null, rationale_md: NASTY },
          { body_md: '  spaced  ', is_correct: false, score_delta: 0.25, rationale_md: null },
        ],
      }),
    ],
    {
      source_license: 'CC-BY-4.0',
      external_ref: 'mbpp/11',
      skills: [
        { key: 'python', weight: 2 },
        { key: 'sql.window-functions', weight: 0.5 },
      ],
    },
  ),
  mcq_multi: item('mcq_multi', [
    version({
      options: [
        { body_md: 'one', is_correct: true, score_delta: null, rationale_md: null },
        { body_md: 'two', is_correct: true, score_delta: null, rationale_md: 'why two' },
        { body_md: 'three', is_correct: false, score_delta: null, rationale_md: null },
      ],
    }),
  ]),
  true_false: item('true_false', [
    version({
      locale: 'pt-BR',
      options: [
        { body_md: 'Verdadeiro', is_correct: false, score_delta: null, rationale_md: null },
        { body_md: 'Falso', is_correct: true, score_delta: null, rationale_md: null },
      ],
    }),
  ]),
  short_answer: item('short_answer', [
    version({
      answer_keys: [
        { match_type: 'regex', pattern: '^\\s*42\\s*$', tolerance: null, score: 1 },
        { match_type: 'exact', pattern: 'Forty-two', tolerance: null, score: 1 },
        { match_type: 'ci', pattern: 'forty two', tolerance: null, score: 0.5 },
        // A duplicate pattern cannot be a second mapEntry, so it must travel in the extension.
        { match_type: 'ci', pattern: 'Forty-two', tolerance: null, score: 0.75 },
        { match_type: 'numeric_tolerance', pattern: '42', tolerance: 0.01, score: 1 },
        // Tab and newline would be normalised in an attribute.
        { match_type: 'exact', pattern: 'forty\ttwo\nlines', tolerance: null, score: 0.1 },
        { match_type: 'exact', pattern: `with${CR}return`, tolerance: null, score: 0.1 },
        { match_type: 'exact', pattern: ' "quoted" & <tagged> ', tolerance: null, score: 0.2 },
      ],
    }),
  ]),
  coding: item('coding', [
    version({
      coding_spec: {
        allowed_languages: ['python', 'javascript'],
        starter_code: { python: 'def solve(n):\n    pass\n', javascript: '' },
        solution_code: { python: `def solve(n):${CR}\n    return n * 2${SOH}` },
        time_limit_ms: 2000,
        memory_limit_kb: 131_072,
        grading_mode: 'custom_checker',
        checker_code: NASTY,
        fixture_sql: null,
      },
      test_cases: [
        {
          label: 'sample',
          stdin: '2\n',
          expected_stdout: '4\n',
          args: null,
          is_sample: true,
          weight: 1,
        },
        {
          label: null,
          stdin: NASTY,
          expected_stdout: `4${CR}\n`,
          args: [],
          is_sample: false,
          weight: 2.5,
        },
        {
          label: MARKUP,
          stdin: '',
          expected_stdout: null,
          args: ['', ' a ', NASTY],
          is_sample: false,
          weight: 0.5,
        },
      ],
    }),
  ]),
  sql: item('sql', [
    version({
      coding_spec: {
        allowed_languages: ['postgresql'],
        starter_code: {},
        solution_code: {},
        time_limit_ms: 5000,
        memory_limit_kb: 262_144,
        grading_mode: 'test_cases',
        checker_code: null,
        fixture_sql: 'CREATE TABLE t (id int);\nINSERT INTO t VALUES (1), (2);',
      },
      test_cases: [
        {
          label: 'rows',
          stdin: 'SELECT count(*) FROM t;',
          expected_stdout: '2',
          args: null,
          is_sample: false,
          weight: 1,
        },
      ],
    }),
  ]),
  subjective: item('subjective', [version({ published: false, est_seconds: 900, max_score: 10 })], {
    status: 'review',
  }),
  system_design: item('system_design', [
    version({ explanation_md: '', prompt_md: 'Design a rate limiter.' }),
  ]),
};

/** Every kind, in the contract's declared order. */
export const ALL: readonly BankItem[] = QUESTION_KINDS.map((kind) => FIXTURES[kind]);
