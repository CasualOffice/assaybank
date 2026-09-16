/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The question-statistics sweep against a real PostgreSQL.
 *
 * The pure computation is proven in `@assaybank/grading` against values computed independently
 * in Python. What this proves is the path around it: that the rows the database hands over are
 * the rows the statistic should see. So the seed reproduces that fixture's exact scores, and the
 * sweep must land on the same 0.2531 — any drift means the query read the wrong responses, not
 * that the arithmetic changed.
 *
 * Seeded as the owner, which is exempt from row-level security, so the fixture is not decided by
 * the code under test.
 */

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import postgres from 'postgres';
import { getContainerRuntimeClient } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDb, migrate, type Database } from '@assaybank/db';

import { runQuestionStats } from '../../src/jobs/question-stats.js';

const IMAGE = 'postgres:16-alpine';
const OWNER = 'hiring';
const OWNER_PASSWORD = 'hiring';
const DB = 'hiring';
const APP_PASSWORD = 'hiring_app_stats_test';
const JOB_PASSWORD = 'hiring_job_stats_test';

/** Injected, never the wall clock. */
const FIRST_RUN = new Date('2026-10-20T02:30:00.000Z');
const SECOND_RUN = new Date('2026-10-21T02:30:00.000Z');

// Fixture A from packages/grading/src/psychometrics.test.ts: [item, itemMax, total, seconds].
// Independently computed: p 0.75, corrected discrimination 0.2531, mean 49.5 s.
const A: ReadonlyArray<readonly [number, number, number, number]> = [
  [1, 1, 12, 30], [0, 1, 5, 31], [1, 1, 17, 32], [1, 1, 2, 33], [1, 1, 2, 34], [1, 1, 12, 35],
  [1, 1, 18, 36], [1, 1, 12, 37], [1, 1, 17, 38], [0, 1, 2, 39], [1, 1, 17, 40], [1, 1, 20, 41],
  [1, 1, 19, 42], [0, 1, 8, 43], [1, 1, 3, 44], [1, 1, 4, 45], [1, 1, 12, 46], [1, 1, 8, 47],
  [1, 1, 11, 48], [1, 1, 14, 49], [1, 1, 20, 50], [0, 1, 15, 51], [1, 1, 4, 52], [1, 1, 9, 53],
  [1, 1, 19, 54], [0, 1, 7, 55], [1, 1, 6, 56], [0, 1, 7, 57], [1, 1, 12, 58], [1, 1, 8, 59],
  [0, 1, 4, 60], [1, 1, 8, 61], [1, 1, 20, 62], [1, 1, 19, 63], [1, 1, 13, 64], [1, 1, 13, 65],
  [0, 1, 11, 66], [0, 1, 3, 67], [0, 1, 16, 68], [1, 1, 11, 69],
];

const runtime = await (async () => {
  try {
    await getContainerRuntimeClient();
    return { available: true };
  } catch {
    return { available: false };
  }
})();

function required<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new Error(`fixture did not produce ${name}`);
  return value;
}

