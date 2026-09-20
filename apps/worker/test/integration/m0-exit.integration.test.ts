/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The M0 exit criterion, end to end (`H-040`, MILESTONES M0).
 *
 * > 200 questions loaded, tagged to at least 3 job roles, exportable and re-importable
 * > without loss.
 *
 * ## Why this is a test and not a seeded staging database
 *
 * MILESTONES words the first criterion as a `count(*)` "in the seeded staging database after
 * the import run". That is evidence somebody produced once, on a machine that no longer
 * exists, which nobody can re-check. A milestone closed on that is closed on a memory.
 *
 * This runs the real path — the real dataset reader, the real import job, a real PostgreSQL
 * with RLS and the real export — and it runs on every build. The criterion stops being a
 * claim and becomes a thing that is either true right now or red.
 *
 * ## Why the questions are generated rather than vendored
 *
 * Two hundred rows of MBPP would be two hundred rows of somebody else's copyrighted content
 * in this repository, carried for a test. The licence permits it with credit, but the
 * obligation is real and the fixture would be large, stale and unreadable.
 *
 * So the test **generates a file in MBPP's shape** and feeds it to the same
 * `readJsonlDataset('mbpp', …)` the import job calls. What that proves is what the criterion
 * is actually about: the bank, the taxonomy, the importer and the round trip hold at two
 * hundred questions. That MBPP's own field names parse correctly is proved separately, by
 * `datasets.test.ts`, against fixtures shaped like the real file.
 *
 * ## What "without loss" means here
 *
 * Export A, import into an empty organisation B, export B, and compare with `toStrictEqual`.
 * Ids and timestamps never enter the comparison because the interchange type does not carry
 * them — which is the point of ADR-003's version model rather than a convenience of this test.
 */

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import postgres from 'postgres';
import { getContainerRuntimeClient } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  OrgIdSchema,
  QuestionIdSchema,
  SkillIdSchema,
  UserIdSchema,
  type OrgId,
  type UserId,
} from '@assaybank/contracts';
import {
  createDb,
  getJobRoleCoverage,
  migrate,
  publishVersion,
  setQuestionSkills,
  setQuestionStatus,
  withOrg,
  type Database,
} from '@assaybank/db';

import { readJsonlDataset } from '../../src/interchange/datasets/index.js';
import { exportBank, importBankItems } from '../../src/jobs/bank-transfer.js';

const IMAGE = 'postgres:16-alpine';
const OWNER = 'hiring';
const OWNER_PASSWORD = 'hiring';
const DB = 'hiring';
const APP_PASSWORD = 'hiring_app_m0_test';
const JOB_PASSWORD = 'hiring_job_m0_test';

/** The number the criterion names. Not a round number chosen for convenience — it is the bar. */
const QUESTIONS = 200;

const AT = new Date('2026-10-20T09:00:00.000Z');

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

/** The single row of a `count(*)`, as a number. */
const countOf = (rows: readonly { count: string }[]): number =>
  Number(required(rows[0], 'count').count);

/**
 * The skills three roles are built from.
 *
 * Six, across two families, so the three roles below overlap without being identical — which
 * is what makes the coverage query interesting. A role that shared no skill with any other
 * would prove the join works for one role three times.
 */
const SKILLS = [
  'py.data-structures',
  'py.iteration',
  'algo.sorting',
  'algo.search',
  'sql.joins',
  'sys.caching',
] as const;

/** Three roles, each requiring three skills, at a band that includes the imported difficulty. */
const ROLES = [
  { code: 'be-junior', title: 'Junior backend engineer', skills: [0, 1, 2] },
  { code: 'de-mid', title: 'Data engineer', skills: [0, 4, 3] },
  { code: 'sre-junior', title: 'Junior SRE', skills: [1, 5, 3] },
] as const;

/**
 * A file in MBPP's shape, with `count` problems.
 *
 * Three assertions each, which is what MBPP carries, so the import produces one sample case
 * and two hidden ones per question — enough to clear the publish bar (ADR-024, and the kind
 * rule's "at least one hidden case").
 */
