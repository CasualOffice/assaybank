/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The redemption policy, against a fake gateway.
 *
 * Everything here is a decision about whether somebody sits an assessment, so each case
 * is one rule: the window, the allowance, the confirmation, the uniformity of a refusal.
 * The *transaction* — the row lock that makes the allowance check and the insert one
 * decision — is not fake-able and is tested in
 * `test/integration/candidate-redeem.integration.test.ts` against a real PostgreSQL.
 *
 * The timing case is the one worth reading twice. It asserts that the comparison deciding
 * whether the presented token matches the stored hash does the same work whether the
 * first byte differs or the last one does, by observing `crypto.timingSafeEqual` itself.
 * An implementation that compared with `===`, or that stopped at the first differing
 * byte, would pass every behavioural assertion in this file and fail that one.
 */

import { timingSafeEqual } from 'node:crypto';

import { fixedClock, hashToken, verifyAttemptToken } from '@assaybank/auth';
import {
  ApiError,
  AssessmentIdSchema,
  AttemptIdSchema,
  CandidateIdSchema,
  InvitationIdSchema,
  OrgIdSchema,
  type AttemptId,
  type OrgId,
} from '@assaybank/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { deriveCredentialKeys } from './keys.js';
import {
  MAX_INVITATION_TOKEN_LENGTH,
  createRedemptionService,
  type CreateAttemptInput,
  type LockedInvitation,
  type RedemptionAuditInput,
  type RedemptionGateway,
  type RedemptionOutcome,
} from './redemption.js';
import { toApiError } from './refusal.js';

/** Only the comparison is observed; the rest of `node:crypto` is the real module. */
type CryptoModule = Record<string, unknown> & { timingSafeEqual: typeof timingSafeEqual };

vi.mock('node:crypto', async (importOriginal) => {
  const actual: CryptoModule = await importOriginal();
  return { ...actual, timingSafeEqual: vi.fn(actual.timingSafeEqual) };
});

const comparisonSpy = vi.mocked(timingSafeEqual);

const KEYS = deriveCredentialKeys({
  sessionSecret: 'a-session-secret-for-the-redemption-tests',
  tokenPepper: 'a-token-pepper-for-the-redemption-tests',
});

const ORG = OrgIdSchema.parse('33333333-3333-4333-8333-333333333333');
const INVITATION = InvitationIdSchema.parse('66666666-6666-4666-8666-666666666666');
const CANDIDATE = CandidateIdSchema.parse('77777777-7777-4777-8777-777777777777');
const ASSESSMENT = AssessmentIdSchema.parse('88888888-8888-4888-8888-888888888888');

const NOW = new Date('2026-10-12T09:00:00.000Z');
const PLAINTEXT = 'an-invitation-token-that-stands-in-for-256-random-bits';
const HOUR_SECONDS = 3600;

/** The invitation a happy-path redemption reads, with every field at its ordinary value. */
function anInvitation(overrides: Partial<LockedInvitation> = {}): LockedInvitation {
  return {
    invitationId: INVITATION,
    orgId: ORG,
    tokenHash: hashToken(PLAINTEXT, KEYS.pepper),
    candidateId: CANDIDATE,
    opensAt: undefined,
    expiresAt: new Date(NOW.getTime() + 7 * 24 * 3_600_000),
    maxAttempts: 1,
    sittingsTaken: 0,
    sentAt: new Date(NOW.getTime() - 3_600_000),
    assessment: {
      id: ASSESSMENT,
      name: 'Backend screen',
      durationSeconds: HOUR_SECONDS,
      status: 'published',
      versionNo: 3,
      allowBackNav: true,
      sectionCount: 2,
    },
    ...overrides,
  };
}

/** A gateway that behaves like the real one without a database. */
interface FakeGateway extends RedemptionGateway {
  readonly created: CreateAttemptInput[];
  readonly audited: RedemptionAuditInput[];
  /** How many times the locking callback was entered. */
  readonly locks: { count: number };
}

