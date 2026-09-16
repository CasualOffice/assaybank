/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The serialisation boundary, exercised over a record that carries every dangerous field
 * the schema defines.
 *
 * The fixture is the important part. It is not a plausible question — it is a coding
 * question that *also* has MCQ options with `is_correct` set, short-answer keys, a
 * reference solution, a custom checker, an explanation and twelve hidden test cases, all
 * at once. A per-kind fixture carrying only the fields that kind uses would prove that
 * the serialiser drops what it was never given, which is not the property under test.
 *
 * Every kind is then driven through {@link toCandidateView} by iterating
 * {@link QUESTION_KINDS} rather than by listing the ones somebody thought of, so a ninth
 * kind added to the enum fails here on the day it is added.
 */

import { describe, expect, it } from 'vitest';

import { findAnswerKeyFields } from './audience.js';
import {
  QuestionIdSchema,
  QuestionVersionIdSchema,
  SkillIdSchema,
  UserIdSchema,
} from './ids.js';
import {
  CHOICE_KINDS,
  CODE_KINDS,
  CandidateQuestionSchema,
  PROMPT_EXCERPT_LENGTH,
  PROSE_KINDS,
  QUESTION_KINDS,
  QUESTION_STATUSES,
  AuthorQuestionSchema,
  AuthorQuestionSummarySchema,
  toAuthorSummaryView,
  toAuthorVersionView,
  toAuthorView,
  toCandidateView,
  type QuestionKind,
  type QuestionRecord,
  type QuestionVersionRecord,
} from './questions.js';

const QUESTION_ID = QuestionIdSchema.parse('7c1a2b3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d');
const VERSION_ID = QuestionVersionIdSchema.parse('1b2c3d4e-5f60-4718-9a2b-3c4d5e6f7a8b');
const SKILL_ID = SkillIdSchema.parse('9a8b7c6d-5e4f-4302-b1a0-9f8e7d6c5b4a');
const AUTHOR_ID = UserIdSchema.parse('2f3e4d5c-6b7a-4980-9f1e-2d3c4b5a6978');

/** Injected, never the wall clock (docs/17 §8). */
const CREATED_AT = new Date('2026-10-20T09:00:00.000Z');
const PUBLISHED_AT = new Date('2026-10-21T11:30:00.000Z');

/**
 * One version carrying every field a candidate must never see, whatever its kind.
 *
 * Deliberately incoherent as a question. The serialiser is being asked to prove that it
 * *omits*, not that it was handed nothing to omit.
 */
function dangerousVersion(): QuestionVersionRecord {
  return {
    id: VERSION_ID,
    question_id: QUESTION_ID,
    version_no: 3,
    locale: 'en',
    prompt_md: 'Reverse a linked list in place.',
    explanation_md: 'The trick is to keep three pointers.',
    difficulty: 4,
    est_seconds: 900,
    max_score: 10,
    negative_score: 2.5,
    published_at: PUBLISHED_AT,
    created_by: AUTHOR_ID,
    created_at: CREATED_AT,
    options: [
      {
        id: 'aa11bb22-cc33-4d44-8e55-ff6677889900',
        ordinal: 1,
        body_md: 'Iteratively, with three pointers',
        is_correct: true,
        score_delta: 10,
        rationale_md: 'The intended answer.',
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
      solution_code: { python: 'def solve(head):\n    return reversed(head)\n' },
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
        stdin: '1 2 3',
        expected_stdout: '3 2 1',
        args: null,
        is_sample: true,
        weight: 0,
      },
      {
        id: 'dd44ee55-ff66-4077-b188-223344556677',
        ordinal: 2,
        label: 'hidden 1',
        stdin: '9 8 7',
        expected_stdout: '7 8 9',
        args: ['--fast'],
        is_sample: false,
        weight: 1,
      },
      {
        id: 'ee55ff66-0077-4188-9299-334455667788',
        ordinal: 3,
        label: 'hidden 2',
        stdin: '',
        expected_stdout: '',
        args: null,
        is_sample: false,
        weight: 1,
      },
    ],
    answer_keys: [
      {
        id: 'ff660077-1188-4299-83aa-445566778899',
        match_type: 'ci',
        pattern: 'sentinel-answer-key-pattern',
        tolerance: null,
        score: 10,
      },
    ],
  };
}

