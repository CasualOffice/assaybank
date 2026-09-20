/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The session lookup behind `POST /sessions/{id}/ticket`, against real row-level security.
 *
 * `routes.test.ts` asserts that the route answers `404` rather than `403` for a session in
 * another organisation — but it does so against a fake gateway whose whole body is
 * `if (orgId !== ORG) return undefined`. That fake *is* the property it is being used to
 * prove, so the route test establishes only that the route reports what the gateway said.
 * The claim that actually matters — docs/14 `H-154` and ADR-010: *"a session id belonging
 * to another tenant returns no row even though the query names it"* — is a claim about
 * PostgreSQL, because `sessions.ts` deliberately has no `WHERE org_id = …` clause. It
 * names the id and nothing else and lets the policy do the scoping.
 *
 * So this file runs the real gateway against the real table:
 *
 * 1. A session is found in its own organisation, with the status and the end instant the
 *    ticket route branches on.
 * 2. The *same id*, asked for by a neighbouring tenant, comes back `undefined` — and it is
 *    the policy that hides it, not a predicate in the query, which is why deleting the
 *    policy would fail this test and deleting a `WHERE` clause could not.
 * 3. An unknown id is `undefined` too, so the two cases are indistinguishable to the
 *    caller and the route has only one answer to give.
 */

import { withOrg } from '@assaybank/db';
import { SessionIdSchema } from '@assaybank/contracts';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPostgresSessionGateway } from '../../src/credentials/sessions.js';
import {
  seedOrg,
  startTestPostgres,
  type SeededOrg,
  type TestPostgres,
} from './postgres-fixture.js';

/** Containers are slow to start and the suite shares one. */
const BOOT_TIMEOUT_MS = 180_000;

/** Any pepper: this suite never reads an invitation. The fixture requires one. */
const PEPPER = 'a-pepper-the-session-suite-never-uses';

let pg: TestPostgres;
let host: SeededOrg;
let neighbour: SeededOrg;

beforeAll(async () => {
  pg = await startTestPostgres();
  host = await seedOrg(pg.owner, 'session-host', PEPPER);
  neighbour = await seedOrg(pg.owner, 'session-neighbour', PEPPER);
}, BOOT_TIMEOUT_MS);

afterAll(async () => {
  await pg?.stop();
}, BOOT_TIMEOUT_MS);

describe('the session behind a ticket request', () => {
  it('is found, live, in its own organisation', async () => {
    const gateway = createPostgresSessionGateway(pg.db);

    const found = await gateway.findSession(host.orgId, host.sessionId);

    expect(found).toEqual({
      sessionId: host.sessionId,
      status: 'live',
      endedAt: undefined,
    });
  });

  it('reports the end instant once the interview is over, which is what refuses the ticket', async () => {
    const endedAt = new Date('2026-10-12T11:30:00.000Z');
    await pg.owner`
      UPDATE interview_sessions
         SET status = 'ended', ended_at = ${endedAt}
       WHERE id = ${neighbour.sessionId}::uuid
    `;

    const found = await createPostgresSessionGateway(pg.db).findSession(
      neighbour.orgId,
      neighbour.sessionId,
    );

    expect(found?.status).toBe('ended');
    expect(found?.endedAt?.toISOString()).toBe(endedAt.toISOString());
  });

  it('is invisible to a neighbouring tenant asking for it by id', async () => {
    const gateway = createPostgresSessionGateway(pg.db);

    // The owner can see it, so the row exists and the id is right: a lookup that returned
    // `undefined` because the fixture failed would prove nothing.
    const [existing] = await pg.owner<{ n: number }[]>`
      SELECT count(*)::int AS n FROM interview_sessions WHERE id = ${host.sessionId}::uuid
    `;
    expect(existing?.n).toBe(1);

    await expect(gateway.findSession(neighbour.orgId, host.sessionId)).resolves.toBeUndefined();
    await expect(gateway.findSession(host.orgId, neighbour.sessionId)).resolves.toBeUndefined();
  });

  it('is hidden by the policy rather than by the query, which is why the query names no org', async () => {
    // The gateway's SQL is `WHERE id = $1` and nothing more. This is the same statement
    // under the neighbour's context: if `interview_sessions` lost its policy, this would
    // return the row and the test above would start passing for the wrong reason.
    const rows = await withOrg(pg.db, neighbour.orgId, async (tx) =>
      tx.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM interview_sessions WHERE id = ${host.sessionId}::uuid`,
      ),
    );

    expect(rows[0]?.n).toBe(0);
  });

  it('answers undefined for an id nobody holds, so absence and another tenant look alike', async () => {
    const unknown = SessionIdSchema.parse('11111111-1111-4111-8111-111111111111');

    await expect(
      createPostgresSessionGateway(pg.db).findSession(host.orgId, unknown),
    ).resolves.toBeUndefined();
  });
});
