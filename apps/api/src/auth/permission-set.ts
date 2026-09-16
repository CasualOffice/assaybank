/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Where a staff principal's permissions come from: the database, and only the database.
 *
 * FR-27 requires an organisation to be able to define its own role, so the model is
 * `user_role_assignments` → `user_roles` → `user_role_permissions` → `permissions`, and a
 * user's permission set is the union of the keys their roles carry. There is no role name
 * in this file and none at any call site: a custom role called `exam-ops` holding
 * `attempt.read` and `attempt.void` is indistinguishable, everywhere above this line, from
 * any other way of holding those two keys. That is the property that makes custom roles
 * safe to offer — nothing downstream can behave differently for a role it has never heard
 * of, because nothing downstream ever learns the role.
 *
 * **The catalogue is closed even though roles are open.** `permission_key` is a foreign
 * key onto `permissions`, a table seeded by migration 0001 with no `INSERT` grant to
 * either application role (migration 0002, Group C). An organisation may assemble any
 * subset it likes and may not invent a key, which is what stops "custom role" from
 * becoming "custom permission" and is the existing control docs/14 T-021 relies on.
 *
 * **Tenancy is not a `WHERE` clause here.** The query runs inside `withOrg`, so row-level
 * security answers it: `user_role_assignments` is reachable only through a `users` row this
 * organisation can see, and `user_role_permissions` only through a `user_roles` row that is
 * either this organisation's or a global system role (migration 0002, A.3 and B.1). Asking
 * for another tenant's user returns the empty set rather than their permissions — and
 * returns it because of the policy, not because this function remembered to filter
 * (ADR-010).
 *
 * **Resolved per request, never cached in the session.** That is what makes a revoked
 * permission take effect on the next request rather than at the end of a session, and it
 * is why `staff-session.ts` can say a session carries no permissions at all.
 */

import { eq } from 'drizzle-orm';

import type { Permission } from '@assaybank/auth';
import type { UserId } from '@assaybank/contracts';
import { userRoleAssignments, userRolePermissions, type DbTransaction } from '@assaybank/db';

/**
 * The union of the permission keys this user's roles carry, in the organisation whose
 * context the transaction is running in.
 *
 * Returns the keys verbatim rather than narrowing them to `KnownPermission`. A key this
 * build does not recognise cannot reach a route check anyway — `can()` refuses anything
 * outside its catalogue — so filtering here would only hide the fact that the database and
 * the build disagree, at the one moment somebody would want to know.
 *
 * An empty set is a normal answer: a user with no roles, an archived user, or a user id
 * belonging to another organisation. None of the three is distinguishable from here, and
 * none of them should be.
 */
export async function resolvePermissions(
  tx: DbTransaction,
  userId: UserId,
): Promise<ReadonlySet<Permission>> {
  const rows = await tx
    .select({ key: userRolePermissions.permissionKey })
    .from(userRoleAssignments)
    .innerJoin(
      userRolePermissions,
      eq(userRolePermissions.userRoleId, userRoleAssignments.userRoleId),
    )
    .where(eq(userRoleAssignments.userId, userId));

  return new Set(rows.map((row) => row.key));
}