function dangerousQuestion(kind: QuestionKind): QuestionRecord {
  return {
    id: QUESTION_ID,
    kind,
    status: 'published',
    external_ref: 'lbpp/17',
    source_license: 'MIT',
    author_id: AUTHOR_ID,
    exposure_count: 41,
    archived_at: null,
    created_at: CREATED_AT,
    skills: [{ skill_id: SKILL_ID, weight: 1.5 }],
    current_version: dangerousVersion(),
  };
}

describe('the vocabulary', () => {
  it('names all eight kinds from the schema enum', () => {
    expect(QUESTION_KINDS).toEqual([
      'mcq_single',
      'mcq_multi',
      'true_false',
      'short_answer',
      'coding',
      'sql',
      'subjective',
      'system_design',
    ]);
  });

  it('partitions every kind into exactly one shape group, with nothing left over', () => {
    // The `toCandidateView` fall-through is `short_answer`, so the three groups plus that
    // one kind must account for the whole enum. A ninth kind added to the enum and to no
    // group would silently be served as a short answer; this is what notices.
    const grouped = [...CHOICE_KINDS, ...CODE_KINDS, ...PROSE_KINDS, 'short_answer'];
    expect([...grouped].sort()).toEqual([...QUESTION_KINDS].sort());
    expect(new Set(grouped).size).toBe(QUESTION_KINDS.length);
  });

  it('names the four lifecycle states in order', () => {
    expect(QUESTION_STATUSES).toEqual(['draft', 'review', 'published', 'retired']);
  });
});

describe('toAuthorView', () => {
  it('carries the answer key, because an author who cannot see it cannot author', () => {
    const view = toAuthorView(dangerousQuestion('coding'));
    const version = view.current_version;

    expect(version).not.toBeNull();
    expect(version?.options[0]?.is_correct).toBe(true);
    expect(version?.coding_spec?.solution_code).toEqual({
      python: 'def solve(head):\n    return reversed(head)\n',
    });
    expect(version?.test_cases[1]?.expected_stdout).toBe('7 8 9');
    expect(version?.answer_keys[0]?.pattern).toBe('sentinel-answer-key-pattern');
    expect(version?.explanation_md).toBe('The trick is to keep three pointers.');
  });

  it('serialises every instant as RFC 3339 UTC rather than as a Date', () => {
    const view = toAuthorView(dangerousQuestion('coding'));
    expect(view.created_at).toBe('2026-10-20T09:00:00.000Z');
    expect(view.current_version?.published_at).toBe('2026-10-21T11:30:00.000Z');
    expect(view.archived_at).toBeNull();
  });

  it('produces a value its own schema accepts', () => {
    expect(AuthorQuestionSchema.safeParse(toAuthorView(dangerousQuestion('mcq_single'))).success).toBe(
      true,
    );
  });

  it('serves a question that has no version yet as a null current_version', () => {
    const view = toAuthorView({ ...dangerousQuestion('coding'), current_version: null });
    expect(view.current_version).toBeNull();
  });

  it('copies the child collections rather than aliasing the record’s arrays', () => {
    const record = dangerousQuestion('coding');
    const view = toAuthorView(record);
    expect(view.current_version?.test_cases).not.toBe(record.current_version?.test_cases);
    expect(view.current_version?.coding_spec?.starter_code).not.toBe(
      record.current_version?.coding_spec?.starter_code,
    );
  });
});

