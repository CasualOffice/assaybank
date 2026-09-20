/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The five staff authentication endpoints of docs/03-API-spec.md §1.
 *
 * ```
 * POST /auth/login          {email, password}     → sets session cookie
 * POST /auth/oidc/start     {provider}            → 302 to IdP
 * GET  /auth/oidc/callback                        → sets session cookie
 * POST /auth/logout
 * GET  /auth/me                                   → {user, org, permissions[]}
 * ```
 *
 * These paths are the contract, so they are Fastify routes here rather than Better Auth's
 * own `/sign-in/email` and `/sign-out` mounted under a prefix. Each one calls
 * `auth.api.*` by name — there is no dispatcher, no adapter and no interface between this
 * file and the library.
 *
 * ## The shape of every handler
 *
 * 1. Work out the organisation, from the request. This is the step nothing else in the
 *    system has to do, because everything else has a session.
 * 2. `withOrg(db, orgId, (tx) => inTenantContext(tx, () => auth.api.…))`, so every
 *    statement the library issues runs under that organisation's policies (ADR-010).
 * 3. Relay Better Auth's `Set-Cookie` headers verbatim. Its cookies are its own; parsing
 *    or rebuilding them here would be a second opinion about a format we do not own.
 *
 * ## Failures are uniform, and that is a feature with a cost
 *
 * Every way a login can fail — no such address, an address in two organisations, no
 * password set, the wrong password, an archived account — produces the same 401
 * `unauthenticated` envelope with the same message. docs/14 `H-176`: a candidate-facing
 * refusal must not be an oracle, and the same reasoning applies with more force to staff,
 * where knowing an address has an account is the first step of a targeted phish.
 *
 * The cost is that a recruiter who mistyped their email and a recruiter who mistyped their
 * password see the same screen. That is the trade the threat model asks for, and it is
 * mitigated where it should be — in the log line, under the request's trace id, where
 * support can see exactly which of the five it was.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';

import { verifyPasswordAgainstNothing, type StaffPrincipal } from '@assaybank/auth';
import { API_BASE_PATH, ApiError } from '@assaybank/contracts';
import { organizations, users, withOrg, type Database, type DbTransaction } from '@assaybank/db';

import { currentPrincipal } from '../principal.js';
import { rateLimitFor } from '../rate-limit.js';
import { resolvePermissions } from './permission-set.js';
import { OIDC_PROVIDER_ID, AUTH_BASE_PATH, type StaffAuth } from './better-auth.js';
import { clearOidcOrgCookie, oidcOrgCookie, verifyOidcOrgCookie } from './oidc-org-cookie.js';
import { resolveLoginOrg, resolveOrgBySlug, resolveSoleOrg } from './org-lookup.js';
import { resolveStaffSession, toWebHeaders } from './staff-session.js';
import { inTenantContext } from './tenant-db.js';

/** Everything the routes need. Assembled by `server.ts` from the parsed configuration. */
export interface StaffIdentityServices {
  readonly auth: StaffAuth;
  readonly db: Database;
  /** `SESSION_SECRET`, for the OIDC organisation cookie. Nothing else reads it here. */
  readonly sessionSecret: string;
  /** This API's own public base URL. Never derived from a `Host` header. */
  readonly apiUrl: string;
  /** Where the console lives, for the OIDC redirect back. */
  readonly consoleUrl: string;
  /** Whether cookies this module mints carry `Secure`. Matches the Better Auth instance. */
  readonly secureCookies: boolean;
  /** Whether an identity provider is configured at all. */
  readonly oidcEnabled: boolean;
  /** The clock. ADR-006: every response carries `server_time`, and it is injected. */
  readonly now: () => Date;
}

