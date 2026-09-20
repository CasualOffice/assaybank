/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The two tables Better Auth needs that `docs/hiring_platform_schema.sql` does not have.
 *
 * The schema file models the product: organisations, staff, questions, attempts. It does
 * not model *how a staff member proves who they are*, because that is a library's
 * concern and the library was chosen later (docs/14 T-014 names Better Auth). Better
 * Auth has four models — `user`, `session`, `account`, `verification` — and this file
 * supplies the two of them that must be rows in Postgres:
 *
 * | Better Auth model | Here | Why |
 * |---|---|---|
 * | `user` | the existing `users` table | Staff already exist. Migration 0006 adds the three columns Better Auth's model expects (`email_verified`, `image`, `updated_at`) rather than creating a second, competing notion of a person. |
 * | `session` | **not a table** | Sessions live in Valkey, through Better Auth's `secondaryStorage`. See below — this is a tenancy decision, not a performance one. |
 * | `account` | {@link staffAccounts} | Where the password hash and the OIDC provider link live. |
 * | `verification` | {@link staffVerifications} | Short-lived OIDC `state` and PKCE material, consumed exactly once. |
 *
 * ## Why sessions are not in Postgres
 *
 * Every tenant table's policy is `org_id = app.current_org` (ADR-010), and
 * `app.current_org` comes from the authenticated session. A `staff_sessions` table would
 * therefore have to be read *before* the organisation is known, to discover the
 * organisation — a circular dependency whose only resolutions are a role that bypasses
 * row-level security on the request path, or a policy-free session table. Both are worse
 * than the third option: the session lives in Valkey, keyed by its own token, and the
 * blob it stores carries the user row (including `org_id`) that Better Auth cached when
 * the session was created. Resolving a cookie to an organisation then touches no
 * tenant-scoped row at all, and the first thing that *does* touch one already knows which
 * organisation to claim.
 *
 * Two consequences worth stating. Revocation is immediate and cheap, which is what the
 * incident playbook in docs/14 §10 asks for ("invalidate all sessions for the affected
 * user"). And a Valkey flush logs every staff user out — an inconvenience, never a data
 * loss, and candidates are unaffected because their credential is a signed token rather
 * than a stored session (docs/03 §1).
 *
 * ## Both tables are tenant tables, and neither could have been skipped
 *
 * `org_id` is `NOT NULL` on both, with `DEFAULT public.app_current_org()`. The default is
 * load-bearing: Better Auth has no idea this system is multi-tenant and will never supply
 * the column, so the value comes from the transaction the insert runs in — the same
 * transaction whose `WITH CHECK` clause then verifies it. An insert outside `withOrg`
 * gets `NULL` and fails the `NOT NULL`, which is the correct outcome rather than a row
 * belonging to nobody.
 *
 * `staff_verifications` carrying a tenant key deserves a note, because the row is written
 * *before* anyone has authenticated. It is written by `POST /auth/oidc/start`, which has
 * already resolved which organisation the sign-in is for, so the organisation is known
 * even though the person is not. Scoping it means one tenant's OIDC flow cannot consume
 * another's state, which is the cross-tenant half of docs/14 `H-150`.
 */

import { sql } from 'drizzle-orm';
import { index, pgTable, text, unique, uuid, type AnyPgColumn } from 'drizzle-orm/pg-core';

import { tstz } from './columns.js';
import { organizations, users } from './tenancy-rbac.js';

/**
 * The tenant key for a row Better Auth inserts.
 *
 * Identical to `orgRef()` in `./tenancy-rbac.ts` except for the default, and it has to be
 * a separate helper rather than a parameter on that one: `orgRef` is used by fifteen
 * tables where the application supplies `org_id` explicitly, and giving *those* a default
 * would turn "the developer forgot the tenant key" from an error into a row silently
 * attributed to whatever transaction happened to be open.
 *
 * `src/rls-tables.ts` finds these tables by looking for a column literally named
 * `org_id`, so both spellings land in `TENANT_TABLES` and in the generated isolation
 * suite regardless.
 */
const authoredOrgRef = () =>
  uuid('org_id')
    .notNull()
    .default(sql`public.app_current_org()`)
    .references((): AnyPgColumn => organizations.id, { onDelete: 'cascade' });

/**
 * Better Auth's `account` model: one row per way a user can prove who they are.
 *
 * Two providers exist in this system. `provider_id = 'credential'` is a password, and the
 * Argon2id hash lives in {@link staffAccounts.password} — note that
 * `users.password_hash` is *not* that hash; it predates the library choice and migration
 * 0006 leaves it alone rather than maintaining two copies of the same secret. The OIDC
 * provider uses its own `provider_id` with `account_id` set to the IdP's subject claim.
 *
 * Column names are Better Auth's model names in snake_case, and the Drizzle property
 * names are Better Auth's field names exactly. That is not cosmetic: the Drizzle adapter
 * resolves a model field to `table[fieldName]`, so a property spelled differently would
 * need a `fields` mapping entry, and a missing entry is a runtime error on a login rather
 * than a compile error.
 */
export const staffAccounts = pgTable(
  'staff_accounts',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    orgId: authoredOrgRef(),
    userId: uuid('user_id')
      .notNull()
      .references((): AnyPgColumn => users.id, { onDelete: 'cascade' }),
    /** The identifier at the provider: the user's own id for a password, the `sub` for OIDC. */
    accountId: text('account_id').notNull(),
    /** `credential` for a password, or the configured OIDC provider id. */
    providerId: text('provider_id').notNull(),
    /**
     * The Argon2id hash, for `provider_id = 'credential'` only. Null for every federated
     * account, which is what makes "this organisation is IdP-only" expressible as data.
     */
    password: text('password'),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: tstz('access_token_expires_at'),
    refreshTokenExpiresAt: tstz('refresh_token_expires_at'),
    scope: text('scope'),
    createdAt: tstz('created_at').notNull().defaultNow(),
    updatedAt: tstz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    // Global rather than per-organisation on purpose. An IdP subject identifies one human
    // at one identity provider; letting the same `(provider, subject)` pair map to staff
    // rows in two organisations would mean one federated identity silently holding two
    // sets of permissions, which is the multi-tenant shape of docs/14 T-015.
    unique('staff_accounts_provider_id_account_id_key').on(t.providerId, t.accountId),
    index('staff_accounts_user_id_idx').on(t.userId),
  ],
);

