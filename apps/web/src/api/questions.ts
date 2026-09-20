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
  AuthorQuestionSchema,
  AuthorQuestionVersionSchema,
  QUESTIONS_PATH,
  QUESTION_PATH,
  QUESTION_VERSIONS_PATH,
  QUESTION_VERSION_PATH,
  QUESTION_VERSION_PUBLISH_PATH,
  QuestionListResponseSchema,
  QuestionVersionListResponseSchema,
  type AuthorQuestionVersionView,
  type AuthorQuestionView,
  type ListQuestionsQuery,
  type PatchQuestion,
  type QuestionListResponse,
  type QuestionVersionListResponse,
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

/**
 * A version body: the fields the author changed, and nothing else.
 *
 * Deliberately not `QuestionVersionInput`. That type has every field optional — it describes the
 * patch the *server* accepts — so as a client-side type it would accept a misspelled key as an
 * absent one. The server parses the real schema and rejects an unknown key (docs/17 §3), which is
 * where that check belongs.
 */
export type VersionPatch = Record<string, unknown>;

/** One question with its current version expanded — `GET /questions/{id}`. */
export function questionQuery(client: ApiClient, id: string) {
  return queryOptions<AuthorQuestionView>({
    queryKey: ['question', id],
    queryFn: ({ signal }) =>
      client.request(QUESTION_PATH.replace('{id}', id), {
        schema: AuthorQuestionSchema,
        signal,
      }),
  });
}

/** Every version of a question, newest first — the history panel. */
export function questionVersionsQuery(client: ApiClient, id: string) {
  return queryOptions<QuestionVersionListResponse>({
    queryKey: ['question', id, 'versions'],
    queryFn: ({ signal }) =>
      client.request(QUESTION_VERSIONS_PATH.replace('{id}', id), {
        schema: QuestionVersionListResponseSchema,
        signal,
      }),
  });
}

/**
 * Writes a new version of a question — `POST /questions/{id}/versions`.
 *
 * The body is a patch over the previous version (docs/03 §4), so a field the author did not
 * touch is not sent and is copied forward byte for byte. Sending the whole form back would
 * introduce differences nobody asked for into a history whose point is answering "what
 * changed between version 3 and version 4".
 */
export function createVersionRequest(
  client: ApiClient,
  id: string,
  body: VersionPatch,
): Promise<AuthorQuestionVersionView> {
  return client.request(QUESTION_VERSIONS_PATH.replace('{id}', id), {
    schema: AuthorQuestionVersionSchema,
    method: 'POST',
    body,
  });
}

/** Edits an unpublished version in place — `PATCH /questions/{id}/versions/{v}`. */
export function updateVersionRequest(
  client: ApiClient,
  id: string,
  versionNo: number,
  body: VersionPatch,
): Promise<AuthorQuestionVersionView> {
  return client.request(
    QUESTION_VERSION_PATH.replace('{id}', id).replace('{v}', String(versionNo)),
    { schema: AuthorQuestionVersionSchema, method: 'PATCH', body },
  );
}

/** Freezes a version and makes it the one candidates are served. Irreversible (ADR-003). */
export function publishVersionRequest(
  client: ApiClient,
  id: string,
  versionNo: number,
): Promise<AuthorQuestionVersionView> {
  return client.request(
    QUESTION_VERSION_PUBLISH_PATH.replace('{id}', id).replace('{v}', String(versionNo)),
    { schema: AuthorQuestionVersionSchema, method: 'POST' },
  );
}

/** Moves a question through its lifecycle — `PATCH /questions/{id}`. */
export function patchQuestionRequest(
  client: ApiClient,
  id: string,
  body: PatchQuestion,
): Promise<AuthorQuestionView> {
  return client.request(QUESTION_PATH.replace('{id}', id), {
    schema: AuthorQuestionSchema,
    method: 'PATCH',
    body,
  });
}
