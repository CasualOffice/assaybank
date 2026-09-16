/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `request.audited(...)` against a real PostgreSQL — P1 step 5.
 *
 * `src/audit.test.ts` covers every refusal that happens before a transaction opens, and
 * it has to point at an unreachable pool to prove they happen first. That leaves the
 * half nobody can assert without a database: **what is actually in the row when the
 * request succeeds**, and whether the handler's work and its record really do fail
 * together.
 *
 * Those are exactly the properties a stub cannot hold. A fake transaction commits
 * whatever it is told to, so a suite built on one proves that `audited` called `withOrg`
 * and nothing about what committed (docs/17 §8). `AuditEntry.amend` in particular — the
 * only path by which a handler's `after` state reaches the record — has no observable
 * effect at all without a row to read back, so without this file it is untested code on
 * the write path of the audit log.
 *
 * **Why both DSNs point at the owner.** `migrate` creates `hiring_app` and `hiring_job`
 * without passwords on purpose — a password in a migration is a secret in the repository
 * — and this workspace has no driver of its own to set one with. Role separation and the
 * RLS policies are proven where they belong, against both roles, in
 * `packages/db/tests/`. What is under test here is the request-side wiring: which
 * organisation, which actor, which address, which instant, and the transaction boundary.
 * None of that is decided by which role holds the connection.
 */

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { StaffPrincipal } from '@assaybank/auth';
import { OrgIdSchema, UserIdSchema, type OrgId, type UserId } from '@assaybank/contracts';
import { AUDIT_REASON_KEY, createDb, migrate, withOrg, type Database } from '@assaybank/db';

import type { AuditEntry, AuditSpec, AuditedWork } from '../../src/audit.js';
import { requirePermission } from '../../src/authorisation.js';
import { setPrincipal } from '../../src/principal.js';
import { buildServer } from '../../src/server.js';
import { testConfig } from '../../src/test-support.js';

/** Pinned to the version docker-compose.yml runs, as `packages/db`'s fixture is. */
const POSTGRES_IMAGE = 'postgres:16-alpine';

/** Injected, and never the wall clock (ADR-006, docs/17 §8). */
const AT = new Date('2026-10-13T08:15:00.000Z');

/** Fixed rather than generated, so a failure names the same row every run. */
const ORG_ID: OrgId = OrgIdSchema.parse('4a1c9e70-2b83-4d51-8f6a-0c7d5e91b204');

/**
 * The entity the audited action names. `audit_log.entity_id` carries no foreign key —
 * the row outlives the entity it describes — so this needs no `attempts` row behind it,
 * and inventing one would be seeding a table this file never reads.
 */
const ENTITY_ID = '8d2b6f41-95c0-4a37-b6e2-1f0a7c3d5e89';

let container: StartedPostgreSqlContainer | undefined;
let db: Database | undefined;
let userId: UserId | undefined;
let server: FastifyInstance | undefined;

/** Fails loudly rather than letting an uninitialised fixture become a vacuous pass. */
function required<T>(value: T | undefined, name: string): T {
  if (value === undefined) {
    throw new Error(`fixture ${name} was not initialised; the suite cannot assert anything`);
  }
  return value;
}

/**
 * One `audit_log` row, read back through a transaction of its own.
 *
 * The index signature is what `tx.execute<T>` asks for — an interface without one does
 * not satisfy `Record<string, unknown>` — and it costs nothing here: the named columns
 * keep their own types, and a typo in one of them is still a compile error.
 */
interface AuditRow {
  readonly [column: string]: unknown;
  readonly org_id: string;
  readonly actor_user_id: string | null;
  readonly action: string;
  readonly entity_type: string;
  readonly entity_id: string | null;
  readonly before: Record<string, unknown> | null;
  readonly after: Record<string, unknown> | null;
  readonly ip: string | null;
  /**
   * Rendered as UTC text by the query rather than left to the driver. `tx.execute` hands
   * back whatever postgres.js made of the column, and an assertion that compares a value
   * of an unknown shape against an ISO string is an assertion about the driver.
   */
  readonly at: string;
}

async function rowsForAction(action: string): Promise<AuditRow[]> {
  const handle = required(db, 'db');
  return withOrg(handle, ORG_ID, async (tx) =>
    tx.execute<AuditRow>(sql`
      SELECT org_id, actor_user_id, action, entity_type, entity_id,
             before, after, host(ip) AS ip,
             to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS at
        FROM audit_log WHERE action = ${action} ORDER BY id
    `),
  );
}