/**
 * Better Auth's `verification` model: the OIDC `state` and PKCE verifier, in flight.
 *
 * Rows live for minutes and are consumed exactly once — Better Auth deletes the row as
 * part of validating the callback, which is what makes a replayed `code` fail with a
 * state mismatch rather than logging somebody in twice (docs/14 `H-150`).
 *
 * `value` holds provider material and is therefore a short-lived secret. It is not
 * hashed, because unlike an invitation token it is never presented by the holder as a
 * credential: the callback proves possession of the PKCE verifier against the challenge
 * this row stores, and a stolen row without the browser's state cookie is not enough.
 */
export const staffVerifications = pgTable(
  'staff_verifications',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    orgId: authoredOrgRef(),
    /** What is being verified — the `state` parameter, for the OIDC flow. */
    identifier: text('identifier').notNull(),
    /** The material being held against it. Opaque to this package. */
    value: text('value').notNull(),
    expiresAt: tstz('expires_at').notNull(),
    createdAt: tstz('created_at').notNull().defaultNow(),
    updatedAt: tstz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('staff_verifications_identifier_idx').on(t.identifier),
    // The sweep that deletes expired rows reads this. Without it the cleanup is a
    // sequential scan of a table that only ever grows between sweeps.
    index('staff_verifications_expires_at_idx').on(t.expiresAt),
  ],
);