/** The body of `POST /auth/login`. */
const LOGIN_BODY = {
  type: 'object',
  required: ['email', 'password'],
  additionalProperties: false,
  properties: {
    email: { type: 'string', format: 'email', maxLength: 320 },
    // The bound is a cost ceiling on an unauthenticated request, not a UI rule: Argon2's
    // cost grows with input length, so an unbounded field is a denial of service wearing
    // a login form. It matches MAX_PASSWORD_LENGTH in packages/auth.
    password: { type: 'string', minLength: 1, maxLength: 128 },
    // Not in docs/03 §1, and optional, so the documented call still works. It exists
    // because `users` is unique on (org_id, email): the same address may legitimately
    // exist in two organisations, and the lookup refuses to choose between them. A
    // console served per-organisation sends its slug and the ambiguity never arises.
    org: { type: 'string', minLength: 1, maxLength: 128 },
  },
} as const;

/** The body of `POST /auth/oidc/start`. */
const OIDC_START_BODY = {
  type: 'object',
  additionalProperties: false,
  properties: {
    // docs/03 §1 names this field. One identity provider is configured per deployment, so
    // the only accepted value is the one this API registered — naming it in the request
    // is how a client discovers it was wrong rather than being silently redirected.
    provider: { type: 'string', minLength: 1, maxLength: 64 },
    org: { type: 'string', minLength: 1, maxLength: 128 },
  },
} as const;

interface LoginBody {
  readonly email: string;
  readonly password: string;
  readonly org?: string;
}

interface OidcStartBody {
  readonly provider?: string;
  readonly org?: string;
}

/** The `{user, org, permissions[]}` body of docs/03 §1, plus ADR-006's `server_time`. */
export interface StaffProfile {
  readonly user: {
    readonly id: string;
    readonly email: string;
    readonly full_name: string;
    readonly timezone: string;
  };
  readonly org: { readonly id: string; readonly name: string; readonly slug: string };
  readonly permissions: readonly string[];
  /** ADR-006: the server owns the clock, and says so on every response. */
  readonly server_time: string;
}

/**
 * Reads the profile for a signed-in user, inside an already-scoped transaction.
 *
 * The organisation row is read through the policy rather than trusted from the session:
 * the session says which organisation, and `organizations` then answers with the row that
 * organisation is allowed to see — which is exactly one row, its own (migration 0002,
 * A.1). A renamed organisation therefore shows its new name on the next request without
 * anybody having to invalidate a session.
 */
async function readProfile(
  tx: DbTransaction,
  principal: StaffPrincipal,
  now: Date,
): Promise<StaffProfile> {
  const [user] = await tx
    .select({
      id: users.id,
      email: users.email,
      fullName: users.fullName,
      timezone: users.timezone,
    })
    .from(users)
    .where(eq(users.id, principal.userId))
    .limit(1);

  const [org] = await tx
    .select({ id: organizations.id, name: organizations.name, slug: organizations.slug })
    .from(organizations)
    .where(eq(organizations.id, principal.orgId))
    .limit(1);

  if (user === undefined || org === undefined) {
    // The session resolved but the rows behind it did not. An archived user, a deleted
    // organisation, or a session that outlived its subject — all of which mean "you are
    // not signed in" rather than "something broke", and all of which must say so
    // identically (docs/14 T-011).
    throw ApiError.unauthenticated();
  }

  return {
    user: {
      id: user.id,
      email: user.email,
      full_name: user.fullName,
      timezone: user.timezone,
    },
    org: { id: org.id, name: org.name, slug: org.slug },
    // Sorted so the response is stable between requests: an unsorted set makes a diff of
    // two `/auth/me` responses unreadable and makes a client's cache key churn.
    permissions: [...principal.permissions].sort((a, b) => a.localeCompare(b)),
    server_time: now.toISOString(),
  };
}

/**
 * Copies Better Auth's cookies onto the Fastify reply, unchanged.
 *
 * `getSetCookie()` rather than `get('set-cookie')`: a sign-in sets the session cookie and
 * may expire others in the same response, and the single-header form would collapse them
 * into one string that no browser parses back into three cookies.
 */
