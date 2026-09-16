/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Who is making this request — decided once, at the edge, and read everywhere else.
 *
 * A {@link Principal} is either a staff member with a resolved permission set or a
 * candidate scoped to one attempt (docs/03 §1). This module owns nothing but the seam:
 * the request decorator that carries it, the single setter that fills it, and the
 * accessor that refuses to guess when it is absent. Authentication — the cookie, the
 * bearer token, the session lookup — is P1 step 3 and lives elsewhere; authorisation is
 * step 4 and lives in `authorisation.ts`. Keeping the carrier separate from both means
 * the permission check can be written, and tested, against a principal that arrived by
 * any means, and it means the authentication work has exactly one place to deposit its
 * result.
 *
 * **The permission set comes from the database, never from the request** (docs/14 TB-4).
 * Nothing in this file parses anything a client sent; `setPrincipal` is called by code
 * that has already verified a credential and resolved the set by joining
 * `user_role_assignments` → `user_roles` → `user_role_permissions` inside `withOrg`,
 * where row-level security — not a `WHERE` clause somebody remembered — is what keeps the
 * answer to one tenant (ADR-010). Because the set is data rather than a role name, a role
 * an organisation invented is indistinguishable here from a system one, which is what
 * makes custom roles safe to offer (FR-27).
 *
 * **One request, one principal.** {@link setPrincipal} refuses to overwrite an identity
 * that is already established. Two authentication paths that both "succeed" — a session
 * cookie and a bearer token on the same request, say — is not a case to resolve by
 * last-writer-wins; it is a case to refuse loudly, because whichever one loses was still
 * accepted by something.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';

import type { Principal } from '@assaybank/auth';
import { ApiError } from '@assaybank/contracts';

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * The authenticated principal, or `undefined` on a request that carried no
     * credential. Set exactly once, by {@link setPrincipal}.
     *
     * `undefined` rather than an "anonymous principal" on purpose: an anonymous value
     * that satisfies the type is a value that flows into `can()`, and a permission check
     * that can be handed a plausible-looking nobody is one refactor away from granting
     * something to nobody.
     */
    principal: Principal | undefined;
  }
}

/**
 * Declares the decorator on the instance.
 *
 * Idempotent, because both the authentication plugin and the authorisation plugin need
 * the decorator to exist and neither should have to know which of them was registered
 * first; Fastify throws `FST_ERR_DEC_ALREADY_PRESENT` on a second unconditional
 * `decorateRequest`.
 */
export function registerPrincipal(app: FastifyInstance): void {
  if (app.hasRequestDecorator('principal')) return;
  // A primitive default. Fastify v5 requires the property to exist before a hook may
  // assign it, and a reference-typed default would be shared by every request.
  app.decorateRequest('principal', undefined);
}

/**
 * Records the identity behind this request.
 *
 * @throws {Error} if the request already has a different principal. That is a
 * programming error — two credentials accepted on one request — so it becomes a 500 and
 * a log line rather than a quiet reassignment.
 */
export function setPrincipal(request: FastifyRequest, principal: Principal): void {
  const existing = request.principal;
  if (existing !== undefined && existing !== principal) {
    throw new Error(
      'This request already has a principal. Two authentication paths accepted the same ' +
        'request, and silently keeping the second would mean the first was still accepted ' +
        'by something. Resolve which credential the route takes instead.',
    );
  }
  request.principal = principal;
}

/**
 * The principal, or a 401.
 *
 * For handlers that need the identity. The reason is never disclosed — every refusal is
 * the same `unauthenticated` envelope (docs/14 T-011).
 */
export function currentPrincipal(request: FastifyRequest): Principal {
  const principal = request.principal;
  if (principal === undefined) throw ApiError.unauthenticated();
  return principal;
}