describe('toAuthorSummaryView', () => {
  it('truncates a long prompt to an excerpt and marks it', () => {
    const prompt = 'x'.repeat(PROMPT_EXCERPT_LENGTH + 50);
    const summary = toAuthorSummaryView({
      id: QUESTION_ID,
      kind: 'coding',
      status: 'published',
      external_ref: null,
      source_license: 'MIT',
      exposure_count: 0,
      archived_at: null,
      created_at: CREATED_AT,
      current_version_id: VERSION_ID,
      current_published_at: PUBLISHED_AT,
      latest_version_no: 3,
      latest_difficulty: 4,
      latest_prompt_md: prompt,
    });

    expect(summary.latest_prompt_excerpt).toHaveLength(PROMPT_EXCERPT_LENGTH + 1);
    expect(summary.latest_prompt_excerpt?.endsWith('…')).toBe(true);
    expect(AuthorQuestionSummarySchema.safeParse(summary).success).toBe(true);
  });

  it('leaves a short prompt alone and a versionless question null throughout', () => {
    const summary = toAuthorSummaryView({
      id: QUESTION_ID,
      kind: 'subjective',
      status: 'draft',
      external_ref: null,
      source_license: null,
      exposure_count: 0,
      archived_at: null,
      created_at: CREATED_AT,
      current_version_id: null,
      current_published_at: null,
      latest_version_no: null,
      latest_difficulty: null,
      latest_prompt_md: null,
    });

    expect(summary.latest_prompt_excerpt).toBeNull();
    expect(summary.current_version_id).toBeNull();
  });

  it('counts an excerpt in characters, not code units, so an emoji is not split', () => {
    const summary = toAuthorSummaryView({
      id: QUESTION_ID,
      kind: 'coding',
      status: 'draft',
      external_ref: null,
      source_license: null,
      exposure_count: 0,
      archived_at: null,
      created_at: CREATED_AT,
      current_version_id: VERSION_ID,
      current_published_at: null,
      latest_version_no: 1,
      latest_difficulty: 1,
      latest_prompt_md: '🧪'.repeat(PROMPT_EXCERPT_LENGTH + 10),
    });

    expect([...(summary.latest_prompt_excerpt ?? '')]).toHaveLength(PROMPT_EXCERPT_LENGTH + 1);
    // A naive slice would cut a surrogate pair and leave a lone half, which renders as
    // the replacement character in every browser.
    expect(summary.latest_prompt_excerpt).not.toContain('�');
  });
});