function fakeGateway(
  invitation: LockedInvitation | undefined,
  options: { readonly routeTo?: OrgId | undefined } = {},
): FakeGateway {
  const created: CreateAttemptInput[] = [];
  const audited: RedemptionAuditInput[] = [];
  const locks = { count: 0 };
  let current = invitation;
  let nextId = 1;

  return {
    created,
    audited,
    locks,

    findOrgByTokenHash(tokenHash: string): Promise<OrgId | undefined> {
      if (options.routeTo !== undefined) return Promise.resolve(options.routeTo);
      if (current !== undefined && current.tokenHash === tokenHash) {
        return Promise.resolve(current.orgId);
      }
      return Promise.resolve(undefined);
    },

    async withLockedInvitation<T>(
      _orgId: OrgId,
      _tokenHash: string,
      fn: (locked: LockedInvitation, tx: never) => Promise<T>,
    ): Promise<T | undefined> {
      const locked = current;
      if (locked === undefined) return undefined;

      locks.count += 1;

      const tx = {
        createAttempt(input: CreateAttemptInput): Promise<AttemptId> {
          created.push(input);
          // The real gateway counts inside the lock; the fake keeps the same invariant so
          // that a replay in this suite sees what a replay would really see.
          current = { ...locked, sittingsTaken: locked.sittingsTaken + created.length };
          return Promise.resolve(
            AttemptIdSchema.parse(`00000000-0000-4000-8000-00000000000${String(nextId++)}`),
          );
        },
        recordRedemption(input: RedemptionAuditInput): Promise<void> {
          audited.push(input);
          return Promise.resolve();
        },
      };

      return fn(locked, tx as unknown as never);
    },
  };
}

/** The service under test, with the clock frozen at `instant`. */
function serviceFor(
  gateway: RedemptionGateway,
  instant: Date = NOW,
): ReturnType<typeof createRedemptionService> {
  return createRedemptionService({ gateway, keys: KEYS, clock: fixedClock(instant) });
}

/** The refusal reason of an outcome that must have failed. */
function reasonOf(outcome: RedemptionOutcome): string {
  if (outcome.ok) throw new Error('expected the redemption to be refused, but it succeeded');
  return outcome.refusal.reason;
}

beforeEach(() => {
  comparisonSpy.mockClear();
});

describe('a first redemption', () => {
  it('creates one attempt and returns a token scoped to it', async () => {
    const gateway = fakeGateway(anInvitation());
    const outcome = await serviceFor(gateway).redeem({ token: PLAINTEXT, ip: '203.0.113.7' });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(gateway.created).toHaveLength(1);
    expect(gateway.created[0]).toMatchObject({
      invitationId: INVITATION,
      candidateId: CANDIDATE,
      assessmentId: ASSESSMENT,
      assessmentVersion: 3,
    });

    const verified = verifyAttemptToken(
      outcome.redemption.attemptToken,
      KEYS.attemptToken,
      fixedClock(NOW),
      outcome.redemption.attemptId,
    );
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    expect(verified.value.attemptId).toBe(outcome.redemption.attemptId);
    expect(verified.value.orgId).toBe(ORG);
  });

  it('computes the token’s expiry from the assessment and the injected clock', async () => {
    const outcome = await serviceFor(fakeGateway(anInvitation())).redeem({ token: PLAINTEXT });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    // 30 minutes to start + one hour of sitting + 15 minutes of tail.
    expect(outcome.redemption.expiresAt.toISOString()).toBe(
      new Date(NOW.getTime() + (30 * 60 + HOUR_SECONDS + 15 * 60) * 1000).toISOString(),
    );
  });

  it('records one audit entry naming the attempt, the sitting and the address', async () => {
    const gateway = fakeGateway(anInvitation());
    const outcome = await serviceFor(gateway).redeem({ token: PLAINTEXT, ip: '203.0.113.7' });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(gateway.audited).toEqual([
      {
        attemptId: outcome.redemption.attemptId,
        invitationId: INVITATION,
        sitting: 1,
        maxAttempts: 1,
        ip: '203.0.113.7',
        at: NOW,
      },
    ]);
  });

  it('reports which sitting it was', async () => {
    const outcome = await serviceFor(fakeGateway(anInvitation())).redeem({ token: PLAINTEXT });
    expect(outcome.ok && outcome.redemption.sitting).toBe(1);
  });
});

