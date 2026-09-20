/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Server state for the question bank.
 *
 * Query *options* rather than hooks. `queryOptions()` gives one object that a component can
 * pass to `useQuery`, a route can pass to `ensureQueryData` to load before it renders, and a
 * test can execute directly — all sharing one key and one parser. A custom `useQuestions()`
 * hook would be usable from exactly one of those three places.
 *
 * The key mirrors the filter object, so changing a filter is a new key and therefore a new
 * cache entry with its own loading state, and going back to a previous filter is instant.
 */

import {
  QUESTIONS_PATH,
  QuestionListResponseSchema,
  type ListQuestionsQuery,
  type QuestionListResponse,
} from '@assaybank/contracts';
import { queryOptions } from '@tanstack/react-query';

import { type ApiClient } from './client.js';

/** The filters the questions screen exposes. A subset of the API's, and all optional. */
export interface QuestionFilters {
  readonly q?: string | undefined;
  readonly kind?: ListQuestionsQuery['kind'] | undefined;
  readonly status?: ListQuestionsQuery['status'] | undefined;
  readonly difficulty?: number | undefined;
  readonly cursor?: string | undefined;
}

/** How many rows a page of the bank holds. */
export const QUESTIONS_PAGE_SIZE = 25;

/**
 * The cache key for a filter set.
 *
 * Every value is named, so two different filters cannot collide, and the order is fixed, so
 * the same filter always produces the same key regardless of how the object was built.
 */
export function questionsQueryKey(filters: QuestionFilters): readonly unknown[] {
  return [
    'questions',
    {
      q: filters.q ?? null,
      kind: filters.kind ?? null,
      status: filters.status ?? null,
      difficulty: filters.difficulty ?? null,
      cursor: filters.cursor ?? null,
    },
  ];
}

/** One page of the bank, for the given filters. */
export function questionsQuery(client: ApiClient, filters: QuestionFilters) {
  return queryOptions<QuestionListResponse>({
    queryKey: questionsQueryKey(filters),
    queryFn: ({ signal }) =>
      client.request(QUESTIONS_PATH, {
        schema: QuestionListResponseSchema,
        query: {
          limit: QUESTIONS_PAGE_SIZE,
          // `undefined` is dropped by the client rather than sent as the string
          // "undefined", so an absent filter is an absent parameter.
          q: filters.q === '' ? undefined : filters.q,
          kind: filters.kind,
          status: filters.status,
          difficulty: filters.difficulty,
          cursor: filters.cursor,
        },
        signal,
      }),
    // A bank changes when somebody edits it, not on its own. Thirty seconds is long enough
    // that paging back and forth is instant and short enough that a colleague's publish
    // shows up without a reload.
    staleTime: 30_000,
  });
}

/** True when any filter is set — the difference between "empty bank" and "no matches". */
export function hasActiveFilters(filters: QuestionFilters): boolean {
  return (
    (filters.q ?? '') !== '' ||
    filters.kind !== undefined ||
    filters.status !== undefined ||
    filters.difficulty !== undefined
  );
}
