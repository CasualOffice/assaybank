/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Redemption against a real PostgreSQL, with real row-level security.
 *
 * The unit suite covers the policy — which window, which allowance, which refusal. This
 * covers the four things that only a database can establish, and that a fake would quietly
 * pretend to:
 *
 * 1. **The tenant routing works at all.** A redemption arrives with no organisation, so
 *    the first lookup runs through the `SECURITY DEFINER` function of migration
 *    `0005_invitation_lookup`. If that grant or that function is wrong, nothing redeems —
 *    and no unit test can tell.
 * 2. **Single use survives concurrency.** Two redemptions of one invitation, issued at
 *    once against two pooled connections, produce one attempt and one refusal, because
 *    the invitation row is locked (docs/14 `H-139`).
 * 3. **The audit row shares the transaction.** A redemption that fails after the insert
 *    leaves neither the attempt nor its audit row behind.
 * 4. **Isolation holds around all of it.** The attempt lands in the invitation's own
 *    organisation and is invisible to every other one (ADR-010).
 */

import { fixedClock, hashToken } from '@assaybank/auth';
import { PLATFORM_ORG_ID, withOrg } from '@assaybank/db';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPostgresRedemptionGateway } from '../../src/credentials/redemption-postgres.js';
import { deriveCredentialKeys } from '../../src/credentials/keys.js';
import {
  createRedemptionService,
  type RedemptionOutcome,
} from '../../src/credentials/redemption.js';
import {
  seedOrg,
  startTestPostgres,
  type SeededOrg,
  type TestPostgres,
} from './postgres-fixture.js';

const KEYS = deriveCredentialKeys({
  sessionSecret: 'an-integration-session-secret',
  tokenPepper: 'an-integration-token-pepper',
});

/** Containers are slow to start and the suite shares one. */
const BOOT_TIMEOUT_MS = 180_000;

let pg: TestPostgres;

beforeAll(async () => {
  pg = await startTestPostgres();
}, BOOT_TIMEOUT_MS);

afterAll(async () => {
  await pg?.stop();
}, BOOT_TIMEOUT_MS);

/** The real service over the real gateway, with the clock frozen at `now`. */
function serviceAt(now: Date = new Date()): ReturnType<typeof createRedemptionService> {
  const clock = fixedClock(now);
  return createRedemptionService({
    gateway: createPostgresRedemptionGateway({ db: pg.db, clock }),
    keys: KEYS,
    clock,
  });
}

/** A unique label per seeded organisation, so one container serves the whole suite. */
let seedCounter = 0;
function nextLabel(prefix: string): string {
  seedCounter += 1;
  return `${prefix}-${String(seedCounter)}`;
}

/** Every attempt belonging to an invitation, read as the owner. */
async function attemptsOf(
  invitationId: string,
): Promise<{ id: string; org_id: string; status: string }[]> {
  return pg.owner<{ id: string; org_id: string; status: string }[]>`
    SELECT id::text, org_id::text, status::text FROM attempts WHERE invitation_id = ${invitationId}::uuid
  `;
}

/** Every redemption audit row for an organisation, read as the owner. */
async function redemptionAuditOf(
  orgId: string,
): Promise<
  { action: string; entity_id: string; after: Record<string, unknown>; ip: string | null }[]
> {
  return pg.owner<
    { action: string; entity_id: string; after: Record<string, unknown>; ip: string | null }[]
  >`
    SELECT action, entity_id::text, after, host(ip) AS ip
      FROM audit_log
     WHERE org_id = ${orgId}::uuid AND action = 'candidate.invitation_redeem'
     ORDER BY at
  `;
}

/** The refusal reason of an outcome that must have failed. */
function reasonOf(outcome: RedemptionOutcome): string {
  if (outcome.ok) throw new Error('expected the redemption to be refused, but it succeeded');
  return outcome.refusal.reason;
}

