/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * @assaybank/web — the staff console for recruiters, interviewers and administrators.
 *
 * Owns: the question bank and assessment builder screens, results and reports, the live
 * interview host view, and org administration. P0 ships the shell and four placeholders;
 * `src/app/routes.ts` names the phase that builds each of them.
 *
 * It renders state; it never decides a score, a deadline or a question draw. It talks only
 * to the API and the collaboration service, never to Postgres, Valkey or the object store
 * (CODE-GRAPH L5/L6, lint-enforced). It never ships in the candidate bundle and never
 * shares a build output with apps/candidate (ADR-013).
 *
 * Nothing imports this module — an app is an entry point, not a library, and importing one
 * is a type error as well as a lint error. `src/main.tsx` is where the application starts.
 */

/**
 * The workspace's own package name. Exported so a bootstrap can name itself in a log
 * line or a span resource without a second source of truth.
 */
export const WORKSPACE_NAME = '@assaybank/web';
