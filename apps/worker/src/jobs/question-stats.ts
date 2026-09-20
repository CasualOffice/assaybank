/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The nightly question-statistics sweep (FR-5).
 *
 * The composition the layering rules require: `@assaybank/db` reads responses and writes rows,
 * `@assaybank/grading` computes, and this file joins them. Neither package knows the other.
 *
 * One organisation at a time, inside `withOrg`, so row-level security bounds each computation to
 * one tenant's candidates. Only the list of organisations is read elevated, because no single
 * organisation can see the others — and that one elevated read is audited like any other.
 */

import { computeItemStatistics, type ItemResponse } from '@assaybank/grading';
import { OrgIdSchema } from '@assaybank/contracts';
import {
  listOrganisationIds,
  readItemResponses,
  upsertQuestionStats,
  withElevated,
  withOrg,
  type Database,
  type ItemResponseRow,
  type QuestionStatsRow,
} from '@assaybank/db';

export interface QuestionStatsDeps {
  readonly db: Database;
  readonly now: () => Date;
}

export interface QuestionStatsOutcome {
  readonly organisations: number;
  /** Versions with at least one finalised response, and so a row written. */
  readonly versionsWritten: number;
  /** Of those, versions past the threshold with a p-value recorded. */
  readonly versionsWithStatistics: number;
}

/** Groups a sorted response stream by version, preserving order within each group. */
function byVersion(rows: readonly ItemResponseRow[]): Map<string, ItemResponse[]> {
  const groups = new Map<string, ItemResponse[]>();
  for (const row of rows) {
    const group = groups.get(row.questionVersionId) ?? [];
    group.push({
      itemScore: row.itemScore,
      itemMax: row.itemMax,
      totalScore: row.totalScore,
      seconds: row.seconds,
    });
    groups.set(row.questionVersionId, group);
  }
  return groups;
}

export async function runQuestionStats(deps: QuestionStatsDeps): Promise<QuestionStatsOutcome> {
  const at = deps.now();

  const organisations =
    // The reason is an audit action, not prose: `job.` marks the null-actor audit row as a
    // machine. What it did — list every organisation so each can be recomputed in turn under
    // its own row-level security — is this comment's job, not the audit row's.
    (await withElevated(deps.db, 'job.question_stats', listOrganisationIds)).map((id) =>
      OrgIdSchema.parse(id),
    );

  let versionsWritten = 0;
  let versionsWithStatistics = 0;

  for (const orgId of organisations) {
    const outcome = await withOrg(deps.db, orgId, async (tx) => {
      const groups = byVersion(await readItemResponses(tx));

      const rows: QuestionStatsRow[] = [];
      // Sorted by version id so the write order, and so the audit and log order, is stable.
      for (const versionId of [...groups.keys()].sort()) {
        const stats = computeItemStatistics(groups.get(versionId) ?? []);
        rows.push({ questionVersionId: versionId, ...stats });
      }

      const written = await upsertQuestionStats(tx, rows, at);
      return { written, withStats: rows.filter((r) => r.pValue !== null).length };
    });

    versionsWritten += outcome.written;
    versionsWithStatistics += outcome.withStats;
  }

  return { organisations: organisations.length, versionsWritten, versionsWithStatistics };
}
