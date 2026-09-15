/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Authorisation: who may do what (FR-27, docs/17 §7).
 *
 * Three rules, and all three are enforced by the shape of the code rather than by a
 * reviewer noticing:
 *
 * **1. Permission, never role.** `can()` takes an action. It cannot be asked whether
 * somebody is an administrator, because a route that branches on a role name is a route
 * that silently widens the next time the role does. `org.admin` grants `org.admin` and
 * nothing else — there is no ambient admin path, and no implication table for one to hide
 * in. A staff user who may manage users but may not export reports is a normal
 * configuration, not an edge case.
 *
 * **2. A candidate can do nothing here.** The staff permission set and the candidate
 * credential are different authentication domains that must not share credentials
 * (docs/03 §1). {@link can} returns `false` for a candidate principal for every
 * permission, including any permission invented after this file was written, because the
 * candidate branch does not consult a set — it returns. A candidate's authorisation is
 * entirely "this one attempt", and that lives in the attempt token, not here.
 *
 * **3. Unknown permissions fail closed.** `Permission` is `string`, so a typo at a call
 * site is not a compile error. It is, however, a denial: a permission key that is not in
 * {@link PERMISSIONS} is refused for everyone. `assertCan(principal, 'question.pubish')`
 * therefore locks the route rather than opening it, which is the failure mode to have.
 *
 * Org scope is not a parameter of this function. It cannot be, safely: an authorisation
 * check that takes the org from its caller is one bad argument away from being told the
 * wrong one. The principal carries exactly one `orgId`, the request sets
 * `app.current_org` from it, and RLS makes a cross-tenant row return zero rows even if
 * everything here is wrong (ADR-010). Defence in depth, in that order.
 */

import { type AttemptId, ApiError, type OrgId, type UserId } from '@assaybank/contracts';

/**
 * A permission key.
 *
 * Deliberately `string` rather than the union of {@link PERMISSIONS}: the set is data —
 * seeded into the `permissions` table and joined through `user_role_permissions` — so
 * values arriving from the database are ordinary strings. {@link KnownPermission} is the
 * closed union for code that can be specific, and {@link can} fails closed on anything
 * outside it.
 */
export type Permission = string;

/**
 * Every permission the system defines, verbatim from the seed in
 * docs/hiring_platform_schema.sql §13.
 *
 * This list and that `INSERT` are the same list. Adding a permission means adding it in
 * both places in one change, and the migration that seeds the row is what makes it
 * grantable; adding it here alone grants nobody anything.
 */
export const PERMISSIONS = [
  'question.read',
  'question.write',
  'question.publish',
  'assessment.write',
  'invite.send',
  'attempt.read',
  'attempt.grade',
  'attempt.void',
  'interview.host',
  'report.export',
  'org.admin',
] as const satisfies readonly Permission[];

/** The closed union of the permissions this build knows about. */
export type KnownPermission = (typeof PERMISSIONS)[number];

/**
 * The seed's descriptions, for `GET /permissions` and for the role editor.
 *
 * `Record<KnownPermission, string>` on purpose: a permission added to {@link PERMISSIONS}
 * without a description is a compile error, so the administrator UI can never show a
 * checkbox labelled with a raw key.
 */
export const PERMISSION_DESCRIPTIONS: Readonly<Record<KnownPermission, string>> = Object.freeze({
  'question.read': 'View the question bank',
  'question.write': 'Create and edit questions',
  'question.publish': 'Publish a question version',
  'assessment.write': 'Create and edit assessments',
  'invite.send': 'Invite candidates to assessments',
  'attempt.read': 'View attempts and results',
  'attempt.grade': 'Manually grade or override scores',
  'attempt.void': 'Void an attempt for integrity reasons',
  'interview.host': 'Run live interview sessions',
  'report.export': 'Export candidate and aggregate reports',
  'org.admin': 'Manage users, roles and settings',
});

/** Narrows an arbitrary string to a permission this build defines. */
export function isPermission(value: unknown): value is KnownPermission {
  return typeof value === 'string' && (PERMISSIONS as readonly string[]).includes(value);
}

/** A signed-in member of staff, with the permissions their roles resolve to. */
export type StaffPrincipal = {
  readonly kind: 'staff';
  /** The user row behind the session. */
  readonly userId: UserId;
  /** The one tenant this session acts in. */
  readonly orgId: OrgId;
  /**
   * The resolved union of the permissions granted by this user's roles, in this org.
   * Resolved once when the session is loaded, never re-derived from a role name.
   */
  readonly permissions: ReadonlySet<Permission>;
};

/**
 * A candidate sitting one attempt. No account, no roles, no permission set — the
 * absence of a `permissions` field is the point, not an omission.
 */
export type CandidatePrincipal = {
  readonly kind: 'candidate';
  /** The single attempt the bearer token authorises (docs/03 §1). */
  readonly attemptId: AttemptId;
  /** The tenant that owns the attempt. Becomes `app.current_org` (ADR-010). */
  readonly orgId: OrgId;
};

/** Whoever is making the request. Exactly one of two kinds; there is no third. */
export type Principal = StaffPrincipal | CandidatePrincipal;

/**
 * May this principal perform this action?
 *
 * Total, side-effect free, and fail-closed in all three directions: candidates are
 * refused without consulting anything, unknown permission keys are refused, and a staff
 * principal is refused unless the key is literally present in their resolved set.
 */
export function can(principal: Principal, permission: Permission): boolean {
  if (!isPermission(permission)) {
    return false;
  }

  if (principal.kind === 'candidate') {
    return false;
  }

  return principal.permissions.has(permission);
}

/**
 * {@link can}, as a guard. Throws `ApiError('forbidden')` — a 403 with the generic
 * message and no details — when the answer is no.
 *
 * On a route that takes a resource id, prefer letting the lookup fail: the threat model
 * requires `not_found` rather than `forbidden` where a 403 would confirm that some other
 * tenant holds the id (`H-128`). This is for the permission itself, where the caller
 * already knows the action exists.
 */
export function assertCan(principal: Principal, permission: Permission): void {
  if (!can(principal, permission)) {
    throw ApiError.forbidden();
  }
}
