/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The generated cross-tenant isolation suite — the highest-value thing in P0.
 *
 * ADR-010 is only worth anything if it is complete, and "complete" means no tenant table
 * was missed. So the cases are not written by hand. `TENANT_TABLES` is derived from the
 * Drizzle schema (`src/rls-tables.ts`), and this file loops over it: for **every** table
 * carrying `org_id`, a query executed as org A must return zero rows belonging to org B,
 * for select, update and delete.
 *
 * That gives the property a hand-written suite cannot have. A tenant table added in P2
 * with no policy is covered the moment its Drizzle definition lands, and it fails here
 * with its own name in the message. The one table someone forgets is the one that leaks,
 * and this is what stops that table from existing.
 *
 * **Vacuity is the real risk**, not a missing assertion. A suite that quietly tested
 * nothing — because the derivation returned an empty list, or the seed inserted no rows,
 * or the app role could not see anything at all — would pass forever and prove nothing.
 * So every table also gets a positive control: as org B, the same query must return the
 * row. An isolation assertion with no positive control beside it is a green tick with no
 * meaning.
 *
 * **Real Postgres, never a mock** (docs/17 §8). RLS, grants and policy predicates do not
 * exist in a fake. This suite therefore needs a container runtime, and skips cleanly with
 * a printed reason when there is none — it must not fail a build on a laptop with no
 * daemon, and it must genuinely run the moment one is up.
 */

import { getContainerRuntimeClient } from 'testcontainers';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import postgres from 'postgres';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  GLOBAL_ROW_TABLES,
  TENANT_KEY_COLUMN,
  TENANT_ROOT_TABLE,
  TENANT_TABLES,
  createDb,
  migrate,
  withElevated,
  withOrg,
  type Database,
} from '../src/index.js';
import type { OrgId } from '@assaybank/contracts';

/**
 * Pinned to the version docker-compose.yml runs, so the policies are tested on the
 * engine they will actually run on. RLS plan behaviour and `num_nonnulls` semantics are
 * both version-sensitive enough that testing on a different major would prove less than
 * it appears to.
 */
const POSTGRES_IMAGE = 'postgres:16-alpine';

const OWNER_USER = 'hiring';
const OWNER_PASSWORD = 'hiring';
const DATABASE = 'hiring';
/**
 * Assigned by this suite, not by the migration. 0002 creates the roles without a
 * password on purpose — a password in a migration is a secret in the repository.
 */
const APP_PASSWORD = 'hiring_app_test';
const JOB_PASSWORD = 'hiring_job_test';

