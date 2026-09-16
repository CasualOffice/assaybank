/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The M0 exit criterion's round trip, through a real PostgreSQL: "exportable and re-importable
 * without loss" (docs/06 §"Exit criteria", MILESTONES M0).
 *
 * A bank of every question kind — multi-version history, hostile text, licensed content, skills —
 * is imported into organisation A, exported, carried as a JSON bank document into an empty
 * organisation B and as a QTI 2.1 package into an empty organisation C, and exported again from
 * each. The exports are compared with `toStrictEqual`. Ids and timestamps never enter the
 * comparison because the interchange type does not carry them.
 *
 * The importing organisations have their *own* `python` skill, distinct from A's, so a pass also
 * shows skills were resolved by key inside the importing tenant and not carried across by id.
 */

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import postgres from 'postgres';
import { getContainerRuntimeClient } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { OrgIdSchema, UserIdSchema, type OrgId, type UserId } from '@assaybank/contracts';
import { createDb, migrate, type Database } from '@assaybank/db';

import type { BankItem } from '../../src/interchange/bank-item.js';
import {
  buildBankDocument,
  readBankDocument,
  serialiseBankDocument,
} from '../../src/interchange/bank-document.js';
import {
  readQtiPackage,
  unzipPackage,
  writeQtiPackage,
  zipPackage,
} from '../../src/interchange/qti.js';
import { exportBank, IMPORT_AUDIT_ACTION, importBankItems } from '../../src/jobs/bank-transfer.js';
import { ALL, EXACT, FIXTURES } from '../fixtures/bank-items.js';

const IMAGE = 'postgres:16-alpine';
const OWNER = 'hiring';
const OWNER_PASSWORD = 'hiring';
const DB = 'hiring';
const APP_PASSWORD = 'hiring_app_bank_test';
const JOB_PASSWORD = 'hiring_job_bank_test';

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

/** Positional refs, as `exportBank` writes them. */
const withRefs = (items: readonly BankItem[]): BankItem[] =>
  items.map((item, i) => ({ ...item, ref: `q-${String(i + 1).padStart(5, '0')}` }));

