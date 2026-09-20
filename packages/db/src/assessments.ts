/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Assessments: the pool a rule would draw from, and the rows a composition becomes
 * (`H-179`, docs/18 §2.2).
 *
 * ## Why the availability query lives beside the coverage one
 *
 * "How many questions could this rule draw?" and "how well does the bank cover this role?"
 * are the same question asked with different filters, and the definition of *eligible* has to
 * be identical in both or the console shows one number and the draw finds another. Eligible
 * is: published, not archived, tagged with the skill, and its **current published version**
 * inside the difficulty band. `taxonomy.ts`'s coverage query is the original; this one adds
 * the kind filter a plan may carry and asks per rule rather than per role.
 *
 * The number is a snapshot and says so. It is true when asked and a colleague publishing a
 * question a second later makes it stale, which is why the draw checks feasibility again at
 * attempt start rather than trusting what composition recorded (ADR-004).
 *
 * ## Writing is one transaction or none
 *
 * An assessment is three tables — the row, its sections, their rules — and a partial write
 * leaves a paper that cannot be sat and looks like one that can. The caller's `withOrg`
 * transaction wraps all three.
 */

import { sql } from 'drizzle-orm';

import type { DbTransaction } from './client.js';

/** What makes a question eligible for one rule. */
export interface AvailabilityFilter {
  readonly skillId: string;
  /** Empty means no kind restriction, matching `section_rules.kinds`' `DEFAULT '{}'`. */
  readonly kinds: readonly string[];
  readonly minDifficulty: number;
  readonly maxDifficulty: number;
}

/**
 * How many published questions one rule could draw from, right now.
 *
 * One query per rule rather than one grouped query for all of them: a rule carries its own
 * band and its own kind list, so the grouping key is the rule itself, and a role has a
 * handful of required skills rather than thousands. If that stops being true this becomes a
 * lateral join, and the shape of the answer does not change.
 */
export async function countAvailable(
  tx: DbTransaction,
  filter: AvailabilityFilter,
): Promise<number> {
  // A list crosses into SQL as **one JSON parameter**, never as an array binding and never
  // by concatenation.
  //
  // Concatenation is out because CLAUDE.md forbids interpolating into SQL, and the fact
  // that these particular values come from a validated enum is exactly the reasoning that
  // would make the next call site, which does not, look safe too.
  //
  // Array binding is out because it does not survive this stack. Drizzle's template
  // flattens a JS array into one placeholder per element, so an empty list renders
  // `cardinality()` with no argument, and `sql.param` did not bind it as a single value
  // either — both produce the same opaque `42601` from Postgres, which says only "syntax
  // error" and points at nothing. A `jsonb` scalar is a plain parameter that behaves the
  // same whether the list holds none, one or twenty, and `jsonb_array_elements_text`
  // unpacks it server-side.
  const kindsJson = JSON.stringify([...filter.kinds]);
  const rows = await tx.execute<{ n: string }>(sql`
    SELECT count(DISTINCT q.id)::text AS n
      FROM question_skills qs
      JOIN questions q
        ON q.id = qs.question_id
       AND q.status = 'published'
       AND q.archived_at IS NULL
      JOIN question_versions qv ON qv.id = q.current_version_id
     WHERE qs.skill_id = ${filter.skillId}::uuid
       AND qv.difficulty BETWEEN ${filter.minDifficulty} AND ${filter.maxDifficulty}
       AND (
         jsonb_array_length(${kindsJson}::jsonb) = 0
         OR q.kind::text IN (SELECT jsonb_array_elements_text(${kindsJson}::jsonb))
       )
  `);
  return Number.parseInt(rows[0]?.n ?? '0', 10);
}

/** One rule to write. Mirrors `section_rules`. */
export interface SectionRuleRecord {
  readonly pickCount: number;
  readonly skillIds: readonly string[];
  readonly kinds: readonly string[];
  readonly minDifficulty: number;
  readonly maxDifficulty: number;
  readonly excludeSeenDays: number;
  readonly scorePerQuestion: number;
}

/** One section to write, with its rules. */
export interface SectionRecord {
  readonly name: string;
  readonly rules: readonly SectionRuleRecord[];
}

/** Everything a composition writes. */
export interface CreateAssessmentRecord {
  readonly orgId: string;
  readonly jobRoleId: string;
  readonly name: string;
  readonly durationSeconds: number;
  readonly createdBy: string;
  readonly sections: readonly SectionRecord[];
}

