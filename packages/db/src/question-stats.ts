/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Reading the responses question statistics are computed from, and writing the results.
 *
 * No statistics are computed here — that is `computeItemStatistics` in `@assaybank/grading`,
 * pure and tested against independently computed values. This module only moves rows, which is
 * what `packages/db` is for (CLAUDE.md: it must not contain business rules). The worker composes
 * the two.
 *
 * Both functions take a transaction `withOrg` has scoped, and neither filters by organisation:
 * row-level security is what keeps one organisation's candidates out of another's statistics.
 */

import { sql } from 'drizzle-orm';

import type { DbTransaction } from './client.js';

/** One finalised response, shaped for `computeItemStatistics`. */
export interface ItemResponseRow {
  readonly questionVersionId: string;
  readonly itemScore: number;
  readonly itemMax: number;
  /** The attempt's total — the sum of `final_score` over its answers, this one included. */
  readonly totalScore: number;
  readonly seconds: number;
}

/**
 * Every finalised, fully scored response in the current organisation.
 *
 * Three filters, each deliberate:
 *
 * - **`attempts.status = 'finalised'`** — an attempt still being graded or under review has
 *   provisional scores, and a statistic computed from them would move when a human finishes.
 * - **`final_score IS NOT NULL`** — the finalisation guard should make this redundant for a
 *   finalised attempt; it is repeated because a null here would become a zero in the sum and
 *   quietly understate difficulty.
 * - **voided attempts are excluded by the first filter** — a voided attempt is one a person
 *   decided does not count (FR-25), so it must not count here either.
 *
 * The total is `SUM(final_score) OVER (attempt)` rather than `attempts.raw_score`, so the item
 * score and the total come from the same column and cannot disagree if section weighting ever
 * makes `raw_score` something other than the plain sum.
 *
 * Ordered by version then answer id, so the stream is identical run to run.
 */
export async function readItemResponses(tx: DbTransaction): Promise<ItemResponseRow[]> {
  const rows = await tx.execute<{
    question_version_id: string;
    item_score: string;
    item_max: string;
    total_score: string;
    seconds: number;
  }>(sql`
    SELECT aq.question_version_id,
           an.final_score::text                                           AS item_score,
           aq.max_score::text                                             AS item_max,
           (SUM(an.final_score) OVER (PARTITION BY aq.attempt_id))::text  AS total_score,
           an.seconds_spent                                               AS seconds
      FROM answers an
      JOIN attempt_questions aq ON aq.id = an.attempt_question_id
      JOIN attempts a           ON a.id = aq.attempt_id
     WHERE a.status = 'finalised'
       AND an.final_score IS NOT NULL
     ORDER BY aq.question_version_id, an.id
  `);

  return rows.map((r) => ({
    questionVersionId: r.question_version_id,
    itemScore: Number.parseFloat(r.item_score),
    itemMax: Number.parseFloat(r.item_max),
    totalScore: Number.parseFloat(r.total_score),
    seconds: r.seconds,
  }));
}

export interface QuestionStatsRow {
  readonly questionVersionId: string;
  readonly n: number;
  readonly pValue: number | null;
  readonly discrimination: number | null;
  readonly meanSeconds: number | null;
}

/**
 * Writes one row per version, replacing whatever was there.
 *
 * A replace, not an increment: FR-5's statistics are recomputed from the record, so a re-grade
 * that changes a score changes the statistic the next night and nothing drifts in between.
 */
export async function upsertQuestionStats(
  tx: DbTransaction,
  rows: readonly QuestionStatsRow[],
  at: Date,
): Promise<number> {
  let written = 0;
  for (const row of rows) {
    await tx.execute(sql`
      INSERT INTO question_stats (question_version_id, n_attempts, p_value, discrimination,
                                  mean_seconds, computed_at)
      VALUES (${row.questionVersionId}::uuid, ${row.n}, ${row.pValue}, ${row.discrimination},
              ${row.meanSeconds}, ${at.toISOString()}::timestamptz)
      ON CONFLICT (question_version_id) DO UPDATE
         SET n_attempts     = EXCLUDED.n_attempts,
             p_value        = EXCLUDED.p_value,
             discrimination = EXCLUDED.discrimination,
             mean_seconds   = EXCLUDED.mean_seconds,
             computed_at    = EXCLUDED.computed_at
    `);
    written += 1;
  }
  return written;
}

/**
 * Every organisation id, in id order.
 *
 * Needs an elevated transaction: row-level security lets an organisation see only itself, so
 * no single tenant can list the others. The caller wraps this in `withElevated`, which records
 * the elevation — a sweep that crosses tenants is exactly what should leave a trail.
 */
export async function listOrganisationIds(tx: DbTransaction): Promise<string[]> {
  const rows = await tx.execute<{ id: string }>(sql`SELECT id FROM organizations ORDER BY id`);
  return rows.map((r) => r.id);
}

export interface StoredQuestionStats {
  readonly nAttempts: number;
  readonly pValue: number | null;
  readonly discrimination: number | null;
  readonly meanSeconds: number | null;
  readonly computedAt: Date | null;
}

/** The recorded statistics for one version, or `undefined` if the sweep has never written any. */
export async function getQuestionStats(
  tx: DbTransaction,
  questionVersionId: string,
): Promise<StoredQuestionStats | undefined> {
  const rows = await tx.execute<{
    n_attempts: number;
    p_value: string | null;
    discrimination: string | null;
    mean_seconds: string | null;
    computed_at: string | null;
  }>(sql`
    SELECT n_attempts, p_value::text, discrimination::text, mean_seconds::text, computed_at::text
      FROM question_stats WHERE question_version_id = ${questionVersionId}::uuid
  `);
  const row = rows[0];
  if (row === undefined) return undefined;
  const num = (v: string | null): number | null => (v === null ? null : Number.parseFloat(v));
  return {
    nAttempts: row.n_attempts,
    pValue: num(row.p_value),
    discrimination: num(row.discrimination),
    meanSeconds: num(row.mean_seconds),
    computedAt: row.computed_at === null ? null : new Date(row.computed_at),
  };
}
