/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Organisation context through a *shared* connection pool — P1 step 1.
 *
 * `tests/rls.test.ts` proves the policies isolate. This file proves the other half, the
 * half that has nothing to do with SQL: that the right organisation is in scope when a
 * policy is evaluated, on a pool where connections are handed round between requests.
 *
 * **Sequential coverage would pass a broken implementation.** Setting `app.current_org`
 * once per connection — the obvious reading of ADR-010's "per checkout" — is correct for
 * one request at a time and wrong the moment two overlap: request B borrows a connection
 * request A has already stamped, and reads A's tenant. Every assertion below that matters
 * is therefore concurrent. A naive implementation is green under a sequential suite, which
 * is precisely how it ships.
 *
 * Three properties, in the order they can fail:
 *
 *   1. Two interleaved `withOrg` calls, each pausing while the other queries, see only
 *      their own rows.
 *   2. Under a storm of overlapping checkouts on a small pool, no call ever sees another
 *      organisation's row.
 *   3. A connection handed back to the pool carries nothing. Asserted three ways, one of
 *      which deliberately breaks it first — an assertion that something is absent is worth
 *      nothing until you have watched the same assertion notice it being present.
 *
 * Plus `withElevated`: the right role, and an `audit_log` row that commits and rolls back
 * with the work it describes (ADR-010's price for `BYPASSRLS`).
 */

import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { OrgId } from '@assaybank/contracts';

import {
  OrgContextLeakError,
  PLATFORM_ORG_ID,
  createDb,
  withElevated,
  withOrg,
  type Database,
} from '../src/index.js';
import {
  announceSkip,
  containerRuntime,
  required,
  startTestDatabase,
  suiteName,
  type TestDatabase,
} from '../test/postgres-fixture.js';
import { seedOrg, type SeededOrg } from '../test/org-seed.js';

announceSkip('org-context.test.ts');

let fixture: TestDatabase | undefined;
let db: Database | undefined;
let orgA: SeededOrg | undefined;
let orgB: SeededOrg | undefined;

/** A promise plus its resolver, so two concurrent callbacks can take turns on purpose. */
function barrier(): { readonly wait: Promise<void>; release: () => void } {
  let release = (): void => undefined;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
}

/** Every `org_id` visible in `attempts` to a caller scoped to `org`, deduplicated. */
async function visibleOrgIds(handle: Database, org: OrgId): Promise<string[]> {
  return withOrg(handle, org, async (tx) => {
    const rows = await tx.execute<{ org_id: string }>(sql`SELECT org_id FROM attempts`);
    return [...new Set(rows.map((row) => row.org_id))];
  });
}

describe.skipIf(!containerRuntime.available)(suiteName('organisation context (ADR-010)'), () => {
  beforeAll(async () => {
    fixture = await startTestDatabase();
    orgA = await seedOrg(fixture.owner, 'ctxa');
    orgB = await seedOrg(fixture.owner, 'ctxb');
    db = createDb({ url: fixture.appUrl, jobUrl: fixture.jobUrl, poolMax: 4 });
  }, 300_000);

  afterAll(async () => {
    await db?.close();
    await fixture?.stop();
  });

  // ---- the property that only concurrency can test -------------------------
  describe('interleaving', () => {
    it('keeps two organisations apart when their transactions overlap on one pool', async () => {
      const handle = required(db, 'db');
      const a = required(orgA, 'orgA');
      const b = required(orgB, 'orgB');

      // The interleave is forced, not hoped for. A reads, then hands control to B and
      // blocks; B reads and hands control back; A reads again. Both transactions are open
      // across the other's query, which is the state a per-connection implementation
      // cannot survive and a sequential test never produces.
      const aStarted = barrier();
      const bFinished = barrier();

      const aWork = withOrg(handle, a.orgId, async (tx) => {
        const before = await tx.execute<{ org_id: string }>(sql`SELECT org_id FROM attempts`);
        aStarted.release();
        await bFinished.wait;
        const after = await tx.execute<{ org_id: string }>(sql`SELECT org_id FROM attempts`);
        return {
          before: [...new Set(before.map((row) => row.org_id))],
          after: [...new Set(after.map((row) => row.org_id))],
        };
      });

      const bWork = withOrg(handle, b.orgId, async (tx) => {
        await aStarted.wait;
        const rows = await tx.execute<{ org_id: string }>(sql`SELECT org_id FROM attempts`);
        bFinished.release();
        return [...new Set(rows.map((row) => row.org_id))];
      });

      const [seenByA, seenByB] = await Promise.all([aWork, bWork]);

      expect(seenByA.before, 'org A saw something other than its own attempts').toEqual([a.orgId]);
      expect(seenByB, 'org B saw something other than its own attempts').toEqual([b.orgId]);
      // The one that catches a per-connection implementation: A's second read happens
      // after B has set the variable, on a pool both are using.
      expect(seenByA.after, "org A's view changed after org B ran a query").toEqual([a.orgId]);
    });

    it('holds under a storm of overlapping checkouts on a pool smaller than the work', async () => {
      const handle = required(db, 'db');
      const a = required(orgA, 'orgA');
      const b = required(orgB, 'orgB');

      // Forty calls, four connections: every connection is reused nine or ten times while
      // other calls are mid-transaction. The `setTimeout(0)` inside each transaction is
      // what makes the overlap real — without a yield the driver could run each callback
      // to completion before the next one starts, and the suite would be sequential while
      // looking concurrent.
      const work = Array.from({ length: 40 }, (_, index) => {
        const org = index % 2 === 0 ? a : b;
        return withOrg(handle, org.orgId, async (tx) => {
          await new Promise((resolve) => setTimeout(resolve, index % 7));
          const rows = await tx.execute<{ org_id: string }>(
            sql`SELECT org_id FROM attempts ORDER BY created_at`,
          );
          return { expected: org.orgId, seen: [...new Set(rows.map((row) => row.org_id))] };
        });
      });

      for (const result of await Promise.all(work)) {
        expect(
          result.seen,
          `a concurrent checkout scoped to ${result.expected} saw another org`,
        ).toEqual([result.expected]);
      }
    });
  });

  // ---- nothing survives the commit ----------------------------------------
  describe('a connection returned to the pool', () => {
    it('carries no app.current_org, so the next checkout starts clean', async () => {
      // poolMax: 1. Every call below is the same physical connection, so "the next
      // checkout" is not a hypothetical — it is guaranteed to be the one just released.
      const a = required(orgA, 'orgA');
      const b = required(orgB, 'orgB');
      const single = createDb({
        url: required(fixture, 'fixture').appUrl,
        jobUrl: required(fixture, 'fixture').jobUrl,
        poolMax: 1,
      });

      try {
        for (const org of [a, b, a, a, b]) {
          // `withOrg` throws if the connection arrived carrying anything at all — even the
          // same organisation — so five clean checkouts in a row is a direct statement
          // that the transaction-local setting was discarded each time.
          expect(await visibleOrgIds(single, org.orgId)).toEqual([org.orgId]);
        }
      } finally {
        await single.close();
      }
    });

    it('would be caught if it did: a session-scoped setting survives the commit and is refused', async () => {
      // The negative control for the test above. A `set_config(..., false)` inside a
      // committed transaction is session-scoped, so it rides the connection back into the
      // pool — exactly the leak ADR-010 describes, reproduced on purpose. If this test
      // ever stopped failing the way it does, the test above would be proving nothing.
      const a = required(orgA, 'orgA');
      const b = required(orgB, 'orgB');
      const poisoned = createDb({
        url: required(fixture, 'fixture').appUrl,
        jobUrl: required(fixture, 'fixture').jobUrl,
        poolMax: 1,
      });

      try {
        await withOrg(poisoned, a.orgId, async (tx) => {
          await tx.execute(sql`SELECT set_config('app.current_org', ${b.orgId}, false)`);
        });

        await expect(
          withOrg(poisoned, a.orgId, () => Promise.resolve('never reached')),
        ).rejects.toBeInstanceOf(OrgContextLeakError);
      } finally {
        // Closed rather than reused: the connection is deliberately still poisoned.
        await poisoned.close();
      }
    });

    it('names no organisation in the error, because the error is going into a log', () => {
      const error = new OrgContextLeakError();
      expect(error.message).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
      expect(error.message).toContain('ADR-010');
    });

    it('relies on a PostgreSQL guarantee, asserted here rather than assumed', async () => {
      // The mechanism under everything above: `set_config(name, value, true)` is discarded
      // at COMMIT, and a never-set placeholder reads as NULL. Both are load-bearing — the
      // second is why an unscoped connection denies rather than admits (0002) — and both
      // are cheap enough to assert directly instead of citing.
      const bare = postgres(required(fixture, 'fixture').appUrl, { max: 1 });
      try {
        const [fresh] = await bare<{ unset: boolean }[]>`
          SELECT current_setting('app.current_org', true) IS NULL AS unset
        `;
        expect(required(fresh, 'the unset reading').unset).toBe(true);

        await bare.begin(async (tx) => {
          await tx`SELECT set_config('app.current_org', 'transaction-local', true)`;
          const [inside] = await tx<{ value: string }[]>`
            SELECT current_setting('app.current_org', true) AS value
          `;
          expect(required(inside, 'the in-transaction reading').value).toBe('transaction-local');
        });

        // Same connection — max: 1 — after the commit.
        const [after] = await bare<{ value: string | null }[]>`
          SELECT coalesce(current_setting('app.current_org', true), '') AS value
        `;
        expect(required(after, 'the post-commit reading').value).toBe('');
      } finally {
        await bare.end();
      }
    });
  });

  // ---- withOrg runs as the role that policies apply to ---------------------
  it('runs as hiring_app, the role row-level security is enforced for', async () => {
    const handle = required(db, 'db');
    const a = required(orgA, 'orgA');

    const identity = await withOrg(handle, a.orgId, async (tx) => {
      const rows = await tx.execute<{ role: string; bypass: boolean; scoped: string }>(sql`
        SELECT current_user AS role,
               rolbypassrls AS bypass,
               current_setting('app.current_org', true) AS scoped
          FROM pg_roles
         WHERE rolname = current_user
      `);
      return required(rows[0], 'the identity row');
    });

    expect(identity.role).toBe('hiring_app');
    expect(identity.bypass, 'hiring_app must not bypass RLS (ADR-010)').toBe(false);
    expect(identity.scoped).toBe(a.orgId);
  });

  // ---- withElevated: BYPASSRLS, and the trail it owes ----------------------
  describe('withElevated', () => {
    it('runs as hiring_job, records the reason on the session, and writes an audit row', async () => {
      const a = required(orgA, 'orgA');
      const b = required(orgB, 'orgB');
      const client = required(fixture, 'fixture').owner;

      const elevations: { reason: string; orgId: OrgId }[] = [];
      const at = new Date('2026-10-06T09:15:00.000Z');
      const handle = createDb(
        {
          url: required(fixture, 'fixture').appUrl,
          jobUrl: required(fixture, 'fixture').jobUrl,
          poolMax: 2,
        },
        {
          onElevation: (record) => elevations.push({ reason: record.reason, orgId: record.orgId }),
          now: () => at,
        },
      );

      try {
        const seen = await withElevated(handle, 'job.deadline_sweep', async (tx) => {
          const rows = await tx.execute<{ role: string; bypass: boolean; reason: string }>(sql`
            SELECT current_user AS role,
                   rolbypassrls AS bypass,
                   current_setting('app.elevation_reason', true) AS reason
              FROM pg_roles
             WHERE rolname = current_user
          `);
          const identity = required(rows[0], 'the identity row');

          const orgs = await tx.execute<{ id: string }>(sql`SELECT id FROM organizations`);
          return { identity, orgIds: orgs.map((row) => row.id) };
        });

        expect(seen.identity.role).toBe('hiring_job');
        expect(seen.identity.bypass, 'the job role bypasses RLS by design (ADR-010)').toBe(true);
        expect(seen.identity.reason).toBe('job.deadline_sweep');
        // BYPASSRLS means every tenant at once, which is the whole reason it owes a trail.
        expect(seen.orgIds).toContain(a.orgId);
        expect(seen.orgIds).toContain(b.orgId);

        const [row] = await client<
          { org_id: string; actor_user_id: string | null; entity_type: string; at: Date }[]
        >`
          SELECT org_id, actor_user_id, entity_type, at
            FROM audit_log WHERE action = 'job.deadline_sweep'
        `;
        const audit = required(row, 'the elevation audit row');
        expect(audit.org_id, 'a sweep acts for no single tenant').toBe(PLATFORM_ORG_ID);
        expect(audit.actor_user_id, 'a background job has no human actor').toBeNull();
        expect(audit.entity_type).toBe('system');
        // Time is injected, never read from the wall clock (ADR-006, docs/17 §8).
        expect(audit.at.toISOString()).toBe(at.toISOString());

        expect(elevations).toEqual([{ reason: 'job.deadline_sweep', orgId: PLATFORM_ORG_ID }]);
      } finally {
        await handle.close();
      }
    });

    it('attributes the row to the organisation when the job knows which one it is acting for', async () => {
      const handle = required(db, 'db');
      const a = required(orgA, 'orgA');

      await withElevated(
        handle,
        { reason: 'job.grade', orgId: a.orgId, entityType: 'attempt' },
        async (tx) => {
          await tx.execute(sql`SELECT 1`);
        },
      );

      // The point of attributing it: the organisation can see, in its own history, that a
      // background job touched its data. A row filed under the platform is a row the
      // affected tenant cannot read.
      const visible = await withOrg(handle, a.orgId, async (tx) => {
        const rows = await tx.execute<{ action: string; entity_type: string }>(
          sql`SELECT action, entity_type FROM audit_log WHERE action = 'job.grade'`,
        );
        return rows;
      });

      expect(visible).toHaveLength(1);
      expect(visible[0]?.entity_type).toBe('attempt');
    });

    it('rolls the audit row back with the work, so history records only what committed', async () => {
      const handle = required(db, 'db');
      const client = required(fixture, 'fixture').owner;

      await expect(
        withElevated(handle, 'job.rollback_probe', async (tx) => {
          await tx.execute(sql`SELECT 1`);
          throw new Error('the job failed after elevating');
        }),
      ).rejects.toThrow('the job failed after elevating');

      const [row] = await client<{ n: number }[]>`
        SELECT count(*)::int AS n FROM audit_log WHERE action = 'job.rollback_probe'
      `;
      expect(
        required(row, 'the rollback count').n,
        'an elevation that rolled back must not claim it read anything',
      ).toBe(0);
    });

    it('still tells the log stream about an elevation that rolled back', async () => {
      // The two records answer different questions: the audit row says what committed,
      // the hook says what was attempted. A job that elevates and then fails every time
      // is invisible in the first and obvious in the second.
      const elevations: string[] = [];
      const handle = createDb(
        {
          url: required(fixture, 'fixture').appUrl,
          jobUrl: required(fixture, 'fixture').jobUrl,
          poolMax: 1,
        },
        { onElevation: (record) => elevations.push(record.reason) },
      );

      try {
        await expect(
          withElevated(handle, 'job.attempted_only', () => Promise.reject(new Error('nope'))),
        ).rejects.toThrow('nope');
        expect(elevations).toEqual(['job.attempted_only']);
      } finally {
        await handle.close();
      }
    });

    it('refuses an elevation with no reason', async () => {
      const handle = required(db, 'db');
      await expect(withElevated(handle, '   ', () => Promise.resolve(undefined))).rejects.toThrow(
        /requires a reason/,
      );
    });

    it('refuses a reason that would not read as a background action', async () => {
      // `audit_log.actor_user_id` is null for a job, so the `job.` prefix is the only
      // thing separating "a machine did this" from "nobody recorded who did this".
      const handle = required(db, 'db');
      for (const reason of ['grade', 'attempt.void', 'JOB.grade', 'job.']) {
        await expect(
          withElevated(handle, reason, () => Promise.resolve(undefined)),
        ).rejects.toThrow(/is not a job action/);
      }
    });

    it('writes no audit row for a reason it refused', async () => {
      const handle = required(db, 'db');
      const client = required(fixture, 'fixture').owner;
      const before = await client<{ n: number }[]>`SELECT count(*)::int AS n FROM audit_log`;

      await expect(
        withElevated(handle, 'attempt.void', () => Promise.resolve(undefined)),
      ).rejects.toThrow();

      const after = await client<{ n: number }[]>`SELECT count(*)::int AS n FROM audit_log`;
      expect(after[0]?.n).toBe(before[0]?.n);
    });
  });

  // ---- the platform organisation ------------------------------------------
  describe('the platform organisation', () => {
    it('cannot be created, so it can never own a row (0003)', async () => {
      const client = required(fixture, 'fixture').owner;
      await expect(
        client`
          INSERT INTO organizations (id, name, slug)
          VALUES (${PLATFORM_ORG_ID}, 'Platform', 'platform')
        `,
      ).rejects.toThrow(/organizations_id_not_platform/);
    });

    it('sees nothing, which is what makes it safe for the readiness probe', async () => {
      // apps/api runs /readyz through withOrg as this organisation precisely because a
      // table with a missing policy still could not leak a row to it.
      const handle = required(db, 'db');
      const rows = await withOrg(handle, PLATFORM_ORG_ID, async (tx) =>
        tx.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM attempts`),
      );
      expect(rows[0]?.n).toBe(0);
    });

    it('cannot read the platform audit rows from inside a tenant', async () => {
      const handle = required(db, 'db');
      const a = required(orgA, 'orgA');

      const visible = await withOrg(handle, a.orgId, async (tx) =>
        tx.execute<{ n: number }>(
          sql`SELECT count(*)::int AS n FROM audit_log WHERE org_id = ${PLATFORM_ORG_ID}`,
        ),
      );
      expect(visible[0]?.n, 'a tenant read a platform-scoped audit row').toBe(0);
    });
  });
});
