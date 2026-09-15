/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Section 8 of docs/hiring_platform_schema.sql — live interviews.
 *
 * `doc_state` is the final Yjs snapshot of the shared document (ADR-005). `apps/collab`
 * writes it on an interval so that the work lost to a node crash or a rolling restart is
 * bounded by `COLLAB_SNAPSHOT_INTERVAL_MS` rather than by the length of the interview —
 * a candidate never loses work is the first of the five rules in docs/17 §0.
 *
 * `session_events` is the replay stream: edits, runs, pastes, language changes and, per
 * ADR-017, the candidate's own AI prompts and the responses they got. Recording AI use
 * is the one AI-adjacent capability ADR-011 permits, because it records what the
 * candidate did rather than inferring anything about them. The interviewer sees it as
 * part of the record; nothing computes a verdict from it.
 *
 * The table is high volume and is converted to monthly range partitions by
 * `infra/postgres/init/04-partitions.sql` today, and by a reviewed migration in this
 * package when it first carries real volume (M3).
 */

import { sql } from 'drizzle-orm';
import {
  bigserial,
  check,
  index,
  jsonb,
  pgTable,
  text,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

import { applications, candidates } from './candidates-attempts.js';
import { bytea, tstz } from './columns.js';
import { jobRoles } from './job-roles.js';
import { orgRef, users } from './tenancy-rbac.js';

export const interviewSessions = pgTable('interview_sessions', {
  id: uuid('id')
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  orgId: orgRef(),
  applicationId: uuid('application_id').references((): AnyPgColumn => applications.id),
  jobRoleId: uuid('job_role_id').references((): AnyPgColumn => jobRoles.id),
  title: text('title'),
  /** A short shareable join code. Globally unique, so joining needs no org context. */
  roomCode: text('room_code').notNull().unique('interview_sessions_room_code_key'),
  scheduledAt: tstz('scheduled_at'),
  startedAt: tstz('started_at'),
  endedAt: tstz('ended_at'),
  /** The final Yjs document snapshot. Binary, not base64 text. */
  docState: bytea('doc_state'),
  /** Object-store key territory, not a public URL. Retention is swept (docs/11 §4.1). */
  recordingUrl: text('recording_url'),
  status: text('status').notNull().default('scheduled'),
  createdBy: uuid('created_by').references((): AnyPgColumn => users.id),
});

/**
 * Who was in the room. Exactly one of `user_id` and `candidate_id` is set — a
 * participant is either staff or the candidate, never both and never neither, and that
 * is a `CHECK` rather than a convention because the interviewer-versus-candidate
 * distinction decides what the replay shows to whom.
 */
export const sessionParticipants = pgTable(
  'session_participants',
  {
    sessionId: uuid('session_id')
      .notNull()
      .references((): AnyPgColumn => interviewSessions.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').references((): AnyPgColumn => users.id),
    candidateId: uuid('candidate_id').references((): AnyPgColumn => candidates.id),
    /** `interviewer` | `candidate` | `observer`. */
    participantRole: text('participant_role').notNull(),
    joinedAt: tstz('joined_at'),
    leftAt: tstz('left_at'),
  },
  () => [check('session_participants_check', sql`num_nonnulls(user_id, candidate_id) = 1`)],
);

/** The keystroke and event stream for replay. Partitioned by month; archived after ~90 days. */
export const sessionEvents = pgTable(
  'session_events',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    sessionId: uuid('session_id')
      .notNull()
      .references((): AnyPgColumn => interviewSessions.id, { onDelete: 'cascade' }),
    at: tstz('at').notNull().defaultNow(),
    /** `candidate` | `interviewer`. */
    actor: text('actor').notNull(),
    /** `edit` | `run` | `paste` | `language_change` | `ai_prompt`. */
    eventType: text('event_type').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
  },
  (t) => [index('session_events_session_id_at_idx').on(t.sessionId, t.at)],
);
