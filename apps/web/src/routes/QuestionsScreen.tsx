/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The question bank: the console's first real screen.
 *
 * ## The shape of a list screen
 *
 * Page header, filter toolbar, table, pager — in that order, and the same order on every
 * index screen the console grows. The consistency is the feature: a recruiter who has
 * learned where the filters are on this screen has learned it for candidates and
 * assessments too.
 *
 * ## Four states, written on purpose
 *
 * Loading, error, empty and populated are four screens, not one screen with things
 * missing. The two empty cases are also different from each other — a bank with nothing in
 * it wants "write your first question", and a filter that matched nothing wants "widen the
 * filter" — and offering the wrong one is an answer to a question the user did not ask.
 *
 * ## Why the row is a link and not an `onClick`
 *
 * A clickable `<tr>` is invisible to the keyboard and to anything that navigates by
 * control. The first cell holds a real anchor: it is tabbable, it has a href a user can
 * copy or open in a new tab, and the rest of the row is a hit area the mouse can use.
 */

import {
  MAX_DIFFICULTY,
  MIN_DIFFICULTY,
  QUESTION_KINDS,
  QUESTION_STATUSES,
  type AuthorQuestionSummaryView,
  type QuestionKind,
  type QuestionStatus,
} from '@assaybank/contracts';
import {
  Alert,
  Badge,
  Button,
  EmptyState,
  Field,
  Input,
  Select,
  Skeleton,
  Table,
  Toolbar,
  useAnnounce,
  type BadgeTone,
} from '@assaybank/ui';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useId, useRef, type ReactNode } from 'react';

import { useApi } from '../api/api.js';
import { hasActiveFilters, questionsQuery, type QuestionFilters } from '../api/questions.js';
import { toDisplayEnvelope } from '../app/ErrorBoundary.js';

/** Human wording for a kind. The enum value is a database label, not a word for a screen. */
export const KIND_LABELS: Readonly<Record<QuestionKind, string>> = {
  mcq_single: 'Multiple choice',
  mcq_multi: 'Multiple answer',
  true_false: 'True / false',
  short_answer: 'Short answer',
  coding: 'Coding',
  sql: 'SQL',
  subjective: 'Written',
  system_design: 'System design',
};

export const STATUS_LABELS: Readonly<Record<QuestionStatus, string>> = {
  draft: 'Draft',
  review: 'In review',
  published: 'Published',
  retired: 'Retired',
};

/**
 * Colour repeats the word; it never replaces it (SC 1.4.1).
 *
 * `published` is the only success: a published question is the only one a candidate can be
 * served. `retired` is a warning rather than a danger — withdrawing a question is a normal
 * act of bank maintenance (FR-4), not a failure.
 */
export const STATUS_TONES: Readonly<Record<QuestionStatus, BadgeTone>> = {
  draft: 'neutral',
  review: 'info',
  published: 'success',
  retired: 'warning',
};

/** The difficulty band, as a word. A bare "4" means nothing without the scale beside it. */
const DIFFICULTY_LABELS: Readonly<Record<number, string>> = {
  1: 'Introductory',
  2: 'Easy',
  3: 'Moderate',
  4: 'Hard',
  5: 'Expert',
};

const DIFFICULTIES = Array.from(
  { length: MAX_DIFFICULTY - MIN_DIFFICULTY + 1 },
  (_, i) => MIN_DIFFICULTY + i,
);

/**
 * One line of prompt for a table row.
 *
 * The API already truncates to `PROMPT_EXCERPT_LENGTH` (docs/03 §4) — this trims further, to
 * a word boundary, so a row stays one line at a console width. Trimming twice is deliberate:
 * the server's limit is about payload size and the client's is about layout, and neither
 * should have to know the other's number.
 */
