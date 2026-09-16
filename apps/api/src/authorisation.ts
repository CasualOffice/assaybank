/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Per-action authorisation: a route names the permission it requires, and the name is
 * checked before the handler runs.
 *
 * docs/14 §"Defaults": *"New endpoints require an explicit permission key; a route with
 * no permission check fails a CI lint rather than defaulting to authenticated-is-enough."*
 * That sentence is the whole design, and it has two halves that are easy to confuse.
 *
 * **Half one: the check.** `registerAuthorisation` installs a `preValidation` hook that
 * reads the route's declaration and refuses the request if the principal does not carry
 * the named permission. `preValidation` rather than `preHandler` is deliberate: it runs
 * *before* schema validation, so a caller with no business touching an endpoint is told
 * `forbidden` rather than being handed a `validation_failed` that describes the shape of
 * a request they were never allowed to make.
 *
 * **Half two: the enumeration.** A check that a route can forget to declare is a check
 * that some route will eventually not have, and — this is the part that makes it
 * dangerous — a route that forgot its declaration is indistinguishable, from the outside,
 * from a route that is deliberately public. Reading the diff does not find it; the
 * missing line is not in the diff. So every registered route is recorded as it is
 * registered ({@link authorisationReport}) and `route-authorisation.test.ts` enumerates
 * the table and fails on any entry with no declaration. The route table is the only
 * artefact that lists routes somebody forgot.
 *
 * Because the test is the backstop and not the gate, the runtime behaviour of an
 * undeclared route is to **deny** — a 403 with the standard envelope, and an `error`-level
 * log line. Failing closed means the worst outcome of a forgotten declaration is an
 * endpoint that does not work, which is discovered in minutes, instead of an endpoint
 * that works for everyone, which is discovered by a customer.
 *
 * ## Public is a decision, not an omission
 *
 * Exactly one list — {@link PUBLIC_ROUTES} — says which routes require no permission, and
 * every entry carries a one-line reason. It is a separate list rather than a per-route
 * flag on purpose: a flag is written by the person adding the route, at the moment they
 * want it to work, and it is reviewed in a diff of that route alone. A central list is
 * reviewed as a list — the reviewer sees the other ten entries and asks why this is the
 * eleventh — and it can be read end to end during a security review without trusting
 * anybody's grep. A route may not declare itself public (the plugin refuses to start if
 * it tries), and a route may not be both allow-listed and permission-checked, because one
 * of those two statements would be silently ignored.
 *
 * Entries distinguish `credential: 'none'` from `credential: 'session'`. The second is
 * *not* "authenticated is enough" applied to business routes: it exists for the two
 * endpoints whose subject is the session itself (`/auth/me`, `/auth/logout`), where the
 * principal is both the actor and the resource and there is no action for a permission
 * key to name. Everything else is a permission. And `session` means a **staff** session
 * specifically: docs/03 §1 keeps the two credential domains apart, and because a
 * candidate holds no permission key at all, these two entries are the only places in the
 * route table where an attempt token could otherwise have been enough — so the kind is
 * checked here rather than left to each of those handlers to remember.
 *
 * ## What this module does not do
 *
 * It does not authenticate. It reads `request.principal` (see `principal.ts`) and nothing
 * else — no cookie, no header, no token. And it is not the only defence: ADR-010 gives
 * every tenant table a row-level-security policy keyed on `app.current_org`, so a
 * cross-organisation read returns zero rows even when everything here is wrong. This is
 * the first of the two layers, not the only one.
 */

import type { FastifyInstance, FastifyRequest, RouteOptions } from 'fastify';

import { can, type KnownPermission, type Permission } from '@assaybank/auth';
import { API_BASE_PATH, ApiError } from '@assaybank/contracts';
import { counter, type CounterMetric } from '@assaybank/observability';

import { registerPrincipal } from './principal.js';

/**
 * What a route says about who may call it.
 *
 * `permission` is declared at the route with {@link requirePermission}. `public` is never
 * declared at a route — it is produced from a {@link PUBLIC_ROUTES} entry — and the
 * `onRoute` guard rejects a route that tries to declare it, so the allow-list stays the
 * single place "no permission required" can be said.
 */
export type RouteAuthorisation =
  | {
      readonly kind: 'permission';
      /** The permission key the caller must hold, from the docs/03 §13 seed. */
      readonly permission: Permission;
    }
  | {
      readonly kind: 'public';
      readonly credential: PublicCredential;
      /** Why this route needs no permission. Copied from the allow-list entry. */
      readonly reason: string;
    };

