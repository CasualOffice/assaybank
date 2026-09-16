/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The leak suite's third assertion, and the one that runs against real HTTP (P1 step 6).
 *
 * `candidate-scope.test.ts` proves the property about the `Principal`: `can()` denies a
 * candidate every permission, including permissions nobody has invented yet. That is the
 * right assertion about the function. It is not an assertion about the *system*, because
 * a route that never consults `can()` would still be open, and a serialiser that returns
 * the row would still leak.
 *
 * So this file drives a real Fastify instance carrying the real credential flow:
 *
 * 1. **A redeemed attempt token reaches no staff route.** Every permission in the seeded
 *    catalogue gets a route that declares it, the token is presented to all of them, and
 *    every single one refuses. The set of routes is generated from `PERMISSIONS`, so a
 *    permission added in P2 is covered on the day it is added — the only kind of coverage
 *    worth having for "the one someone forgets".
 * 2. **The refusal is a 403, not a 401.** The distinction is the point: the credential was
 *    read, accepted, and turned into a principal, and it still bought nothing. A 401
 *    would mean the token was never parsed, which would make the assertion prove nothing
 *    about scope.
 * 3. **No staff-shaped payload appears in a candidate-scoped response.** Success and
 *    refusal alike are walked against both deny-lists — `forbidden-fields.ts` for content
 *    a candidate must never see, `staff-shaped-fields.ts` for fields that belong to the
 *    staff surface.
 * 4. **The real staff business routes are refused too, by name.** P1 step 7 added the
 *    first of them — `GET` and `PATCH /org/settings` (docs/03 §13) — and the generated
 *    matrix above would not have covered them, because a generated route is a route
 *    somebody wrote to be covered. The refusal happens at the authorisation hook, before
 *    the handler, which is why the server below can hand those routes a database handle
 *    that would throw if a query were ever attempted: reaching one is itself the failure.
 *
 * The imports are relative paths into the workspaces' sources rather than package names,
 * because the leak suite is a root-level Vitest project and is not itself a workspace
 * with dependencies.
 */

import { afterEach, describe, expect, it } from 'vitest';

import {
  PERMISSIONS,
  fixedClock,
  hashToken,
  type Permission,
} from '../../packages/auth/src/index.js';
import {
  API_BASE_PATH,
  AssessmentIdSchema,
  AttemptIdSchema,
  CandidateIdSchema,
  InvitationIdSchema,
  OrgIdSchema,
  SessionIdSchema,
  type OrgId,
  type SessionId,
} from '../../packages/contracts/src/index.js';
import { requirePermission } from '../../apps/api/src/authorisation.js';
import { ORG_SETTINGS_ROUTE } from '../../apps/api/src/org/routes.js';
import { buildServer } from '../../apps/api/src/server.js';
import { testConfig } from '../../apps/api/src/test-support.js';
import { deriveCredentialKeys } from '../../apps/api/src/credentials/keys.js';
import {
  createRedemptionService,
  type CreateAttemptInput,
  type LockedInvitation,
  type RedemptionGateway,
} from '../../apps/api/src/credentials/redemption.js';
import type {
  SessionAvailability,
  SessionGateway,
} from '../../apps/api/src/credentials/sessions.js';
import { memorySingleUseStore } from '../../apps/api/src/credentials/single-use.js';
import { createWsTicketService } from '../../apps/api/src/credentials/ws-ticket.js';
import type { RedeemResponse } from '../../apps/api/src/credentials/responses.js';
import { findForbiddenFields } from './forbidden-fields.js';
import { findStaffShapedFields } from './staff-shaped-fields.js';

/**
 * The server type, taken from the builder rather than imported from `fastify`.
 *
 * The leak suite is a root-level Vitest project with no dependencies of its own, so it
 * cannot name a package that only `apps/api` installs. Inferring the type keeps the
 * suite honest about what it is testing — whatever `buildServer` returns — and keeps the
 * project dependency-free.
 */
