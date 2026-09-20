/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Cross-site request forgery: docs/14 T-017, and the control `H-153` asks for.
 *
 * *"A staff user visits a hostile page which submits a cross-origin `POST /user-roles` or
 * `PATCH /attempts/{id}` using their ambient session cookie."* The session cookie is
 * `SameSite=Lax`, which stops the classic form post, and the API speaks JSON, which a
 * cross-origin form cannot produce without a preflight. Neither of those is a control we
 * chose to rely on alone: `Lax` is the *browser's* policy and it has exceptions, and a
 * future endpoint accepting a simple content type would silently lose the second.
 *
 * So the check is explicit and it is on the server. Every state-changing request that
 * carries a cookie must prove it came from an origin this deployment recognises.
 *
 * ## The two signals, and why both
 *
 * **`Origin`.** Sent by every browser on every `POST`, `PATCH`, `PUT` and `DELETE`, and
 * not settable by page script. If it is present, it must be in
 * `CORS_ALLOWED_ORIGINS` — the same list the CORS layer uses, so "which origins are ours"
 * has one answer (docs/13 §4.2).
 *
 * **`Sec-Fetch-Site`.** Fetch Metadata, sent by current browsers and likewise
 * unforgeable from script. `same-origin` and `none` (a user typing the URL) are fine;
 * `cross-site` and `same-site` are not. It catches the case `Origin` alone does not: a
 * subdomain of the console's own site, which is `same-site` but not our origin.
 *
 * A request with **neither** header is not a browser — curl, a server-to-server client, a
 * mobile app. Those cannot be CSRF victims, because CSRF is an attack on ambient
 * credentials that a browser attaches automatically, and nothing else has ambient
 * credentials. Refusing them would break every integration for no security gain, so the
 * rule is conditioned on the thing that actually makes the attack possible: **a cookie**.
 * No cookie, no ambient credential, nothing to forge with.
 *
 * ## What this is not
 *
 * It is not Better Auth's CSRF check. Better Auth has one, in its router middleware, and
 * this API never reaches that middleware: the routes in `auth/routes.ts` call
 * `auth.api.*` in process, which bypasses the whole chain. Depending on a control that is
 * not running is worse than having none, because nobody looks for it again. This check
 * also covers routes Better Auth has never heard of, which is where `H-127` actually
 * points — `POST /user-roles`, `PATCH /attempts/{id}` — and those are the majority.
 *
 * `H-127` also asks for double-submit tokens. They are the remaining half and they need a
 * client to carry them; the staff console does not exist until P8. Strict origin checking
 * is the half that works with no client cooperation at all, and it is the half that stops
 * the attack outright rather than making it noisier.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';

import { ApiError } from '@assaybank/contracts';
import { counter, type CounterMetric } from '@assaybank/observability';

/**
 * Methods that change state, and are therefore worth forging.
 *
 * `GET` and `HEAD` are absent by design, not by omission: a `GET` that changes state is
 * the bug, and adding it here would paper over it. `OPTIONS` is the preflight, which
 * carries no credentials by definition.
 */
export const STATE_CHANGING_METHODS: ReadonlySet<string> = new Set([
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
]);

/**
 * `Sec-Fetch-Site` values that mean "this did not come from somebody else's page".
 *
 * `none` is a top-level navigation the user began — typing the URL, or a bookmark. It is
 * included because the OIDC callback is exactly that shape when a browser follows the
 * identity provider's redirect, and because a user cannot be tricked into typing a `POST`.
 */
export const SAFE_FETCH_SITES: ReadonlySet<string> = new Set(['same-origin', 'none']);

/** docs/12 §4.6 — a climbing count here is either a misconfigured console or an attack. */
export const csrfRejectedTotal: CounterMetric<'reason'> = counter<'reason'>({
  name: 'http_csrf_rejected_total',
  help: 'State-changing requests refused because their origin was not recognised.',
  labelNames: ['reason'],
  labelValues: { reason: ['origin', 'fetch_site'] },
});

/** Why a request failed the check. Bounded, because it is a metric label. */
export type CsrfRejection = 'origin' | 'fetch_site';

/** A single header value, or `undefined` — Fastify hands back an array for repeats. */
function header(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  if (Array.isArray(value)) return value[0];
  return value;
}

/**
 * Decides whether this request may change state, given the origins this deployment trusts.
 *
 * Pure, and exported separately from the hook so the decision table can be tested as a
 * table rather than through twenty `app.inject()` calls.
 */
export function csrfRejection(
  request: FastifyRequest,
  allowedOrigins: readonly string[],
): CsrfRejection | undefined {
  if (!STATE_CHANGING_METHODS.has(request.method.toUpperCase())) return undefined;

  // No cookie, no ambient credential, nothing to forge. See the module comment.
  if (header(request, 'cookie') === undefined) return undefined;

  const origin = header(request, 'origin');
  if (origin !== undefined && !allowedOrigins.includes(origin)) return 'origin';

  const fetchSite = header(request, 'sec-fetch-site');
  if (fetchSite !== undefined && !SAFE_FETCH_SITES.has(fetchSite)) return 'fetch_site';

  // A cookie-bearing state change with neither header. Every browser that can be used for
  // this attack sends `Origin`; an older one that does not is a client we would rather
  // admit than break, and `SameSite=Lax` is still in force for it.
  return undefined;
}

/** Options for {@link registerCsrfProtection}. */
export interface CsrfOptions {
  /** `CORS_ALLOWED_ORIGINS`. The same list the CORS layer is configured from. */
  readonly allowedOrigins: readonly string[];
}

/**
 * Installs the check on `app`.
 *
 * `onRequest`, the earliest hook there is: a forged request should not reach body
 * parsing, rate-limit accounting or a route handler, and refusing it before the body is
 * read also means a hostile page cannot make us allocate a megabyte.
 *
 * Refused with `forbidden` rather than `unauthenticated`, per `H-127`. The distinction
 * matters to a client: the credential was fine, the *context* was not, and re-logging-in
 * would not help.
 */
export function registerCsrfProtection(app: FastifyInstance, options: CsrfOptions): void {
  const allowedOrigins = [...options.allowedOrigins];

  app.addHook('onRequest', (request, _reply, done) => {
    const rejection = csrfRejection(request, allowedOrigins);
    if (rejection === undefined) {
      done();
      return;
    }

    csrfRejectedTotal.inc({ reason: rejection });
    request.log.warn(
      {
        event: 'http.csrf_rejected',
        reason: rejection,
        method: request.method,
        // The offending origin is attacker-controlled text, so it is not a metric label
        // and not an error detail. It is the single most useful thing in the log line
        // when a customer's console is misconfigured, so it is logged (docs/12 §6).
        request_origin: header(request, 'origin') ?? null,
      },
      'state-changing request refused: unrecognised origin',
    );

    done(ApiError.forbidden());
  });
}