declare module 'fastify' {
  interface FastifyContextConfig {
    /**
     * The permission this route requires. Set through {@link requirePermission}:
     *
     * ```ts
     * app.get('/questions', { config: requirePermission('question.read') }, handler);
     * ```
     *
     * Absent, and not allow-listed, means the route is refused — see the module comment.
     */
    authorisation?: RouteAuthorisation;
  }
}

/**
 * Declares the permission a route requires, for spreading into the route's `config`.
 *
 * Takes {@link KnownPermission} rather than {@link Permission}: a mistyped key at a call
 * site is a compile error here, while a key arriving from the database is still an
 * ordinary string that `can()` fails closed on. Strict where the set is known, fail-closed
 * where it is data — the two halves of "permissions are data" (FR-27).
 *
 * Composes with the other route configuration by spreading:
 * `{ config: { ...rateLimitFor('staff_api'), ...requirePermission('attempt.read') } }`.
 */
export function requirePermission(permission: KnownPermission): {
  readonly authorisation: RouteAuthorisation;
} {
  return { authorisation: { kind: 'permission', permission } };
}

/** What an allow-listed route still requires, even though it requires no permission. */
export type PublicCredential =
  /** No credential at all. The route is reachable by anyone who can reach the socket. */
  | 'none'
  /**
   * A **staff** session, but no permission key. Only for routes whose subject *is* the
   * session — see the module comment. Never a substitute for a permission on a business
   * route, and never satisfied by a candidate's attempt token: docs/03 §1 keeps the two
   * credential domains apart, and every route that carries this credential answers with
   * the caller's own user, organisation and permission set, none of which a candidate
   * has. A candidate holds no permission key, so `can()` already refuses them every
   * permission-checked route; these entries would otherwise be the only doors in the
   * building an attempt token opens.
   */
  | 'session';

/** One deliberately unprotected route. */
export interface PublicRoute {
  /** As Fastify registers it: `GET`, `POST`, `OPTIONS`. `HEAD` follows its `GET`. */
  readonly method: string;
  /** The registered path, including any prefix and Fastify's `:param` spelling. */
  readonly url: string;
  readonly credential: PublicCredential;
  /** One line. It is read during a security review, so it says *why*, not *what*. */
  readonly reason: string;
}

/**
 * Every route that requires no permission key, with the reason it does not.
 *
 * Eleven entries, and each one is a decision somebody made in the open. Four are
 * operational; one is the CORS preflight; four are the ways a credential is first
 * obtained — password login, the OIDC pair, and candidate redemption (docs/03 §1); and
 * two are the endpoints whose subject is the session itself.
 *
 * Routes listed here that do not exist yet — login, redemption, the OIDC pair — are
 * pre-authorised by design: P1 step 3 and step 6 build them, and having the decision
 * recorded before the code exists is the point. An entry matching no route grants
 * nothing; the check is by exact method and path.
 */
export const PUBLIC_ROUTES: readonly PublicRoute[] = Object.freeze([
  {
    method: 'GET',
    url: '/healthz',
    credential: 'none',
    reason:
      'Liveness, probed by the orchestrator, which holds no credential and must not need one.',
  },
  {
    method: 'GET',
    url: '/readyz',
    credential: 'none',
    reason: 'Readiness, probed by the load balancer; it reports dependency status, never data.',
  },
  {
    method: 'GET',
    url: '/metrics',
    credential: 'none',
    reason:
      'Scraped by the collector on the pod network; the exposition is aggregate and ' +
      'cardinality-guarded, so it carries no tenant row (docs/12 §6).',
  },
  {
    method: 'GET',
    url: '/openapi.json',
    credential: 'none',
    reason: 'The published contract. It describes the API; it contains no organisation data.',
  },
  {
    method: 'OPTIONS',
    url: '*',
    credential: 'none',
    reason:
      'The CORS preflight registered by @fastify/cors. A browser sends it without ' +
      'credentials by definition, and it answers with headers rather than a body.',
  },
  {
    method: 'POST',
    url: `${API_BASE_PATH}/auth/login`,
    credential: 'none',
    reason: 'Issues the session. Requiring one would be circular (docs/03 §1).',
  },
  {
    method: 'POST',
    url: `${API_BASE_PATH}/auth/oidc/start`,
    credential: 'none',
    reason: 'Begins the OIDC redirect, before any session exists (docs/03 §1).',
  },
  {
    method: 'GET',
    url: `${API_BASE_PATH}/auth/oidc/callback`,
    credential: 'none',
    reason:
      'The identity provider redirects the browser here carrying a code, not a session; ' +
      'the state parameter, not a permission, is what authorises it.',
  },
  {
    method: 'POST',
    url: `${API_BASE_PATH}/candidate/redeem`,
    credential: 'none',
    reason:
      'A candidate has no account. Redeeming an invitation token is how they obtain the ' +
      'only credential they will ever hold (docs/03 §1); it is rate limited per address.',
  },
  {
    method: 'POST',
    url: `${API_BASE_PATH}/auth/logout`,
    credential: 'session',
    reason: 'Ends the caller’s own session. There is no other actor and no action to name.',
  },
  {
    method: 'GET',
    url: `${API_BASE_PATH}/auth/me`,
    credential: 'session',
    reason:
      'Returns the caller’s own user, organisation and permission set. The subject is the ' +
      'session itself, so a permission gating it would have to be held by everyone.',
  },
] satisfies readonly PublicRoute[]);