describe.skipIf(!runtime.available)('question-stats sweep', () => {
  let container: StartedPostgreSqlContainer;
  let owner: postgres.Sql;
  let db: Database;
  let itemVersionId = '';
  let sparseVersionId = '';
  let otherOrgItemVersionId = '';

  /** An organisation with an author, an assessment and a candidate to hang attempts on. */
  async function seedOrg(slug: string) {
    const org = required((await owner<{ id: string }[]>`
      INSERT INTO organizations (name, slug) VALUES (${slug}, ${slug}) RETURNING id`)[0], 'org');
    const assessment = required((await owner<{ id: string }[]>`
      INSERT INTO assessments (org_id, name, duration_seconds)
      VALUES (${org.id}, 'Screen', 3600) RETURNING id`)[0], 'assessment');
    const candidate = required((await owner<{ id: string }[]>`
      INSERT INTO candidates (org_id, email) VALUES (${org.id}, ${`c@${slug}.example`}) RETURNING id`)[0], 'candidate');
    return { orgId: org.id, assessmentId: assessment.id, candidateId: candidate.id };
  }

  async function seedVersion(orgId: string, label: string): Promise<string> {
    const q = required((await owner<{ id: string }[]>`
      INSERT INTO questions (org_id, kind, status) VALUES (${orgId}, 'mcq_single', 'published')
      RETURNING id`)[0], 'question');
    const v = required((await owner<{ id: string }[]>`
      INSERT INTO question_versions (question_id, version_no, prompt_md, difficulty, published_at)
      VALUES (${q.id}, 1, ${label}, 2, now()) RETURNING id`)[0], 'version');
    return v.id;
  }

  /** One attempt: the item under test plus a "rest" item carrying the remainder of the total. */
  async function seedAttempt(
    org: { orgId: string; assessmentId: string; candidateId: string },
    itemVersion: string,
    restVersion: string,
    [item, itemMax, total, seconds]: readonly [number, number, number, number],
    status: 'finalised' | 'under_review' | 'voided' = 'finalised',
  ): Promise<void> {
    const attempt = required((await owner<{ id: string }[]>`
      INSERT INTO attempts (org_id, candidate_id, assessment_id, assessment_version, status)
      VALUES (${org.orgId}, ${org.candidateId}, ${org.assessmentId}, 1, ${status}) RETURNING id`)[0], 'attempt');
    const aqItem = required((await owner<{ id: string }[]>`
      INSERT INTO attempt_questions (attempt_id, question_version_id, ordinal, max_score)
      VALUES (${attempt.id}, ${itemVersion}, 1, ${itemMax}) RETURNING id`)[0], 'aq item');
    const aqRest = required((await owner<{ id: string }[]>`
      INSERT INTO attempt_questions (attempt_id, question_version_id, ordinal, max_score)
      VALUES (${attempt.id}, ${restVersion}, 2, 19) RETURNING id`)[0], 'aq rest');
    await owner`
      INSERT INTO answers (attempt_question_id, final_score, seconds_spent)
      VALUES (${aqItem.id}, ${item}, ${seconds}), (${aqRest.id}, ${total - item}, 300)`;
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer(IMAGE)
      .withDatabase(DB).withUsername(OWNER).withPassword(OWNER_PASSWORD).start();
    const host = container.getHost();
    const port = container.getPort();
    const ownerUrl = `postgres://${OWNER}:${OWNER_PASSWORD}@${host}:${port}/${DB}`;
    await migrate({ url: ownerUrl });

    owner = postgres(ownerUrl, { max: 2 });
    await owner.unsafe(`ALTER ROLE hiring_app WITH PASSWORD '${APP_PASSWORD}'`);
    await owner.unsafe(`ALTER ROLE hiring_job WITH PASSWORD '${JOB_PASSWORD}'`);
    db = createDb({
      url: `postgres://hiring_app:${APP_PASSWORD}@${host}:${port}/${DB}`,
      jobUrl: `postgres://hiring_job:${JOB_PASSWORD}@${host}:${port}/${DB}`,
      poolMax: 4,
    });

    const acme = await seedOrg('acme-stats');
    itemVersionId = await seedVersion(acme.orgId, 'item under test');
    const restVersion = await seedVersion(acme.orgId, 'rest of the test');
    for (const row of A) await seedAttempt(acme, itemVersionId, restVersion, row);

    // Noise that must NOT reach the statistic. If either were counted, p and r would move.
    await seedAttempt(acme, itemVersionId, restVersion, [0, 1, 20, 999], 'under_review');
    await seedAttempt(acme, itemVersionId, restVersion, [0, 1, 20, 999], 'voided');

    // A version with too few responses for a statistic to mean anything.
    sparseVersionId = await seedVersion(acme.orgId, 'sparse');
    for (const row of A.slice(0, 5)) await seedAttempt(acme, sparseVersionId, restVersion, row);

    // A second tenant whose candidates all got the item wrong. Tenancy is what keeps this out.
    const globex = await seedOrg('globex-stats');
    otherOrgItemVersionId = await seedVersion(globex.orgId, 'other tenant item');
    const globexRest = await seedVersion(globex.orgId, 'other tenant rest');
    for (const [, max, total, s] of A) {
      await seedAttempt(globex, otherOrgItemVersionId, globexRest, [0, max, total, s]);
    }
  }, 240_000);

  afterAll(async () => {
    await owner?.end();
    await container?.stop();
  });

  async function statsFor(versionId: string) {
    return (await owner<{
      n_attempts: number; p_value: string | null; discrimination: string | null;
      mean_seconds: string | null; computed_at: Date | null;
    }[]>`SELECT n_attempts, p_value, discrimination, mean_seconds, computed_at
           FROM question_stats WHERE question_version_id = ${versionId}`)[0];
  }

  it('reproduces the independently computed statistics from rows in the database', async () => {
    await runQuestionStats({ db, now: () => FIRST_RUN });

    const row = required(await statsFor(itemVersionId), 'stats row');
    expect(row.n_attempts).toBe(40);
    expect(row.p_value).toBe('0.7500');
    // Same number as the Python computation and the pure-function test. The two noise attempts
    // (under review, voided) would have changed it; so would counting the item in its own total.
    expect(row.discrimination).toBe('0.2531');
    expect(row.mean_seconds).toBe('49.50');
    expect(row.computed_at?.toISOString()).toBe(FIRST_RUN.toISOString());
  });

  it('records the count but no statistic below the threshold', async () => {
    const row = required(await statsFor(sparseVersionId), 'sparse row');
    expect(row.n_attempts).toBe(5);
    expect(row.p_value).toBeNull();
    expect(row.discrimination).toBeNull();
  });

  it('keeps each tenant’s candidates out of the other’s statistics', async () => {
    const acme = required(await statsFor(itemVersionId), 'acme');
    const globex = required(await statsFor(otherOrgItemVersionId), 'globex');
    // Globex's candidates all scored 0. Pooled with Acme's, Acme's p-value would fall.
    expect(acme.p_value).toBe('0.7500');
    expect(globex.p_value).toBe('0.0000');
    // Nobody varied on the item, so there is no correlation to report — null, not 0.
    expect(globex.discrimination).toBeNull();
  });

  it('replaces rather than accumulates on the next run', async () => {
    const outcome = await runQuestionStats({ db, now: () => SECOND_RUN });

    const row = required(await statsFor(itemVersionId), 'stats row');
    expect(row.n_attempts).toBe(40);
    expect(row.discrimination).toBe('0.2531');
    expect(row.computed_at?.toISOString()).toBe(SECOND_RUN.toISOString());
    expect(outcome.organisations).toBe(2);
  });

  it('leaves an audit trail for the one read that crosses tenants', async () => {
    // Listing every organisation is the only elevated step. A sweep that reaches across
    // tenants without a record is exactly the path an incident would hide in.
    const rows = await owner<{ n: string }[]>`
      SELECT count(*)::text AS n FROM audit_log WHERE action = 'job.question_stats'`;
    expect(Number.parseInt(required(rows[0], 'audit count').n, 10)).toBeGreaterThanOrEqual(2);
  });
});