type LeakServer = ReturnType<typeof buildServer>;

const KEYS = deriveCredentialKeys({
  sessionSecret: 'a-session-secret-for-the-leak-suite',
  tokenPepper: 'a-token-pepper-for-the-leak-suite',
});

const ORG = OrgIdSchema.parse('33333333-3333-4333-8333-333333333333');
const ATTEMPT = AttemptIdSchema.parse('00000000-0000-4000-8000-000000000001');
const SESSION = SessionIdSchema.parse('44444444-4444-4444-8444-444444444444');

const NOW = new Date('2026-10-12T09:00:00.000Z');
const PLAINTEXT = 'the-invitation-token-the-candidate-was-emailed';
const REDEEM_URL = `${API_BASE_PATH}/candidate/redeem`;

/** The path the staff-route matrix serves for one permission key. */
function matrixPath(permission: Permission): string {
  return `${API_BASE_PATH}/leak-matrix/${permission}`;
}

/**
 * A gateway holding one redeemable invitation.
 *
 * Its rows deliberately carry staff-side fields — the invitation's bookkeeping, the
 * assessment's configuration — because a serialiser that returned what it was given is
 * exactly what this suite exists to catch. If the response were built by spreading the
 * row, the deny-list below would find it.
 */
function fakeRedemptionGateway(): RedemptionGateway {
  let sittingsTaken = 0;

  const invitation = (): LockedInvitation => ({
    invitationId: InvitationIdSchema.parse('66666666-6666-4666-8666-666666666666'),
    orgId: ORG,
    tokenHash: hashToken(PLAINTEXT, KEYS.pepper),
    candidateId: CandidateIdSchema.parse('22222222-2222-4222-8222-222222222222'),
    opensAt: undefined,
    expiresAt: new Date(NOW.getTime() + 7 * 24 * 3_600_000),
    maxAttempts: 3,
    sittingsTaken,
    sentAt: undefined,
    assessment: {
      id: AssessmentIdSchema.parse('88888888-8888-4888-8888-888888888888'),
      name: 'Backend screen',
      durationSeconds: 3600,
      status: 'published',
      versionNo: 4,
      allowBackNav: true,
      sectionCount: 2,
    },
  });

  return {
    findOrgByTokenHash: (tokenHash: string): Promise<OrgId | undefined> =>
      Promise.resolve(tokenHash === invitation().tokenHash ? ORG : undefined),

    withLockedInvitation: async <T>(
      _orgId: OrgId,
      _tokenHash: string,
      fn: (locked: LockedInvitation, tx: never) => Promise<T>,
    ): Promise<T | undefined> => {
      const tx = {
        createAttempt(_input: CreateAttemptInput): Promise<typeof ATTEMPT> {
          sittingsTaken += 1;
          return Promise.resolve(ATTEMPT);
        },
        recordRedemption: (): Promise<void> => Promise.resolve(),
      };
      return fn(invitation(), tx as unknown as never);
    },
  };
}

/** One live interview session, in ORG. */
const fakeSessions: SessionGateway = {
  findSession: (orgId: OrgId, sessionId: SessionId): Promise<SessionAvailability | undefined> =>
    Promise.resolve(
      orgId === ORG && sessionId === SESSION
        ? { sessionId, status: 'live', endedAt: undefined }
        : undefined,
    ),
};

let servers: LeakServer[] = [];

/**
 * A server carrying the real credential flow and one staff route per seeded permission.
 *
 * The matrix routes return a staff-shaped body on purpose. If any of them ever answered
 * a candidate's request, the assertion below would catch it twice: once on the status
 * code, and once on the deny-list finding `permissions` in the body.
 */