/** The seeded user's name — the row the audited work below rewrites. */
async function nameOfUser(): Promise<string> {
  const handle = required(db, 'db');
  const rows = await withOrg(handle, ORG_ID, async (tx) =>
    tx.execute<{ full_name: string }>(
      sql`SELECT full_name FROM users WHERE id = ${required(userId, 'userId')}::uuid`,
    ),
  );
  return required(rows[0], 'the seeded user').full_name;
}

/** A server whose single route performs one audited action against the container. */
function harness(spec: AuditSpec, work: AuditedWork<unknown>): FastifyInstance {
  const principal: StaffPrincipal = {
    kind: 'staff',
    userId: required(userId, 'userId'),
    orgId: ORG_ID,
    permissions: new Set(['attempt.void']),
  };

  const app = buildServer({
    config: testConfig(),
    logger: false,
    db: required(db, 'db'),
    now: () => AT,
  });
  server = app;

  app.addHook('onRequest', (request, _reply, done) => {
    setPrincipal(request, principal);
    done();
  });

  void app.register((instance, _opts, done) => {
    instance.post('/test-audited', { config: requirePermission('attempt.void') }, async (request) =>
      request.audited(spec, work),
    );
    done();
  });

  return app;
}

describe('request.audited, against a real PostgreSQL', () => {
  beforeAll(async () => {
    container = await new PostgreSqlContainer(POSTGRES_IMAGE)
      .withDatabase('hiring')
      .withUsername('hiring')
      .withPassword('hiring')
      .start();

    const url = `postgres://hiring:hiring@${container.getHost()}:${String(
      container.getPort(),
    )}/hiring`;
    await migrate({ url });

    // Both DSNs are the owner's. See the module comment.
    const handle = createDb({ url, jobUrl: url, poolMax: 4 }, { now: () => AT });
    db = handle;

    // Seeded in a transaction of its own, so the fixture is not built by the thing under
    // test. The owner is exempt from its own policies (0002 uses no FORCE), which is why
    // the organisation can be inserted from inside a `withOrg` scoped to it.
    await withOrg(handle, ORG_ID, async (tx) => {
      await tx.execute(sql`
        INSERT INTO organizations (id, name, slug)
        VALUES (${ORG_ID}::uuid, 'Audited Ltd', 'audited')
      `);
      const rows = await tx.execute<{ id: string }>(sql`
        INSERT INTO users (org_id, email, full_name)
        VALUES (${ORG_ID}::uuid, 'staff@audited.example', 'Dana Staff')
        RETURNING id::text AS id
      `);
      userId = UserIdSchema.parse(required(rows[0], 'the seeded user').id);
    });
  }, 300_000);

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  afterAll(async () => {
    await db?.close();
    await container?.stop();
  }, 120_000);

  it('writes one row carrying the principal, the address and the injected instant', async () => {
    const app = harness(
      {
        action: 'attempt.void',
        entityType: 'attempt',
        entityId: ENTITY_ID,
        reason: '  Two people were present in the frame.  ',
        before: { status: 'in_progress' },
      },
      () => Promise.resolve({ ok: true }),
    );

    const response = await app.inject({ method: 'POST', url: '/test-audited' });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ ok: boolean }>().ok).toBe(true);

    const [row] = await rowsForAction('attempt.void');
    const audit = required(row, 'the audit row');
    expect(audit.org_id, "the row was filed under a different tenant's id").toBe(ORG_ID);
    expect(audit.actor_user_id, 'the acting staff user was not recorded').toBe(userId);
    expect(audit.entity_type).toBe('attempt');
    expect(audit.entity_id).toBe(ENTITY_ID);
    expect(audit.before).toEqual({ status: 'in_progress' });
    expect(audit.after).toEqual({ [AUDIT_REASON_KEY]: 'Two people were present in the frame.' });
    // `app.inject` speaks over a socket whose peer is the loopback address.
    expect(audit.ip, 'the client address was not recorded').toBe('127.0.0.1');
    // ADR-006: the instant is `buildServer`'s injected clock, not `now()` in SQL and not
    // the wall clock. Without the injection this assertion could not exist at all.
    expect(audit.at).toBe('2026-10-13T08:15:00Z');
  });

  it('records what the work learned, through amend, after the work has run', async () => {
    // The `after` state of a change does not exist until the change has been made, so a
    // record assembled entirely before the work is a record that can never carry one.
    const app = harness(
      {
        action: 'score.override',
        entityType: 'attempt',
        reason: 'Question 3 accepted an equivalent answer the key omitted.',
        before: { raw_score: 41 },
      },
      (_tx, entry: AuditEntry) => {
        entry.amend({ entityId: ENTITY_ID, after: { raw_score: 55 } });
        return Promise.resolve({ raw_score: 55 });
      },
    );

    expect((await app.inject({ method: 'POST', url: '/test-audited' })).statusCode).toBe(200);

    const [row] = await rowsForAction('score.override');
    const audit = required(row, 'the override row');
    // FR-21: both numbers survive, and so does the sentence explaining the disagreement.
    expect(audit.before).toEqual({ raw_score: 41 });
    expect(audit.after).toEqual({
      raw_score: 55,
      [AUDIT_REASON_KEY]: 'Question 3 accepted an equivalent answer the key omitted.',
    });
    // An entity the route did not know until the work ran.
    expect(audit.entity_id, 'amend did not reach the row').toBe(ENTITY_ID);
  });

  it('lets the last amendment win and leaves the fields it omits alone', async () => {
    const app = harness(
      {
        action: 'question.publish',
        entityType: 'question_version',
        entityId: ENTITY_ID,
        before: { status: 'draft' },
      },
      (_tx, entry: AuditEntry) => {
        entry.amend({ after: { status: 'reviewing' } });
        entry.amend({ after: { status: 'published' } });
        return Promise.resolve({});
      },
    );

    expect((await app.inject({ method: 'POST', url: '/test-audited' })).statusCode).toBe(200);

    const [row] = await rowsForAction('question.publish');
    const audit = required(row, 'the publish row');
    expect(audit.after).toEqual({ status: 'published' });
    expect(audit.before, 'an amendment overwrote a field it did not name').toEqual({
      status: 'draft',
    });
  });

  it('rolls the work back with the record when the work fails', async () => {
    const before = await nameOfUser();

    const app = harness(
      {
        action: 'attempt.rollback_probe',
        entityType: 'attempt',
        entityId: ENTITY_ID,
        reason: 'recorded, then undone',
      },
      async (tx) => {
        await tx.execute(sql`
          UPDATE users SET full_name = 'Renamed By A Failed Action'
           WHERE id = ${required(userId, 'userId')}::uuid
        `);
        throw new Error('the action failed after its work had been done');
      },
    );

    expect((await app.inject({ method: 'POST', url: '/test-audited' })).statusCode).toBe(500);

    // Neither half survived. The pairing is the point: had the audit row been written on
    // a second connection, history would now claim a change the database does not have.
    expect(await nameOfUser(), 'the failed work committed anyway').toBe(before);
    expect(await rowsForAction('attempt.rollback_probe')).toHaveLength(0);
  });

  it('rolls the work back when the record is the thing that is refused', async () => {
    // The other direction, and the one the writer exists for: the work succeeded and the
    // row could not be written, so the action does not take effect. Here the payload
    // carries a key whose name says it is a credential — a seven-year record is no place
    // for one — and the refusal reaches the client as `internal`, describing nothing.
    const before = await nameOfUser();

    const app = harness(
      { action: 'attempt.refused_probe', entityType: 'attempt', entityId: ENTITY_ID },
      async (tx, entry: AuditEntry) => {
        await tx.execute(sql`
          UPDATE users SET full_name = 'Renamed By An Unrecordable Action'
           WHERE id = ${required(userId, 'userId')}::uuid
        `);
        entry.amend({ after: { session_token: 'sk-live-not-a-real-one' } });
        return Promise.resolve({});
      },
    );

    const response = await app.inject({ method: 'POST', url: '/test-audited' });
    expect(response.statusCode).toBe(500);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('internal');
    expect(response.body, 'the refusal echoed the payload back').not.toContain('sk-live');

    expect(await nameOfUser(), 'an action that could not be recorded took effect').toBe(before);
    expect(await rowsForAction('attempt.refused_probe')).toHaveLength(0);
  });
});