/** Why a request was refused. Bounded: it is a metric label (docs/12 §6). */
export const AUTHORISATION_DENIAL_REASONS = [
  /** The route declared no permission and is not allow-listed. A bug, failing closed. */
  'undeclared',
  /** No principal on a route that needs one. */
  'unauthenticated',
  /** A principal that does not hold the declared permission. */
  'permission',
  /**
   * A principal from the wrong credential domain: a candidate's attempt token presented
   * to a route whose allow-list entry says `credential: 'session'`, which means a staff
   * session. Distinct from `permission` because a candidate reaching a staff session
   * endpoint is a token-scope question, not a role-configuration one, and the two want
   * different people looking at them.
   */
  'principal_kind',
] as const;

/** One of {@link AUTHORISATION_DENIAL_REASONS}. */
export type AuthorisationDenialReason = (typeof AUTHORISATION_DENIAL_REASONS)[number];

/**
 * Refusals, by reason.
 *
 * `undeclared` should be flat zero forever; an alarm on it catches the route that
 * shipped without a declaration between the moment it merged and the moment somebody
 * reads the failing enumeration test. `permission` climbing is either a role
 * misconfiguration or somebody probing, and the two are worth telling apart early.
 */
export const authorisationDeniedTotal: CounterMetric<'reason'> = counter<'reason'>({
  name: 'http_authorisation_denied_total',
  help: 'Requests refused by the per-action authorisation check, by reason.',
  labelNames: ['reason'],
  labelValues: { reason: AUTHORISATION_DENIAL_REASONS },
});

/** One row of the route table, as recorded when the route was registered. */
export interface RouteAuthorisationRecord {
  readonly method: string;
  readonly url: string;
  /** `undefined` means the route declared nothing and is not allow-listed. */
  readonly declaration: RouteAuthorisation | undefined;
}

/** Every route this instance registered, and the subset that declared nothing. */
export interface AuthorisationReport {
  readonly routes: readonly RouteAuthorisationRecord[];
  readonly undeclared: readonly RouteAuthorisationRecord[];
}

/**
 * The per-instance route table.
 *
 * A `WeakMap` rather than an instance decorator: two plugins cannot collide on a name
 * that is not there, the table cannot be reached from a handler that has no business
 * reading it, and a closed server is collectable.
 */
const ROUTE_TABLES = new WeakMap<FastifyInstance, RouteAuthorisationRecord[]>();

/**
 * Normalises a method and path into the key both halves of this module agree on.
 *
 * `HEAD` folds onto `GET` because Fastify synthesises a `HEAD` route for every `GET`
 * (`exposeHeadRoutes`), sharing its `config` object. Left unfolded, every allow-listed
 * `GET` would need a twin entry, and the twin is exactly the line somebody forgets.
 */
function routeKey(method: string, url: string): string {
  const upper = method.toUpperCase();
  return `${upper === 'HEAD' ? 'GET' : upper} ${url}`;
}

