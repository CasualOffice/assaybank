/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Who is signed in (`H-177`, docs/03 §1).
 *
 * ## Three states, not two
 *
 * A session is **resolving**, **absent** or **present**, and collapsing the first two is the
 * defect this module exists to prevent. Treating "not loaded yet" as "not signed in" flashes
 * a login form at somebody who is signed in, on every reload; treating it as "signed in"
 * renders a console shell around an empty session, which is what the tracker row describes.
 * The shell asks for the state and renders three different things.
 *
 * ## A 401 from anywhere means the same thing
 *
 * A session expires mid-visit, and the next query is the one that finds out. Rather than
 * every screen learning to recognise that, `isUnauthenticated` names the shape once and the
 * shell acts on it — so a new screen inherits the behaviour instead of forgetting it.
 */

import {
  AUTH_LOGIN_PATH,
  AUTH_LOGOUT_PATH,
  AUTH_ME_PATH,
  StaffProfileSchema,
  type LoginRequest,
  type StaffProfile,
} from '@assaybank/contracts';
import { queryOptions } from '@tanstack/react-query';

import { ApiRequestError, type ApiClient } from './client.js';

export type { StaffProfile };

/** The cache key the shell reads and a logout clears. */
export const SESSION_KEY = ['auth', 'me'] as const;

/**
 * Who we are — `GET /auth/me`.
 *
 * `retry: false` on purpose. The default retries a failed query three times, and a 401 is not
 * a transient failure: retrying it delays the login screen by several seconds for somebody
 * who is simply not signed in, and it asks an unauthenticated question three more times.
 */
export function sessionQuery(client: ApiClient) {
  return queryOptions<StaffProfile>({
    queryKey: SESSION_KEY,
    queryFn: ({ signal }) => client.request(AUTH_ME_PATH, { schema: StaffProfileSchema, signal }),
    retry: false,
    /**
     * And do not quietly re-ask on a remount either.
     *
     * React Query re-runs an errored query when a fresh observer mounts, which for this one
     * means the gate renders "checking your session…" and *then* the sign-in form — the
     * flash the three-state split exists to avoid. A 401 is not going to answer differently
     * a moment later, and when it genuinely should be re-asked there is a button that does
     * it: signing in.
     */
    retryOnMount: false,
    // The session outlives a navigation, so re-asking on every mount is a request per screen
    // for an answer that has not changed. Five minutes is well inside any session lifetime.
    staleTime: 5 * 60_000,
  });
}

/** Signs in — `POST /auth/login`. The response is the profile, so it seeds the cache. */
export function loginRequest(client: ApiClient, body: LoginRequest): Promise<StaffProfile> {
  return client.request(AUTH_LOGIN_PATH, {
    schema: StaffProfileSchema,
    method: 'POST',
    body,
  });
}

/** Signs out — `POST /auth/logout`. Answers `204`, so there is nothing to parse. */
export function logoutRequest(client: ApiClient): Promise<void> {
  return client.requestVoid(AUTH_LOGOUT_PATH, { method: 'POST' });
}

/**
 * Whether an error is the server saying "I do not know who you are".
 *
 * Named once here rather than recognised in each screen. `unauthenticated` is the code, not
 * the status: docs/03 §1 distinguishes it from `forbidden` — a candidate's attempt token on a
 * staff route is not a staff member lacking a permission, and neither is an expired session.
 * Branching on `code` rather than on `message` is the convention CLAUDE.md sets.
 */
export function isUnauthenticated(error: unknown): boolean {
  return ApiRequestError.is(error) && error.code === 'unauthenticated';
}
