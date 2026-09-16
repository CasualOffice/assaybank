/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Bank import and export jobs: the outbox the API writes and the record the worker keeps
 * (migration 0010, ADR-021).
 *
 * Not in `docs/hiring_platform_schema.sql`'s original forty; added with the import routes. A
 * tenant table like any other — `org_id`, an RLS policy, and a place in the generated isolation
 * suite.
 */

import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

import { bytea, tstz } from './columns.js';
import { orgRef, users } from './tenancy-rbac.js';

export const bankJobs = pgTable(
  'bank_jobs',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    orgId: orgRef(),
    /** `import` | `export`. */
    kind: text('kind').notNull(),
    /** `json` | `qti`. */
    format: text('format').notNull(),
    /** `queued` → `dispatched` → `running` → `succeeded` | `failed`. */
    status: text('status').notNull().default('queued'),
    requestedBy: uuid('requested_by')
      .notNull()
      .references((): AnyPgColumn => users.id),
    options: jsonb('options')
      .notNull()
      .default(sql`'{}'::jsonb`),
    /** The uploaded file. Cleared when the job finishes. */
    input: bytea('input'),
    inputBytes: integer('input_bytes'),
    /** An export's file, readable until `expires_at`. */
    result: bytea('result'),
    resultContentType: text('result_content_type'),
    resultBytes: integer('result_bytes'),
    /** The import checkpoint: the position of the first item not yet written or refused. */
    nextIndex: integer('next_index').notNull().default(0),
    createdCount: integer('created_count').notNull().default(0),
    skippedCount: integer('skipped_count').notNull().default(0),
    problems: jsonb('problems')
      .notNull()
      .default(sql`'[]'::jsonb`),
    problemsTruncated: boolean('problems_truncated').notNull().default(false),
    failure: text('failure'),
    createdAt: tstz('created_at').notNull(),
    dispatchedAt: tstz('dispatched_at'),
    startedAt: tstz('started_at'),
    finishedAt: tstz('finished_at'),
    expiresAt: tstz('expires_at'),
  },
  (t) => [
    check('bank_jobs_kind_check', sql`kind IN ('import', 'export')`),
    check('bank_jobs_format_check', sql`format IN ('json', 'qti')`),
    check(
      'bank_jobs_status_check',
      sql`status IN ('queued', 'dispatched', 'running', 'succeeded', 'failed')`,
    ),
    check(
      'bank_jobs_input_bytes_check',
      sql`input_bytes IS NULL OR input_bytes BETWEEN 0 AND 33554432`,
    ),
    check(
      'bank_jobs_result_bytes_check',
      sql`result_bytes IS NULL OR result_bytes BETWEEN 0 AND 33554432`,
    ),
    check(
      'bank_jobs_counts_check',
      sql`next_index >= 0 AND created_count >= 0 AND skipped_count >= 0`,
    ),
    index('bank_jobs_org_id_created_at_idx').on(t.orgId, t.createdAt.desc()),
  ],
);
