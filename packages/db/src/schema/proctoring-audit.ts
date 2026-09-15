/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Section 10 of docs/hiring_platform_schema.sql — proctoring signals and the audit log.
 *
 * **Signals only.** ADR-007 and ADR-017: nothing reads `proctor_events` or
 * `proctor_media` and rejects, voids or down-scores. A signal enters a human review
 * queue with its evidence attached, and that is the whole of what it does. The signals
 * are weak, their errors are not distributed evenly across candidates, and an employment
 * decision made automatically on weak evidence is both unfair and a regulated exposure.
 * There is deliberately no column here that could hold a computed verdict.
 *
 * `proctor_media.delete_after` is a retention commitment, not a hint. Biometric media is
 * swept by the worker on this column (docs/11 §4.1); explicit deletion is slower than a
 * bucket lifecycle rule and is auditable and portable, which a provider feature is not
 * (ADR-014).
 *
 * `audit_log` is a **domain record, not telemetry** (docs/17 §9). It lives in Postgres,
 * is append-only, is queryable, and is retained for seven years. It carries `org_id`
 * with no foreign key on purpose: an audit row must survive the hard deletion of the
 * entity it describes, because GDPR erasure removes the candidate and not the record
 * that the candidate's attempt was voided.
 */

import { sql } from 'drizzle-orm';
import {
  bigserial,
  check,
  index,
  inet,
  jsonb,
  pgTable,
  smallint,
  text,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

import { attempts } from './candidates-attempts.js';
import { tstz } from './columns.js';
import { users } from './tenancy-rbac.js';

/** Advisory integrity signals. Partitioned by month; archived after ~90 days. */
export const proctorEvents = pgTable(
  'proctor_events',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    attemptId: uuid('attempt_id')
      .notNull()
      .references((): AnyPgColumn => attempts.id, { onDelete: 'cascade' }),
    at: tstz('at').notNull().defaultNow(),
    /**
     * `tab_blur` | `fullscreen_exit` | `paste` | `copy` | `devtools_open` | `multi_face` |
     * `no_face` | `second_screen`.
     */
    eventType: text('event_type').notNull(),
    /** 1-3. A reviewer's triage order, never an input to a score. */
    severity: smallint('severity').notNull().default(1),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
  },
  (t) => [
    check('proctor_events_severity_check', sql`severity BETWEEN 1 AND 3`),
    index('proctor_events_attempt_id_at_idx').on(t.attemptId, t.at),
  ],
);

/** Webcam snapshots, screen clips and ID photos. Biometric data with a delete clock. */
export const proctorMedia = pgTable('proctor_media', {
  id: uuid('id')
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  attemptId: uuid('attempt_id')
    .notNull()
    .references((): AnyPgColumn => attempts.id, { onDelete: 'cascade' }),
  /** `webcam_snapshot` | `screen_clip` | `id_photo`. */
  kind: text('kind').notNull(),
  /** An S3/R2 object key. Never a public URL — access is always through a signed read. */
  objectKey: text('object_key').notNull(),
  capturedAt: tstz('captured_at').notNull(),
  /** Not null, by design. Biometrics are not kept forever (docs/11). */
  deleteAfter: tstz('delete_after').notNull(),
});

/**
 * The append-only audit log.
 *
 * Both application roles may INSERT and SELECT; neither may UPDATE or DELETE, revoked in
 * migration 0002. That revocation is the counterweight to the job role's `BYPASSRLS`
 * (ADR-010): a background write that cannot be constrained by a policy must at least be
 * reconstructable afterwards, and history that can be rewritten is not a record.
 */
export const auditLog = pgTable(
  'audit_log',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    /** No foreign key: the audit row outlives the organisation's erased entities. */
    orgId: uuid('org_id').notNull(),
    /** Null for a background job. ADR-010 requires those to carry a `job.` action prefix. */
    actorUserId: uuid('actor_user_id').references((): AnyPgColumn => users.id),
    /** `question.publish`, `attempt.void`, `score.override`, `job.grade`. */
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id'),
    before: jsonb('before').$type<Record<string, unknown>>(),
    after: jsonb('after').$type<Record<string, unknown>>(),
    ip: inet('ip'),
    at: tstz('at').notNull().defaultNow(),
  },
  (t) => [index('audit_log_org_id_at_idx').on(t.orgId, t.at.desc())],
);
