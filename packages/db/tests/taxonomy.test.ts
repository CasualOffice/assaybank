/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Skills, merging, and bank coverage against a real PostgreSQL (ADR-009).
 *
 * The coverage assertions are the reason this file exists. `GET /job-roles/{id}/coverage` is
 * what stops a recruiter building an assessment for a role the bank cannot support, and the
 * failure mode that matters is not a wrong count — it is a required skill with zero questions
 * **disappearing from the report**, because an inner join dropped it. A report that omits the
 * gap is worse than no report: it reads as "no problems found".
 *
 * So the fixture contains a deliberate hole, and the test asserts the hole is visible.
 */

import { sql } from 'drizzle-orm';
import { getContainerRuntimeClient } from 'testcontainers';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { OrgIdSchema, type OrgId } from '@assaybank/contracts';
import { createDb, migrate, withOrg, type Database } from '../src/index.js';
import {
  createJobRole,
  getJobRoleSkills,
  invisibleSkillIds,
  listJobRoles,
  setJobRoleSkills,
  updateJobRole,
} from '../src/job-roles.js';
import {
  createSkill,
  getJobRoleCoverage,
  mergeSkills,
  SkillMergeError,
  SkillNotFoundError,
  TaxonomyDepthError,
} from '../src/taxonomy.js';

const POSTGRES_IMAGE = 'postgres:16-alpine';
const OWNER_USER = 'hiring';
const OWNER_PASSWORD = 'hiring';
const DATABASE = 'hiring';
const APP_PASSWORD = 'hiring_app_tax_test';
const JOB_PASSWORD = 'hiring_job_tax_test';

const runtime = await (async (): Promise<{ available: boolean; reason: string }> => {
  try {
    await getContainerRuntimeClient();
    return { available: true, reason: '' };
  } catch (error) {
    return { available: false, reason: error instanceof Error ? error.message : String(error) };
  }
})();

/** `!` is forbidden (docs/17 §1); a fixture that did not insert should say so by name. */
function required<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new Error(`fixture did not produce ${name}`);
  return value;
}

