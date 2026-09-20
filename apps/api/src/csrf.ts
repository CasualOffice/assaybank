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
 * also covers routes Better Auth has never heard of, which is where `H-153` actually
 * points — `POST /user-roles`, `PATCH /attempts/{id}` — and those are the majority.
 *
 * ## The second half: a token the browser does not have to volunteer
 *
 * Everything above rests on headers the *browser* attaches. That is a control with a single
 * point of failure: a browser that stops sending `Origin`, a proxy that strips it, a future
 * Fetch Metadata change, and the whole thing is gone at once with nothing behind it.
 *
 * So `H-153`'s other half is here too — a signed double-submit token, minted per session and
 * carried in a cookie script can read and a header only same-origin script can set. It was
 * deferred once on the grounds that it needed a client to carry it and the staff console did
 * not exist; the console exists now (`H-177`), so the reason has expired and the control is
 * built. `auth/csrf-token.ts` holds the token; this file holds the decision.
 *
 * The two halves cover each other's failure. Origin checking evaporates if the browser stops
 * volunteering headers; a double-submit token evaporates if anything can write the victim's
 * cookies — which the `__Host-` prefix on both the session and the token is what prevents
 * (`auth/cookie-names.ts`). Neither failure takes both.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';

import { API_BASE_PATH, ApiError, CSRF_HEADER } from '@assaybank/contracts';
import { counter, type CounterMetric } from '@assaybank/observability';

import { readCookie } from './auth/oidc-org-cookie.js';
import { sessionCookieName } from './auth/cookie-names.js';
import { csrfCookieName, verifyCsrfToken } from './auth/csrf-token.js';

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
  help: 'State-changing requests refused because their origin or their token was not ours.',
  labelNames: ['reason'],
  labelValues: { reason: ['origin', 'fetch_site', 'token'] },
});

/** Why a request failed the check. Bounded, because it is a metric label. */
export type CsrfRejection = 'origin' | 'fetch_site' | 'token';

/**
 * The two routes that establish a credential rather than use one, and are therefore exempt
 * from the token half.
 *
 * Not a convenience. A staff member whose session has expired still has the dead session
 * cookie in their browser, and no CSRF token, because the token is minted alongside a
 * *living* session. Requiring one on `POST /auth/login` would mean the only way out of that
 * state is to clear cookies by hand — a lockout, caused by a control, affecting exactly the
 * people who most need to sign in.
 *
 * They are not unprotected. Login CSRF — forcing a victim into the attacker's account so that
 * the victim's subsequent work lands somewhere the attacker can read — is stopped by the
 * origin half, which applies to every route including these two. What is given up is the
 * belt-and-braces redundancy, on the two routes where the alternative is an outage.
 */
export const TOKEN_EXEMPT_PATHS: ReadonlySet<string> = new Set([
  `${API_BASE_PATH}/auth/login`,
  `${API_BASE_PATH}/auth/oidc/start`,
]);

/** A single header value, or `undefined` — Fastify hands back an array for repeats. */
function header(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  if (Array.isArray(value)) return value[0];
  return value;
}

/** How the token half is configured, when there is a staff session to protect. */
export interface CsrfTokenOptions {
  /** `SESSION_SECRET`. The same key the session cookie is signed under. */
  readonly secret: string;
  /** Whether cookies are host-prefixed. Matches the Better Auth instance. */
  readonly secure: boolean;
}

/** Options for {@link registerCsrfProtection}. */
export interface CsrfOptions {
  /** `CORS_ALLOWED_ORIGINS`. The same list the CORS layer is configured from. */
  readonly allowedOrigins: readonly string[];
  /**
   * The double-submit half, or `undefined` when this instance issues no staff sessions.
   *
   * Absent in the unit suite that exercises the server skeleton with no identity wired up,
   * and that is sound rather than a hole: the token protects an *ambient* credential, and
   * the only ambient credential in this system is the staff session cookie. An instance
   * that cannot issue one has nothing for a forged request to spend. Candidates
   * authenticate with a bearer token, which a cross-site page cannot make a browser attach.
   */
  readonly token?: CsrfTokenOptions | undefined;
}

/**
 * Decides whether this request may change state.
 *
 * Pure, and exported separately from the hook so the decision table can be tested as a
 * table rather than through twenty `app.inject()` calls.
 */
export function csrfRejection(
  request: FastifyRequest,
  options: CsrfOptions,
): CsrfRejection | undefined {
  if (!STATE_CHANGING_METHODS.has(request.method.toUpperCase())) return undefined;

  // No cookie, no ambient credential, nothing to forge. See the module comment.
  const cookies = header(request, 'cookie');
  if (cookies === undefined) return undefined;

  const origin = header(request, 'origin');
  if (origin !== undefined && !options.allowedOrigins.includes(origin)) return 'origin';

  const fetchSite = header(request, 'sec-fetch-site');
  if (fetchSite !== undefined && !SAFE_FETCH_SITES.has(fetchSite)) return 'fetch_site';

  const token = options.token;
  if (token !== undefined) {
    // A cookie header is not a *session* cookie header. A browser sends everything it holds
    // for the host, and a staff console's analytics cookie is not a credential — so the
    // token is demanded of requests that actually carry the thing being protected, and of
    // nothing else. A request with no session is refused a moment later by the
    // authorisation layer, which is where "who are you" belongs.
    const session = readCookie(cookies, sessionCookieName(token.secure));

    if (session !== undefined && !TOKEN_EXEMPT_PATHS.has(pathOf(request))) {
      // Both halves of the double submit, and they must agree with each other as well as
      // with the signature. Comparing the header against the cookie is what makes this a
      // *double* submit: a cross-site page can cause the cookie to be sent and cannot read
      // it, so it cannot produce the header.
      const presented = header(request, CSRF_HEADER);
      const stored = readCookie(cookies, csrfCookieName(token.secure));

      if (presented === undefined || stored === undefined || presented !== stored) return 'token';
      if (!verifyCsrfToken(token.secret, session, presented)) return 'token';
    }
  }

  // A cookie-bearing state change with neither header. Every browser that can be used for
  // this attack sends `Origin`; an older one that does not is a client we would rather
  // admit than break, and `SameSite=Lax` is still in force for it.
  return undefined;
}

/** The request's path, without the query string an exemption must not be widened by. */
function pathOf(request: FastifyRequest): string {
  const query = request.url.indexOf('?');
  return query < 0 ? request.url : request.url.slice(0, query);
}

/**
 * Installs the check on `app`.
 *
 * `onRequest`, the earliest hook there is: a forged request should not reach body
 * parsing, rate-limit accounting or a route handler, and refusing it before the body is
 * read also means a hostile page cannot make us allocate a megabyte.
 *
 * Refused with `forbidden` rather than `unauthenticated`, per `H-153`. The distinction
 * matters to a client: the credential was fine, the *context* was not, and re-logging-in
 * would not help.
 */
export function registerCsrfProtection(app: FastifyInstance, options: CsrfOptions): void {
  const frozen: CsrfOptions = {
    allowedOrigins: [...options.allowedOrigins],
    token: options.token,
  };

  app.addHook('onRequest', (request, _reply, done) => {
    const rejection = csrfRejection(request, frozen);
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
      'state-changing request refused by the cross-site check',
    );

    done(ApiError.forbidden());
  });
}