function relayCookies(reply: FastifyReply, response: Response): void {
  for (const cookie of response.headers.getSetCookie()) {
    void reply.header('set-cookie', cookie);
  }
}

/** The `Cookie` header as one string, or `undefined`. */
function cookieHeader(request: FastifyRequest): string | undefined {
  const value = request.headers.cookie;
  return Array.isArray(value) ? value.join('; ') : value;
}

/**
 * Registers the five routes.
 *
 * Called from `server.ts` inside `app.after()`, so the rate limiter's `onRoute` hook and
 * the authorisation table are both in place before any of these is declared. Every one of
 * them appears in `PUBLIC_ROUTES` — three needing no credential, two needing a session
 * and no permission — which is where the decision that they are unprotected is recorded
 * and reviewed (`../authorisation.ts`).
 */
export function registerStaffAuthRoutes(
  app: FastifyInstance,
  services: StaffIdentityServices,
): void {
  const { auth, db, now } = services;

  // --- POST /auth/login --------------------------------------------------------
  app.post(
    `${API_BASE_PATH}/auth/login`,
    { schema: { body: LOGIN_BODY }, config: rateLimitFor('staff_login') },
    async (request, reply): Promise<StaffProfile> => {
      const body = request.body as LoginBody;

      const orgId = await resolveLoginOrg(db, { email: body.email, orgSlug: body.org });

      if (orgId === undefined) {
        // No organisation: the address is unknown, or it is held in two. Burn the same
        // Argon2 work a real verification would, then refuse identically. Without this the
        // two paths are a millisecond apart and a stopwatch enumerates the staff list
        // (docs/14 `H-176`).
        await verifyPasswordAgainstNothing(body.password);
        request.log.warn(
          { event: 'auth.login_failed', reason: 'no_organisation' },
          'staff login refused: the address resolved to no single organisation',
        );
        throw ApiError.unauthenticated();
      }

      const outcome = await withOrg(db, orgId, async (tx) =>
        inTenantContext(tx, async () => {
          const response = await auth.api.signInEmail({
            body: { email: body.email, password: body.password },
            headers: toWebHeaders(request),
            asResponse: true,
          });

          if (!response.ok) return { response, profile: undefined };

          // Inside the same transaction as the sign-in. The session exists at this point,
          // so the principal is known; reading the profile here means a login and a
          // subsequent `GET /auth/me` cannot disagree about what was true at sign-in.
          const subject = await resolveStaffSession(auth, sessionHeadersFrom(response));

          if (subject === undefined) throw ApiError.unauthenticated();

          const permissions = await resolvePermissions(tx, subject.userId);
          const profile = await readProfile(
            tx,
            { kind: 'staff', userId: subject.userId, orgId: subject.orgId, permissions },
            now(),
          );
          return { response, profile };
        }),
      );

      relayCookies(reply, outcome.response);

      if (outcome.profile === undefined) {
        request.log.warn(
          { event: 'auth.login_failed', reason: 'credentials', status: outcome.response.status },
          'staff login refused by the credential check',
        );
        // Better Auth's own body says "Invalid email or password", which is already
        // non-specific — but it is not the envelope of docs/03 §2, and one formatting path
        // is the rule. Every refusal on this route leaves as `unauthenticated`.
        throw ApiError.unauthenticated();
      }

      request.log.info({ event: 'auth.login_succeeded', org_id: orgId }, 'staff session issued');
      return outcome.profile;
    },
  );

  // --- GET /auth/me ------------------------------------------------------------
  app.get(`${API_BASE_PATH}/auth/me`, async (request): Promise<StaffProfile> => {
    const principal = currentPrincipal(request);
    if (principal.kind !== 'staff') {
      // A candidate's attempt token reaches no staff route. The refusal is
      // `unauthenticated` rather than `forbidden` because the two authentication domains
      // are separate (docs/03 §1) — a candidate is not a staff member lacking a
      // permission, they are not a staff member at all.
      throw ApiError.unauthenticated();
    }

    return withOrg(db, principal.orgId, (tx) => readProfile(tx, principal, now()));
  });

  // --- POST /auth/logout -------------------------------------------------------
  app.post(`${API_BASE_PATH}/auth/logout`, async (request, reply) => {
    const principal = currentPrincipal(request);
    if (principal.kind !== 'staff') throw ApiError.unauthenticated();

    const response = await withOrg(db, principal.orgId, (tx) =>
      inTenantContext(tx, () =>
        auth.api.signOut({ headers: toWebHeaders(request), asResponse: true }),
      ),
    );

    // The expiring cookies Better Auth sets. Relayed rather than rebuilt, so the names
    // and attributes match the ones it issued — a `Set-Cookie` that differs by a single
    // attribute clears nothing and the session cookie survives the logout.
    relayCookies(reply, response);
    return reply.code(204).send();
  });

  // --- POST /auth/oidc/start ---------------------------------------------------
  app.post(
    `${API_BASE_PATH}/auth/oidc/start`,
    { schema: { body: OIDC_START_BODY }, config: rateLimitFor('staff_login') },
    async (request, reply): Promise<{ url: string }> => {
      const body = (request.body ?? {}) as OidcStartBody;

      // No provider configured means no flow to start. `not_found` rather than a 400:
      // there is no such endpoint on this deployment, which is what a 404 says.
      if (!services.oidcEnabled) throw ApiError.notFound();
      if (body.provider !== undefined && body.provider !== OIDC_PROVIDER_ID) {
        throw ApiError.notFound();
      }

      const orgId =
        body.org === undefined ? await resolveSoleOrg(db) : await resolveOrgBySlug(db, body.org);

      // A deployment with more than one organisation and a request that named none. There
      // is nothing to redirect to, and guessing would send somebody to another tenant's
      // identity provider.
      if (orgId === undefined) throw ApiError.notFound();

      const { url, state } = await withOrg(db, orgId, (tx) =>
        inTenantContext(tx, () => startOidc(auth, request, services)),
      );

      // Set before the client follows the redirect, and bound to this flow's `state`.
      void reply.header(
        'set-cookie',
        oidcOrgCookie({
          secret: services.sessionSecret,
          orgId,
          state,
          secure: services.secureCookies,
        }),
      );

      // A JSON body carrying the URL, not a 302. docs/03 §1 describes the effect ("302 to
      // IdP") from the browser's point of view; the request itself is a `POST` from
      // script, and a fetch that follows a redirect to a third-party origin either fails
      // CORS or silently discards the response. The console navigates to `url`.
      return { url };
    },
  );

  // --- GET /auth/oidc/callback -------------------------------------------------
  app.get(`${API_BASE_PATH}/auth/oidc/callback`, async (request, reply) => {
    if (!services.oidcEnabled) throw ApiError.notFound();

    const query = (request.query ?? {}) as Record<string, string | undefined>;
    const orgId = verifyOidcOrgCookie({
      secret: services.sessionSecret,
      cookieHeader: cookieHeader(request),
      state: query['state'],
      secure: services.secureCookies,
    });

    // The cookie is missing, forged, expired, or was minted for a different flow. All four
    // are the same refusal, and none of them says which.
    if (orgId === undefined) {
      request.log.warn(
        { event: 'auth.oidc_callback_refused', reason: 'org_cookie' },
        'OIDC callback refused: no valid organisation cookie for this state',
      );
      throw ApiError.unauthenticated();
    }

    const response = await withOrg(db, orgId, (tx) =>
      inTenantContext(tx, () => auth.handler(callbackRequest(request, services))),
    );

    relayCookies(reply, response);
    // The flow is over either way; the cookie has no further use and a cookie with no
    // further use is a cookie to delete.
    void reply.header('set-cookie', clearOidcOrgCookie(services.secureCookies));

    // Better Auth answers the callback with a redirect — to the console on success, to its
    // error URL otherwise. Relaying its `Location` keeps the success and failure paths
    // identical from here, which is what stops this handler from becoming a second place
    // that decides whether a sign-in worked.
    const location = response.headers.get('location');
    return reply
      .code(302)
      .header('location', location ?? `${services.consoleUrl}/login`)
      .send();
  });
}