const runtime = await (async (): Promise<{ available: boolean; reason: string }> => {
  try {
    await getContainerRuntimeClient();
    return { available: true, reason: '' };
  } catch (error) {
    return {
      available: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
})();

/**
 * The skip has to say so. A suite that quietly does not run is worse than one that fails,
 * because nobody investigates a green tick — so the reason goes to stderr, where vitest
 * does not fold it into a task's captured output, and into the suite name, where any
 * reporter shows it.
 */
if (!runtime.available) {
  process.stderr.write(
    `\n[rls.test.ts] SKIPPED: no container runtime is reachable, so the row-level-security\n` +
      `suite cannot run. Start Docker (or Colima, or Podman) and re-run to execute it.\n` +
      `Reason reported by testcontainers: ${runtime.reason}\n` +
      `The completeness half of this property is still checked, without a daemon, by\n` +
      `src/rls-tables.test.ts.\n\n`,
  );
}

const SUITE_NAME = runtime.available
  ? 'row-level security (ADR-010)'
  : `row-level security (ADR-010) — SKIPPED, no container runtime: ${runtime.reason}`;

/**
 * One global row (`org_id IS NULL`) per table that admits them — the shared rows every tenant
 * reads. Keyed by table so a new nullable-`org_id` table without an entry here fails the
 * completeness case below instead of being skipped.
 */
const GLOBAL_SEEDS: Readonly<Record<string, string>> = {
  skills: `INSERT INTO skills (org_id, key, name) VALUES (NULL, 'rls-global-probe', 'Global probe')`,
  user_roles: `INSERT INTO user_roles (org_id, key, name, is_system)
               VALUES (NULL, 'rls-global-probe', 'Global probe', true)`,
};

/** Per-organisation seed: one row in every table that carries org_id. */
interface Seed {
  readonly orgId: OrgId;
  readonly label: string;
}

let container: StartedPostgreSqlContainer | undefined;
let owner: postgres.Sql | undefined;
let db: Database | undefined;
let orgA: Seed | undefined;
let orgB: Seed | undefined;

/** Fails loudly rather than letting an undefined fixture turn into a vacuous pass. */
function required<T>(value: T | undefined, name: string): T {
  if (value === undefined) {
    throw new Error(`fixture ${name} was not initialised; the suite cannot assert anything`);
  }
  return value;
}

/**
 * Writes one row into every tenant table for one organisation, in foreign-key order.
 *
 * Run as the owner, which is exempt from its own policies (0002 deliberately does not use
 * FORCE ROW LEVEL SECURITY). Seeding through the app role would be circular: the thing
 * under test would decide what the fixture contains.
 */
async function seed(client: postgres.Sql, label: string): Promise<Seed> {
  const [org] = await client<{ id: string }[]>`
    INSERT INTO organizations (name, slug) VALUES (${label}, ${label}) RETURNING id
  `;
  const orgId = required(org, `organizations row for ${label}`).id;

  const [user] = await client<{ id: string }[]>`
    INSERT INTO users (org_id, email, full_name)
    VALUES (${orgId}, ${`staff@${label}.example`}, ${`Staff ${label}`})
    RETURNING id
  `;
  const userId = required(user, `users row for ${label}`).id;

  await client`
    INSERT INTO user_roles (org_id, key, name) VALUES (${orgId}, 'recruiter', 'Recruiter')
  `;

  // Identity tables added in P1. Every tenant table needs a seeded row or its positive
  // control ("is visible to the organisation that owns it") fails with zero rows — which
  // is the generated suite telling you a table was added and the seed was not updated.
  await client`
    INSERT INTO staff_accounts (org_id, user_id, account_id, provider_id, password)
    VALUES (${orgId}, ${userId}, ${`acct-${label}`}, 'credential', ${`hash-${label}`})
  `;

  await client`
    INSERT INTO staff_verifications (org_id, identifier, value, expires_at)
    VALUES (${orgId}, ${`verify@${label}.example`}, ${`token-${label}`}, now() + interval '1 day')
  `;

  const [skill] = await client<{ id: string }[]>`
    INSERT INTO skills (org_id, key, name) VALUES (${orgId}, ${`python-${label}`}, 'Python')
    RETURNING id
  `;
  required(skill, `skills row for ${label}`);

  const [jobRole] = await client<{ id: string }[]>`
    INSERT INTO job_roles (org_id, code, title) VALUES (${orgId}, 'BE-SDE1', 'Backend Engineer')
    RETURNING id
  `;
  const jobRoleId = required(jobRole, `job_roles row for ${label}`).id;

  const [opening] = await client<{ id: string }[]>`
    INSERT INTO job_openings (org_id, job_role_id, title)
    VALUES (${orgId}, ${jobRoleId}, 'Backend Engineer')
    RETURNING id
  `;
  const openingId = required(opening, `job_openings row for ${label}`).id;

  await client`
    INSERT INTO questions (org_id, kind, status, author_id)
    VALUES (${orgId}, 'mcq_single', 'published', ${userId})
  `;

  const [assessment] = await client<{ id: string }[]>`
    INSERT INTO assessments (org_id, name, duration_seconds, created_by)
    VALUES (${orgId}, 'Screening', 3600, ${userId})
    RETURNING id
  `;
  const assessmentId = required(assessment, `assessments row for ${label}`).id;

  const [candidate] = await client<{ id: string }[]>`
    INSERT INTO candidates (org_id, email, full_name)
    VALUES (${orgId}, ${`candidate@${label}.example`}, ${`Candidate ${label}`})
    RETURNING id
  `;
  const candidateId = required(candidate, `candidates row for ${label}`).id;

  await client`
    INSERT INTO applications (org_id, candidate_id, job_opening_id)
    VALUES (${orgId}, ${candidateId}, ${openingId})
  `;

  await client`
    INSERT INTO invitations (org_id, assessment_id, token_hash, expires_at, created_by)
    VALUES (${orgId}, ${assessmentId}, ${`hash-${label}`}, now() + interval '7 days', ${userId})
  `;

  await client`
    INSERT INTO attempts (org_id, candidate_id, assessment_id, assessment_version)
    VALUES (${orgId}, ${candidateId}, ${assessmentId}, 1)
  `;

  await client`
    INSERT INTO submissions (org_id, language, language_version, source_code)
    VALUES (${orgId}, 'python', '3.12.0', 'print(1)')
  `;

  await client`
    INSERT INTO interview_sessions (org_id, room_code, created_by)
    VALUES (${orgId}, ${`room-${label}`}, ${userId})
  `;

  await client`
    INSERT INTO scorecard_templates (org_id, name) VALUES (${orgId}, 'Backend loop')
  `;

  await client`
    INSERT INTO audit_log (org_id, actor_user_id, action, entity_type)
    VALUES (${orgId}, ${userId}, 'question.publish', 'question')
  `;

  return { orgId: orgId as OrgId, label };
}

/**
 * PostgreSQL's `insufficient_privilege` (SQLSTATE 42501). Stronger isolation than zero
 * rows, not weaker: the statement never reached a policy because the grant refused it
 * first. `audit_log` is deliberately in that position for UPDATE and DELETE.
 *
 * The cause chain is walked because Drizzle wraps a driver error in a
 * `DrizzleQueryError`, so the SQLSTATE is one level down from what the caller catches.
 */
function isInsufficientPrivilege(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && typeof current === 'object' && current !== null; depth += 1) {
    if ('code' in current && current.code === '42501') {
      return true;
    }
    current = 'cause' in current ? current.cause : undefined;
  }
  return false;
}

/**
 * Runs a statement as the application role, scoped to `org`, and reports how many rows it
 * touched — or `'denied'` when the grant refuses it outright, which `audit_log` does for
 * UPDATE and DELETE by design (ADR-010: the append-only counterweight to BYPASSRLS).
 */
async function rowsTouched(
  handle: Database,
  org: OrgId,
  statement: ReturnType<typeof sql>,
): Promise<number | 'denied'> {
  try {
    return await withOrg(handle, org, async (tx) => {
      const rows = await tx.execute(statement);
      return rows.length;
    });
  } catch (error) {
    if (isInsufficientPrivilege(error)) {
      return 'denied';
    }
    throw error;
  }
}

describe.skipIf(!runtime.available)(SUITE_NAME, () => {
  const MIGRATIONS_DIR = join(import.meta.dirname, '..', 'migrations');

  // Counted from the directory rather than hardcoded. A literal here breaks every time a
  // migration is added — which is exactly what it did — and the assertion that matters is
  // "all of them applied", not "there were exactly N".
  let migrationCount = 0;

  beforeAll(async () => {
    container = await new PostgreSqlContainer(POSTGRES_IMAGE)
      .withDatabase(DATABASE)
      .withUsername(OWNER_USER)
      .withPassword(OWNER_PASSWORD)
      .start();

    const host = container.getHost();
    const port = container.getPort();
    const ownerUrl = `postgres://${OWNER_USER}:${OWNER_PASSWORD}@${host}:${port}/${DATABASE}`;

    migrationCount = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).length;
    const first = await migrate({ url: ownerUrl });
    expect(first.applied).toBe(migrationCount);

    owner = postgres(ownerUrl, { max: 1 });

    // The migration creates the roles without a password (see 0002). Give them one so the
    // suite can connect as them, exactly as an operator would.
    await owner.unsafe(`ALTER ROLE hiring_app WITH PASSWORD '${APP_PASSWORD}'`);
    await owner.unsafe(`ALTER ROLE hiring_job WITH PASSWORD '${JOB_PASSWORD}'`);

    for (const table of GLOBAL_ROW_TABLES) {
      const statement = GLOBAL_SEEDS[table];
      if (statement !== undefined) await owner.unsafe(statement);
    }

    orgA = await seed(owner, 'orga');
    orgB = await seed(owner, 'orgb');

    db = createDb({
      url: `postgres://hiring_app:${APP_PASSWORD}@${host}:${port}/${DATABASE}`,
      jobUrl: `postgres://hiring_job:${JOB_PASSWORD}@${host}:${port}/${DATABASE}`,
      poolMax: 4,
    });
  }, 300_000);

  afterAll(async () => {
    await db?.close();
    await owner?.end();
    await container?.stop();
  });

  it('derives a non-empty table list, so the cases below are not vacuous', () => {
    expect(TENANT_TABLES.length).toBeGreaterThan(0);
  });

  // ---- the generated cases ------------------------------------------------
  // One block per tenant table. A table added to the schema with org_id and no policy
  // arrives here automatically and fails.
  describe.each(TENANT_TABLES)('%s', (table) => {
    const key = sql.identifier(TENANT_KEY_COLUMN);
    const relation = sql.identifier(table);

    it('is visible to the organisation that owns it (this is what makes the rest mean something)', async () => {
      const handle = required(db, 'db');
      const b = required(orgB, 'orgB');

      const touched = await rowsTouched(
        handle,
        b.orgId,
        sql`SELECT 1 FROM ${relation} WHERE ${key} = ${b.orgId}`,
      );
      expect(touched, `org B must be able to see its own ${table} row`).not.toBe('denied');
      expect(touched).toBeGreaterThan(0);
    });

    it('returns no rows of another organisation on SELECT', async () => {
      const handle = required(db, 'db');
      const a = required(orgA, 'orgA');
      const b = required(orgB, 'orgB');

      const touched = await rowsTouched(
        handle,
        a.orgId,
        sql`SELECT 1 FROM ${relation} WHERE ${key} = ${b.orgId}`,
      );
      expect(touched, `org A leaked a ${table} row belonging to org B`).toBe(0);
    });

    it('updates no rows of another organisation', async () => {
      const handle = required(db, 'db');
      const a = required(orgA, 'orgA');
      const b = required(orgB, 'orgB');

      // A no-op assignment: the point is how many rows the policy lets the statement
      // reach, not what it would have written.
      const touched = await rowsTouched(
        handle,
        a.orgId,
        sql`UPDATE ${relation} SET ${key} = ${key} WHERE ${key} = ${b.orgId} RETURNING 1`,
      );
      expect(touched === 0 || touched === 'denied', `org A updated a ${table} row of org B`).toBe(
        true,
      );
    });

    it('deletes no rows of another organisation', async () => {
      const handle = required(db, 'db');
      const a = required(orgA, 'orgA');
      const b = required(orgB, 'orgB');

      const touched = await rowsTouched(
        handle,
        a.orgId,
        sql`DELETE FROM ${relation} WHERE ${key} = ${b.orgId} RETURNING 1`,
      );
      expect(touched === 0 || touched === 'denied', `org A deleted a ${table} row of org B`).toBe(
        true,
      );
    });
  });

  // ---- global rows ----------------------------------------------------------
  // A nullable org_id means "shared by every tenant". Reading those rows is the point; writing
  // them is not. The generated cases above compare org A against org B and so never touch a
  // global row — which is how a policy whose USING clause admitted global rows for DELETE and
  // UPDATE went unnoticed until 0008. A tenant that can delete a global skill strips it, by
  // cascade, from every organisation's questions; one that can claim it takes it from them.
  it('seeds a global row for every table that admits one', () => {
    expect(GLOBAL_ROW_TABLES.length).toBeGreaterThan(0);
    for (const table of GLOBAL_ROW_TABLES) {
      expect(GLOBAL_SEEDS[table], `add a global seed for ${table}`).toBeDefined();
    }
  });

  describe.each(GLOBAL_ROW_TABLES)('%s global rows', (table) => {
    const key = sql.identifier(TENANT_KEY_COLUMN);
    const relation = sql.identifier(table);

    it('are readable by a tenant', async () => {
      const a = required(orgA, 'orgA');
      const touched = await rowsTouched(
        required(db, 'db'),
        a.orgId,
        sql`SELECT 1 FROM ${relation} WHERE ${key} IS NULL`,
      );
      expect(touched).not.toBe('denied');
      expect(touched).toBeGreaterThan(0);
    });

    it('cannot be claimed by a tenant rewriting org_id to its own', async () => {
      const a = required(orgA, 'orgA');
      const touched = await rowsTouched(
        required(db, 'db'),
        a.orgId,
        sql`UPDATE ${relation} SET ${key} = ${a.orgId} WHERE ${key} IS NULL RETURNING 1`,
      );
      expect(touched === 0 || touched === 'denied', `org A claimed a global ${table} row`).toBe(
        true,
      );
    });

    it('cannot be deleted by a tenant', async () => {
      const a = required(orgA, 'orgA');
      const touched = await rowsTouched(
        required(db, 'db'),
        a.orgId,
        sql`DELETE FROM ${relation} WHERE ${key} IS NULL RETURNING 1`,
      );
      expect(touched === 0 || touched === 'denied', `org A deleted a global ${table} row`).toBe(
        true,
      );
    });

    it('cannot be created by a tenant', async () => {
      const a = required(orgA, 'orgA');
      const handle = required(db, 'db');
      const insert =
        table === 'skills'
          ? sql`INSERT INTO skills (org_id, key, name) VALUES (NULL, 'rls-forged', 'Forged') RETURNING 1`
          : sql`INSERT INTO user_roles (org_id, key, name) VALUES (NULL, 'rls-forged', 'Forged') RETURNING 1`;
      const outcome = await withOrg(handle, a.orgId, async (tx) => tx.execute(insert)).then(
        () => 'inserted',
        (error: unknown) => (isInsufficientPrivilege(error) ? 'denied' : 'other-error'),
      );
      expect(outcome).toBe('denied');
    });

    it('survive: nothing above removed or reassigned the seeded global row', async () => {
      const rows = await required(owner, 'owner').unsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM "${table}" WHERE ${TENANT_KEY_COLUMN} IS NULL AND key = 'rls-global-probe'`,
      );
      expect(rows[0]?.n).toBe(1);
    });
  });

  // ---- the tenancy root ---------------------------------------------------
  describe(TENANT_ROOT_TABLE, () => {
    it('is keyed on id, and shows an organisation only itself', async () => {
      const handle = required(db, 'db');
      const a = required(orgA, 'orgA');
      const b = required(orgB, 'orgB');

      const visible = await withOrg(handle, a.orgId, async (tx) => {
        const rows = await tx.execute<{ id: string }>(sql`SELECT id FROM organizations`);
        return rows.map((row) => row.id);
      });

      expect(visible).toEqual([a.orgId]);
      expect(visible).not.toContain(b.orgId);
    });
  });

  // ---- the properties the loop cannot express ------------------------------
  it('denies everything when app.current_org is unset', async () => {
    // The accessor returns NULL for an unset variable, and `org_id = NULL` is NULL rather
    // than true. The safe direction is the default direction: a connection nobody scoped
    // sees nothing, instead of seeing everything.
    const started = required(container, 'container');
    const bare = postgres(
      `postgres://hiring_app:${APP_PASSWORD}@${started.getHost()}:${started.getPort()}/${DATABASE}`,
      { max: 1 },
    );
    try {
      const rows = await bare<{ n: number }[]>`SELECT count(*)::int AS n FROM attempts`;
      expect(rows[0]?.n).toBe(0);
    } finally {
      await bare.end();
    }
  });

  it('lets the elevated background-job role see every organisation, and records why', async () => {
    // ADR-010: a grading job has no authenticated session behind it, so there is no org to
    // put in app.current_org and no policy that could admit it. BYPASSRLS states that
    // plainly. What it owes in return is the reason, captured here.
    const started = required(container, 'container');
    const a = required(orgA, 'orgA');
    const b = required(orgB, 'orgB');

    const elevations: string[] = [];
    const elevated = createDb(
      {
        url: `postgres://hiring_app:${APP_PASSWORD}@${started.getHost()}:${started.getPort()}/${DATABASE}`,
        jobUrl: `postgres://hiring_job:${JOB_PASSWORD}@${started.getHost()}:${started.getPort()}/${DATABASE}`,
        poolMax: 2,
      },
      { onElevation: (record) => elevations.push(record.reason) },
    );

    try {
      const ids = await withElevated(elevated, 'job.grade', async (tx) => {
        const rows = await tx.execute<{ id: string }>(sql`SELECT id FROM organizations`);
        return rows.map((row) => row.id);
      });
      expect(ids).toContain(a.orgId);
      expect(ids).toContain(b.orgId);
      expect(elevations).toEqual(['job.grade']);
    } finally {
      await elevated.close();
    }
  });

  it('refuses an elevation with no reason', async () => {
    const handle = required(db, 'db');
    await expect(withElevated(handle, '   ', () => Promise.resolve(undefined))).rejects.toThrow(
      /requires a reason/,
    );
  });

  it('refuses to rewrite the audit log, as either application role', async () => {
    // Append-only is a grant, not a habit (docs/17 §9). This is the counterweight to the
    // job role's BYPASSRLS: history that can be rewritten is not a record.
    const handle = required(db, 'db');
    const a = required(orgA, 'orgA');

    await expect(
      withOrg(handle, a.orgId, async (tx) => {
        await tx.execute(sql`UPDATE audit_log SET action = 'tampered' WHERE org_id = ${a.orgId}`);
      }),
    ).rejects.toSatisfy(isInsufficientPrivilege);

    await expect(
      withElevated(handle, 'job.test', async (tx) => {
        await tx.execute(sql`DELETE FROM audit_log WHERE org_id = ${a.orgId}`);
      }),
    ).rejects.toSatisfy(isInsufficientPrivilege);
  });

  it('refuses to mutate a published question version (ADR-003)', async () => {
    const client = required(owner, 'owner');
    const a = required(orgA, 'orgA');

    const [question] = await client<{ id: string }[]>`
      SELECT id FROM questions WHERE org_id = ${a.orgId} LIMIT 1
    `;
    const questionId = required(question, 'a seeded question').id;

    const [version] = await client<{ id: string }[]>`
      INSERT INTO question_versions (question_id, version_no, prompt_md, difficulty)
      VALUES (${questionId}, 1, 'What is 2 + 2?', 2)
      RETURNING id
    `;
    const versionId = required(version, 'a question version').id;

    // Publishing is the one permitted transition: NULL -> an instant.
    await client`UPDATE question_versions SET published_at = now() WHERE id = ${versionId}`;

    // Everything after it is refused, even to the owner, because the API is not the only
    // writer: the importer, the statistics job and future migrations write here too.
    await expect(
      client`UPDATE question_versions SET prompt_md = 'What is 2 + 3?' WHERE id = ${versionId}`,
    ).rejects.toThrow(/published and immutable/);
  });

  it('applies cleanly a second time, and reports that it did nothing', async () => {
    // docs/17 §4 and P0 step 6: `make migrate` twice, the second run is a no-op.
    const started = required(container, 'container');
    const url = `postgres://${OWNER_USER}:${OWNER_PASSWORD}@${started.getHost()}:${started.getPort()}/${DATABASE}`;
    const again = await migrate({ url });
    expect(again.applied).toBe(0);
    expect(again.total).toBe(migrationCount);
  });

  it('left every seeded row intact: nothing above actually deleted anything', async () => {
    // The backstop. If a policy were missing, one of the DELETE cases would have removed a
    // row and every later assertion about it would have been measuring an empty table.
    const client = required(owner, 'owner');
    const b = required(orgB, 'orgB');

    for (const table of TENANT_TABLES) {
      const rows = await client.unsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM "${table}" WHERE ${TENANT_KEY_COLUMN} = $1`,
        [b.orgId],
      );
      expect(rows[0]?.n, `org B lost its ${table} row`).toBeGreaterThan(0);
    }
  });
});
