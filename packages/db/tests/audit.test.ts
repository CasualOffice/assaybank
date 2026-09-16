/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The audit log against a real PostgreSQL — P1 step 5.
 *
 * `src/audit.test.ts` covers what the writer decides before it reaches a database. This
 * file covers the four properties that only a database can demonstrate, and that are the
 * entire reason the audit log is built the way it is:
 *
 *   1. An action and its audit row commit together.
 *   2. An action that rolls back leaves no audit row — history records what committed,
 *      not what the application believed.
 *   3. `UPDATE`, `DELETE` and `TRUNCATE` on `audit_log` are refused, for the owner as
 *      well as for the application roles, and stay refused under the replication setting
 *      that silently disables ordinary triggers.
 *   4. An action that requires a reason cannot be stored without one — including by a
 *      writer that never heard of `packages/db/src/audit.ts`.
 *
 * None of these can be faked. A stub transaction commits whatever you tell it to, a
 * stub table has no trigger, and a stub has no `session_replication_role` (docs/17 §8).
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AttemptIdSchema, UserIdSchema } from '@assaybank/contracts';

import {
  AUDIT_REASON_KEY,
  AuditEntryError,
  AuditReasonRequiredError,
  PLATFORM_ORG_ID,
  REASON_REQUIRED_ACTIONS,
  createDb,
  isAuditableAddress,
  withElevated,
  withOrg,
  writeAudit,
  type Database,
} from '../src/index.js';
import {
  announceSkip,
  containerRuntime,
  isInsufficientPrivilege,
  required,
  startTestDatabase,
  suiteName,
  type TestDatabase,
} from '../test/postgres-fixture.js';
import { seedOrg, type SeededOrg } from '../test/org-seed.js';

announceSkip('audit.test.ts');

let fixture: TestDatabase | undefined;
let db: Database | undefined;
let org: SeededOrg | undefined;
let other: SeededOrg | undefined;

/** Fixed, injected, and never the wall clock (ADR-006, docs/17 §8). */
const AT = new Date('2026-10-11T11:22:33.000Z');

/** One `audit_log` row as the owner sees it, bypassing every policy. */
interface AuditRow {
  readonly id: string;
  readonly org_id: string;
  readonly actor_user_id: string | null;
  readonly action: string;
  readonly entity_type: string;
  readonly entity_id: string | null;
  readonly before: Record<string, unknown> | null;
  readonly after: Record<string, unknown> | null;
  readonly ip: string | null;
  readonly at: Date;
}

/** Every row for one action, read out of band as the owner. */
async function rowsForAction(action: string): Promise<AuditRow[]> {
  const client = required(fixture, 'fixture').owner;
  return client<AuditRow[]>`
    SELECT id::text AS id, org_id, actor_user_id, action, entity_type,
           entity_id, before, after, host(ip) AS ip, at
      FROM audit_log WHERE action = ${action} ORDER BY id
  `;
}

/** The seeded attempt this suite acts on. */
async function attemptId(seeded: SeededOrg): Promise<string> {
  const client = required(fixture, 'fixture').owner;
  const [row] = await client<{ id: string }[]>`
    SELECT id FROM attempts WHERE org_id = ${seeded.orgId} LIMIT 1
  `;
  return required(row, `an attempt for ${seeded.label}`).id;
}

/**
 * Does `error`, or anything it wraps, carry this SQLSTATE?
 *
 * Drizzle wraps a driver error in a `DrizzleQueryError` whose message is only
 * `Failed query: ...`, so asserting on the text would pass for any failure at all —
 * including the query simply not running. The SQLSTATE is one level down and names the
 * specific refusal.
 */
function hasSqlState(error: unknown, state: string): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && typeof current === 'object' && current !== null; depth += 1) {
    if ('code' in current && current.code === state) return true;
    current = 'cause' in current ? current.cause : undefined;
  }
  return false;
}

/** The status of one attempt, read as the owner. */
async function statusOf(id: string): Promise<string> {
  const client = required(fixture, 'fixture').owner;
  const [row] = await client<{ status: string }[]>`SELECT status FROM attempts WHERE id = ${id}`;
  return required(row, 'the attempt row').status;
}