/** Indexes the allow-list, rejecting a duplicate — one of the two would be unreviewed. */
function indexPublicRoutes(routes: readonly PublicRoute[]): ReadonlyMap<string, PublicRoute> {
  const index = new Map<string, PublicRoute>();
  for (const route of routes) {
    if (route.reason.trim() === '') {
      throw new Error(
        `The public-route entry for ${route.method} ${route.url} has no reason. An ` +
          'unexplained exemption is indistinguishable from a mistake six months later.',
      );
    }
    const key = routeKey(route.method, route.url);
    if (index.has(key)) {
      throw new Error(
        `${key} appears twice in the public-route allow-list. Two reasons for one route ` +
          'means one of them was never reviewed.',
      );
    }
    index.set(key, route);
  }
  return index;
}

function publicAuthorisation(entry: PublicRoute): RouteAuthorisation {
  return { kind: 'public', credential: entry.credential, reason: entry.reason };
}

/**
 * The declaration for a request that matched no route at all.
 *
 * Fastify models "no route" as a route of its own, so this hook runs for it. There is
 * nothing to authorise — the handler is the not-found handler, it reads no table and
 * answers the same envelope to everybody — and refusing it would turn every unknown path
 * into a 403, which is both wrong (docs/03 §2 says `not_found`) and *less* private: an
 * unmatched URL and a real route the caller may not touch would stop answering
 * identically, which is the exact oracle ADR-010's "`not_found`, never `forbidden`" rule
 * exists to close.
 */
const NO_ROUTE: RouteAuthorisation = {
  kind: 'public',
  credential: 'none',
  reason: 'No route matched. The not-found handler reads nothing and answers everyone alike.',
};

/**
 * The declaration in force for a request: what the route said, or what the allow-list
 * says about it, or `undefined` — which is the case this whole module exists to catch.
 */
export function authorisationFor(
  request: FastifyRequest,
  publicRoutes: ReadonlyMap<string, PublicRoute>,
): RouteAuthorisation | undefined {
  if (request.is404) return NO_ROUTE;

  const declared = request.routeOptions.config.authorisation;
  if (declared !== undefined) return declared;

  const entry = publicRoutes.get(routeKey(request.method, request.routeOptions.url ?? ''));
  return entry === undefined ? undefined : publicAuthorisation(entry);
}

/**
 * The refusal itself.
 *
 * `forbidden` and `unauthenticated` are served exactly as `@assaybank/contracts` authors
 * them: the fixed message for the code, no `details`, nothing naming the permission, the
 * route, the resource or whether any of them exist. The permission key is a fact about
 * the server's configuration and telling a caller which key they lack is a free map of
 * the authorisation model; it goes in the log, under the same trace id, where an operator
 * can read it and an attacker cannot.
 */
function refuse(
  request: FastifyRequest,
  reason: AuthorisationDenialReason,
  declaration: RouteAuthorisation | undefined,
): ApiError {
  authorisationDeniedTotal.inc({ reason });

  const route = request.routeOptions.url ?? 'unmatched';

  if (reason === 'undeclared') {
    // `error`, not `warn`: this is a defect in this repository, not a client behaving
    // badly, and the route is answering 403 to everyone until somebody fixes it.
    request.log.error(
      { event: 'http.authorisation_undeclared', method: request.method, route_class: route },
      'route declares no permission and is not on the public allow-list; refusing it',
    );
    return ApiError.forbidden();
  }

  request.log.warn(
    {
      event: 'http.authorisation_denied',
      reason,
      method: request.method,
      route_class: route,
      // Server-side only. The response says none of this.
      required_permission:
        declaration !== undefined && declaration.kind === 'permission'
          ? declaration.permission
          : undefined,
      principal_kind: request.principal?.kind ?? 'none',
    },
    'request refused by the authorisation check',
  );

  return reason === 'unauthenticated' ? ApiError.unauthenticated() : ApiError.forbidden();
}

/**
 * The check, in the order the answers are cheapest and the failures are most specific.
 *
 * Authentication is tested before the permission so that a caller with no credential
 * gets 401 and a caller with the wrong one gets 403 — the distinction a client needs to
 * decide whether to re-authenticate or to give up, and the only distinction either
 * response makes.
 */
