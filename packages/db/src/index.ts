/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * @assaybank/db — Drizzle schema, migrations, row-level-security policies and seed data.
 *
 * Owns: the tables modelling docs/hiring_platform_schema.sql, the forward-only
 * expand-contract migration runner, `withOrg(orgId)` which scopes a transaction to one
 * organisation, and the generated RLS isolation suite in `tests/rls.test.ts`.
 *
 * Every tenant table carries org_id and an org_isolation policy; a table added without
 * one fails both the completeness check in migration 0002 and the generated suite
 * (ADR-010). No export hands out a raw connection that bypasses app.current_org —
 * `withOrg` and `withElevated` are the entire query surface, and the pools are held in a
 * module-private WeakMap so there is nothing else to reach for.
 *
 * Contains no business rules. Deciding *which* rows to read is the caller's job; this
 * package only guarantees that the rows it can reach belong to the right tenant.
 */

export { createDb, withElevated, withOrg } from './client.js';
export type { Database, DbConfig, DbOptions, DbTransaction, ElevationRecord } from './client.js';

export { MIGRATIONS_DIR, migrate } from './migrate.js';
export type { MigrateOptions, MigrateResult } from './migrate.js';

export {
  ALL_TABLES,
  DERIVED_TENANT_TABLES,
  GLOBAL_ROW_TABLES,
  RLS_EXEMPT_TABLES,
  TENANT_KEY_COLUMN,
  TENANT_ROOT_TABLE,
  TENANT_TABLES,
} from './rls-tables.js';

export * from './schema/index.js';

/**
 * The workspace's own package name. Exported so a bootstrap can name itself in a log
 * line or a span resource without a second source of truth, and so this module has a
 * real export from the first commit.
 */
export const WORKSPACE_NAME = '@assaybank/db';