describe.skipIf(!containerRuntime.available)(suiteName('the audit log (P1 step 5)'), () => {
  beforeAll(async () => {
    fixture = await startTestDatabase();
    org = await seedOrg(fixture.owner, 'audita');
    other = await seedOrg(fixture.owner, 'auditb');
    db = createDb({ url: fixture.appUrl, jobUrl: fixture.jobUrl, poolMax: 4 }, { now: () => AT });
  }, 300_000);

  afterAll(async () => {
    await db?.close();
    await fixture?.stop();
  });

  // ---- the transaction boundary -------------------------------------------
  describe('an action and its audit row', () => {
    it('commit together', async () => {
      const handle = required(db, 'db');
      const seeded = required(org, 'org');
      const target = await attemptId(seeded);
      const actor = UserIdSchema.parse(seeded.userId);

      const id = await withOrg(handle, seeded.orgId, async (tx) => {
        const [before] = await tx.execute<{ status: string }>(
          sql`SELECT status FROM attempts WHERE id = ${target}::uuid`,
        );
        await tx.execute(
          sql`UPDATE attempts SET status = 'voided' WHERE id = ${target}::uuid`,
        );
        return writeAudit(tx, {
          orgId: seeded.orgId,
          actor: { kind: 'staff', userId: actor },
          action: 'attempt.void',
          entityType: 'attempt',
          entityId: target,
          before: { status: required(before, 'the prior status').status },
          after: { status: 'voided' },
          reason: 'Two people were present in the webcam frame; reviewed by a human.',
          ip: '203.0.113.7',
          at: AT,
        });
      });

      expect(id, 'the writer returned no audit id').toMatch(/^[0-9]+$/);
      expect(await statusOf(target), 'the action did not commit').toBe('voided');

      const [row] = await rowsForAction('attempt.void');
      const audit = required(row, 'the audit row for the void');
      expect(audit.id).toBe(id);
      expect(audit.org_id).toBe(seeded.orgId);
      expect(audit.actor_user_id, 'the actor was not recorded').toBe(seeded.userId);
      expect(audit.entity_type).toBe('attempt');
      expect(audit.entity_id).toBe(target);
      expect(audit.before).toEqual({ status: 'created' });
      expect(audit.after?.[AUDIT_REASON_KEY]).toContain('reviewed by a human');
      expect(audit.ip, 'the client address was not recorded').toBe('203.0.113.7');
      // ADR-006: the instant is the injected one, not whatever the database thought.
      expect(audit.at.toISOString()).toBe(AT.toISOString());
    });

    it('roll back together, so history records what committed and not what was attempted', async () => {
      const handle = required(db, 'db');
      const seeded = required(other, 'other');
      const target = await attemptId(seeded);
      const actor = UserIdSchema.parse(seeded.userId);

      await expect(
        withOrg(handle, seeded.orgId, async (tx) => {
          await tx.execute(sql`UPDATE attempts SET status = 'voided' WHERE id = ${target}::uuid`);
          await writeAudit(tx, {
            orgId: seeded.orgId,
            actor: { kind: 'staff', userId: actor },
            action: 'attempt.rollback_probe',
            entityType: 'attempt',
            entityId: target,
            reason: 'recorded, then undone',
            at: AT,
          });
          // Anything after the audit row: a constraint violation, a deadlock, a bug.
          throw new Error('the action failed after its audit row was written');
        }),
      ).rejects.toThrow('the action failed after its audit row was written');

      // Neither half survived. The pairing is the point: if the audit row had been
      // written by a second connection, this assertion would find a record of a void
      // that never happened, attached to an attempt that is still live.
      expect(await statusOf(target), 'the action committed despite the failure').toBe('created');
      expect(await rowsForAction('attempt.rollback_probe')).toHaveLength(0);
    });

    it('do not fall to a client-supplied header: a bogus address is refused before it can abort them', async () => {
      const handle = required(db, 'db');
      const seeded = required(org, 'org');
      const target = await attemptId(seeded);
      const actor = UserIdSchema.parse(seeded.userId);

      // With trustProxy on — every deployed tier — `request.ip` is the left-most
      // X-Forwarded-For token, which is text a client chose. Postgres proves here that
      // such text really does abort the surrounding transaction when it reaches `inet`:
      await expect(
        withOrg(handle, seeded.orgId, async (tx) => {
          await tx.execute(sql`SELECT ${'nonsense'}::inet`);
        }),
        // 22P02, invalid_text_representation: the cast itself refused the value.
      ).rejects.toSatisfy((error: unknown) => hasSqlState(error, '22P02'));

      // ...so the writer refuses it first, and the refusal is the writer's own class
      // rather than a driver error surfacing from halfway through the action.
      await expect(
        withOrg(handle, seeded.orgId, async (tx) => {
          await tx.execute(sql`UPDATE attempts SET status = 'voided' WHERE id = ${target}::uuid`);
          await writeAudit(tx, {
            orgId: seeded.orgId,
            actor: { kind: 'staff', userId: actor },
            action: 'attempt.ip_probe',
            entityType: 'attempt',
            entityId: target,
            reason: 'a client sent X-Forwarded-For: nonsense',
            ip: 'nonsense',
            at: AT,
          });
        }),
      ).rejects.toBeInstanceOf(AuditEntryError);

      expect(await rowsForAction('attempt.ip_probe')).toHaveLength(0);
    });

    it('accept every address the writer lets through', async () => {
      // The other half of the guard: a rule that rejects everything would also pass the
      // test above. Each of these reaches the inet column and comes back.
      const handle = required(db, 'db');
      const seeded = required(org, 'org');
      const actor = UserIdSchema.parse(seeded.userId);

      for (const ip of ['198.51.100.9', '2001:db8::1', '::ffff:127.0.0.1']) {
        expect(isAuditableAddress(ip), `${ip} was refused by the writer`).toBe(true);
        await withOrg(handle, seeded.orgId, async (tx) => {
          await writeAudit(tx, {
            orgId: seeded.orgId,
            actor: { kind: 'staff', userId: actor },
            action: 'attempt.address_probe',
            entityType: 'attempt',
            at: AT,
            ip,
          });
        });
      }

      const stored = (await rowsForAction('attempt.address_probe')).map((row) => row.ip);
      expect(stored).toEqual(['198.51.100.9', '2001:db8::1', '::ffff:127.0.0.1']);
    });
  });

  // ---- the row belongs to its tenant --------------------------------------
  describe('the row', () => {
    it('is visible to the organisation it names and to no other (ADR-010)', async () => {
      const handle = required(db, 'db');
      const mine = required(org, 'org');
      const theirs = required(other, 'other');

      const seen = await withOrg(handle, mine.orgId, async (tx) =>
        tx.execute<{ n: number }>(
          sql`SELECT count(*)::int AS n FROM audit_log WHERE action = 'attempt.void'`,
        ),
      );
      expect(seen[0]?.n).toBe(1);

      const theirView = await withOrg(handle, theirs.orgId, async (tx) =>
        tx.execute<{ n: number }>(
          sql`SELECT count(*)::int AS n FROM audit_log WHERE action = 'attempt.void'`,
        ),
      );
      expect(theirView[0]?.n, "another tenant read this organisation's audit row").toBe(0);
    });
  });

  // ---- append-only, at the database ---------------------------------------
  describe('append-only', () => {
    it('refuses UPDATE from the application role, which has no grant for it (0002)', async () => {
      const handle = required(db, 'db');
      const seeded = required(org, 'org');
      await expect(
        withOrg(handle, seeded.orgId, async (tx) => {
          await tx.execute(sql`UPDATE audit_log SET action = 'tampered'`);
        }),
      ).rejects.toSatisfy(isInsufficientPrivilege);
    });

    it('refuses DELETE from the application role', async () => {
      const handle = required(db, 'db');
      const seeded = required(org, 'org');
      await expect(
        withOrg(handle, seeded.orgId, async (tx) => {
          await tx.execute(sql`DELETE FROM audit_log`);
        }),
      ).rejects.toSatisfy(isInsufficientPrivilege);
    });

    it('refuses UPDATE from the owner, whom no grant binds (0004)', async () => {
      // The gap a REVOKE cannot close. Every migration, every psql session and every
      // restore runs as the owner, and "history that can be rewritten is not a record"
      // has to hold for it too, or the seven-year promise is about who we trust.
      const client = required(fixture, 'fixture').owner;
      await expect(
        client`UPDATE audit_log SET action = 'tampered' WHERE action = 'attempt.void'`,
      ).rejects.toSatisfy(isInsufficientPrivilege);
    });

    it('refuses DELETE from the owner', async () => {
      const client = required(fixture, 'fixture').owner;
      await expect(client`DELETE FROM audit_log WHERE action = 'attempt.void'`).rejects.toSatisfy(
        isInsufficientPrivilege,
      );
    });

    it('refuses a DELETE that would have matched nothing, so the operator learns why', async () => {
      // A row-level trigger would let this succeed silently: it matches no rows, so it
      // fires for none. The statement-level trigger refuses the attempt itself, which is
      // the answer worth giving to somebody who is about to try a wider predicate.
      const client = required(fixture, 'fixture').owner;
      await expect(client`DELETE FROM audit_log WHERE action = 'nothing.matches_this'`).rejects.toSatisfy(
        isInsufficientPrivilege,
      );
    });

    it('refuses TRUNCATE, which is not a DELETE and is not covered by the DELETE grant', async () => {
      const client = required(fixture, 'fixture').owner;
      await expect(client.unsafe('TRUNCATE audit_log')).rejects.toSatisfy(isInsufficientPrivilege);
    });

    it('stays refused under session_replication_role = replica', async () => {
      // The setting a logical-replication apply worker runs under, and the one
      // `pg_restore --disable-triggers` sets. A trigger left at the default ENABLE ORIGIN
      // does not fire under it — so a protection that a routine restore turns off is a
      // protection that is off exactly when somebody is moving the data around.
      const client = required(fixture, 'fixture').owner;
      await expect(
        client.begin(async (tx) => {
          await tx.unsafe(`SET LOCAL session_replication_role = 'replica'`);
          await tx.unsafe(`DELETE FROM audit_log WHERE action = 'attempt.void'`);
        }),
      ).rejects.toSatisfy(isInsufficientPrivilege);

      // And the row is still there.
      expect(await rowsForAction('attempt.void')).toHaveLength(1);
    });

    it('says what it refused and names nothing it was protecting', async () => {
      const client = required(fixture, 'fixture').owner;
      try {
        await client`DELETE FROM audit_log`;
        expect.unreachable('the audit log accepted a DELETE');
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        expect(message).toContain('append-only');
        expect(message).toContain('DELETE');
        // The message reaches logs and, through an inattentive handler, a response body.
        expect(message, 'the refusal quoted a tenant identifier').not.toMatch(
          /[0-9a-f]{8}-[0-9a-f]{4}-/,
        );
      }
    });

    it('still accepts INSERT, which is the one thing it is for', async () => {
      const handle = required(db, 'db');
      const seeded = required(org, 'org');
      const actor = UserIdSchema.parse(seeded.userId);
      const before = (await rowsForAction('question.publish')).length;

      await withOrg(handle, seeded.orgId, async (tx) => {
        await writeAudit(tx, {
          orgId: seeded.orgId,
          actor: { kind: 'staff', userId: actor },
          action: 'question.publish',
          entityType: 'question',
          entityId: seeded.questionId,
          at: AT,
        });
      });

      // Counted as a delta rather than as a total: the fixture seeds one of these per
      // organisation, so an absolute number would be a test about how many orgs the
      // suite happens to seed today.
      expect(await rowsForAction('question.publish')).toHaveLength(before + 1);
    });
  });

  // ---- a reason, where a reason is required (FR-21, FR-25, ADR-010) --------
  describe('a reason-requiring action', () => {
    it('is refused by the writer, and takes the action down with it', async () => {
      const handle = required(db, 'db');
      const seeded = required(org, 'org');
      const target = await attemptId(required(other, 'other'));
      const actor = UserIdSchema.parse(seeded.userId);

      await expect(
        withOrg(handle, seeded.orgId, async (tx) => {
          await tx.execute(
            sql`UPDATE attempts SET status = 'under_review' WHERE id = ${target}::uuid`,
          );
          await writeAudit(tx, {
            orgId: seeded.orgId,
            actor: { kind: 'staff', userId: actor },
            action: 'score.override',
            entityType: 'attempt',
            entityId: target,
            before: { raw_score: 41 },
            after: { raw_score: 55 },
            at: AT,
          });
        }),
      ).rejects.toBeInstanceOf(AuditReasonRequiredError);

      // The refusal is inside the transaction, so the override did not happen either.
      // An action that cannot be recorded does not take effect (docs/17 §11 rule 4).
      expect(await statusOf(target)).toBe('created');
      expect(await rowsForAction('score.override')).toHaveLength(0);
    });

    it('is refused by the database too, for a writer that never heard of audit.ts', async () => {
      // The backstop for everything that is not the TypeScript call site: a psql session,
      // an importer, a future service in another language, a fixture taking a shortcut.
      const client = required(fixture, 'fixture').owner;
      const seeded = required(org, 'org');

      for (const action of REASON_REQUIRED_ACTIONS) {
        await expect(
          client`
            INSERT INTO audit_log (org_id, actor_user_id, action, entity_type)
            VALUES (${seeded.orgId}, ${seeded.userId}, ${action}, 'attempt')
          `,
          `${action} was stored with no reason`,
        ).rejects.toThrow(/audit_log_reason_required/);
      }
    });

    it('is refused when the reason is present but empty, which is the same thing', async () => {
      const client = required(fixture, 'fixture').owner;
      const seeded = required(org, 'org');

      for (const payload of ['{}', '{"reason": null}', '{"reason": ""}', '{"reason": "   "}']) {
        await expect(
          client`
            INSERT INTO audit_log (org_id, actor_user_id, action, entity_type, after)
            VALUES (${seeded.orgId}, ${seeded.userId}, 'attempt.void', 'attempt', ${payload}::jsonb)
          `,
          `a void was stored with after = ${payload}`,
        ).rejects.toThrow(/audit_log_reason_required/);
      }
    });

    it('is refused for any elevated background access, by prefix rather than by list', async () => {
      // ADR-010: BYPASSRLS is granted on the understanding that every use is explainable.
      // The predicate is `action LIKE 'job.%'`, so a job invented in P4 is covered on the
      // day it is written rather than on the day somebody remembers to add it.
      const client = required(fixture, 'fixture').owner;
      await expect(
        client`
          INSERT INTO audit_log (org_id, action, entity_type)
          VALUES (${PLATFORM_ORG_ID}, 'job.invented_next_year', 'system')
        `,
      ).rejects.toThrow(/audit_log_reason_required/);
    });

    it('is accepted with one, and the reason is where the runbook looks for it', async () => {
      const handle = required(db, 'db');
      const seeded = required(org, 'org');
      const target = await attemptId(seeded);
      const actor = UserIdSchema.parse(seeded.userId);

      await withOrg(handle, seeded.orgId, async (tx) => {
        await writeAudit(tx, {
          orgId: seeded.orgId,
          actor: { kind: 'staff', userId: actor },
          action: 'score.override',
          entityType: 'attempt',
          entityId: target,
          before: { raw_score: 41 },
          after: { raw_score: 55 },
          reason: 'Question 3 accepted an equivalent answer the key omitted.',
          at: AT,
        });
      });

      // docs/12 §"score dispute" step 4 reads `before`, `after` and the reason off one
      // row. FR-21: both scores survive, and so does the sentence explaining the
      // disagreement, which is what makes the decision defensible eighteen months later.
      const [row] = await rowsForAction('score.override');
      const audit = required(row, 'the override audit row');
      expect(audit.before).toEqual({ raw_score: 41 });
      expect(audit.after).toEqual({
        raw_score: 55,
        [AUDIT_REASON_KEY]: 'Question 3 accepted an equivalent answer the key omitted.',
      });
    });

    it('keeps the SQL constraint and REASON_REQUIRED_ACTIONS the same list', async () => {
      // A constraint in SQL and a constant in TypeScript cannot share a definition, so
      // the next best thing is a test that fails the day they stop agreeing — in either
      // direction. Without it, adding an action to one list is a silent half-change.
      const client = required(fixture, 'fixture').owner;
      const [row] = await client<{ definition: string }[]>`
        SELECT pg_get_constraintdef(oid) AS definition
          FROM pg_constraint
         WHERE conname = 'audit_log_reason_required'
           AND conrelid = 'public.audit_log'::regclass
      `;
      const definition = required(row, 'the reason constraint').definition;

      const quoted = /'([a-z0-9_.]+)'::text/g;
      const inSql = new Set(
        [...definition.matchAll(quoted)].map((match) => match[1]).filter((value) => value?.includes('.')),
      );

      for (const action of REASON_REQUIRED_ACTIONS) {
        expect(inSql, `${action} is required in TypeScript but not in 0004`).toContain(action);
      }
      for (const action of inSql) {
        expect(
          REASON_REQUIRED_ACTIONS as readonly string[],
          `${String(action)} is required in 0004 but not in TypeScript`,
        ).toContain(action);
      }
      expect(definition, 'the job.% prefix rule left the constraint').toContain('job.%');
    });
  });

  // ---- the elevated path writes through the same writer --------------------
  describe('withElevated', () => {
    it('records its elevation through the one writer, reason and all', async () => {
      const handle = required(db, 'db');
      const seeded = required(org, 'org');

      await withElevated(handle, { reason: 'job.grade', orgId: seeded.orgId, entityType: 'attempt' }, async (tx) => {
        await tx.execute(sql`SELECT 1`);
      });

      const [row] = await rowsForAction('job.grade');
      const audit = required(row, 'the elevation audit row');
      expect(audit.actor_user_id, 'a background job has no human actor').toBeNull();
      expect(audit.after).toEqual({
        role: 'hiring_job',
        bypassed_rls: true,
        [AUDIT_REASON_KEY]: 'job.grade',
      });
      expect(audit.at.toISOString()).toBe(AT.toISOString());
    });
  });

  // ---- the candidate actor -------------------------------------------------
  describe('a candidate action', () => {
    it('is attributed by attempt, because a candidate has no user row', async () => {
      const handle = required(db, 'db');
      const seeded = required(org, 'org');
      const target = AttemptIdSchema.parse(await attemptId(seeded));

      await withOrg(handle, seeded.orgId, async (tx) => {
        await writeAudit(tx, {
          orgId: seeded.orgId,
          actor: { kind: 'candidate', attemptId: target },
          action: 'candidate.submit',
          entityType: 'attempt',
          entityId: target,
          at: AT,
        });
      });

      const [row] = await rowsForAction('candidate.submit');
      const audit = required(row, 'the candidate audit row');
      expect(audit.actor_user_id).toBeNull();
      expect(audit.after).toEqual({ actor_attempt_id: target });
    });
  });

  // ---- the migration is replayable ----------------------------------------
  it('is idempotent: 0004 re-applies as a no-op', async () => {
    // Every statement in the migration is CREATE OR REPLACE, DROP IF EXISTS or guarded,
    // so `make migrate` twice is safe and a half-applied migration can be finished by
    // re-running it rather than by hand-editing the journal.
    const client = required(fixture, 'fixture').owner;
    const path = new URL('../migrations/0004_audit_append_only.sql', import.meta.url);
    const { readFileSync } = await import('node:fs');
    const statements = readFileSync(path, 'utf8')
      .split('--> statement-breakpoint')
      .map((part) => part.trim())
      .filter((part) => part !== '');

    for (const statement of statements) {
      await client.unsafe(statement);
    }

    // And the protections are still in place afterwards.
    await expect(client`DELETE FROM audit_log`).rejects.toSatisfy(isInsufficientPrivilege);
  });

  // ---- a second pool sees exactly what committed ---------------------------
  it('shows a second pool the committed rows and none of the rolled-back ones', async () => {
    // A different pool, a different connection, a different transaction: the only thing
    // that could carry a row across is a commit. Everything asserted above about the
    // rollback is restated here from outside the pool that performed it.
    const started = required(fixture, 'fixture');
    const seeded = required(org, 'org');
    const separate = createDb({ url: started.appUrl, jobUrl: started.jobUrl, poolMax: 1 });
    try {
      const rows = await withOrg(separate, seeded.orgId, async (tx) =>
        tx.execute<{ action: string }>(sql`SELECT action FROM audit_log ORDER BY id`),
      );
      const actions = rows.map((row) => row.action);
      expect(actions).toContain('attempt.void');
      expect(actions, 'a rolled-back action reached a second pool').not.toContain(
        'attempt.rollback_probe',
      );
    } finally {
      await separate.close();
    }
  });
});