function buildLeakServer(): LeakServer {
  const clock = fixedClock(NOW);

  const app = buildServer({
    config: testConfig(),
    logger: false,
    // A handle that opens nothing. `buildServer` registers the staff business routes only
    // when it is given one, so omitting it would have hidden `GET`/`PATCH /org/settings`
    // from this suite behind a 404 that looks exactly like a pass. Nothing here can run a
    // query: the pools live in a WeakMap keyed on the handle, so any statement this
    // object reached would throw — which is the assertion, stated as a fixture.
    db: { close: (): Promise<void> => Promise.resolve() },
    credentials: {
      keys: KEYS,
      clock,
      redemption: createRedemptionService({ gateway: fakeRedemptionGateway(), keys: KEYS, clock }),
      tickets: createWsTicketService({
        signingKey: KEYS.wsTicket,
        pepper: KEYS.pepper,
        clock,
        store: memorySingleUseStore(clock),
      }),
      sessions: fakeSessions,
    },
  });

  void app.register((instance, _opts, done) => {
    for (const permission of PERMISSIONS) {
      instance.get(matrixPath(permission), { config: requirePermission(permission) }, () => ({
        permission,
        permissions: [...PERMISSIONS],
        user: { user_id: '77777777-7777-4777-8777-777777777777', email: 'staff@example.test' },
        org_id: ORG,
      }));
    }
    done();
  });

  servers.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(servers.map((app) => app.close()));
  servers = [];
});

/** Redeems the seeded invitation and returns the attempt token it produced. */
async function redeemedToken(app: LeakServer): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: REDEEM_URL,
    payload: { token: PLAINTEXT },
  });

  expect(response.statusCode).toBe(200);
  return response.json<RedeemResponse>().attempt_token;
}