function mbppFile(count: number): string {
  return Array.from({ length: count }, (_, i) => {
    const n = i + 1;
    return JSON.stringify({
      task_id: 600 + n,
      text: `Write a function \`solve_${String(n)}\` returning its argument doubled.`,
      code: `def solve_${String(n)}(x):\n    return x * 2\n`,
      test_setup_code: '',
      test_list: [
        `assert solve_${String(n)}(1) == 2`,
        `assert solve_${String(n)}(0) == 0`,
        `assert solve_${String(n)}(-3) == -6`,
      ],
      challenge_test_list: [],
    });
  }).join('\n');
}

describe.skipIf(!runtime.available)('M0 exit criterion (H-040)', () => {
  let container: StartedPostgreSqlContainer;
  let owner: postgres.Sql;
  let db: Database;

  const orgs: Record<'a' | 'b', { id: OrgId; user: UserId }> = {} as never;
  const skillIds: string[] = [];
  const roleIds: string[] = [];

  async function seedOrg(slug: string): Promise<{ id: OrgId; user: UserId }> {
    const org = required(
      (
        await owner<{ id: string }[]>`
          INSERT INTO organizations (name, slug) VALUES (${slug}, ${slug}) RETURNING id`
      )[0],
      'org',
    );
    const user = required(
      (
        await owner<{ id: string }[]>`
          INSERT INTO users (org_id, email, full_name)
          VALUES (${org.id}, ${`author@${slug}.example`}, 'Author') RETURNING id`
      )[0],
      'user',
    );
    // Both organisations own every skill by key. B's are different rows, so a pass shows the
    // re-import resolved skills inside the importing tenant rather than carrying ids across.
    for (const key of SKILLS) {
      await owner`INSERT INTO skills (org_id, key, name) VALUES (${org.id}, ${key}, ${key})`;
    }
    return { id: OrgIdSchema.parse(org.id), user: UserIdSchema.parse(user.id) };
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer(IMAGE)
      .withDatabase(DB)
      .withUsername(OWNER)
      .withPassword(OWNER_PASSWORD)
      .start();
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

    orgs.a = await seedOrg('m0-a');
    orgs.b = await seedOrg('m0-b');

    const rows = await owner<{ id: string; key: string }[]>`
      SELECT id, key FROM skills WHERE org_id = ${orgs.a.id} ORDER BY key`;
    const byKey = new Map(rows.map((r) => [r.key, r.id]));
    skillIds.push(...SKILLS.map((key) => required(byKey.get(key), `skill ${key}`)));

    for (const role of ROLES) {
      const inserted = required(
        (
          await owner<{ id: string }[]>`
            INSERT INTO job_roles (org_id, code, title) VALUES (${orgs.a.id}, ${role.code}, ${role.title})
            RETURNING id`
        )[0],
        'role',
      );
      roleIds.push(inserted.id);
      for (const index of role.skills) {
        // Band 2–4, which brackets the difficulty an import declares. A band that excluded it
        // would report zero coverage for a bank that is in fact full.
        await owner`
          INSERT INTO job_role_skills (job_role_id, skill_id, weight, min_difficulty, max_difficulty, is_required)
          VALUES (${inserted.id}, ${required(skillIds[index], 'skill')}, 2, 2, 4, true)`;
      }
    }
  }, 300_000);

  afterAll(async () => {
    await db?.close();
    await owner?.end();
    await container?.stop();
  });

  it('loads 200 questions through the real dataset reader and import job', async () => {
    const read = readJsonlDataset('mbpp', mbppFile(QUESTIONS));

    expect(read.problems).toEqual([]);
    expect(read.items).toHaveLength(QUESTIONS);

    const outcome = await importBankItems(
      db,
      { orgId: orgs.a.id, requestedBy: orgs.a.user, sourceLicense: 'proprietary' },
      read.items,
      () => AT,
    );

    expect(outcome.problems).toEqual([]);
    expect(outcome.created).toHaveLength(QUESTIONS);

    const rows = await owner<{ count: string }[]>`
      SELECT count(*)::text AS count FROM questions WHERE org_id = ${orgs.a.id}`;
    expect(countOf(rows)).toBe(QUESTIONS);
  }, 300_000);

  it('tags them across the taxonomy and publishes them', async () => {
    const questions = await owner<{ id: string }[]>`
      SELECT id FROM questions WHERE org_id = ${orgs.a.id} ORDER BY external_ref`;
    expect(questions).toHaveLength(QUESTIONS);

    await withOrg(db, orgs.a.id, async (tx) => {
      for (const [position, row] of questions.entries()) {
        const questionId = QuestionIdSchema.parse(row.id);
        // Round-robin, so every skill carries a share and no role is covered by accident.
        const skill = required(skillIds[position % skillIds.length], 'skill');
        await setQuestionSkills(tx, questionId, [
          { skillId: SkillIdSchema.parse(skill), weight: 1 },
        ]);
        // Two writes, because they are two things. `publishVersion` freezes the version and
        // points the question at it; the question's own lifecycle status is separate, and the
        // API does both for the same reason — a version can be published while the question
        // it belongs to is being retired.
        await publishVersion(tx, questionId, 1, AT);
        await setQuestionStatus(tx, questionId, 'published');
      }
    });

    const rows = await owner<{ count: string }[]>`
      SELECT count(*)::text AS count
      FROM questions WHERE org_id = ${orgs.a.id} AND status = 'published'`;

    // The criterion's own verification: `SELECT count(*) FROM questions WHERE status = 'published'`.
    expect(countOf(rows)).toBe(QUESTIONS);
  }, 300_000);

  it('covers three distinct job roles, through skills rather than through roles', async () => {
    // FR-2 and ADR-009: the query goes role → job_role_skills → question_skills, and there is
    // no path from a role to a question. Three roles with non-zero in-band coverage is the
    // criterion; that they overlap on skills is what makes it a taxonomy rather than a label.
    expect(roleIds).toHaveLength(3);

    for (const roleId of roleIds) {
      const coverage = await withOrg(db, orgs.a.id, (tx) => getJobRoleCoverage(tx, roleId));

      expect(coverage).toHaveLength(3);
      for (const skill of coverage) {
        expect(skill.inBand).toBeGreaterThan(0);
      }
    }
  }, 120_000);

  it('exports, re-imports into an empty organisation, and loses nothing', async () => {
    const fromA = await exportBank(db, orgs.a.id);
    expect(fromA).toHaveLength(QUESTIONS);

    const outcome = await importBankItems(
      db,
      { orgId: orgs.b.id, requestedBy: orgs.b.user, sourceLicense: 'proprietary' },
      fromA.map((item, index) => ({ index, item })),
      () => AT,
    );
    expect(outcome.problems).toEqual([]);
    expect(outcome.created).toHaveLength(QUESTIONS);

    const fromB = await exportBank(db, orgs.b.id);

    // `toStrictEqual` over two hundred questions, their versions, their coding specs and their
    // six hundred test cases. Ids and timestamps are absent from the interchange type, so the
    // comparison is of content and of nothing else.
    expect(fromB).toStrictEqual(fromA);
  }, 600_000);

  it('carries the unit tests across, which is what makes the copies gradeable', async () => {
    // This reads the database rather than the export, and that is the point.
    //
    // The round trip above compares A's export with B's export, so it is **blind to any field
    // the exporter drops**: the loss is symmetric and both sides match. Verified by making the
    // exporter write `assertion_code: null` — the comparison above still passed and only this
    // assertion failed. Without it, a regression there would leave organisation B holding two
    // hundred questions that look identical and that nothing can grade (ADR-024).
    const rows = await owner<{ count: string }[]>`
      SELECT count(*)::text AS count
      FROM test_cases tc
      JOIN question_versions qv ON qv.id = tc.question_version_id
      JOIN questions q ON q.id = qv.question_id
      WHERE q.org_id = ${orgs.b.id} AND tc.assertion_code IS NOT NULL`;

    expect(countOf(rows)).toBe(QUESTIONS * 3);
  }, 120_000);
});
