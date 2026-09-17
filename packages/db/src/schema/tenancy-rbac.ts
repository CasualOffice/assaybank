/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Section 1 of docs/hiring_platform_schema.sql — tenancy, users and RBAC.
 *
 * `organizations` is the root of the tenancy graph: it is keyed on `id` rather than
 * `org_id`, and its row-level-security policy compares `id` to `app.current_org`
 * (ADR-010). Every other tenant table reaches it through {@link orgRef}.
 *
 * "User roles" here are who can do what inside the tool. They are not job roles — the
 * positions being hired for — which live in `./job-roles.ts`. The schema file says "do
 * not merge these" and it is right: they have different lifecycles, different owners and
 * different permissions.
 */

import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  unique,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

import { citext, tstz } from './columns.js';

/** The tenancy root. One row per customer organisation. */
export const organizations = pgTable('organizations', {
  id: uuid('id')
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique('organizations_slug_key'),
  settings: jsonb('settings').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: tstz('created_at').notNull().defaultNow(),
});

/**
 * The tenant key every tenant-scoped table carries.
 *
 * Declared once so the column name, the type, the foreign key and the cascade are
 * identical on all fifteen of them. `src/rls-tables.ts` derives `TENANT_TABLES` by
 * looking for a column literally named `org_id`, so a table that spells its tenant key
 * differently is a table the RLS suite will not cover — which is exactly why there is
 * one helper rather than fifteen hand-written columns.
 *
 * `onDelete: 'cascade'` is the schema file's choice: removing an organisation removes
 * its data. `audit_log` deliberately does not use this helper (see
 * `./proctoring-audit.ts`).
 */
export const orgRef = () =>
  uuid('org_id')
    .notNull()
    .references((): AnyPgColumn => organizations.id, { onDelete: 'cascade' });

/**
 * A nullable tenant key, for the two tables where `NULL` means "global, shared by every
 * tenant": the system role definitions and the global skill taxonomy.
 */
export const optionalOrgRef = () =>
  uuid('org_id').references((): AnyPgColumn => organizations.id, { onDelete: 'cascade' });

/** Staff: recruiters, interviewers, reviewers and administrators. Candidates are not users. */
export const users = pgTable(
  'users',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    orgId: orgRef(),
    email: citext('email').notNull(),
    fullName: text('full_name').notNull(),
    /**
     * From `docs/hiring_platform_schema.sql`, and **not** where a password lives.
     *
     * Staff credentials are Better Auth's `account` model, which is
     * `staff_accounts.password` (see `./staff-identity.ts`). This column predates that
     * choice; migration 0006 leaves it in place rather than maintaining two copies of the
     * same secret, because two places to rotate a password is one place to forget. Never
     * a plaintext password, at any point, whichever column is being discussed.
     */
    passwordHash: text('password_hash'),
    ssoSubject: text('sso_subject'),
    timezone: text('timezone').notNull().default('UTC'),
    /**
     * Better Auth's `user.emailVerified`. Added by migration 0006.
     *
     * Defaults to `true` because there is no self-service staff sign-up to verify against
     * — an administrator or an identity provider created this row, and that act is the
     * verification. Nothing gates on it today (`requireEmailVerification` is off); the
     * column exists because the library's user model has it, and a model field with no
     * column is an insert that fails at 03:00 rather than at boot.
     */
    emailVerified: boolean('email_verified').notNull().default(true),
    /** Better Auth's `user.image`. An avatar URL from the IdP, when it offers one. */
    image: text('image'),
    archivedAt: tstz('archived_at'),
    createdAt: tstz('created_at').notNull().defaultNow(),
    /** Better Auth's `user.updatedAt`. Written by the library on every profile change. */
    updatedAt: tstz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    unique('users_org_id_email_key').on(t.orgId, t.email),
    // Partial: the common query is "the active staff of this org", and excluding the
    // archived rows keeps the index the size of the working set rather than of history.
    index('users_org_id_idx')
      .on(t.orgId)
      .where(sql`archived_at IS NULL`),
  ],
);

/**
 * RBAC roles, kept as data rather than an enum so an organisation can define its own.
 * `org_id IS NULL` marks a system role shared by every tenant.
 */
export const userRoles = pgTable(
  'user_roles',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    orgId: optionalOrgRef(),
    /** `admin` | `recruiter` | `interviewer` | `reviewer`, or an org's own key. */
    key: text('key').notNull(),
    name: text('name').notNull(),
    isSystem: boolean('is_system').notNull().default(false),
  },
  (t) => [
    unique('user_roles_org_id_key_key').on(t.orgId, t.key),
    // Global system roles need their own arbiter: NULLs are distinct for uniqueness, so the
    // constraint above admits two rows keyed `admin` with org_id NULL (migration 0011).
    uniqueIndex('user_roles_global_key_key')
      .on(t.key)
      .where(sql`org_id IS NULL`),
  ],
);

/**
 * The fixed catalogue of permission keys. Part of the product, not of a customer's
 * configuration, so it has no tenant dimension and never will — it is the one table in
 * `public` with no row-level security, isolated instead by having no write grant
 * (migration 0002, Group C).
 */
export const permissions = pgTable('permissions', {
  key: text('key').primaryKey(),
  description: text('description').notNull(),
});

/** Which permissions a role carries. */
export const userRolePermissions = pgTable(
  'user_role_permissions',
  {
    userRoleId: uuid('user_role_id')
      .notNull()
      .references((): AnyPgColumn => userRoles.id, { onDelete: 'cascade' }),
    permissionKey: text('permission_key')
      .notNull()
      .references((): AnyPgColumn => permissions.key, { onDelete: 'cascade' }),
  },
  (t) => [
    primaryKey({
      name: 'user_role_permissions_pkey',
      columns: [t.userRoleId, t.permissionKey],
    }),
  ],
);

/** Which roles a user holds. */
export const userRoleAssignments = pgTable(
  'user_role_assignments',
  {
    userId: uuid('user_id')
      .notNull()
      .references((): AnyPgColumn => users.id, { onDelete: 'cascade' }),
    userRoleId: uuid('user_role_id')
      .notNull()
      .references((): AnyPgColumn => userRoles.id, { onDelete: 'cascade' }),
    grantedAt: tstz('granted_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ name: 'user_role_assignments_pkey', columns: [t.userId, t.userRoleId] })],
);