describe('an attempt token reaches no staff route', () => {
  it('has a permission catalogue to be refused by in the first place', () => {
    // Guards against the vacuous pass: an empty PERMISSIONS would make every assertion
    // below succeed while proving nothing.
    expect(PERMISSIONS.length).toBeGreaterThan(0);
  });

  it('is refused by every route that declares a permission', async () => {
    const app = buildLeakServer();
    const token = await redeemedToken(app);

    for (const permission of PERMISSIONS) {
      const response = await app.inject({
        method: 'GET',
        url: matrixPath(permission),
        headers: { authorization: `Bearer ${token}` },
      });

      // 403, never 200, and never 401: the credential was read and accepted, and the
      // principal it produced holds nothing.
      expect({ permission, status: response.statusCode }).toEqual({ permission, status: 403 });
      expect(response.json<{ error: { code: string } }>().error.code).toBe('forbidden');
    }
  });

  it('is refused by the interview-ticket route, which is a real staff endpoint', async () => {
    const app = buildLeakServer();
    const token = await redeemedToken(app);

    const response = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/sessions/${SESSION}/ticket`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(403);
    expect(response.body).not.toContain('ticket');
  });

  it('is refused by the organisation settings endpoints, on both verbs', async () => {
    // The first real staff business route in the tree (P1 step 7). It is org-scoped,
    // permission-gated and audited, which makes it the shape every endpoint from P2
    // onward has — so a candidate token reaching it would not be one bug, it would be
    // the template for the next twenty.
    const app = buildLeakServer();
    const token = await redeemedToken(app);

    for (const method of ['GET', 'PATCH'] as const) {
      const response = await app.inject({
        method,
        url: ORG_SETTINGS_ROUTE,
        headers: { authorization: `Bearer ${token}` },
        ...(method === 'PATCH' ? { payload: { branding: { display_name: 'Not Yours' } } } : {}),
      });

      // 403, and specifically not 500: a 500 would mean the handler ran and the refusal
      // came from the database rather than from the authorisation check. The server was
      // built with a handle that cannot execute anything, so the distinction is real.
      expect({ method, status: response.statusCode }).toEqual({ method, status: 403 });
      expect(response.json<{ error: { code: string } }>().error.code).toBe('forbidden');

      const body: unknown = response.json();
      expect(findStaffShapedFields(body)).toEqual([]);
      expect(findForbiddenFields(body)).toEqual([]);
      // Nothing about the organisation, its settings, or the permission that was missing.
      expect(response.body).not.toContain('org.admin');
      expect(response.body).not.toContain('settings');
      expect(response.body).not.toContain('branding');
    }
  });

  it('carries no staff-shaped field into any of those refusals', async () => {
    const app = buildLeakServer();
    const token = await redeemedToken(app);

    for (const permission of PERMISSIONS) {
      const response = await app.inject({
        method: 'GET',
        url: matrixPath(permission),
        headers: { authorization: `Bearer ${token}` },
      });

      const body: unknown = response.json();
      expect(findStaffShapedFields(body)).toEqual([]);
      expect(findForbiddenFields(body)).toEqual([]);
      // Not even the name of the permission that was missing: a 403 that named it would
      // hand an attacker a map of the authorisation model one request at a time.
      expect(response.body).not.toContain(permission);
    }
  });
});

describe('no staff-shaped payload reaches a candidate-scoped response', () => {
  it('is true of a successful redemption', async () => {
    const app = buildLeakServer();

    const response = await app.inject({
      method: 'POST',
      url: REDEEM_URL,
      payload: { token: PLAINTEXT },
    });
    const body: unknown = response.json();

    expect(response.statusCode).toBe(200);
    expect(findStaffShapedFields(body)).toEqual([]);
    expect(findForbiddenFields(body)).toEqual([]);
  });

  it('serves exactly the candidate-facing summary and nothing else', async () => {
    const app = buildLeakServer();

    const response = await app.inject({
      method: 'POST',
      url: REDEEM_URL,
      payload: { token: PLAINTEXT },
    });
    const body = response.json<RedeemResponse>();

    // An allow-list beside the deny-list. The deny-list catches the fields we thought of;
    // this catches the field somebody adds that nobody thought to deny.
    expect(Object.keys(body).sort()).toEqual([
      'assessment_summary',
      'attempt',
      'attempt_token',
      'attempt_token_expires_at',
      'server_time',
    ]);
    expect(Object.keys(body.assessment_summary).sort()).toEqual([
      'allow_back_nav',
      'duration_seconds',
      'id',
      'name',
      'section_count',
    ]);
    expect(Object.keys(body.attempt).sort()).toEqual(['id', 'sitting']);
  });

  it('is true of a refused redemption', async () => {
    const app = buildLeakServer();

    const response = await app.inject({
      method: 'POST',
      url: REDEEM_URL,
      payload: { token: 'a-token-that-matches-no-invitation' },
    });
    const body: unknown = response.json();

    expect(response.statusCode).toBe(404);
    expect(findStaffShapedFields(body)).toEqual([]);
    expect(findForbiddenFields(body)).toEqual([]);
  });

  it('never echoes the invitation token, hashed or otherwise', async () => {
    const app = buildLeakServer();

    const response = await app.inject({
      method: 'POST',
      url: REDEEM_URL,
      payload: { token: PLAINTEXT },
    });

    expect(response.body).not.toContain(PLAINTEXT);
    expect(response.body).not.toContain(hashToken(PLAINTEXT, KEYS.pepper));
    // Nor the signing keys, which would be a catastrophe rather than a leak.
    expect(response.body).not.toContain(KEYS.pepper);
    expect(response.body).not.toContain(KEYS.attemptToken);
    expect(response.body).not.toContain(KEYS.wsTicket);
  });

  it('is true of a validation failure, which is the response most likely to echo input', async () => {
    const app = buildLeakServer();

    const response = await app.inject({
      method: 'POST',
      url: REDEEM_URL,
      payload: { token: '' },
    });
    const body: unknown = response.json();

    expect(response.statusCode).toBe(422);
    expect(findStaffShapedFields(body)).toEqual([]);
    expect(findForbiddenFields(body)).toEqual([]);
  });
});
