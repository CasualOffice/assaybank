/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The request-context plugin: one identifier per request, carried everywhere.
 *
 * docs/12 §5.3 fixes the contract:
 *
 * ```
 * request_id = "req_" + trace_id        # trace_id is 32 lowercase hex characters
 * ```
 *
 * and requires that the same value appear on **every** response in `X-Request-Id`, in
 * `error.request_id` of a failing response, and as `trace_id` on every log line the
 * request produced. That is the whole point: a candidate emails support a screenshot
 * showing `req_4bf92f35…`, support pastes it into the trace view, and the investigation
 * starts at the request rather than at "something went wrong around 14:30".
 *
 * **The id is minted here, never accepted from the client.** docs/12 §5.2 rule 2: the API
 * is the trace root for candidate traffic, and a candidate's browser is not a trusted
 * source of trace ids. A client that could choose its own `traceparent` could collide
 * two candidates onto one trace, or poison a support lookup. So `requestIdHeader` is
 * disabled on the Fastify instance (see server.ts) and an inbound `traceparent` is
 * ignored by this hook.
 *
 * **Why AsyncLocalStorage.** The code that most needs the trace id is a log line five
 * frames below the handler — exactly the place nobody would have threaded a parameter
 * to. `withContext` from `@assaybank/observability` owns the storage; this module only
 * decides what goes in it and when.
 */

import { randomBytes } from 'node:crypto';

import type { FastifyInstance } from 'fastify';

import { withContext } from '@assaybank/observability';

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * The 32 lowercase hex characters of this request's trace id. Logged as `trace_id`.
     */
    traceId: string;
    /**
     * `req_` + {@link FastifyRequest.traceId} — the value served in `X-Request-Id` and in
     * `error.request_id`. docs/12 §5.3.
     */
    requestId: string;
  }
}

/** The `request_id` prefix fixed by docs/12 §5.3. */
export const REQUEST_ID_PREFIX = 'req_';

/** The response header carrying the request id on every response, success or failure. */
export const REQUEST_ID_HEADER = 'x-request-id';

/** Matches a well-formed request id. Exported for tests and for the support tooling. */
export const REQUEST_ID_PATTERN = /^req_[0-9a-f]{32}$/u;

/**
 * Mints a W3C-shaped trace id: 16 random bytes as 32 lowercase hex characters.
 *
 * Randomness comes from `node:crypto` rather than `Math.random` because two requests
 * sharing an id makes a support lookup return the wrong candidate's trace, and because
 * a guessable id lets an attacker assert "my request was `req_…`" about somebody else's.
 *
 * **Known gap, and the shape of its fix.** When the OpenTelemetry SDK is running, the
 * authoritative trace id is the one the active server span already has — that is the id
 * the collector will store, and it is what `@assaybank/observability`'s logger puts in
 * `trace_id` on every line. A freshly minted id is therefore *not* the same value, so a
 * support ticket quoting `req_…` currently resolves through the `reqId` field on the log
 * lines rather than directly against the trace, which is one hop more than docs/12 §5.3
 * promises. Closing it is a two-line change: add `@opentelemetry/api` (on the ADR-001
 * approved list, but not yet a dependency of this workspace, and a dependency cannot be
 * added without regenerating the lockfile) and pass
 * `traceId: () => trace.getSpan(context.active())?.spanContext().traceId ?? newTraceId()`
 * as {@link RequestContextOptions.traceId}. The seam exists precisely so that the fix
 * touches boot and nothing else.
 */
export function newTraceId(): string {
  return randomBytes(16).toString('hex');
}

/** The request id derived from a trace id. */
export function requestIdFor(traceId: string): string {
  return `${REQUEST_ID_PREFIX}${traceId}`;
}

/** Options for {@link registerRequestContext}. */
export interface RequestContextOptions {
  /**
   * Source of the trace id for a request. Defaults to {@link newTraceId}.
   *
   * It takes no argument on purpose: a source that could see the request could be
   * tempted to read `traceparent` off it, which docs/12 §5.2 forbids.
   */
  readonly traceId?: (() => string) | undefined;
}

/**
 * Installs the context hook on `app`.
 *
 * Called directly on the root instance rather than through `app.register`, because a
 * Fastify plugin is an encapsulation context and a decorator declared inside one is
 * invisible to routes outside it. `fastify-plugin`, which exists to break that
 * encapsulation, is not on the approved dependency list (ADR-001) and is not needed: a
 * plain function that takes the instance does the same thing with nothing to install.
 */
export function registerRequestContext(
  app: FastifyInstance,
  options: RequestContextOptions = {},
): void {
  const mint = options.traceId ?? newTraceId;

  // Fastify v5 requires a declared default before a request decorator may be assigned.
  // Primitives only — a shared reference default would be shared across requests.
  app.decorateRequest('traceId', '');
  app.decorateRequest('requestId', '');

  app.addHook('onRequest', (request, reply, done) => {
    // `request.id` is produced by the instance's genReqId (server.ts), which already
    // returns `req_<traceId>`. Reusing it means Fastify's own `reqId` log field, the
    // response header and the error envelope are one value rather than three.
    const requestId = REQUEST_ID_PATTERN.test(request.id) ? request.id : requestIdFor(mint());
    const traceId = requestId.slice(REQUEST_ID_PREFIX.length);

    request.requestId = requestId;
    request.traceId = traceId;

    // Set on the reply object now, so it is present on a 404, on a 429 raised before any
    // handler runs, and on a 500 raised inside one. A header set only in the success
    // path is a header missing from exactly the responses support needs it on.
    reply.header(REQUEST_ID_HEADER, requestId);

    // `done()` is called *inside* the storage, so every hook, handler and awaited
    // continuation after this point observes the context.
    withContext({ traceId }, () => {
      done();
    });
  });
}