function enforce(request: FastifyRequest, declaration: RouteAuthorisation | undefined): void {
  if (declaration === undefined) throw refuse(request, 'undeclared', declaration);

  if (declaration.kind === 'public' && declaration.credential === 'none') return;

  const principal = request.principal;
  if (principal === undefined) throw refuse(request, 'unauthenticated', declaration);

  // credential: 'session' — a *staff* session is the whole requirement. An attempt token
  // is a credential, but it is a credential in the other domain (docs/03 §1), and these
  // two entries are the only places in the route table where "a principal" rather than "a
  // permission" is the test; without this line they would be the only doors a candidate's
  // token opens.
  if (declaration.kind === 'public') {
    if (principal.kind !== 'staff') throw refuse(request, 'principal_kind', declaration);
    return;
  }

  // `can` is total and fails closed: candidates are refused without consulting a set, and
  // a permission key outside the seeded catalogue is refused for everyone.
  if (!can(principal, declaration.permission)) throw refuse(request, 'permission', declaration);
}

/** Options for {@link registerAuthorisation}. */
export interface AuthorisationOptions {
  /**
   * The allow-list. Defaults to {@link PUBLIC_ROUTES}; a test overrides it to exercise a
   * route table of its own, and nothing in production passes it.
   */
  readonly publicRoutes?: readonly PublicRoute[] | undefined;
}

/**
 * Installs the authorisation check and the route table on `app`.
 *
 * Must be called **before any route is registered**, because the record of a route is
 * made by an `onRoute` hook and Fastify runs those synchronously, against the hooks that
 * exist at the moment `.get()` is called. server.ts calls it among the other
 * cross-cutting registrations, all of which run before the deferred `app.after` block
 * where routes are added.
 *
 * A plain function on the instance rather than an `app.register` plugin, for the reason
 * given in server.ts: a plugin is an encapsulation context, and a hook declared inside
 * one does not apply to routes outside it — which for an authorisation check is the worst
 * possible failure mode.
 */
export function registerAuthorisation(
  app: FastifyInstance,
  options: AuthorisationOptions = {},
): void {
  const publicRoutes = indexPublicRoutes(options.publicRoutes ?? PUBLIC_ROUTES);

  const table: RouteAuthorisationRecord[] = [];
  ROUTE_TABLES.set(app, table);

  registerPrincipal(app);

  app.addHook('onRoute', (route: RouteOptions) => {
    const declared = route.config?.authorisation;

    if (declared !== undefined && declared.kind === 'public') {
      throw new Error(
        `${route.method.toString()} ${route.url} declares itself public. "No permission ` +
          'required" is said once, in PUBLIC_ROUTES, where it is reviewed as a list ' +
          'rather than inside the diff of the route that wanted it.',
      );
    }

    // Fastify passes an array when one handler serves several methods.
    const methods = Array.isArray(route.method) ? route.method : [route.method];

    for (const method of methods) {
      const allowListed = publicRoutes.get(routeKey(method, route.url));

      if (declared !== undefined && allowListed !== undefined) {
        throw new Error(
          `${method} ${route.url} both requires "${declared.permission}" and appears in ` +
            'PUBLIC_ROUTES. One of those two statements is being ignored, and which one ' +
            'is not obvious from either place.',
        );
      }

      table.push({
        method,
        url: route.url,
        declaration:
          declared ?? (allowListed === undefined ? undefined : publicAuthorisation(allowListed)),
      });
    }
  });

  // preValidation, not preHandler: before the body schema runs, so an unauthorised caller
  // is never handed a validation error describing a request they may not make.
  app.addHook('preValidation', (request, _reply, done) => {
    try {
      enforce(request, authorisationFor(request, publicRoutes));
      done();
    } catch (error: unknown) {
      done(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

/**
 * Every route registered on `app`, with what it declared.
 *
 * The enumeration test's input, and the answer to "which endpoints are reachable without
 * a permission?" during a security review. Call it after `await app.ready()`, once the
 * deferred registrations have run.
 */
export function authorisationReport(app: FastifyInstance): AuthorisationReport {
  const table = ROUTE_TABLES.get(app);
  if (table === undefined) {
    throw new Error(
      'registerAuthorisation() was never called on this instance, so no route table was ' +
        'recorded — which means no route on it is being checked either.',
    );
  }
  return {
    routes: [...table],
    undeclared: table.filter((record) => record.declaration === undefined),
  };
}

/** Renders route records as one line each, for a test failure a human can act on. */
export function describeRoutes(records: readonly RouteAuthorisationRecord[]): string {
  return records.map((record) => `${record.method} ${record.url}`).join('\n');
}
