/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Candidates, invitations and publishing (`H-182`, docs/18 §2.4).
 *
 * ## A candidate row is created by being invited
 *
 * There is no "add candidate" step, and deliberately so: the first thing anybody does with a
 * candidate is invite them, and a separate creation step would be a form to fill in before
 * the useful one. `upsertCandidate` is keyed on `(org_id, email)` — the same person invited
 * to a second assessment is the same row, which is what makes "has this person sat anything
 * for us before" answerable later.
 *
 * `citext` on `email` means the match is case-insensitive at the database, so `Ada@x` and
 * `ada@x` cannot become two candidates. That is the column's job rather than a `lower()` in
 * application code, which only the call sites that remember it would apply.
 *
 * ## The token is never here in plaintext
 *
 * `createInvitation` takes a hash. The caller mints the token, hands the hash here and the
 * plaintext to the response, and nothing in this module can read a live link back — which is
 * the property that makes a database copy insufficient to sit somebody's assessment.
 */

import { sql } from 'drizzle-orm';

import type { DbTransaction } from './client.js';

/** Finds or creates the candidate for one address. */
export async function upsertCandidate(
  tx: DbTransaction,
  input: { orgId: string; email: string; fullName?: string | undefined },
): Promise<string> {
  const rows = await tx.execute<{ id: string }>(sql`
    INSERT INTO candidates (org_id, email, full_name)
    VALUES (${input.orgId}::uuid, ${input.email}, ${input.fullName ?? null})
    ON CONFLICT (org_id, email) DO UPDATE
      SET full_name = coalesce(candidates.full_name, excluded.full_name)
    RETURNING id
  `);

  const id = rows[0]?.id;
  if (id === undefined) throw new Error('the candidate upsert returned no id');
  return id;
}

/**
 * The addresses of this assessment's invitations that are still live.
 *
 * "Live" is not expired and not fully used. A person whose invitation lapsed a month ago
 * should be re-invitable; a person holding a working link should not be handed a second one,
 * because two live links is two sittings nobody decided to allow.
 */
export async function liveInvitedEmails(
  tx: DbTransaction,
  assessmentId: string,
  now: Date,
): Promise<Set<string>> {
  const rows = await tx.execute<{ email: string }>(sql`
    SELECT lower(c.email::text) AS email
      FROM invitations i
      JOIN applications app ON app.id = i.application_id
      JOIN candidates c ON c.id = app.candidate_id
     WHERE i.assessment_id = ${assessmentId}::uuid
       AND i.expires_at > ${now.toISOString()}::timestamptz
       AND (
         SELECT count(*) FROM attempts t WHERE t.invitation_id = i.id
       ) < i.max_attempts
  `);
  return new Set(rows.map((row) => row.email));
}

/** What one invitation needs to exist. */
export interface CreateInvitationRecord {
  readonly orgId: string;
  readonly assessmentId: string;
  readonly applicationId: string;
  /** Peppered hash of the token. The plaintext never reaches this module. */
  readonly tokenHash: string;
  readonly expiresAt: Date;
  readonly maxAttempts: number;
  readonly createdBy: string;
}

export async function createInvitation(
  tx: DbTransaction,
  record: CreateInvitationRecord,
): Promise<string> {
  const rows = await tx.execute<{ id: string }>(sql`
    INSERT INTO invitations
      (org_id, application_id, assessment_id, token_hash, expires_at, max_attempts, created_by)
    VALUES (${record.orgId}::uuid, ${record.applicationId}::uuid, ${record.assessmentId}::uuid,
            ${record.tokenHash}, ${record.expiresAt.toISOString()}::timestamptz,
            ${record.maxAttempts}, ${record.createdBy}::uuid)
    RETURNING id
  `);

  const id = rows[0]?.id;
  if (id === undefined) throw new Error('the invitation insert returned no id');
  return id;
}

/**
 * The application an invitation hangs from, created if this candidate has none.
 *
 * An invitation's `candidate_id` is reached through `applications`, which is how redemption
 * finds who is sitting. `applications` needs a `job_opening_id`, and an assessment composed
 * from a role does not have one — so the role's opening is found or created here. It is
 * bookkeeping rather than a product concept today; when openings become a thing a recruiter
 * manages, this is the function that stops being right.
 */
export async function applicationFor(
  tx: DbTransaction,
  input: { orgId: string; candidateId: string; jobRoleId: string; title: string },
): Promise<string> {
  const openings = await tx.execute<{ id: string }>(sql`
    INSERT INTO job_openings (org_id, job_role_id, title, status)
    SELECT ${input.orgId}::uuid, ${input.jobRoleId}::uuid, ${input.title}, 'open'
     WHERE NOT EXISTS (
       SELECT 1 FROM job_openings
        WHERE org_id = ${input.orgId}::uuid
          AND title = ${input.title}
     )
    RETURNING id
  `);

  let openingId = openings[0]?.id;
  if (openingId === undefined) {
    const existing = await tx.execute<{ id: string }>(sql`
      SELECT id FROM job_openings
       WHERE org_id = ${input.orgId}::uuid AND title = ${input.title}
       ORDER BY opened_at LIMIT 1
    `);
    openingId = existing[0]?.id;
  }
  if (openingId === undefined) throw new Error('no job opening could be found or created');

  const apps = await tx.execute<{ id: string }>(sql`
    INSERT INTO applications (org_id, candidate_id, job_opening_id)
    VALUES (${input.orgId}::uuid, ${input.candidateId}::uuid, ${openingId}::uuid)
    ON CONFLICT (candidate_id, job_opening_id) DO UPDATE SET stage = applications.stage
    RETURNING id
  `);

  const id = apps[0]?.id;
  if (id === undefined) throw new Error('the application upsert returned no id');
  return id;
}