describe('the invitation lookup', () => {
  it('routes a token to its organisation without any org context', async () => {
    const org = await seedOrg(pg.owner, nextLabel('routing'), KEYS.pepper);
    const gateway = createPostgresRedemptionGateway({ db: pg.db, clock: fixedClock(new Date()) });

    await expect(gateway.findOrgByTokenHash(`v1$${'0'.repeat(64)}`)).resolves.toBeUndefined();

    // The same call the redemption makes: no app.current_org has been established for
    // this tenant, and the answer still comes back.
    const hashed = hashToken(org.token, KEYS.pepper);
    await expect(gateway.findOrgByTokenHash(hashed)).resolves.toBe(org.orgId);
  });

  it('is the only way in: the application role cannot read invitations unscoped', async () => {
    const org = await seedOrg(pg.owner, nextLabel('unscoped'), KEYS.pepper);
    const hashed = hashToken(org.token, KEYS.pepper);

    const rows = await withOrg(pg.db, org.orgId, async (tx) =>
      tx.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM invitations`),
    );
    expect(rows[0]?.n).toBe(1);

    // The assertion the SECURITY DEFINER function exists for, and the one this test was
    // missing: the *same* transaction the routing lookup runs in — `withOrg` under the
    // nil organisation, which owns no rows by construction (migration 0003) — cannot
    // reach the invitation by its hash through an ordinary SELECT. If `invitations` ever
    // lost its policy, or gained a permissive one, this would return the row and
    // migration 0005 would be dead weight nobody noticed.
    const viaPolicy = await withOrg(pg.db, PLATFORM_ORG_ID, async (tx) =>
      tx.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM invitations WHERE token_hash = ${hashed}`,
      ),
    );
    expect(viaPolicy[0]?.n).toBe(0);

    // And the function, in that same context, still answers.
    const gateway = createPostgresRedemptionGateway({ db: pg.db, clock: fixedClock(new Date()) });
    await expect(gateway.findOrgByTokenHash(hashed)).resolves.toBe(org.orgId);

    const unscoped = await withOrg(
      pg.db,
      // A different tenant: the same query, and the invitation is invisible.
      (await seedOrg(pg.owner, nextLabel('other'), KEYS.pepper)).orgId,
      async (tx) =>
        tx.execute<{ n: number }>(
          sql`SELECT count(*)::int AS n FROM invitations WHERE id = ${org.invitationId}::uuid`,
        ),
    );
    expect(unscoped[0]?.n).toBe(0);
  });

  it('is granted to the application role and to nobody else', async () => {
    const [row] = await pg.owner<{ app: boolean; anyone: boolean }[]>`
      SELECT has_function_privilege('hiring_app', 'public.invitation_org_for_token(text)', 'EXECUTE') AS app,
             has_function_privilege('public',     'public.invitation_org_for_token(text)', 'EXECUTE') AS anyone
    `;

    expect(row?.app).toBe(true);
    expect(row?.anyone).toBe(false);
  });
});

describe('a redemption', () => {
  let org: SeededOrg;

  beforeAll(async () => {
    org = await seedOrg(pg.owner, nextLabel('redeem'), KEYS.pepper);
  });

  it('creates exactly one attempt, in the invitation’s own organisation', async () => {
    const outcome = await serviceAt().redeem({ token: org.token, ip: '203.0.113.9' });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const attempts = await attemptsOf(org.invitationId);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      id: outcome.redemption.attemptId,
      org_id: org.orgId,
      // The lifecycle's first state, from the column default rather than from this code.
      status: 'created',
    });
  });

  it('wrote the audit row in the same transaction, naming the attempt and the address', async () => {
    const rows = await redemptionAuditOf(org.orgId);

    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row?.action).toBe('candidate.invitation_redeem');
    expect(row?.ip).toBe('203.0.113.9');
    expect(row?.after).toMatchObject({
      invitation_id: org.invitationId,
      sitting: 1,
      max_attempts: 1,
      // The writer's own key: a candidate has no user row, so the attempt is the actor.
      actor_attempt_id: row?.entity_id,
    });
  });

  it('refuses the replay and creates nothing the second time', async () => {
    const replay = await serviceAt().redeem({ token: org.token });

    expect(reasonOf(replay)).toBe('already_redeemed');
    await expect(attemptsOf(org.invitationId)).resolves.toHaveLength(1);
    await expect(redemptionAuditOf(org.orgId)).resolves.toHaveLength(1);
  });

  it('leaves the attempt invisible to every other organisation', async () => {
    const other = await seedOrg(pg.owner, nextLabel('neighbour'), KEYS.pepper);

    const seenByNeighbour = await withOrg(pg.db, other.orgId, async (tx) =>
      tx.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM attempts WHERE invitation_id = ${org.invitationId}::uuid`,
      ),
    );
    const seenByOwnerOrg = await withOrg(pg.db, org.orgId, async (tx) =>
      tx.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM attempts WHERE invitation_id = ${org.invitationId}::uuid`,
      ),
    );

    expect(seenByNeighbour[0]?.n).toBe(0);
    expect(seenByOwnerOrg[0]?.n).toBe(1);
  });
});

describe('two redemptions at once', () => {
  it('produce one attempt and one refusal, because the invitation row is locked', async () => {
    // docs/14 H-139 and docs/06 §11.1's concurrency invariant, under real contention:
    // two connections, one row, one winner. A check-then-insert without the lock passes
    // this test sequentially and fails it here.
    const org = await seedOrg(pg.owner, nextLabel('race'), KEYS.pepper);
    const service = serviceAt();

    const outcomes = await Promise.all([
      service.redeem({ token: org.token }),
      service.redeem({ token: org.token }),
    ]);

    expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
    expect(outcomes.filter((outcome) => !outcome.ok).map(reasonOf)).toEqual(['already_redeemed']);

    await expect(attemptsOf(org.invitationId)).resolves.toHaveLength(1);
    await expect(redemptionAuditOf(org.orgId)).resolves.toHaveLength(1);
  });

  it('hands out both sittings of a two-sitting invitation, and no third', async () => {
    const org = await seedOrg(pg.owner, nextLabel('two-sittings'), KEYS.pepper, { maxAttempts: 2 });
    const service = serviceAt();

    const outcomes = await Promise.all([
      service.redeem({ token: org.token }),
      service.redeem({ token: org.token }),
      service.redeem({ token: org.token }),
    ]);

    expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(2);
    await expect(attemptsOf(org.invitationId)).resolves.toHaveLength(2);
  });
});

