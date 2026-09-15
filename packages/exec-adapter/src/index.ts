/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * @assaybank/exec-adapter — a thin adapter over Piston so the sandbox stays swappable.
 *
 * Owns: `execute(request): Promise<ExecResult>`, `listRuntimes()`, and the `ExecLimits`
 * and `ExecResult` types. Outbound: POST {PISTON_URL}/api/v2/execute.
 *
 * The adapter never learns a question id, an attempt id, a candidate id or a test-case
 * expectation — code, stdin, args and limits only (HLD §3.2, ADR-002). Every call sets
 * CPU, wall, memory, process and output limits from EXEC_* configuration: an unlimited
 * call must be a compile error rather than a runtime choice. Only apps/worker may import
 * this package (CODE-GRAPH L6).
 */

/**
 * The workspace's own package name. Exported so a bootstrap can name itself in a log
 * line or a span resource without a second source of truth, and so this module has a
 * real export from the first commit.
 */
export const WORKSPACE_NAME = '@assaybank/exec-adapter';
