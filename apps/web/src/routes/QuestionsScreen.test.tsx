/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The question bank screen's four states, and the wording that distinguishes two of them.
 *
 * Rendered with `react-dom/server` against a seeded query cache, for the reason
 * `vitest.config.ts` gives: jsdom is not an approved dependency, so a component test here
 * asserts the markup that crosses to the browser. That is the right level for these
 * particular claims anyway — every one of them is about what the HTML says.
 *
 * The state that matters most is the pair at the end. "You have no questions" and "no
 * questions match this filter" are different screens with different actions, and a screen
 * that shows the first to somebody whose filter is too narrow has answered a question they
 * did not ask.
 */

import { QUESTION_KINDS, QUESTION_STATUSES, type QuestionListResponse } from '@assaybank/contracts';
import { LiveRegionProvider } from '@assaybank/ui';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ApiClient } from '../api/client.js';
import { ApiProvider } from '../api/api.js';
import { questionsQueryKey, type QuestionFilters } from '../api/questions.js';
import { KIND_LABELS, STATUS_LABELS, STATUS_TONES } from './question-labels.js';
import { excerpt, QuestionsScreen } from './QuestionsScreen.js';

/** One summary row, with the fields the screen actually reads. */
function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    kind: 'coding',
    status: 'published',
    external_ref: null,
    source_license: null,
    exposure_count: 3,
    archived_at: null,
    created_at: '2026-09-01T09:00:00.000Z',
    current_version_id: '11111111-0000-4000-8000-000000000001',
    current_published_at: '2026-09-02T09:00:00.000Z',
    latest_version_no: 2,
    latest_difficulty: 4,
    latest_prompt_excerpt: 'Reverse a singly linked list.',
    ...overrides,
  };
}

/**
 * Renders the screen with the cache already holding `response` for `filters`.
 *
 * Seeding the cache rather than stubbing `fetch`: the query is then settled at first
 * render, which is what makes a server render show the settled state at all.
 */
function render(response: QuestionListResponse, filters: QuestionFilters = {}): string {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(questionsQueryKey(filters), response);

  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <ApiProvider client={new ApiClient({ baseUrl: '/api/v1' })}>
        <LiveRegionProvider>
          {/* Filters are the route's, not the screen's — which is what lets this render
              a filtered view with no router in the tree. */}
          <QuestionsScreen filters={filters} onFiltersChange={() => undefined} />
        </LiveRegionProvider>
      </ApiProvider>
    </QueryClientProvider>,
  );
}