describe('the transaction boundary', () => {
  it('rolls the attempt back with its audit row when the work fails afterwards', async () => {
    const org = await seedOrg(pg.owner, nextLabel('rollback'), KEYS.pepper);
    const clock = fixedClock(new Date());
    const gateway = createPostgresRedemptionGateway({ db: pg.db, clock });

    await expect(
      gateway.withLockedInvitation(
        org.orgId,
        hashToken(org.token, KEYS.pepper),
        async (invitation, tx) => {
          const candidateId = invitation.candidateId;
          if (candidateId === undefined) throw new Error('the fixture seeded no candidate');

          const attemptId = await tx.createAttempt({
            invitationId: invitation.invitationId,
            candidateId,
            assessmentId: invitation.assessment.id,
            assessmentVersion: invitation.assessment.versionNo,
            at: clock.now(),
          });
          await tx.recordRedemption({
            attemptId,
            invitationId: invitation.invitationId,
            sitting: 1,
            maxAttempts: invitation.maxAttempts,
            ip: undefined,
            at: clock.now(),
          });

          // Whatever happens after the write — a queue publish, a serialisation failure,
          // a bug — the record must not survive the work.
          throw new Error('the work failed after writing');
        },
      ),
    ).rejects.toThrow('the work failed after writing');

    await expect(attemptsOf(org.invitationId)).resolves.toHaveLength(0);
    await expect(redemptionAuditOf(org.orgId)).resolves.toHaveLength(0);

    // And the invitation is still redeemable, because nothing was consumed.
    await expect(serviceAt().redeem({ token: org.token })).resolves.toMatchObject({ ok: true });
  });
});

describe('an invitation that may not be redeemed', () => {
  it('is refused when the assessment is still a draft, and creates nothing', async () => {
    const org = await seedOrg(pg.owner, nextLabel('draft'), KEYS.pepper, {
      assessmentStatus: 'draft',
    });

    expect(reasonOf(await serviceAt().redeem({ token: org.token }))).toBe(
      'assessment_not_published',
    );
    await expect(attemptsOf(org.invitationId)).resolves.toHaveLength(0);
  });

  it('is refused once expired, measured against the injected clock', async () => {
    const expiresAt = new Date('2026-10-12T09:00:00.000Z');
    const org = await seedOrg(pg.owner, nextLabel('expiry'), KEYS.pepper, { expiresAt });

    // One millisecond before: still live. Exactly on it: spent. No sleeping, and no
    // dependence on how long the container took to start (ADR-006).
    expect(reasonOf(await serviceAt(expiresAt).redeem({ token: org.token }))).toBe('expired');
    await expect(
      serviceAt(new Date(expiresAt.getTime() - 1)).redeem({ token: org.token }),
    ).resolves.toMatchObject({ ok: true });
  });

  it('is refused before its window opens', async () => {
    const opensAt = new Date(Date.now() + 24 * 3_600_000);
    const org = await seedOrg(pg.owner, nextLabel('not-open'), KEYS.pepper, { opensAt });

    expect(reasonOf(await serviceAt().redeem({ token: org.token }))).toBe('not_yet_open');
  });

  it('is refused when it has no application, so there is no candidate to attempt', async () => {
    const org = await seedOrg(pg.owner, nextLabel('no-application'), KEYS.pepper, {
      withApplication: false,
    });

    expect(reasonOf(await serviceAt().redeem({ token: org.token }))).toBe('invitation_incomplete');
    await expect(attemptsOf(org.invitationId)).resolves.toHaveLength(0);
  });

  it('is refused when the token belongs to nobody', async () => {
    expect(reasonOf(await serviceAt().redeem({ token: 'a-token-nobody-ever-issued' }))).toBe(
      'no_such_invitation',
    );
  });

  it('is refused when the pepper does not match the one the hash was stored under', async () => {
    // A rotated TOKEN_PEPPER makes every stored hash unverifiable (docs/13 §"TOKEN_PEPPER").
    // The failure mode is a refusal, never an admission.
    const org = await seedOrg(pg.owner, nextLabel('pepper'), KEYS.pepper);
    const elsewhere = deriveCredentialKeys({
      sessionSecret: 'an-integration-session-secret',
      tokenPepper: 'a-different-token-pepper',
    });
    const clock = fixedClock(new Date());

    const service = createRedemptionService({
      gateway: createPostgresRedemptionGateway({ db: pg.db, clock }),
      keys: elsewhere,
      clock,
    });

    expect(reasonOf(await service.redeem({ token: org.token }))).toBe('no_such_invitation');
    await expect(attemptsOf(org.invitationId)).resolves.toHaveLength(0);
  });
});
