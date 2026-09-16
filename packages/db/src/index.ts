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
 * (ADR-010), and `tests/rls.test.ts` proves that by building such a table and watching
 * both catch it. No export hands out a raw connection that bypasses app.current_org —
 * `withOrg` and `withElevated` are the entire query surface, and the pools are held in a
 * module-private WeakMap so there is nothing else to reach for. `withOrg` additionally
 * refuses a connection that arrived carrying a previous checkout's organisation, and
 * `withElevated` writes its own audit_log row inside the transaction it elevates.
 *
 * It also owns the audit writer. `writeAudit(tx, entry)` takes a transaction and never a
 * pool, so an audit row can only be written in the same transaction as the action it
 * records; migration 0004 makes the table append-only with a trigger that binds the
 * owner as well as the application roles, and refuses to store a voiding, an override, a
 * re-grade or an elevated access with no reason (FR-21, FR-25, ADR-010).
 *
 * Contains no business rules. Deciding *which* rows to read is the caller's job; this
 * package only guarantees that the rows it can reach belong to the right tenant, and
 * that whatever it did to them is on the record.
 */

export {
  AUDIT_ACTOR_ATTEMPT_KEY,
  AUDIT_REASON_KEY,
  AuditEntryError,
  AuditReasonRequiredError,
  CANDIDATE_ACTION_PREFIX,
  JOB_ACTION_PREFIX,
  MAX_ACTION_LENGTH,
  MAX_ENTITY_TYPE_LENGTH,
  MAX_PAYLOAD_BYTES,
  MAX_REASON_LENGTH,
  REASON_REQUIRED_ACTIONS,
  isAuditableAddress,
  prepareAuditEntry,
  requiresReason,
  writeAudit,
} from './audit.js';
export type {
  AuditActor,
  AuditEntry,
  AuditEntryId,
  AuditPayload,
  PreparedAuditEntry,
  ReasonRequiredAction,
} from './audit.js';

export { createDb, OrgContextLeakError, PLATFORM_ORG_ID, withElevated, withOrg } from './client.js';
export type {
  Database,
  DbConfig,
  DbOptions,
  DbTransaction,
  Elevation,
  ElevationRecord,
} from './client.js';

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
