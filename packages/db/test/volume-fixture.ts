/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Enough rows that the planner has a choice to make.
 *
 * R-09 says row-level security can degrade a plan, and ADR-010 answers "measure before
 * assuming". Neither claim can be tested on the one-row-per-table isolation fixture: on a
 * table of six rows every plan is a sequential scan and every timing is noise, so a
 * measurement taken there would say nothing at all about production and would still look
 * like evidence.
 *
 * So this writes tens of thousands of rows across several organisations. Several matters
 * as much as tens of thousands: with a single tenant, `org_id = app_current_org()` is
 * true for every row and the policy costs nothing by construction, which is the one
 * result guaranteed to be wrong.
 *
 * Deliberately deterministic. No `random()` anywhere — row contents derive from the row
 * number, so a plan captured today and a plan captured after a schema change differ
 * because of the change rather than because the data moved. Statistics are what plans are
 * chosen from, and statistics that shift under you make a baseline useless.
 *
 * A **test fixture**, not a product seeder. `make seed` loads a starter question set for
 * humans to look at; this loads shapes for the planner to trip over, and nothing outside
 * `test/` imports it.
 */

import type postgres from 'postgres';

import type { OrgId } from '@assaybank/contracts';

import { seedOrg, type SeededOrg } from './org-seed.js';

export interface VolumeOptions {
  /** How many organisations share the tables. More than one, or RLS filters nothing. */
  readonly orgs: number;
  /** Attempts per organisation, each with its own candidate. */
  readonly attemptsPerOrg: number;
  /** Served questions per attempt: `attempt_questions` and `answers` rows per attempt. */
  readonly questionsPerAttempt: number;
  /** Distinct published question versions per organisation to draw from. */
  readonly versionsPerOrg: number;
}

/** The volume actually written, so a suite can assert it got what it asked for. */
export interface VolumeCounts {
  readonly organizations: number;
  readonly candidates: number;
  readonly attempts: number;
  readonly attemptQuestions: number;
  readonly answers: number;
}

export interface SeededVolume {
  /** Every organisation seeded, in creation order. */
  readonly orgs: readonly SeededOrg[];
  /** The organisation the hot-path queries are measured against. */
  readonly subject: SeededOrg;
  readonly counts: VolumeCounts;
}

/**
 * Sensible defaults: comfortably past the ten thousand rows the P1 plan asks for in both
 * `attempts` and `answers`, and small enough to load in a couple of seconds.
 */
export const DEFAULT_VOLUME: VolumeOptions = {
  orgs: 12,
  attemptsPerOrg: 1_000,
  questionsPerAttempt: 2,
  // Large enough that the planner stops treating the bank as a table it can scan for
  // free. At a few hundred rows every access path costs the same and the measurement
  // says nothing about a real question bank; at a few thousand it has to choose.
  versionsPerOrg: 400,
};

async function scalar(client: postgres.Sql, statement: string): Promise<number> {
  const rows = await client.unsafe<{ n: string }[]>(statement);
  return Number.parseInt(rows[0]?.n ?? '0', 10);
}

/**
 * Loads the volume, as the owner, and leaves the planner with fresh statistics.
 *
 * Set-based throughout — one `INSERT … SELECT generate_series(…)` per table rather than a
 * loop of parameterised inserts. Twenty-four thousand round trips would dominate the
 * runtime of the suite that calls this, and the fixture would then be the thing being
 * measured.
 */
export async function seedVolume(
  client: postgres.Sql,
  options: VolumeOptions = DEFAULT_VOLUME,
): Promise<SeededVolume> {
  const orgs: SeededOrg[] = [];

  for (let i = 0; i < options.orgs; i += 1) {
    const org = await seedOrg(client, `vol${String(i).padStart(2, '0')}`);
    orgs.push(org);
    await loadOrg(client, org, options);
  }

  const subject = orgs[Math.floor(orgs.length / 2)];
  if (subject === undefined) {
    throw new Error('seedVolume() was asked for zero organisations; it has nothing to measure.');
  }

  // ANALYZE, not VACUUM ANALYZE: the tables were only inserted into, so there is nothing
  // to reclaim, and what the plans need is the statistics. Without this the planner works
  // from the defaults it assumes for an unanalysed table and every plan below is a guess
  // about a table it believes has 2,550 rows.
  await client.unsafe(
    'ANALYZE organizations, candidates, attempts, attempt_questions, answers, ' +
      'questions, question_versions, assessments',
  );

  return {
    orgs,
    subject,
    counts: {
      organizations: await scalar(client, 'SELECT count(*)::text AS n FROM organizations'),
      candidates: await scalar(client, 'SELECT count(*)::text AS n FROM candidates'),
      attempts: await scalar(client, 'SELECT count(*)::text AS n FROM attempts'),
      attemptQuestions: await scalar(client, 'SELECT count(*)::text AS n FROM attempt_questions'),
      answers: await scalar(client, 'SELECT count(*)::text AS n FROM answers'),
    },
  };
}