/** Writes an assessment, its sections and their rules. Returns the new id. */
export async function createAssessment(
  tx: DbTransaction,
  record: CreateAssessmentRecord,
): Promise<string> {
  const inserted = await tx.execute<{ id: string }>(sql`
    INSERT INTO assessments (org_id, job_role_id, name, duration_seconds, created_by)
    VALUES (${record.orgId}::uuid, ${record.jobRoleId}::uuid, ${record.name},
            ${record.durationSeconds}, ${record.createdBy}::uuid)
    RETURNING id
  `);

  const assessmentId = inserted[0]?.id;
  if (assessmentId === undefined) {
    // Unreachable through RLS — the insert names this organisation — and cheaper to state
    // than to reason about at the call site.
    throw new Error('the assessment insert returned no id');
  }

  for (const [index, section] of record.sections.entries()) {
    const sectionRows = await tx.execute<{ id: string }>(sql`
      INSERT INTO assessment_sections (assessment_id, ordinal, name)
      VALUES (${assessmentId}::uuid, ${index + 1}, ${section.name})
      RETURNING id
    `);
    const sectionId = sectionRows[0]?.id;
    if (sectionId === undefined) throw new Error('the section insert returned no id');

    for (const rule of section.rules) {
      // Both lists cross as one JSON parameter each and are unpacked server-side. See the
      // note in `countAvailable` for why this rather than an array binding.
      //
      // `coalesce` because `array_agg` over an empty set is NULL, and both columns are
      // `NOT NULL DEFAULT '{}'` — an empty `kinds` means "no restriction" and has to write
      // an empty array rather than fail the constraint.
      const skillIdsJson = JSON.stringify([...rule.skillIds]);
      const kindsJson = JSON.stringify([...rule.kinds]);

      await tx.execute(sql`
        INSERT INTO section_rules
          (section_id, pick_count, skill_ids, kinds, min_difficulty, max_difficulty,
           exclude_seen_days, score_per_question)
        VALUES (
          ${sectionId}::uuid,
          ${rule.pickCount},
          coalesce(
            (SELECT array_agg(value::uuid) FROM jsonb_array_elements_text(${skillIdsJson}::jsonb)),
            '{}'::uuid[]
          ),
          coalesce(
            (SELECT array_agg(value::question_kind) FROM jsonb_array_elements_text(${kindsJson}::jsonb)),
            '{}'::question_kind[]
          ),
          ${rule.minDifficulty},
          ${rule.maxDifficulty},
          ${rule.excludeSeenDays},
          ${rule.scorePerQuestion}
        )
      `);
    }
  }

  return assessmentId;
}

/** One assessment as a list row, with the size of the paper it composes to. */
export interface AssessmentRow {
  readonly id: string;
  readonly jobRoleId: string | null;
  readonly name: string;
  readonly durationSeconds: number;
  readonly status: string;
  readonly questionCount: number;
  readonly createdAt: string;
}

/**
 * Every assessment this organisation has composed, newest first.
 *
 * `question_count` is summed from the rules rather than stored on the assessment, because
 * storing it would be a second copy of a derivable number and the two would diverge the
 * first time somebody edited a rule.
 */
export async function listAssessments(tx: DbTransaction): Promise<AssessmentRow[]> {
  const rows = await tx.execute<{
    id: string;
    job_role_id: string | null;
    name: string;
    duration_seconds: number;
    status: string;
    question_count: string;
    created_at: Date | string;
  }>(sql`
    SELECT a.id, a.job_role_id, a.name, a.duration_seconds, a.status::text AS status,
           coalesce(sum(sr.pick_count), 0)::text AS question_count,
           a.created_at
      FROM assessments a
      LEFT JOIN assessment_sections sec ON sec.assessment_id = a.id
      LEFT JOIN section_rules sr ON sr.section_id = sec.id
     GROUP BY a.id
     ORDER BY a.created_at DESC, a.id
  `);

  return rows.map((r) => ({
    id: r.id,
    jobRoleId: r.job_role_id,
    name: r.name,
    durationSeconds: r.duration_seconds,
    status: r.status,
    questionCount: Number.parseInt(r.question_count, 10),
    createdAt: new Date(r.created_at).toISOString(),
  }));
}