const text = (markup: string): string =>
  markup
    .replace(/<[^>]*>/gu, ' ')
    .replace(/&#x27;/gu, "'")
    .replace(/&quot;/gu, '"')
    .replace(/&amp;/gu, '&')
    .replace(/\s+/gu, ' ');

describe('the populated state', () => {
  const markup = render({
    data: [
      row(),
      row({
        id: '00000000-0000-4000-8000-000000000002',
        kind: 'mcq_single',
        status: 'draft',
        current_published_at: null,
        latest_difficulty: 1,
        external_ref: 'mbpp/42',
        source_license: 'CC-BY-4.0',
        latest_prompt_excerpt: 'Which index is used?',
      }),
    ],
    next_cursor: null,
  } as unknown as QuestionListResponse);

  it('renders one row per question, in a real table with column headers', () => {
    expect(markup).toContain('<table');
    expect(markup).toContain('scope="col"');
    // The prompt is a row header, so a screen reader names the row by its prompt when
    // reading any cell in it.
    expect(markup).toContain('scope="row"');
    expect(text(markup)).toContain('Reverse a singly linked list.');
    expect(text(markup)).toContain('Which index is used?');
  });

  it('makes the prompt a link, so the row is reachable by keyboard and copyable', () => {
    // A clickable <tr> is invisible to the keyboard and to anything navigating by control.
    expect(markup).toContain('href="/questions/00000000-0000-4000-8000-000000000001"');
  });

  it('states the status as a word, never as a colour alone (SC 1.4.1)', () => {
    expect(text(markup)).toContain('Published');
    expect(text(markup)).toContain('Draft');
    // And names the column for the badge, which is read out of context.
    expect(text(markup)).toContain('Status:');
  });

  it('shows provenance only for imported content, which carries a licence obligation', () => {
    expect(text(markup)).toContain('mbpp/42');
    expect(text(markup)).toContain('CC-BY-4.0');
    // The other row was authored here: no id, no licence, no noise.
    expect(markup).not.toContain('00000000-0000-4000-8000-000000000001</span>');
  });

  it('says a question that was never published is not published, rather than leaving a gap', () => {
    // An empty cell reads as a rendering fault, and a screen reader says nothing for one.
    expect(text(markup)).toContain('Not published');
  });

  it('names the result count where the filters that produced it are', () => {
    expect(text(markup)).toContain('2 questions');
  });
});

describe('the two empty states', () => {
  const empty = { data: [], next_cursor: null } as unknown as QuestionListResponse;

  it('invites a first question when the bank itself is empty', () => {
    const markup = render(empty);

    expect(text(markup)).toContain('No questions yet');
    expect(text(markup)).toContain('New question');
    expect(text(markup)).toContain('Import a bank');
  });

  it('hides the filters when there is nothing to filter', () => {
    const markup = render(empty);

    // A row of filter controls over an empty bank invites the user to fiddle with filters
    // when what they need to do is write their first question.
    expect(markup).not.toContain('Filter questions');
    expect(text(markup)).not.toContain('0 questions');
  });

  it('asks a user whose filter matched nothing to widen it, and does not offer a new question', () => {
    const filters: QuestionFilters = { kind: 'coding' };
    const markup = render(empty, filters);

    expect(text(markup)).toContain('No questions match these filters');
    expect(text(markup)).toContain('Clear filters');
    // The filters stay, because changing them is the way out of this state.
    expect(markup).toContain('Filter questions');
  });

  it('keeps the two states distinguishable in the markup, not only in the words', () => {
    expect(render(empty)).toContain('ab-empty--empty');
    expect(render(empty, { status: 'retired' })).toContain('ab-empty--no-matches');
  });
});

describe('excerpt', () => {
  it('flattens markdown, because a table cell is a plain-text context', () => {
    expect(excerpt('Does `SELECT count(*)` **always** scan?')).toBe(
      'Does SELECT count(*) always scan?',
    );
  });

  it('collapses whitespace so a multi-line prompt is one line', () => {
    expect(excerpt('One\n\n  two   three')).toBe('One two three');
  });

  it('truncates at a word boundary rather than mid-word', () => {
    const long = `${'alpha '.repeat(40)}omega`;
    const result = excerpt(long);

    expect(result.endsWith('…')).toBe(true);
    expect(result).not.toContain('alph…');
    expect(result.length).toBeLessThanOrEqual(97);
  });

  it('names a question with no prompt rather than rendering an empty cell', () => {
    expect(excerpt(null)).toBe('Untitled question');
    expect(excerpt('   ')).toBe('Untitled question');
  });
});

describe('the label maps', () => {
  it('cover every kind and every status the contract defines', () => {
    // A kind added to the contract without a label here renders its database enum value to
    // a recruiter. The exhaustive Record type catches it at compile time; this catches it
    // if that type is ever loosened.
    for (const kind of QUESTION_KINDS) {
      expect(KIND_LABELS[kind], kind).toBeTruthy();
    }
    for (const status of QUESTION_STATUSES) {
      expect(STATUS_LABELS[status], status).toBeTruthy();
      expect(STATUS_TONES[status], status).toBeTruthy();
    }
  });

  it('reserves the success tone for published, the only status a candidate can be served', () => {
    expect(STATUS_TONES.published).toBe('success');
    // Retiring a question is ordinary bank maintenance (FR-4), not a failure.
    expect(STATUS_TONES.retired).toBe('warning');
  });
});