describe.skipIf(!runtime.available)(
  'bank export and re-import through PostgreSQL (M0 exit)',
  () => {
    let container: StartedPostgreSqlContainer;
    let owner: postgres.Sql;
    let db: Database;

    const orgs: Record<'a' | 'b' | 'c' | 'd', { id: OrgId; user: UserId }> = {} as never;
    let exportedFromA: BankItem[] = [];

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
      // Each organisation's own python: same key, different row.
      await owner`INSERT INTO skills (org_id, key, name) VALUES (${org.id}, 'python', 'Python')`;
      return { id: OrgIdSchema.parse(org.id), user: UserIdSchema.parse(user.id) };
    }

    const clock = () => EXACT;

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

      // The global skill every tenant reads.
      await owner`INSERT INTO skills (org_id, key, name) VALUES (NULL, 'sql.window-functions', 'Window functions')`;
      orgs.a = await seedOrg('bank-a');
      orgs.b = await seedOrg('bank-b');
      orgs.c = await seedOrg('bank-c');
      orgs.d = await seedOrg('bank-d');
    }, 240_000);

    afterAll(async () => {
      await db?.close();
      await owner?.end();
      await container?.stop();
    });

    it('imports every kind into A, and exports exactly what went in', async () => {
      const outcome = await importBankItems(
        db,
        { orgId: orgs.a.id, requestedBy: orgs.a.user, sourceLicense: 'proprietary' },
        ALL.map((item, index) => ({ index, item })),
        clock,
      );
      expect(outcome.problems).toEqual([]);
      expect(outcome.created).toHaveLength(ALL.length);

      exportedFromA = await exportBank(db, orgs.a.id);
      // Items with no licence of their own took the request's; the one with its own kept it.
      const expected = withRefs(
        ALL.map((item) => ({ ...item, source_license: item.source_license ?? 'proprietary' })),
      );
      expect(exportedFromA).toStrictEqual(expected);
    });

    it('carries the bank into an empty organisation as JSON, with nothing lost', async () => {
      const file = serialiseBankDocument(buildBankDocument(exportedFromA, EXACT));
      const read = readBankDocument(file);
      expect(read.problems).toEqual([]);

      const outcome = await importBankItems(
        db,
        { orgId: orgs.b.id, requestedBy: orgs.b.user, sourceLicense: 'MIT' },
        read.items,
        clock,
      );
      expect(outcome.problems).toEqual([]);

      const exportedFromB = await exportBank(db, orgs.b.id);
      expect(exportedFromB).toStrictEqual(exportedFromA);
      // The roadmap's P2 gate, literally: export → import → export is byte-identical.
      expect(serialiseBankDocument(buildBankDocument(exportedFromB, EXACT))).toBe(file);
    });

    it('carries the served version of every question into an empty organisation as QTI', async () => {
      const bytes = zipPackage(writeQtiPackage(exportedFromA));
      const read = readQtiPackage(unzipPackage(bytes));
      expect(read.problems).toEqual([]);

      const outcome = await importBankItems(
        db,
        { orgId: orgs.c.id, requestedBy: orgs.c.user, sourceLicense: 'MIT' },
        read.items,
        clock,
      );
      expect(outcome.problems).toEqual([]);

      const servedOnly = exportedFromA.map((item) => {
        const published = item.versions.filter((v) => v.published);
        const served = required(published.at(-1) ?? item.versions.at(-1), 'served version');
        return { ...item, versions: [{ ...served, version_no: 1 }] };
      });
      expect(await exportBank(db, orgs.c.id)).toStrictEqual(servedOnly);
    });

    it('tagged the imported questions with the importing organisation’s own skill', async () => {
      const rows = await owner<{ org_id: string | null }[]>`
      SELECT s.org_id FROM question_skills qs
        JOIN questions q ON q.id = qs.question_id
        JOIN skills s ON s.id = qs.skill_id
       WHERE q.org_id = ${orgs.b.id} AND s.key = 'python'`;
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.org_id === orgs.b.id)).toBe(true);
    });

    it('audits every created question to the person who asked', async () => {
      const rows = await owner<{ n: number; actors: number }[]>`
      SELECT count(*)::int AS n, count(DISTINCT actor_user_id)::int AS actors
        FROM audit_log WHERE org_id = ${orgs.b.id} AND action = ${IMPORT_AUDIT_ACTION}`;
      expect(rows[0]).toEqual({ n: ALL.length, actors: 1 });
    });

    it('refuses an item whose skill the organisation does not have, writing nothing for it', async () => {
      const unknownSkill: BankItem = {
        ...FIXTURES.subjective,
        ref: 'needs-rust',
        skills: [{ key: 'rust', weight: 1 }],
      };
      const outcome = await importBankItems(
        db,
        { orgId: orgs.d.id, requestedBy: orgs.d.user, sourceLicense: 'MIT' },
        [
          { index: 0, item: unknownSkill },
          { index: 1, item: FIXTURES.true_false },
        ],
        clock,
      );
      expect(outcome.created.map((c) => c.index)).toEqual([1]);
      expect(outcome.problems).toEqual([
        expect.objectContaining({ index: 0, ref: 'needs-rust', path: 'skills' }),
      ]);
      const questions = await owner<{ n: number }[]>`
      SELECT count(*)::int AS n FROM questions WHERE org_id = ${orgs.d.id}`;
      expect(questions[0]?.n).toBe(1);
    });

    it('never exports another organisation’s questions', async () => {
      const fromD = await exportBank(db, orgs.d.id);
      expect(fromD).toHaveLength(1);
      expect(fromD[0]?.kind).toBe('true_false');
    });
  },
);