export function excerpt(prompt: string | null, limit = 96): string {
  if (prompt === null || prompt.trim() === '') return 'Untitled question';
  // Markdown, flattened. A table cell is a plain-text context, and rendering the source
  // means a row reading ``SELECT count(*)`` with its backticks showing.
  //
  // Only *paired* emphasis is removed. Stripping every asterisk turns `count(*)` into
  // `count()` and `SELECT *` into `SELECT` — silently, in the column a recruiter scans,
  // and only on the SQL questions.
  const flat = prompt
    .replace(/`+/gu, '')
    .replace(/\*\*(.+?)\*\*/gu, '$1')
    .replace(/(^|\s)\*(\S.*?\S)\*(?=\s|$)/gu, '$1$2')
    .replace(/\s+/gu, ' ')
    .trim();
  if (flat.length <= limit) return flat;
  const cut = flat.slice(0, limit);
  const lastSpace = cut.lastIndexOf(' ');
  return `${cut.slice(0, lastSpace > 40 ? lastSpace : limit)}…`;
}

/** `2026-09-18` — a date a person can scan, in a column that has to stay narrow. */
function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/** The loading state, shaped like the table it becomes. */
function LoadingRows({ rows = 8 }: { rows?: number }): ReactNode {
  return (
    <tbody aria-hidden>
      {Array.from({ length: rows }, (_, i) => (
        <tr key={i}>
          <td>
            <Skeleton height="1rem" width={`${String(55 + ((i * 13) % 35))}%`} />
            <Skeleton height="0.75rem" width="22%" className="ab-questions__skeleton-second" />
          </td>
          <td>
            <Skeleton height="1.25rem" width="6rem" />
          </td>
          <td>
            <Skeleton height="1.25rem" width="5rem" />
          </td>
          <td>
            <Skeleton height="1rem" width="4rem" />
          </td>
          <td>
            <Skeleton height="1rem" width="2rem" />
          </td>
          <td>
            <Skeleton height="1rem" width="5rem" />
          </td>
        </tr>
      ))}
    </tbody>
  );
}

function QuestionRow({ question }: { question: AuthorQuestionSummaryView }): ReactNode {
  const difficulty = question.latest_difficulty;

  return (
    <tr>
      <th scope="row" className="ab-questions__prompt">
        {/* The anchor is the tab stop and the copyable link. The detail screen arrives with
            the authoring UI; until then it is a real URL that answers honestly. */}
        <a className="ab-questions__link" href={`/questions/${question.id}`}>
          {excerpt(question.latest_prompt_excerpt)}
        </a>
        {/* Only when it says something. The id of a question an author wrote themselves is
            noise on every row, and noise on every row is what makes a table unreadable —
            imported provenance is not, because it carries a licence obligation (docs/05 §2). */}
        {question.external_ref === null ? null : (
          <span className="ab-questions__meta">
            <span className="ab-table__mono">{question.external_ref}</span>
            {question.source_license === null ? null : (
              <span className="ab-questions__licence"> · {question.source_license}</span>
            )}
          </span>
        )}
      </th>
      <td className="ab-questions__nowrap">{KIND_LABELS[question.kind]}</td>
      <td>
        <Badge tone={STATUS_TONES[question.status]} label="Status">
          {STATUS_LABELS[question.status]}
        </Badge>
      </td>
      <td className="ab-questions__nowrap">
        {difficulty === null ? (
          <span className="ab-questions__none">—</span>
        ) : (
          (DIFFICULTY_LABELS[difficulty] ?? String(difficulty))
        )}
      </td>
      <td className="ab-table__numeric">{question.latest_version_no ?? '—'}</td>
      <td className="ab-questions__nowrap">
        {question.current_published_at === null ? (
          <span className="ab-questions__none">Not published</span>
        ) : (
          shortDate(question.current_published_at)
        )}
      </td>
    </tr>
  );
}

/** Props for {@link QuestionsScreen}. */
export interface QuestionsScreenProps {
  /** The active filters. The URL is the source of truth; see `questionsRoute`. */
  readonly filters: QuestionFilters;
  /** Applies a change. The route writes it to the URL, which re-renders this screen. */
  readonly onFiltersChange: (next: QuestionFilters) => void;
}

/**
 * The question bank screen.
 *
 * Filters arrive as props and changes go back out as props, because **the URL is the state**.
 * Holding them in component state instead costs three things a console cannot afford: a
 * filtered view nobody can send to a colleague, a browser Back button that leaves the filter
 * in place, and a refresh that silently drops it.
 */
export function QuestionsScreen({ filters, onFiltersChange }: QuestionsScreenProps): ReactNode {
  const client = useApi();
  const { announce } = useAnnounce();
  const searchId = useId();

  const query = useQuery(questionsQuery(client, filters));
  const rows = query.data?.data ?? [];
  const filtered = hasActiveFilters(filters);

  /**
   * A bank with nothing in it, as opposed to a filter that matched nothing.
   *
   * When it is the former there is nothing to filter, so the toolbar and the result count
   * are hidden: a row of controls over an empty screen invites the user to fiddle with
   * filters when what they actually need to do is write their first question.
   */
  const bankIsEmpty = !query.isPending && !query.isError && rows.length === 0 && !filtered;

  /** Announces the result count once per settled result (SC 4.1.3). */
  const announced = useRef<string>('');
  useEffect(() => {
    if (query.isPending || query.isError) return;
    const message =
      rows.length === 0
        ? 'No questions match these filters.'
        : `${String(rows.length)} question${rows.length === 1 ? '' : 's'} shown.`;
    if (announced.current !== message) {
      announced.current = message;
      announce(message);
    }
  }, [announce, query.isPending, query.isError, rows.length]);

  /** Changing a filter starts a new result set, so the page cursor is no longer valid. */
  function setFilter(patch: Partial<QuestionFilters>): void {
    onFiltersChange({ ...filters, ...patch, cursor: undefined });
  }

  function clearFilters(): void {
    onFiltersChange({});
  }

  function nextPage(): void {
    const cursor = query.data?.next_cursor ?? undefined;
    if (cursor === undefined) return;
    onFiltersChange({ ...filters, cursor });
  }

  return (
    <div className="ab-screen">
      <header className="ab-screen__header">
        <div className="ab-screen__heading-block">
          <h1 className="ab-screen__title" id="page-heading" tabIndex={-1}>
            Questions
          </h1>
          <p className="ab-screen__lede">
            Every question in your bank. A published version is frozen — editing one creates a new
            version, and the old one stays exactly as it was served.
          </p>
        </div>
        <div className="ab-screen__actions">
          <Button tone="primary">New question</Button>
        </div>
      </header>

      {bankIsEmpty ? null : (
        <Toolbar label="Filter questions">
          <div className="ab-toolbar__grow">
            <Field label="Search prompts" id={`${searchId}-q`}>
              {(control) => (
                <Input
                  {...control}
                  type="search"
                  placeholder="balanced parentheses"
                  defaultValue={filters.q ?? ''}
                  onChange={(event) => {
                    setFilter({ q: event.currentTarget.value });
                  }}
                />
              )}
            </Field>
          </div>

          <Field label="Kind" id={`${searchId}-kind`}>
            {(control) => (
              <Select
                {...control}
                value={filters.kind ?? ''}
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  setFilter({ kind: value === '' ? undefined : (value as QuestionKind) });
                }}
              >
                <option value="">Any kind</option>
                {QUESTION_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {KIND_LABELS[kind]}
                  </option>
                ))}
              </Select>
            )}
          </Field>

          <Field label="Status" id={`${searchId}-status`}>
            {(control) => (
              <Select
                {...control}
                value={filters.status ?? ''}
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  setFilter({ status: value === '' ? undefined : (value as QuestionStatus) });
                }}
              >
                <option value="">Any status</option>
                {QUESTION_STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {STATUS_LABELS[status]}
                  </option>
                ))}
              </Select>
            )}
          </Field>

          <Field label="Difficulty" id={`${searchId}-difficulty`}>
            {(control) => (
              <Select
                {...control}
                value={filters.difficulty === undefined ? '' : String(filters.difficulty)}
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  setFilter({ difficulty: value === '' ? undefined : Number(value) });
                }}
              >
                <option value="">Any difficulty</option>
                {DIFFICULTIES.map((level) => (
                  <option key={level} value={level}>
                    {DIFFICULTY_LABELS[level] ?? String(level)}
                  </option>
                ))}
              </Select>
            )}
          </Field>

          {filtered ? (
            <div className="ab-toolbar__end">
              <Button onClick={clearFilters}>Clear filters</Button>
            </div>
          ) : null}
        </Toolbar>
      )}

      {query.isError ? (
        <Alert tone="danger" title="The question bank could not be loaded" live="assertive">
          <p>{toDisplayEnvelope(query.error).error.message}</p>
          <p className="ab-screen__error-actions">
            <Button
              onClick={() => {
                void query.refetch();
              }}
            >
              Try again
            </Button>
          </p>
        </Alert>
      ) : null}

      {/* The result count, where a person looks for it: under the filters that produced it,
          not inside the table. The table keeps the same sentence as its accessible name. */}
      {!query.isError && !bankIsEmpty ? (
        <p className="ab-screen__count" role="status">
          {query.isPending
            ? 'Loading questions…'
            : `${String(rows.length)} question${rows.length === 1 ? '' : 's'}${
                (query.data?.next_cursor ?? null) === null ? '' : ', more on the next page'
              }`}
        </p>
      ) : null}

      {!query.isError && (query.isPending || rows.length > 0) ? (
        <Table caption="Questions in this bank" captionHidden className="ab-questions__table">
          <thead>
            <tr>
              <th scope="col">Prompt</th>
              <th scope="col">Kind</th>
              <th scope="col">Status</th>
              <th scope="col">Difficulty</th>
              <th scope="col" className="ab-table__numeric">
                Version
              </th>
              <th scope="col">Published</th>
            </tr>
          </thead>
          {query.isPending ? (
            <LoadingRows />
          ) : (
            <tbody>
              {rows.map((question) => (
                <QuestionRow key={question.id} question={question} />
              ))}
            </tbody>
          )}
        </Table>
      ) : null}

      {!query.isError && !query.isPending && rows.length === 0 ? (
        filtered ? (
          <EmptyState
            reason="no-matches"
            title="No questions match these filters"
            action={<Button onClick={clearFilters}>Clear filters</Button>}
          >
            Your bank has questions in it — none of them match what you have selected. Widen the
            filters, or search for a phrase from the prompt.
          </EmptyState>
        ) : (
          <EmptyState
            reason="empty"
            title="No questions yet"
            action={<Button tone="primary">New question</Button>}
            secondaryAction={<Button>Import a bank</Button>}
          >
            A question is versioned from its first save, and tagged with the skills it measures so
            an assessment can draw on it. Write one, or import a bank you already have as JSON or
            QTI.
          </EmptyState>
        )
      ) : null}

      {/* Next only. Under cursor pagination the way back is the page you came from, and with
          the cursor in the URL that is the browser's Back button — which works, restores the
          scroll position, and needs no cursor trail of its own to go wrong. */}
      {!query.isError && rows.length > 0 ? (
        <nav className="ab-pager" aria-label="Question bank pages">
          <Button onClick={nextPage} disabled={(query.data?.next_cursor ?? null) === null}>
            Next page
          </Button>
        </nav>
      ) : null}
    </div>
  );
}