describe('a replayed redemption', () => {
  it('is refused once the invitation’s single sitting has been taken', async () => {
    const gateway = fakeGateway(anInvitation());
    const service = serviceFor(gateway);

    await expect(service.redeem({ token: PLAINTEXT })).resolves.toMatchObject({ ok: true });

    const replay = await service.redeem({ token: PLAINTEXT });

    expect(reasonOf(replay)).toBe('already_redeemed');
    // The important half: no second attempt, and no second audit row claiming one.
    expect(gateway.created).toHaveLength(1);
    expect(gateway.audited).toHaveLength(1);
  });

  it('is refused for an invitation whose sittings were taken before this process started', async () => {
    const spent = anInvitation({ maxAttempts: 1, sittingsTaken: 1 });
    const gateway = fakeGateway(spent);

    expect(reasonOf(await serviceFor(gateway).redeem({ token: PLAINTEXT }))).toBe(
      'already_redeemed',
    );
    expect(gateway.created).toHaveLength(0);
  });

  it('grants exactly as many sittings as max_attempts, and not one more', async () => {
    const gateway = fakeGateway(anInvitation({ maxAttempts: 2 }));
    const service = serviceFor(gateway);

    await expect(service.redeem({ token: PLAINTEXT })).resolves.toMatchObject({ ok: true });
    const second = await service.redeem({ token: PLAINTEXT });
    expect(second.ok && second.redemption.sitting).toBe(2);

    expect(reasonOf(await service.redeem({ token: PLAINTEXT }))).toBe('already_redeemed');
    expect(gateway.created).toHaveLength(2);
  });

  it('gives the two sittings two different attempts, never a second draw at one', async () => {
    const gateway = fakeGateway(anInvitation({ maxAttempts: 2 }));
    const service = serviceFor(gateway);

    const first = await service.redeem({ token: PLAINTEXT });
    const second = await service.redeem({ token: PLAINTEXT });

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.redemption.attemptId).not.toBe(second.redemption.attemptId);
  });
});

describe('the window and the invitation’s state', () => {
  it('refuses an expired invitation, on the instant it expires', async () => {
    const invitation = anInvitation();
    const gateway = fakeGateway(invitation);

    const justBefore = await serviceFor(
      gateway,
      new Date(invitation.expiresAt.getTime() - 1),
    ).redeem({
      token: PLAINTEXT,
    });
    expect(justBefore.ok).toBe(true);

    const fresh = fakeGateway(anInvitation());
    const exactlyAt = await serviceFor(fresh, invitation.expiresAt).redeem({ token: PLAINTEXT });
    expect(reasonOf(exactlyAt)).toBe('expired');
    expect(fresh.created).toHaveLength(0);
  });

  it('refuses an invitation whose window has not opened', async () => {
    const opensAt = new Date(NOW.getTime() + 3_600_000);
    const outcome = await serviceFor(fakeGateway(anInvitation({ opensAt }))).redeem({
      token: PLAINTEXT,
    });

    expect(reasonOf(outcome)).toBe('not_yet_open');
  });

  it('admits it on the instant the window opens', async () => {
    const opensAt = new Date(NOW.getTime() + 3_600_000);
    const outcome = await serviceFor(fakeGateway(anInvitation({ opensAt })), opensAt).redeem({
      token: PLAINTEXT,
    });

    expect(outcome.ok).toBe(true);
  });

  it('refuses an invitation pointing at an assessment that is not published', async () => {
    for (const status of ['draft', 'review', 'retired']) {
      const invitation = anInvitation();
      const outcome = await serviceFor(
        fakeGateway({ ...invitation, assessment: { ...invitation.assessment, status } }),
      ).redeem({ token: PLAINTEXT });

      expect(reasonOf(outcome)).toBe('assessment_not_published');
    }
  });

  it('refuses an invitation with no application, because there is no candidate to attempt', async () => {
    const outcome = await serviceFor(fakeGateway(anInvitation({ candidateId: undefined }))).redeem({
      token: PLAINTEXT,
    });

    expect(reasonOf(outcome)).toBe('invitation_incomplete');
  });
});

describe('a token that matches nothing', () => {
  it('is refused without the gateway ever taking a lock', async () => {
    const gateway = fakeGateway(anInvitation());

    const outcome = await serviceFor(gateway).redeem({ token: 'not-the-token-that-was-mailed' });

    expect(reasonOf(outcome)).toBe('no_such_invitation');
    expect(gateway.locks.count).toBe(0);
  });

  it('is refused when the invitation vanished between the lookup and the lock', async () => {
    // Revoked by staff in the millisecond between the two statements. An ordinary
    // refusal, not an exception.
    const gateway = fakeGateway(undefined, { routeTo: ORG });

    expect(reasonOf(await serviceFor(gateway).redeem({ token: PLAINTEXT }))).toBe(
      'no_such_invitation',
    );
  });

  it('refuses an empty or oversized token before hashing it', async () => {
    const gateway = fakeGateway(anInvitation());
    const service = serviceFor(gateway);

    expect(reasonOf(await service.redeem({ token: '   ' }))).toBe('malformed');
    expect(
      reasonOf(await service.redeem({ token: 'x'.repeat(MAX_INVITATION_TOKEN_LENGTH + 1) })),
    ).toBe('malformed');
    expect(gateway.locks.count).toBe(0);
  });
});