async function loadOrg(
  client: postgres.Sql,
  org: SeededOrg,
  options: VolumeOptions,
): Promise<void> {
  const orgId: OrgId = org.orgId;

  // --- the bank ------------------------------------------------------------
  // Published, because an attempt is only ever served published content (ADR-003), and a
  // plan measured over draft rows would be measured over rows the hot path never reads.
  await client`
    INSERT INTO questions (org_id, kind, status, author_id)
    SELECT ${orgId}, 'mcq_single', 'published', ${org.userId}
      FROM generate_series(1, ${options.versionsPerOrg})
  `;

  await client`
    INSERT INTO question_versions
      (question_id, version_no, prompt_md, difficulty, max_score, published_at, created_by)
    SELECT q.id, 1, 'Volume fixture prompt ' || q.id, 3, 10.00, now(), ${org.userId}
      FROM questions q
     WHERE q.org_id = ${orgId}
       AND NOT EXISTS (SELECT 1 FROM question_versions v WHERE v.question_id = q.id)
  `;

  // --- candidates and attempts --------------------------------------------
  await client`
    INSERT INTO candidates (org_id, email, full_name)
    SELECT ${orgId},
           'vol' || g || '@' || ${org.label} || '.example',
           'Volume candidate ' || g
      FROM generate_series(1, ${options.attemptsPerOrg}) AS g
  `;

  // One attempt per candidate, spread across the lifecycle and across time. The status
  // mix matters: the staff list query filters on it, and a column where every row has the
  // same value gives the planner a selectivity estimate that no real deployment produces.
  await client`
    WITH c AS (
      SELECT id, row_number() OVER (ORDER BY id) AS n
        FROM candidates
       WHERE org_id = ${orgId} AND email LIKE 'vol%'
    )
    INSERT INTO attempts
      (org_id, candidate_id, assessment_id, assessment_version, status,
       started_at, deadline_at, submitted_at, created_at)
    SELECT ${orgId},
           c.id,
           ${org.assessmentId},
           1,
           (ARRAY['created', 'in_progress', 'submitted', 'auto_graded',
                  'under_review', 'finalised']::attempt_status[])[1 + (c.n % 6)],
           now() - make_interval(mins => (c.n % 20000)::int),
           now() - make_interval(mins => (c.n % 20000)::int) + make_interval(mins => 60),
           CASE WHEN c.n % 6 >= 2
                THEN now() - make_interval(mins => (c.n % 20000)::int) + make_interval(mins => 45)
                END,
           now() - make_interval(mins => (c.n % 20000)::int)
      FROM c
  `;

  // --- the served set ------------------------------------------------------
  await client`
    WITH versions AS (
      SELECT array_agg(v.id ORDER BY v.id) AS ids
        FROM question_versions v
        JOIN questions q ON q.id = v.question_id
       WHERE q.org_id = ${orgId}
    ),
    a AS (
      SELECT id, row_number() OVER (ORDER BY id) AS n
        FROM attempts
       WHERE org_id = ${orgId}
         AND NOT EXISTS (SELECT 1 FROM attempt_questions aq WHERE aq.attempt_id = attempts.id)
    )
    INSERT INTO attempt_questions (attempt_id, question_version_id, ordinal, max_score)
    SELECT a.id,
           versions.ids[1 + ((a.n * ${options.questionsPerAttempt} + o.ordinal)
                             % array_length(versions.ids, 1))],
           o.ordinal,
           10.00
      FROM a
      CROSS JOIN versions
      CROSS JOIN generate_series(1, ${options.questionsPerAttempt}) AS o(ordinal)
  `;

  // --- the answers ---------------------------------------------------------
  // Half carry a null final_score on purpose. The finalisation guard — "may this attempt
  // become finalised?" — is an anti-join for exactly those rows, and a table where every
  // score is present turns that query into a plan it will never have in production.
  await client`
    INSERT INTO answers
      (attempt_question_id, text_answer, seconds_spent, auto_score, final_score, answered_at)
    SELECT aq.id,
           'volume answer',
           30 + (aq.ordinal * 17) % 600,
           7.50,
           CASE WHEN aq.ordinal % 2 = 1 THEN 7.50 END,
           now()
      FROM attempt_questions aq
      JOIN attempts a ON a.id = aq.attempt_id
     WHERE a.org_id = ${orgId}
       AND NOT EXISTS (SELECT 1 FROM answers ans WHERE ans.attempt_question_id = aq.id)
  `;
}
