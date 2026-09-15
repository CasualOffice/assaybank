/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The list of tenant tables, derived from the schema rather than written down.
 *
 * ADR-010 is only worth anything if it is complete, and "complete" means no tenant table
 * was missed. A hand-maintained list does not have that property: the one table someone
 * forgets to add to it is exactly the one that leaks. So the list is computed by walking
 * the Drizzle schema for a column literally named `org_id`, and the generated suite in
 * `tests/rls.test.ts` loops over the result. A tenant table added in P2 with no policy
 * therefore fails CI on the day it is added, with no further wiring.
 *
 * The one table this cannot find is `organizations`, whose tenant key is `id` rather
 * than `org_id`. It is named separately in {@link TENANT_ROOT_TABLE} and tested
 * explicitly, so it is not a gap — but it is the reason the constant below is
 * "tables carrying org_id" and not "tables subject to isolation".
 */

import { getTableColumns, getTableName, is } from 'drizzle-orm';
import { PgTable, type PgColumn } from 'drizzle-orm/pg-core';

import { schema } from './schema/index.js';

/** The column name that marks a row as belonging to one organisation. */
export const TENANT_KEY_COLUMN = 'org_id';

/**
 * The tenancy root. Keyed on `id`, not `org_id`, so it does not appear in
 * {@link TENANT_TABLES} and gets its own assertions in the isolation suite.
 */
export const TENANT_ROOT_TABLE = 'organizations';

/**
 * Tables in `public` that deliberately have no row-level security, each with the reason.
 *
 * `permissions` is the fixed catalogue of permission keys — part of the product, not of
 * a customer's configuration. It is isolated by having no write grant rather than by a
 * policy, which is the stronger guarantee for read-only reference data.
 */
export const RLS_EXEMPT_TABLES: Readonly<Record<string, string>> = {
  permissions:
    'Global reference data. Read-only to tenants by grant rather than by policy; it has ' +
    'no tenant dimension and never will.',
};

/**
 * The tables in {@link schema}, as Drizzle objects.
 *
 * `schema` holds only tables today — enums live beside it, not in it — and
 * `src/schema/schema.test.ts` asserts that. The runtime filter is here anyway so that
 * the day someone adds a `pgEnum` to the object, this list quietly stays correct instead
 * of producing a table named `undefined`.
 */
const TABLES = Object.values(schema).filter((value) => is(value, PgTable));

/**
 * The columns of one table, typed. `getTableColumns` is generic over the exact table, so
 * calling it across a heterogeneous list widens to `any` unless the parameter is narrowed
 * to the base type first — and `any` is what would let a renamed tenant key slip past the
 * check below unnoticed.
 */
const columnsOf = (table: PgTable): PgColumn[] => Object.values(getTableColumns(table));

/** Every table in the schema, by its PostgreSQL name, sorted. */
export const ALL_TABLES: readonly string[] = TABLES.map((table) => getTableName(table)).sort(
  (a, b) => a.localeCompare(b),
);

/**
 * The nullable-`org_id` tables, derived the same way.
 *
 * `NULL` there means "global, shared by every tenant" rather than "not yet assigned", and
 * it is what the asymmetric policy in migration 0002 is written for: `USING` admits the
 * global rows so a tenant can read the shared taxonomy, `WITH CHECK` refuses them so no
 * tenant can create, edit or claim one. An org that could write `org_id = NULL` would be
 * editing every other org's taxonomy.
 *
 * The isolation suite still covers these unchanged: a row belonging to org B is not
 * `NULL`, so org A must not see it either way.
 */
export const GLOBAL_ROW_TABLES: readonly string[] = TABLES.filter((table) =>
  columnsOf(table).some((column) => column.name === TENANT_KEY_COLUMN && !column.notNull),
)
  .map((table) => getTableName(table))
  .sort((a, b) => a.localeCompare(b));

/**
 * Every table carrying an `org_id` column, sorted, derived from the schema definition.
 *
 * This is the input to the generated isolation suite. Adding a table with `org_id`
 * extends that suite automatically; adding one without a policy fails it.
 */
export const TENANT_TABLES: readonly string[] = TABLES.filter((table) =>
  columnsOf(table).some((column) => column.name === TENANT_KEY_COLUMN),
)
  .map((table) => getTableName(table))
  .sort((a, b) => a.localeCompare(b));

/**
 * Tables with neither an `org_id` of their own nor a named exemption: they reach their
 * organisation through a foreign key and their policy walks that key.
 *
 * Exported so the migration-text test can assert that every one of them is accounted
 * for too — "no table was missed" has to cover the child tables, since a leaked
 * `mcq_options` row is a leaked answer key whether or not the table has a tenant column.
 */
export const DERIVED_TENANT_TABLES: readonly string[] = ALL_TABLES.filter(
  (name) =>
    name !== TENANT_ROOT_TABLE &&
    !TENANT_TABLES.includes(name) &&
    !Object.hasOwn(RLS_EXEMPT_TABLES, name),
);