describe('the constant-time confirmation', () => {
  /** The stored hash with exactly one character replaced at `index`. */
  function corruptAt(value: string, index: number): string {
    const replacement = value.charAt(index) === 'a' ? 'b' : 'a';
    return `${value.slice(0, index)}${replacement}${value.slice(index + 1)}`;
  }

  /** The operand lengths of every comparison since the spy was cleared. */
  function comparisons(): Array<[number, number]> {
    return comparisonSpy.mock.calls.map(([left, right]) => [left.byteLength, right.byteLength]);
  }

  it('refuses a row whose stored hash does not match, wherever it differs', async () => {
    const stored = hashToken(PLAINTEXT, KEYS.pepper);

    for (const index of [0, stored.length - 1]) {
      const gateway = fakeGateway(anInvitation({ tokenHash: corruptAt(stored, index) }), {
        routeTo: ORG,
      });

      expect(reasonOf(await serviceFor(gateway).redeem({ token: PLAINTEXT }))).toBe(
        'hash_mismatch',
      );
      expect(gateway.created).toHaveLength(0);
    }
  });

  it('does exactly the same work whether the first or the last byte differs', async () => {
    const stored = hashToken(PLAINTEXT, KEYS.pepper);

    comparisonSpy.mockClear();
    await serviceFor(
      fakeGateway(anInvitation({ tokenHash: corruptAt(stored, 0) }), { routeTo: ORG }),
    ).redeem({ token: PLAINTEXT });
    const firstByteDiffers = comparisons();

    comparisonSpy.mockClear();
    await serviceFor(
      fakeGateway(anInvitation({ tokenHash: corruptAt(stored, stored.length - 1) }), {
        routeTo: ORG,
      }),
    ).redeem({ token: PLAINTEXT });
    const lastByteDiffers = comparisons();

    // One comparison, both operands whole, in both cases. An implementation that stopped
    // at the first differing byte would either not call timingSafeEqual at all or call it
    // with a truncated prefix, and both are visible here.
    expect(firstByteDiffers).toEqual([[stored.length, stored.length]]);
    expect(lastByteDiffers).toEqual(firstByteDiffers);
  });

  it('goes through the constant-time comparison on the success path too', async () => {
    comparisonSpy.mockClear();
    const outcome = await serviceFor(fakeGateway(anInvitation())).redeem({ token: PLAINTEXT });

    expect(outcome.ok).toBe(true);
    const stored = hashToken(PLAINTEXT, KEYS.pepper);
    expect(comparisons()).toContainEqual([stored.length, stored.length]);
  });
});

describe('the refusals a candidate can see', () => {
  it('are one response, whatever actually happened', async () => {
    const stored = hashToken(PLAINTEXT, KEYS.pepper);

    const outcomes = await Promise.all([
      serviceFor(fakeGateway(anInvitation())).redeem({ token: 'no-such-token' }),
      serviceFor(fakeGateway(anInvitation({ sittingsTaken: 1 }))).redeem({ token: PLAINTEXT }),
      serviceFor(fakeGateway(anInvitation()), new Date('2030-01-01T00:00:00.000Z')).redeem({
        token: PLAINTEXT,
      }),
      serviceFor(fakeGateway(anInvitation({ opensAt: new Date(NOW.getTime() + 1) }))).redeem({
        token: PLAINTEXT,
      }),
      serviceFor(fakeGateway(anInvitation({ candidateId: undefined }))).redeem({
        token: PLAINTEXT,
      }),
      serviceFor(
        fakeGateway(anInvitation({ tokenHash: `${stored.slice(0, -1)}z` }), { routeTo: ORG }),
      ).redeem({ token: PLAINTEXT }),
    ]);

    // Six different server-side reasons…
    const reasons = outcomes.map(reasonOf);
    expect(new Set(reasons).size).toBe(6);

    // …and one client-visible response. docs/14 H-146: the endpoint is not an oracle.
    for (const outcome of outcomes) {
      if (outcome.ok) throw new Error('expected a refusal');
      const error: ApiError = toApiError(outcome.refusal);
      expect(error.code).toBe('not_found');
      expect(error.status).toBe(404);
      expect(error.details).toBeUndefined();
      expect(error.message).toBe(ApiError.notFound().message);
    }
  });
});
