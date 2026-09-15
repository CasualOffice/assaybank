/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The ambient request context: the trace id a support ticket resolves to, and the tenant
 * and actor the request is running as.
 *
 * It is an `AsyncLocalStorage` rather than a parameter threaded through every call
 * because the thing that needs it most — a log line five frames below the handler — is
 * exactly the place where nobody would have threaded it.
 *
 * `request_id` in the error envelope is `"req_" + traceId` (docs/12 §5.3), so the value
 * a candidate reads off an error screen is the value that finds the trace.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

import type { OrgId } from '@assaybank/contracts';

/**
 * What every log line and every audit write on this request can discover about itself.
 *
 * `orgId` is present once the request has been authenticated and its tenant resolved;
 * it is absent on unauthenticated routes, and it is a branded `OrgId` rather than a
 * bare string so a tenant id can never be crossed with another identifier.
 */
export type RequestContext = {
  readonly traceId: string;
  readonly orgId?: OrgId | undefined;
  readonly userId?: string | undefined;
};

const storage = new AsyncLocalStorage<RequestContext>();

/**
 * Runs `fn` with `ctx` as the ambient request context, including across every `await`
 * inside it. Returns whatever `fn` returns, so it wraps a synchronous handler and a
 * promise-returning one identically.
 */
export function withContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/**
 * The ambient request context, or `undefined` outside one — a worker's startup path, a
 * cron sweep, a test. Callers must treat the absence as normal rather than as an error.
 */
export function currentContext(): RequestContext | undefined {
  return storage.getStore();
}
