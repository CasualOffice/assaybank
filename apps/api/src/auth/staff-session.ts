/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A session cookie becomes a {@link StaffPrincipal}, and a privilege change ends every
 * session that predates it.
 *
 * ## Resolving a cookie
 *
 * Two steps, in this order, and the order is the tenancy design rather than a detail:
 *
 * 1. `auth.api.getSession(headers)` reads Valkey and nothing else. It returns the session
 *    and the cached user row — including `orgId` — so the organisation is known before a
 *    single tenant-scoped statement has run. There is no chicken-and-egg because there is
 *    no tenant row involved.
 * 2. `withOrg(orgId, …)` then resolves the permission set from `user_role_assignments` →
 *    `user_role_permissions`, under the ordinary policies (`../role-permissions.ts`).
 *
 * **The permission set is re-read on every request.** Nothing about authorisation is
 * cached in the session, which is worth stating because it is what makes the privilege
 * question below narrower than it first looks: a session cannot carry stale permissions,
 * because it carries no permissions at all.
 *
 * ## Rotation on privilege change
 *
 * docs/14 `H-149` requires the session identifier to be regenerated "on login, on
 * privilege change and on logout". Login and logout are Better Auth's own doing — it
 * mints a fresh token on every sign-in (which is what defeats fixation, T-014) and
 * deletes it on sign-out. Privilege change is ours, and it is implemented as
 * {@link revokeStaffSessions}: every session the affected user holds is deleted, so the
 * identifier that existed before the change cannot be presented after it. The user
 * authenticates again and receives a new one.
 *
 * That is a *stronger* reading of "regenerated" than re-issuing a cookie in place, and it
 * is also the only one this file can implement honestly. Re-issuing would mean minting a
 * cookie Better Auth will accept, which means reproducing its signature format from
 * outside the library — a credential minted with somebody else's HMAC scheme, which
 * breaks silently the day they change it. Deleting a session uses the library's own
 * `internalAdapter` and cannot drift.
 *
 * The cost is that an administrator who edits their *own* roles is signed out. That is a
 * rare action with an obvious explanation, and it is the right way round: the alternative
 * — a privilege change that leaves live sessions behind — is the failure mode `H-123`
 * names.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';

import type { Permission, StaffPrincipal } from '@assaybank/auth';
import { ApiError, OrgIdSchema, UserIdSchema, type OrgId, type UserId } from '@assaybank/contracts';
import { withOrg, type Database } from '@assaybank/db';

import { setPrincipal } from '../principal.js';
import { resolvePermissions } from './permission-set.js';
import type { StaffAuth } from './better-auth.js';

/**
 * The shape this module relies on from `auth.api.getSession`.
 *
 * Declared rather than inferred. Better Auth infers a precise type from the options
 * object, and depending on that inference would couple every signature in this file to a
 * type whose name is four generics deep; naming the three fields that are actually read
 * means a library upgrade that reshapes the rest is not a compile error here, while a
 * library upgrade that drops one of these three is.
 */
interface ResolvedSession {
  readonly session: { readonly token: string };
  readonly user: { readonly id: string; readonly orgId: string };
}

/** The identity behind a session cookie, before permissions are resolved. */
export interface StaffSessionSubject {
  readonly userId: UserId;
  readonly orgId: OrgId;
  /** The session token, so a caller can revoke exactly this session. */
  readonly token: string;
}

/**
 * Fastify's header bag as a `Headers`.
 *
 * Better Auth takes web-standard `Headers`, Fastify hands out
 * `Record<string, string | string[]>`, and the conversion is here once rather than at
 * four call sites. A repeated header is joined with `, ` per RFC 9110 rather than having
 * one value silently win — for `cookie` in particular, dropping a value would drop the
 * session on a request that also carried an OIDC state cookie.
 */
export function toWebHeaders(request: FastifyRequest): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  }
  return headers;
}

/**
 * The session behind a request's cookie, or `undefined`.
 *
 * Takes `Headers` rather than the request, because a sign-in needs to resolve the session
 * it has just *created* — which lives in the response's `Set-Cookie`, not in the request
 * that produced it.
 *
 * Never throws for a bad, expired or forged cookie: all three are simply "no session",
 * which is what keeps every refusal on this path the same `unauthenticated` envelope
 * (docs/14 T-011). An exception here would be a way to tell a revoked token from a
 * nonsense one.
 */