/**
 * Builds the `Request` Better Auth's own callback route expects.
 *
 * The identity provider redirects to the documented path, `/auth/oidc/callback`, because
 * that is the `redirectURI` registered with it. Better Auth's handler answers at
 * `${basePath}/callback/${providerId}`. The two are reconciled by rewriting the path and
 * carrying the query and the cookies across unchanged — the `state` cookie in particular,
 * which is what the library checks the `state` parameter against.
 *
 * The URL is built from the configured `API_PUBLIC_URL`, never from the `Host` header. A
 * header-derived base URL is how an attacker makes a service generate links to their own
 * host (docs/14 §"Defaults").
 */
function callbackRequest(request: FastifyRequest, services: StaffIdentityServices): Request {
  const incoming = new URL(request.url, 'http://placeholder.invalid');
  const target = new URL(
    `${AUTH_BASE_PATH}/callback/${OIDC_PROVIDER_ID}${incoming.search}`,
    services.apiUrl,
  );

  return new Request(target, { method: 'GET', headers: toWebHeaders(request) });
}

/**
 * Starts the OIDC flow and reports both the URL and the `state` inside it.
 *
 * `signInSocial` answers `{ url, redirect: true }`. The `state` is read back out of the
 * query string rather than generated here, because the library owns it — it is the value
 * stored in `staff_verifications` and the value the callback is checked against, and a
 * second copy minted on this side would be a second copy to disagree.
 */