describe('toCandidateView', () => {
  it.each(QUESTION_KINDS)('emits no answer-key field for a %s question', (kind) => {
    const record = dangerousQuestion(kind);
    const version = record.current_version;
    if (version === null) throw new Error('the fixture must carry a version');

    // Through JSON, because that is what crosses the boundary. A field that only exists
    // as a non-enumerable property or as `undefined` would be invisible on the wire, and
    // asserting on the object would be asserting about something else.
    const served: unknown = JSON.parse(JSON.stringify(toCandidateView(kind, version)));

    expect(findAnswerKeyFields(served)).toEqual([]);
  });

  it.each(QUESTION_KINDS)('emits nothing at all from test_cases for a %s question', (kind) => {
    const record = dangerousQuestion(kind);
    const version = record.current_version;
    if (version === null) throw new Error('the fixture must carry a version');

    const serialised = JSON.stringify(toCandidateView(kind, version));

    // Every literal in the fixture's test cases, sample and hidden alike. Counts cross
    // the boundary; content does not (see the module comment in questions.ts).
    for (const secret of ['1 2 3', '3 2 1', '9 8 7', '7 8 9', '--fast', 'sample 1', 'hidden 1']) {
      expect(serialised).not.toContain(secret);
    }
    // And the other three sources of an answer, by their content rather than their name.
    for (const secret of ['reversed(head)', 'out == expected', 'sentinel-answer-key-pattern']) {
      expect(serialised).not.toContain(secret);
    }
  });

  it.each(QUESTION_KINDS)('produces a value the candidate schema accepts for a %s question', (kind) => {
    const version = dangerousQuestion(kind).current_version;
    if (version === null) throw new Error('the fixture must carry a version');
    expect(CandidateQuestionSchema.safeParse(toCandidateView(kind, version)).success).toBe(true);
  });

  it.each(QUESTION_KINDS)('serves the version id and never the question id for a %s', (kind) => {
    const version = dangerousQuestion(kind).current_version;
    if (version === null) throw new Error('the fixture must carry a version');

    const served = toCandidateView(kind, version);
    expect(served.question_version_id).toBe(VERSION_ID);
    expect(JSON.stringify(served)).not.toContain(QUESTION_ID);
  });

  it.each(CHOICE_KINDS)('serves %s options with a body and an id, and nothing else', (kind) => {
    const version = dangerousQuestion(kind).current_version;
    if (version === null) throw new Error('the fixture must carry a version');

    const served = toCandidateView(kind, version);
    if (!('options' in served)) throw new Error(`${kind} should have been served as a choice`);

    expect(served.options).toEqual([
      { id: 'aa11bb22-cc33-4d44-8e55-ff6677889900', ordinal: 1, body_md: 'Iteratively, with three pointers' },
      { id: 'bb22cc33-dd44-4e55-9f66-001122334455', ordinal: 2, body_md: 'By sorting the list' },
    ]);
  });

  it.each(CODE_KINDS)('serves %s case counts rather than cases', (kind) => {
    const version = dangerousQuestion(kind).current_version;
    if (version === null) throw new Error('the fixture must carry a version');

    const served = toCandidateView(kind, version);
    if (!('coding' in served)) throw new Error(`${kind} should have been served as code`);

    expect(served.coding.sample_case_count).toBe(1);
    expect(served.coding.hidden_case_count).toBe(2);
    expect(served.coding.allowed_languages).toEqual(['python', 'go']);
    expect(served.coding.starter_code).toEqual({ python: 'def solve(head):\n    ...\n' });
    // The fixture SQL is the schema a SQL candidate queries, not an expectation.
    expect(served.coding.fixture_sql).toBe('CREATE TABLE nodes (id int);');
  });

  it('falls back to the schema’s own sandbox limits when a coding question has no spec', () => {
    const version = dangerousQuestion('coding').current_version;
    if (version === null) throw new Error('the fixture must carry a version');

    const served = toCandidateView('coding', { ...version, coding_spec: null });
    if (!('coding' in served)) throw new Error('coding should have been served as code');

    expect(served.coding.time_limit_ms).toBe(5000);
    expect(served.coding.memory_limit_kb).toBe(262_144);
    expect(served.coding.allowed_languages).toEqual([]);
  });

  it.each(PROSE_KINDS)('serves %s as prompt and scoring only', (kind) => {
    const version = dangerousQuestion(kind).current_version;
    if (version === null) throw new Error('the fixture must carry a version');

    expect(toCandidateView(kind, version)).toEqual({
      question_version_id: VERSION_ID,
      kind,
      prompt_md: 'Reverse a linked list in place.',
      est_seconds: 900,
      max_score: 10,
      negative_score: 2.5,
    });
  });

  it('serves a short answer as prompt and scoring only', () => {
    const version = dangerousQuestion('short_answer').current_version;
    if (version === null) throw new Error('the fixture must carry a version');

    expect(toCandidateView('short_answer', version)).toEqual({
      question_version_id: VERSION_ID,
      kind: 'short_answer',
      prompt_md: 'Reverse a linked list in place.',
      est_seconds: 900,
      max_score: 10,
      negative_score: 2.5,
    });
  });

  it.each(QUESTION_KINDS)('tells a candidate the cost of a wrong answer for a %s', (kind) => {
    const version = dangerousQuestion(kind).current_version;
    if (version === null) throw new Error('the fixture must carry a version');
    // Withholding negative marking is not security; it is a candidate guessing blind.
    expect(toCandidateView(kind, version).negative_score).toBe(2.5);
  });
});

describe('the two views are not the same value', () => {
  it('shares no structure, so widening one cannot widen the other', () => {
    const record = dangerousQuestion('coding');
    const version = record.current_version;
    if (version === null) throw new Error('the fixture must carry a version');

    const author = toAuthorVersionView(version);
    const candidate = toCandidateView('coding', version);

    expect(Object.keys(author)).toContain('answer_keys');
    expect(Object.keys(candidate)).not.toContain('answer_keys');
    // The one field both carry is the prompt, and it is the same prompt.
    expect(candidate.prompt_md).toBe(author.prompt_md);
  });
});