/** One invitation as the console lists it. Never the token. */
export interface InvitationRow {
  readonly id: string;
  readonly email: string;
  readonly fullName: string | null;
  readonly expiresAt: string;
  readonly sentAt: string | null;
  readonly sittingsTaken: number;
  readonly maxAttempts: number;
  readonly createdAt: string;
}

/** Every invitation to one assessment, newest first. */
export async function listInvitations(
  tx: DbTransaction,
  assessmentId: string,
): Promise<InvitationRow[]> {
  const rows = await tx.execute<{
    id: string;
    email: string;
    full_name: string | null;
    expires_at: Date | string;
    sent_at: Date | string | null;
    sittings_taken: number;
    max_attempts: number;
    created_at: Date | string;
  }>(sql`
    SELECT i.id, c.email::text AS email, c.full_name, i.expires_at, i.sent_at,
           (SELECT count(*)::int FROM attempts t WHERE t.invitation_id = i.id) AS sittings_taken,
           i.max_attempts, i.created_at
      FROM invitations i
      JOIN applications app ON app.id = i.application_id
      JOIN candidates c ON c.id = app.candidate_id
     WHERE i.assessment_id = ${assessmentId}::uuid
     ORDER BY i.created_at DESC, i.id
  `);

  return rows.map((row) => ({
    id: row.id,
    email: row.email,
    fullName: row.full_name,
    expiresAt: new Date(row.expires_at).toISOString(),
    sentAt: row.sent_at === null ? null : new Date(row.sent_at).toISOString(),
    sittingsTaken: row.sittings_taken,
    maxAttempts: row.max_attempts,
    createdAt: new Date(row.created_at).toISOString(),
  }));
}

/** An assessment's publishable facts: its status, and whether it has any rules at all. */
export async function assessmentPublishState(
  tx: DbTransaction,
  assessmentId: string,
): Promise<
  { status: string; jobRoleId: string | null; name: string; ruleCount: number } | undefined
> {
  const rows = await tx.execute<{
    status: string;
    job_role_id: string | null;
    name: string;
    rule_count: number;
  }>(sql`
    SELECT a.status::text AS status, a.job_role_id, a.name,
           (
             SELECT count(*)::int
               FROM section_rules sr
               JOIN assessment_sections s ON s.id = sr.section_id
              WHERE s.assessment_id = a.id
           ) AS rule_count
      FROM assessments a
     WHERE a.id = ${assessmentId}::uuid
  `);

  const row = rows[0];
  return row === undefined
    ? undefined
    : {
        status: row.status,
        jobRoleId: row.job_role_id,
        name: row.name,
        ruleCount: row.rule_count,
      };
}

/** Every rule of an assessment, for the feasibility re-check at publish. */
export async function assessmentRules(
  tx: DbTransaction,
  assessmentId: string,
): Promise<
  {
    skillIds: string[];
    kinds: string[];
    minDifficulty: number;
    maxDifficulty: number;
    pickCount: number;
  }[]
> {
  const rows = await tx.execute<{
    skill_ids: string[];
    kinds: string[];
    min_difficulty: number;
    max_difficulty: number;
    pick_count: number;
  }>(sql`
    SELECT sr.skill_ids::text[] AS skill_ids, sr.kinds::text[] AS kinds,
           sr.min_difficulty, sr.max_difficulty, sr.pick_count
      FROM section_rules sr
      JOIN assessment_sections s ON s.id = sr.section_id
     WHERE s.assessment_id = ${assessmentId}::uuid
     ORDER BY s.ordinal, sr.id
  `);

  return rows.map((row) => ({
    skillIds: row.skill_ids,
    kinds: row.kinds,
    minDifficulty: row.min_difficulty,
    maxDifficulty: row.max_difficulty,
    pickCount: row.pick_count,
  }));
}

/** Marks an assessment publishable-and-published. Returns false if it was not a draft. */
export async function publishAssessment(tx: DbTransaction, assessmentId: string): Promise<boolean> {
  // Guarded in the `WHERE`, not by a read-then-write: two recruiters publishing at once
  // should produce one transition and one conflict, not two.
  const rows = await tx.execute<{ id: string }>(sql`
    UPDATE assessments SET status = 'published'
     WHERE id = ${assessmentId}::uuid AND status <> 'published'
    RETURNING id
  `);
  return rows.length > 0;
}
