/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { QueryClient } from '@tanstack/react-query';

import { ApiRequestError, isRetryable } from './client.js';

/** How many times a failed query is retried before the screen is told. */
export const MAX_QUERY_RETRIES = 2;

/**
 * Decides whether a failed request is worth repeating, by **code**.
 *
 * This is the point at which "clients branch on `code`, never on `message`" (docs/17 §3)
 * stops being a convention and becomes behaviour. A library's default retry policy counts
 * attempts and knows nothing about the failure; retrying a `forbidden` is pointless noise
 * against the API's rate limiter, and retrying a `version_immutable` is a request that
 * will never succeed no matter how patient the client is. `rate_limited`,
 * `execution_unavailable` and `internal` are the three that can come good on their own.
 *
 * Exported so the policy can be tested directly rather than through a live query.
 */
export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  if (failureCount >= MAX_QUERY_RETRIES) {
    return false;
  }

  // A failure that is not an ApiRequestError came from this bundle's own code — a parser
  // throwing on an unexpected shape, say — and repeating it would produce the same throw.
  if (!ApiRequestError.is(error)) {
    return false;
  }

  return isRetryable(error);
}

/**
 * Builds the console's query client.
 *
 * A factory rather than a module-level singleton: a singleton is shared state between
 * tests, and P1's login work will need a client whose cache can be discarded when the
 * session changes — a cache that outlives a sign-out is a cache that can show one user
 * another user's data.
 *
 * **Mutations are never retried automatically.** Every mutating endpoint accepts an
 * `Idempotency-Key` (docs/03 §2), and until a call site supplies one a blind retry is a
 * second invitation sent or a second question created. Retry belongs with the key, at the
 * call site that owns it, not in a global default.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: shouldRetryQuery,
        // Half a minute of staleness is fine for a bank listing and wrong for an exam
        // window; a screen that needs fresher data says so, rather than every screen
        // paying for the strictest one.
        staleTime: 30_000,
        // A recruiter alt-tabbing to their inbox is not a reason to re-issue every query
        // on the screen.
        refetchOnWindowFocus: false,
      },
      mutations: {
        retry: false,
      },
    },
  });
}