export async function resolveStaffSession(
  auth: StaffAuth,
  headers: Headers,
): Promise<StaffSessionSubject | undefined> {
  const resolved: unknown = await auth.api.getSession({ headers });
  if (resolved === null || typeof resolved !== 'object') return undefined;

  const { session, user } = resolved as Partial<ResolvedSession>;
  if (session === undefined || user === undefined) return undefined;

  // Parsed into brands rather than cast. The values came out of Valkey, which is storage
  // and therefore an input: a blob edited by anything with access to the socket must fail
  // the parse rather than become a `UserId` by assertion (docs/17 §1).
  const userId = UserIdSchema.safeParse(user.id);
  const orgId = OrgIdSchema.safeParse(user.orgId);
  if (!userId.success || !orgId.success) return undefined;

  return { userId: userId.data, orgId: orgId.data, token: session.token };
}

/**
 * The full principal: the session's identity plus the permissions its roles resolve to,
 * read from the database inside that organisation's context.
 */
export async function resolveStaffPrincipal(
  auth: StaffAuth,
  db: Database,
  request: FastifyRequest,
): Promise<StaffPrincipal | undefined> {
  const subject = await resolveStaffSession(auth, toWebHeaders(request));
  if (subject === undefined) return undefined;

  const permissions: ReadonlySet<Permission> = await withOrg(db, subject.orgId, (tx) =>
    resolvePermissions(tx, subject.userId),
  );

  return {
    kind: 'staff',
    userId: subject.userId,
    orgId: subject.orgId,
    permissions,
  };
}

/**
 * Ends every session `userId` holds, immediately.
 *
 * Called on a privilege change — a role granted, a role revoked, a custom role edited —
 * and by the incident playbook in docs/14 §10, which asks for exactly this verb. With
 * sessions in Valkey it is a handful of `DEL`s and takes effect on the next request
 * rather than at the end of some cache window, which is the property that makes the
 * playbook's promise keepable.
 *
 * Idempotent, and silent about whether the user had any sessions: a caller that could
 * tell would be a caller that can probe who is signed in.
 */
export async function revokeStaffSessions(auth: StaffAuth, userId: UserId): Promise<void> {
  const context = await auth.$context;
  await context.internalAdapter.deleteUserSessions(userId);
}

/** What {@link registerStaffAuthentication} needs. */
export interface StaffAuthenticationOptions {
  readonly auth: StaffAuth;
  readonly db: Database;
}

/**
 * Installs the hook that turns a session cookie into `request.principal`.
 *
 * `preValidation`, and registered **before** `registerAuthorisation` so that it runs
 * first: the authorisation hook reads `request.principal` and would otherwise refuse
 * every authenticated request as unauthenticated. Fastify runs same-phase hooks in
 * registration order, which is what makes "before" mean anything here.
 *
 * It refuses nothing on its own. A request with no cookie simply has no principal, and
 * the authorisation layer decides whether that matters — which is what keeps "is this
 * route public?" answerable in exactly one place (`../authorisation.ts`).
 *
 * The one thing it does refuse is a request carrying *both* a candidate bearer token and
 * a staff session. docs/03 §1: "Two separate authentication domains that must not share
 * credentials." A request holding one of each is not a case to resolve by precedence —
 * whichever lost was still accepted by something — so it is refused with the ordinary
 * `unauthenticated` envelope and logged.
 */
export function registerStaffAuthentication(
  app: FastifyInstance,
  options: StaffAuthenticationOptions,
): void {
  const { auth, db } = options;

  app.addHook('preValidation', async (request) => {
    const existing = request.principal;

    if (existing !== undefined) {
      // A candidate bearer token already claimed this request. If it also carries a staff
      // session, the two domains met on one request and neither is trustworthy here.
      if (await resolveStaffSession(auth, toWebHeaders(request))) {
        request.log.warn(
          { event: 'auth.credential_domains_crossed', principal_kind: existing.kind },
          'a request presented both a candidate token and a staff session; refusing it',
        );
        throw ApiError.unauthenticated();
      }
      return;
    }

    const principal = await resolveStaffPrincipal(auth, db, request);
    if (principal !== undefined) setPrincipal(request, principal);
  });
}
