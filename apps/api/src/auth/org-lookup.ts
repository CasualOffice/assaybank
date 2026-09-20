/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The first thing a login has to work out: which organisation is this?
 *
 * Every tenant policy is `org_id = app.current_org` and `app_current_org()` is `NULL`
 * until something sets it, which denies rather than admits (migration 0002). A login
 * arrives with no session, so nothing has set it, so `users` cannot be read — and the
 * organisation the login belongs to is written in `users`. Migration 0006 breaks the
 * circle with two `SECURITY DEFINER` functions that each return one `uuid` and nothing
 * else, in exactly the shape migration 0005 already uses for candidate redemption.
 *
 * This module is the only caller of either function. Everything it returns is fed
 * straight into `withOrg`, after which the ordinary policies are back in force for the
 * rest of the request.
 *
 * **What an absent answer means, and what it must not mean.** `undefined` covers three
 * different situations — no such address, an address held in two organisations, no such
 * slug — and the caller is required to treat all three identically to a wrong password.
 * Anything else turns this lookup into the account-enumeration oracle that docs/14
 * `H-176` exists to close. That is why these functions return `OrgId | undefined` rather
 * than throwing distinguishable errors: there is no error to distinguish.
 *
 * **Why the lookup runs through `withElevated` and not `withOrg`.** It cannot run through
 * `withOrg` — there is no org yet, which is the entire problem. `withElevated` uses the
 * background-job role, which bypasses row-level security, and writes an `audit_log` row
 * naming the reason inside the same transaction (ADR-010). That trail is not a
 * side-benefit here; an unauthenticated request causing a privileged read is exactly the
 * thing that should leave a record, and the record is what makes a password-spraying run
 * visible afterwards rather than only in a rate-limit counter.
 */

import { sql } from 'drizzle-orm';

import { OrgIdSchema, type OrgId } from '@assaybank/contracts';
import { withElevated, type Database } from '@assaybank/db';

/**
 * The `audit_log.action` written for a login's tenant lookup.
 *
 * `job.`-prefixed because `withElevated` requires it — the prefix is what distinguishes a
 * machine actor from an unattributed human when the row is read back years later — and
 * specific enough to grep for. A spike of these with no matching `auth.login` success is
 * a credential-stuffing run in progress.
 */
export const LOGIN_ORG_LOOKUP_ACTION = 'job.staff_login_org_lookup';

/**
 * What the three SQL functions return: one nullable column.
 *
 * A `type` rather than an `interface`, because `tx.execute<T>` constrains `T` to
 * `Record<string, unknown>` and only a type alias gets the implicit index signature that
 * satisfies it. Not a style preference — an interface here does not compile.
 */
type OrgIdRow = { org_id: string | null };

/**
 * Parses the function's result into a branded id.
 *
 * `safeParse`, not `parse`: a malformed uuid coming back from our own database would be
 * an internal defect, but the sensible reaction on an unauthenticated login path is still
 * "no organisation" rather than a 500 that tells the caller their address produced
 * something unusual.
 */
function toOrgId(rows: readonly OrgIdRow[]): OrgId | undefined {
  const value = rows[0]?.org_id;
  if (value === null || value === undefined) return undefined;
  const parsed = OrgIdSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/**
 * The organisation whose active staff includes `email`, when there is exactly one.
 *
 * `users` is unique on `(org_id, email)`, so the same address may legitimately exist in
 * two organisations; the function returns nothing in that case rather than choosing whose
 * password to check. A client that needs to disambiguate names its organisation, and the
 * login route calls {@link resolveOrgBySlug} instead.
 */
export async function resolveOrgForStaffEmail(
  db: Database,
  email: string,
): Promise<OrgId | undefined> {
  return withElevated(db, { reason: LOGIN_ORG_LOOKUP_ACTION, entityType: 'user' }, async (tx) => {
    // Parameterised, and cast to citext in SQL rather than lower-cased in JavaScript:
    // the column is citext, so the database's collation decides what "the same address"
    // means, and a second opinion here would eventually disagree with it (docs/17 §7 —
    // never interpolate, even a value that looks harmless).
    const rows = await tx.execute<OrgIdRow>(
      sql`SELECT public.staff_login_org_for_email(${email}::citext) AS org_id`,
    );
    return toOrgId(rows);
  });
}

/**
 * The organisation with this slug, if one exists.
 *
 * Used when a client names its organisation — a login page served at a per-organisation
 * URL, or an OIDC start that has to know whose identity provider to redirect to. It
 * discloses only whether a slug exists, which a URL containing the slug has already
 * disclosed to whoever is asking.
 */
export async function resolveOrgBySlug(db: Database, slug: string): Promise<OrgId | undefined> {
  return withElevated(
    db,
    { reason: LOGIN_ORG_LOOKUP_ACTION, entityType: 'organization' },
    async (tx) => {
      const rows = await tx.execute<OrgIdRow>(
        sql`SELECT public.staff_login_org_for_slug(${slug}) AS org_id`,
      );
      return toOrgId(rows);
    },
  );
}

/**
 * The only organisation, when this deployment has exactly one.
 *
 * Self-hosting usually means one organisation and a console that has never heard of a
 * slug, and docs/03 §1 documents `POST /auth/oidc/start` as taking `{provider}` with no
 * organisation in it at all. This is what makes the documented request work. A deployment
 * with two organisations gets `undefined` and the caller must say which — the same
 * refusal-to-guess as an address held twice.
 */
export async function resolveSoleOrg(db: Database): Promise<OrgId | undefined> {
  return withElevated(
    db,
    { reason: LOGIN_ORG_LOOKUP_ACTION, entityType: 'organization' },
    async (tx) => {
      const rows = await tx.execute<OrgIdRow>(sql`SELECT public.staff_login_sole_org() AS org_id`);
      return toOrgId(rows);
    },
  );
}

/**
 * The organisation a sign-in attempt is for: the named one, or the one the address
 * belongs to.
 *
 * The slug wins when it is present, and a slug that resolves to nothing is *not* retried
 * by email. A client that named an organisation and got a different one would be a client
 * whose login page silently signed somebody into the wrong tenant.
 */
export async function resolveLoginOrg(
  db: Database,
  attempt: { readonly email: string; readonly orgSlug?: string | undefined },
): Promise<OrgId | undefined> {
  if (attempt.orgSlug !== undefined && attempt.orgSlug !== '') {
    return resolveOrgBySlug(db, attempt.orgSlug);
  }
  return resolveOrgForStaffEmail(db, attempt.email);
}