async function startOidc(
  auth: StaffAuth,
  request: FastifyRequest,
  services: StaffIdentityServices,
): Promise<{ url: string; state: string }> {
  const result: unknown = await auth.api.signInSocial({
    body: {
      provider: OIDC_PROVIDER_ID,
      // Where the browser ends up after a successful sign-in. Validated by Better Auth
      // against `trustedOrigins`, so a caller cannot turn this into an open redirect.
      callbackURL: services.consoleUrl,
      errorCallbackURL: `${services.consoleUrl}/login`,
    },
    headers: toWebHeaders(request),
  });

  const url =
    typeof result === 'object' && result !== null ? (result as { url?: unknown }).url : undefined;
  if (typeof url !== 'string') {
    // The provider is configured but the library declined to produce a URL — a discovery
    // document that would not load, most likely. It is our problem, not the caller's, so
    // it becomes the fixed `internal` envelope with the detail in the log.
    request.log.error(
      { event: 'auth.oidc_start_failed' },
      'the OIDC provider produced no authorisation URL',
    );
    throw ApiError.internal();
  }

  const state = new URL(url).searchParams.get('state');
  if (state === null) {
    request.log.error(
      { event: 'auth.oidc_start_failed', reason: 'no_state' },
      'the OIDC authorisation URL carried no state parameter',
    );
    throw ApiError.internal();
  }

  return { url, state };
}

/**
 * The headers a freshly signed-in request would present on its next call.
 *
 * `signInEmail` returns the new session in `Set-Cookie`, and the profile has to be read
 * for *that* session rather than for whatever cookie arrived — which, on a sign-in that
 * replaced an existing session, is a token that no longer exists. Turning the response's
 * cookies back into a request `Cookie` header is the smallest way to say "as this session
 * now is".
 */
function sessionHeadersFrom(response: Response): Headers {
  const pairs = response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(';', 1)[0] ?? '')
    // An expiring cookie serialises as `name=`, and feeding that back would present an
    // empty session token rather than no session token at all.
    .filter((pair) => pair !== '' && !pair.endsWith('='));

  return new Headers({ cookie: pairs.join('; ') });
}