describe.skipIf(!runtime.available)('taxonomy and coverage (ADR-009)', () => {
  let container: StartedPostgreSqlContainer;
  let owner: postgres.Sql;
  let db: Database;
  let orgId: OrgId;
  let roleId: string;
  let deepSkillId: string;
  let thinSkillId: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer(POSTGRES_IMAGE)
      .withDatabase(DATABASE)
      .withUsername(OWNER_USER)
      .withPassword(OWNER_PASSWORD)
      .start();

    const host = container.getHost();
    const port = container.getPort();
    const ownerUrl = `postgres://${OWNER_USER}:${OWNER_PASSWORD}@${host}:${port}/${DATABASE}`;
    await migrate({ url: ownerUrl });

    owner = postgres(ownerUrl, { max: 2 });
    await owner.unsafe(`ALTER ROLE hiring_app WITH PASSWORD '${APP_PASSWORD}'`);
    await owner.unsafe(`ALTER ROLE hiring_job WITH PASSWORD '${JOB_PASSWORD}'`);

    db = createDb({
      url: `postgres://hiring_app:${APP_PASSWORD}@${host}:${port}/${DATABASE}`,
      jobUrl: `postgres://hiring_job:${JOB_PASSWORD}@${host}:${port}/${DATABASE}`,
      poolMax: 4,
    });

    // Seeded as the owner: the fixture must not be decided by the thing under test.
    const [org] = await owner<{ id: string }[]>`
      INSERT INTO organizations (name, slug) VALUES ('Taxonomy Co', 'taxonomy-co') RETURNING id
    `;
    orgId = OrgIdSchema.parse(required(org, 'org').id);

    const [author] = await owner<{ id: string }[]>`
      INSERT INTO users (org_id, email, full_name)
      VALUES (${orgId}, 'author@taxonomy.example', 'Author') RETURNING id
    `;

    const [deep] = await owner<{ id: string }[]>`
      INSERT INTO skills (org_id, key, name, category)
      VALUES (${orgId}, 'python', 'Python', 'language') RETURNING id
    `;
    deepSkillId = required(deep, 'deep').id;

    const [thin] = await owner<{ id: string }[]>`
      INSERT INTO skills (org_id, key, name, category)
      VALUES (${orgId}, 'distributed-systems', 'Distributed Systems', 'cs-fundamentals')
      RETURNING id
    `;
    thinSkillId = required(thin, 'thin').id;

    const [role] = await owner<{ id: string }[]>`
      INSERT INTO job_roles (org_id, code, title) VALUES (${orgId}, 'BE-SDE2', 'Backend SDE2')
      RETURNING id
    `;
    roleId = required(role, 'role').id;

    // python is required at difficulty 2-4; distributed-systems is required and has NOTHING.
    await owner`
      INSERT INTO job_role_skills (job_role_id, skill_id, weight, min_difficulty, max_difficulty,
                                   is_required)
      VALUES (${roleId}, ${deepSkillId}, 3.0, 2, 4, true),
             (${roleId}, ${thinSkillId}, 2.0, 3, 5, true)
    `;

    // Four published python questions: difficulties 1, 2, 3, 5. Only 2 and 3 are in band.
    for (const difficulty of [1, 2, 3, 5]) {
      const [q] = await owner<{ id: string }[]>`
        INSERT INTO questions (org_id, kind, status, author_id)
        VALUES (${orgId}, 'mcq_single', 'published', ${required(author, 'author').id}) RETURNING id
      `;
      const [v] = await owner<{ id: string }[]>`
        INSERT INTO question_versions (question_id, version_no, prompt_md, difficulty,
                                       max_score, published_at, created_by)
        VALUES (${required(q, 'q').id}, 1, ${`Python at ${String(difficulty)}`}, ${difficulty}, 1, now(),
                ${required(author, 'author').id})
        RETURNING id
      `;
      await owner`UPDATE questions SET current_version_id = ${required(v, 'v').id} WHERE id = ${required(q, 'q').id}`;
      await owner`
        INSERT INTO question_skills (question_id, skill_id, weight) VALUES (${required(q, 'q').id}, ${deepSkillId}, 1)
      `;
    }

    // A DRAFT python question at difficulty 3 — must not be counted anywhere.
    const [draft] = await owner<{ id: string }[]>`
      INSERT INTO questions (org_id, kind, status, author_id)
      VALUES (${orgId}, 'mcq_single', 'draft', ${required(author, 'author').id}) RETURNING id
    `;
    const [draftV] = await owner<{ id: string }[]>`
      INSERT INTO question_versions (question_id, version_no, prompt_md, difficulty, max_score,
                                     created_by)
      VALUES (${required(draft, 'draft').id}, 1, 'unpublished', 3, 1, ${required(author, 'author').id}) RETURNING id
    `;
    await owner`UPDATE questions SET current_version_id = ${required(draftV, 'draftV').id} WHERE id = ${required(draft, 'draft').id}`;
    await owner`
      INSERT INTO question_skills (question_id, skill_id, weight)
      VALUES (${required(draft, 'draft').id}, ${deepSkillId}, 1)
    `;
  }, 180_000);

  afterAll(async () => {
    await db?.close?.();
    await owner?.end();
    await container?.stop();
  });

  describe('coverage', () => {
    it('reports a required skill with no questions rather than dropping it', async () => {
      const rows = await withOrg(db, orgId, (tx) => getJobRoleCoverage(tx, roleId));

      const thin = rows.find((r) => r.skillKey === 'distributed-systems');
      // The whole point: an inner join would have removed this row and the report would
      // have said "one skill, well covered" while the role was unassessable.
      expect(thin).toBeDefined();
      expect(thin?.published).toBe(0);
      expect(thin?.inBand).toBe(0);
    });

    it('counts only questions in the role’s difficulty band', async () => {
      const rows = await withOrg(db, orgId, (tx) => getJobRoleCoverage(tx, roleId));
      const python = rows.find((r) => r.skillKey === 'python');

      // Published at 1, 2, 3, 5. The band is 2-4, so 2 and 3 count and 1 and 5 do not.
      expect(python?.inBand).toBe(2);
      expect(python?.published).toBe(4);
    });

    it('excludes drafts, because a draft cannot be served to a candidate', async () => {
      const rows = await withOrg(db, orgId, (tx) => getJobRoleCoverage(tx, roleId));
      const python = rows.find((r) => r.skillKey === 'python');

      // Five python questions exist; one is a draft at difficulty 3. If drafts counted,
      // by_difficulty['3'] would be 2 and in_band would be 3.
      expect(python?.byDifficulty['3']).toBe(1);
      expect(python?.inBand).toBe(2);
    });
  });

  describe('merging duplicates (the taxonomy-rot defence)', () => {
    it('rewrites question tags and role requirements, then removes the source', async () => {
      // The duplicate ADR-009 names by example: python3 alongside python.
      const [dupe] = await owner<{ id: string }[]>`
        INSERT INTO skills (org_id, key, name) VALUES (${orgId}, 'python3', 'Python 3') RETURNING id
      `;
      const [q] = await owner<{ id: string }[]>`
        INSERT INTO questions (org_id, kind, status)
        VALUES (${orgId}, 'coding', 'published') RETURNING id
      `;
      await owner`
        INSERT INTO question_skills (question_id, skill_id, weight) VALUES (${required(q, 'q').id}, ${required(dupe, 'dupe').id}, 1)
      `;

      const result = await withOrg(db, orgId, (tx) =>
        mergeSkills(tx, required(dupe, 'dupe').id, deepSkillId),
      );
      expect(result.questionTagsRewritten).toBe(1);

      const remaining = await owner<{ n: string }[]>`
        SELECT count(*)::text AS n FROM skills WHERE id = ${required(dupe, 'dupe').id}
      `;
      expect(required(remaining[0], 'remaining').n).toBe('0');

      const retagged = await owner<{ n: string }[]>`
        SELECT count(*)::text AS n FROM question_skills
         WHERE question_id = ${required(q, 'q').id} AND skill_id = ${deepSkillId}
      `;
      expect(required(retagged[0], 'retagged').n).toBe('1');
    });

    it('does not fail when a question already carries both skills', async () => {
      const [dupe] = await owner<{ id: string }[]>`
        INSERT INTO skills (org_id, key, name) VALUES (${orgId}, 'py', 'Py') RETURNING id
      `;
      const [q] = await owner<{ id: string }[]>`
        INSERT INTO questions (org_id, kind, status)
        VALUES (${orgId}, 'coding', 'published') RETURNING id
      `;
      // Tagged with both. Without ON CONFLICT DO NOTHING the merge violates the composite
      // primary key half way through and leaves the taxonomy in a torn state.
      await owner`
        INSERT INTO question_skills (question_id, skill_id, weight)
        VALUES (${required(q, 'q').id}, ${required(dupe, 'dupe').id}, 1), (${required(q, 'q').id}, ${deepSkillId}, 1)
      `;

      const result = await withOrg(db, orgId, (tx) =>
        mergeSkills(tx, required(dupe, 'dupe').id, deepSkillId),
      );
      expect(result.questionTagsRewritten).toBe(0);

      const rows = await owner<{ n: string }[]>`
        SELECT count(*)::text AS n FROM question_skills WHERE question_id = ${required(q, 'q').id}
      `;
      expect(required(rows[0], 'rows').n).toBe('1');
    });

    it('refuses to merge a skill into itself', async () => {
      await expect(
        withOrg(db, orgId, (tx) => mergeSkills(tx, deepSkillId, deepSkillId)),
      ).rejects.toThrow(SkillMergeError);
    });

    /** An org-owned skill, created as the owner so the fixture does not depend on createSkill. */
    async function ownSkill(key: string, parentId: string | null = null): Promise<string> {
      const [row] = await owner<{ id: string }[]>`
        INSERT INTO skills (org_id, key, name, parent_id)
        VALUES (${orgId}, ${key}, ${key}, ${parentId}) RETURNING id
      `;
      return required(row, key).id;
    }

    it('merges an organisation’s duplicate into a global skill — the common case', async () => {
      const [global] = await owner<{ id: string }[]>`
        INSERT INTO skills (org_id, key, name) VALUES (NULL, 'git', 'Git') RETURNING id
      `;
      const duplicate = await ownSkill('git-scm');
      const result = await withOrg(db, orgId, (tx) =>
        mergeSkills(tx, duplicate, required(global, 'global').id),
      );
      expect(result.childrenReparented).toBe(0);
      const left = await owner`SELECT 1 FROM skills WHERE id = ${duplicate}`;
      expect(left.length).toBe(0);
    });

    it('refuses to merge a global skill away, and writes nothing first', async () => {
      const [global] = await owner<{ id: string }[]>`
        INSERT INTO skills (org_id, key, name) VALUES (NULL, 'linux', 'Linux') RETURNING id
      `;
      const globalId = required(global, 'global').id;
      const [q] = await owner<{ id: string }[]>`
        INSERT INTO questions (org_id, kind, status) VALUES (${orgId}, 'subjective', 'draft') RETURNING id
      `;
      await owner`INSERT INTO question_skills (question_id, skill_id, weight)
                  VALUES (${required(q, 'q').id}, ${globalId}, 1)`;
      const target = await ownSkill('linux-admin');

      await expect(withOrg(db, orgId, (tx) => mergeSkills(tx, globalId, target))).rejects.toThrow(
        SkillMergeError,
      );

      // Refused before the copy: the target gained no tag and the global skill is untouched.
      const copied = await owner`SELECT 1 FROM question_skills WHERE skill_id = ${target}`;
      expect(copied.length).toBe(0);
      const still = await owner`SELECT 1 FROM skills WHERE id = ${globalId}`;
      expect(still.length).toBe(1);
    });

    it('treats another organisation’s skill as not existing, as either side', async () => {
      const [other] = await owner<{ id: string }[]>`
        INSERT INTO organizations (name, slug) VALUES ('Other Co', 'other-co-merge') RETURNING id
      `;
      const [foreign] = await owner<{ id: string }[]>`
        INSERT INTO skills (org_id, key, name) VALUES (${required(other, 'other').id}, 'rust', 'Rust')
        RETURNING id
      `;
      const foreignId = required(foreign, 'foreign').id;
      const mine = await ownSkill('rust-lang');

      await expect(withOrg(db, orgId, (tx) => mergeSkills(tx, mine, foreignId))).rejects.toThrow(
        SkillNotFoundError,
      );
      await expect(withOrg(db, orgId, (tx) => mergeSkills(tx, foreignId, mine))).rejects.toThrow(
        SkillNotFoundError,
      );
    });

    it('refuses a merge that would make the source’s children a third level', async () => {
      const parent = await ownSkill('frontend');
      await ownSkill('frontend.css', parent);
      const otherParent = await ownSkill('web');
      const nestedTarget = await ownSkill('web.ui', otherParent);

      await expect(
        withOrg(db, orgId, (tx) => mergeSkills(tx, parent, nestedTarget)),
      ).rejects.toThrow(TaxonomyDepthError);
    });

    it('refuses to merge a parent into its own child', async () => {
      const parent = await ownSkill('databases');
      const child = await ownSkill('databases.indexing', parent);

      await expect(withOrg(db, orgId, (tx) => mergeSkills(tx, parent, child))).rejects.toThrow(
        SkillMergeError,
      );
    });
  });

  describe('job roles', () => {
    it('refuses a duplicate code by answering undefined, leaving the transaction usable', async () => {
      const outcome = await withOrg(db, orgId, async (tx) => {
        const first = await createJobRole(tx, {
          orgId,
          code: 'DATA-ANALYST',
          title: 'Data analyst',
        });
        const second = await createJobRole(tx, { orgId, code: 'DATA-ANALYST', title: 'Again' });
        // Still usable after the conflict: this is why it is ON CONFLICT and not a caught error.
        const listed = await listJobRoles(tx, {});
        return { first, second, listed };
      });
      expect(outcome.first?.code).toBe('DATA-ANALYST');
      expect(outcome.second).toBeUndefined();
      expect(outcome.listed.some((r) => r.code === 'DATA-ANALYST')).toBe(true);
    });

    it('filters on is_active in both directions', async () => {
      const retired = await withOrg(db, orgId, async (tx) => {
        const role = required(
          await createJobRole(tx, { orgId, code: 'LEGACY-PHP', title: 'Legacy PHP' }),
          'role',
        );
        return updateJobRole(tx, role.id, { isActive: false });
      });
      expect(retired?.isActive).toBe(false);

      const [active, inactive] = await withOrg(db, orgId, async (tx) =>
        Promise.all([listJobRoles(tx, { active: true }), listJobRoles(tx, { active: false })]),
      );
      expect(active.map((r) => r.code)).not.toContain('LEGACY-PHP');
      expect(inactive.map((r) => r.code)).toEqual(['LEGACY-PHP']);
    });

    it('replaces a role’s requirements wholesale and reads them back in coverage order', async () => {
      const rows = await withOrg(db, orgId, async (tx) => {
        await setJobRoleSkills(tx, roleId, [
          { skillId: thinSkillId, weight: 1.5, isRequired: false },
          {
            skillId: deepSkillId,
            weight: 2.25,
            minDifficulty: 2,
            maxDifficulty: 4,
            isRequired: true,
          },
        ]);
        return getJobRoleSkills(tx, roleId);
      });
      expect(rows.map((r) => [r.skillId, r.weight, r.isRequired])).toEqual([
        [deepSkillId, 2.25, true],
        [thinSkillId, 1.5, false],
      ]);
    });

    it('names another organisation’s skill as invisible, and never a global one', async () => {
      const [other] = await owner<{ id: string }[]>`
        INSERT INTO organizations (name, slug) VALUES ('Probe Co', 'probe-co-skills') RETURNING id
      `;
      const [foreign] = await owner<{ id: string }[]>`
        INSERT INTO skills (org_id, key, name) VALUES (${required(other, 'other').id}, 'go', 'Go')
        RETURNING id
      `;
      const [global] = await owner<{ id: string }[]>`
        INSERT INTO skills (org_id, key, name) VALUES (NULL, 'http', 'HTTP') RETURNING id
      `;
      const nowhere = '00000000-0000-4000-8000-000000000000';
      const invisible = await withOrg(db, orgId, (tx) =>
        invisibleSkillIds(tx, [
          required(foreign, 'foreign').id,
          required(global, 'global').id,
          deepSkillId,
          nowhere,
        ]),
      );
      expect(invisible).toEqual([required(foreign, 'foreign').id, nowhere].sort());
    });
  });

  describe('two-level depth (ADR-009)', () => {
    it('allows a child of a root skill', async () => {
      const child = await withOrg(db, orgId, (tx) =>
        createSkill(tx, {
          orgId,
          key: 'python.asyncio',
          name: 'asyncio',
          parentId: deepSkillId,
        }),
      );
      expect(child.parentId).toBe(deepSkillId);
    });

    it('refuses a third level, naming the rule', async () => {
      const child = await withOrg(db, orgId, (tx) =>
        createSkill(tx, { orgId, key: 'python.typing', name: 'typing', parentId: deepSkillId }),
      );

      await expect(
        withOrg(db, orgId, (tx) =>
          createSkill(tx, {
            orgId,
            key: 'python.typing.generics',
            name: 'generics',
            parentId: child.id,
          }),
        ),
      ).rejects.toThrow(TaxonomyDepthError);
    });
  });

  it('is not vacuous: the fixture really does contain published questions', async () => {
    const rows = await withOrg(db, orgId, (tx) =>
      tx.execute<{ n: string }>(sql`SELECT count(*)::text AS n FROM questions`),
    );
    expect(Number.parseInt(required(rows[0], 'rows').n, 10)).toBeGreaterThan(0);
  });
});
