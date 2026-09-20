/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The authoring screen, and the one rule it exists to make legible.
 *
 * ADR-003 is enforced three times over — by a database trigger, by the API's `409
 * version_immutable`, and here. This suite is about the third: that an author looking at a
 * published version is told it is frozen *before* they type into it, and that the way forward is
 * offered in the same breath. A screen that let them edit and then showed them the 409 would
 * satisfy the invariant and fail the author.
 */

import { type AuthorQuestionView } from '@assaybank/contracts';
import { LiveRegionProvider } from '@assaybank/ui';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ApiProvider } from '../api/api.js';
import { ApiClient } from '../api/client.js';
import { QuestionEditor } from './QuestionEditor.js';

const QUESTION_ID = '00000000-0000-4000-8000-000000000001';
const VERSION_ID = '11111111-0000-4000-8000-000000000001';

/** A question whose current version is published or not, with the content its kind allows. */
function question(overrides: {
  kind?: string;
  status?: string;
  published?: boolean;
  options?: unknown[];
  testCases?: unknown[];
  answerKeys?: unknown[];
}): AuthorQuestionView {
  const published = overrides.published ?? false;
  return {
    id: QUESTION_ID,
    kind: overrides.kind ?? 'mcq_single',
    status: overrides.status ?? (published ? 'published' : 'draft'),
    external_ref: null,
    source_license: null,
    author_id: null,
    exposure_count: 0,
    archived_at: null,
    created_at: '2026-09-01T09:00:00.000Z',
    skills: [],
    current_version: {
      id: VERSION_ID,
      question_id: QUESTION_ID,
      version_no: 3,
      locale: 'en',
      prompt_md: 'Which index serves this query?',
      explanation_md: null,
      difficulty: 3,
      est_seconds: 300,
      max_score: 1,
      negative_score: 0,
      published_at: published ? '2026-09-02T09:00:00.000Z' : null,
      created_by: null,
      created_at: '2026-09-01T09:00:00.000Z',
      options: overrides.options ?? [],
      coding_spec: null,
      test_cases: overrides.testCases ?? [],
      answer_keys: overrides.answerKeys ?? [],
    },
  } as unknown as AuthorQuestionView;
}

function render(data: AuthorQuestionView): string {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(['question', QUESTION_ID], data);

  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <ApiProvider client={new ApiClient({ baseUrl: '/api/v1' })}>
        <LiveRegionProvider>
          <QuestionEditor questionId={QUESTION_ID} />
        </LiveRegionProvider>
      </ApiProvider>
    </QueryClientProvider>,
  );
}

/** React's static markup spells the attribute `readOnly`; the DOM spells it `readonly`. */
const READ_ONLY = /readonly=/iu;

const text = (markup: string): string =>
  markup
    .replace(/<[^>]*>/gu, ' ')
    .replace(/&#x27;/gu, "'")
    .replace(/&quot;/gu, '"')
    .replace(/&amp;/gu, '&')
    .replace(/\s+/gu, ' ');

describe('a published version', () => {
  const markup = render(question({ published: true }));

  it('says it is frozen, and says why, before the author types anything', () => {
    expect(text(markup)).toContain('Version 3 is published and frozen');
    expect(text(markup)).toContain('an attempt graded against it has to stay explainable');
  });

  it('offers the way forward in the same breath — the save writes a new version', () => {
    // Not "Save". An author who reads the button knows what it will do to the published
    // version before they press it.
    expect(text(markup)).toContain('Save as new version');
  });

  it('makes every content field read-only rather than letting the 409 teach the rule', () => {
    // `readonly`, not `disabled`: the text stays focusable, selectable and copyable, which is
    // what an author wants on a version they are reading rather than editing.
    expect(READ_ONLY.test(markup)).toBe(true);
    expect(markup).not.toContain('Publish…');
  });
});

describe('a draft version', () => {
  const markup = render(question({ published: false }));

  it('is editable and carries no frozen notice', () => {
    expect(text(markup)).not.toContain('published and frozen');
    expect(READ_ONLY.test(markup)).toBe(false);
  });

  it('offers review, not publish — the state machine refuses a draft (docs/03 §4)', () => {
    // Offering "Publish" here would offer an action the API answers with a 409, which the
    // author can do nothing about from this screen.
    expect(text(markup)).toContain('Send for review');
    expect(text(markup)).not.toContain('Publish…');
  });

  it('offers publish once the question is in review', () => {
    const inReview = render(question({ published: false, status: 'review' }));

    expect(text(inReview)).toContain('Publish…');
    expect(text(inReview)).not.toContain('Send for review');
  });
});

describe('content editors follow the kind', () => {
  it('gives a choice question options, and says how many may be correct', () => {
    const markup = render(
      question({
        kind: 'mcq_single',
        options: [
          {
            id: VERSION_ID,
            ordinal: 1,
            body_md: 'A hash index',
            is_correct: true,
            score_delta: null,
            rationale_md: null,
          },
        ],
      }),
    );

    expect(text(markup)).toContain('Options');
    expect(text(markup)).toContain('Exactly one option is correct');
    expect(markup).toContain('type="radio"');
  });

  it('gives a multi-answer question checkboxes instead, so the control says how many', () => {
    const markup = render(
      question({
        kind: 'mcq_multi',
        options: [
          {
            id: VERSION_ID,
            ordinal: 1,
            body_md: 'A',
            is_correct: true,
            score_delta: null,
            rationale_md: null,
          },
        ],
      }),
    );

    expect(text(markup)).toContain('At least one option is correct');
    expect(markup).not.toContain('type="radio"');
  });

  it('gives a coding question test cases, and states the hidden-case rule', () => {
    const markup = render(
      question({
        kind: 'coding',
        testCases: [
          {
            id: VERSION_ID,
            ordinal: 1,
            label: 'sample',
            stdin: '1',
            expected_stdout: '1',
            args: null,
            is_sample: true,
            weight: 1,
          },
        ],
      }),
    );

    expect(text(markup)).toContain('Test cases');
    // The reason, not just the rule: a question graded only on visible cases is passed by
    // printing the expected output.
    expect(text(markup)).toContain('printing the expected output');
    expect(text(markup)).toContain('1 case, 0 hidden');
  });

  it('gives a short-answer question its accepted answers', () => {
    const markup = render(
      question({
        kind: 'short_answer',
        answerKeys: [
          { id: VERSION_ID, match_type: 'exact', pattern: '42', tolerance: null, score: 1 },
        ],
      }),
    );

    expect(text(markup)).toContain('Accepted answers');
  });

  it('gives a written question none of them', () => {
    const markup = render(question({ kind: 'subjective' }));

    expect(text(markup)).not.toContain('Options');
    expect(text(markup)).not.toContain('Test cases');
    expect(text(markup)).not.toContain('Accepted answers');
  });
});

describe('empty content states guide rather than sit blank', () => {
  it('tells a choice question what it needs before it can be published', () => {
    const markup = render(question({ kind: 'mcq_single', options: [] }));

    expect(text(markup)).toContain('No options yet');
    expect(text(markup)).toContain('at least two options');
  });

  it('tells a coding question the same about hidden cases', () => {
    const markup = render(question({ kind: 'coding', testCases: [] }));

    expect(text(markup)).toContain('No test cases yet');
    expect(text(markup)).toContain('At least one must be hidden');
  });
});
