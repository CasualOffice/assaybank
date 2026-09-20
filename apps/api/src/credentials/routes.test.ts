/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The two endpoints, through a real Fastify instance.
 *
 * Everything below `inject()` is the real thing — the request context, the rate limiter,
 * the authorisation hook, the error handler, the real redemption policy over a fake
 * gateway — because the properties being asserted are properties of the *composition*.
 * That a refusal is uniform is not a fact about `refusal.ts`; it is a fact about what
 * leaves the socket, and only a request can establish it.
 *
 * The distinction this file exists to draw sharply: an attempt token presented to the
 * ticket route is **authenticated and then refused**. The 403 rather than the 401 is the
 * proof that the credential was accepted as a credential and still bought nothing — which
 * is what "the attempt token grants exactly one attempt and nothing else" means in
 * practice.
 */

import { fixedClock, hashToken, verifyAttemptToken, type StaffPrincipal } from '@assaybank/auth';
import {
  API_BASE_PATH,
  AssessmentIdSchema,
  AttemptIdSchema,
  CandidateIdSchema,
  InvitationIdSchema,
  OrgIdSchema,
  SessionIdSchema,
  UserIdSchema,
  type OrgId,
  type SessionId,
} from '@assaybank/contracts';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { authorisationReport } from '../authorisation.js';
import { setPrincipal } from '../principal.js';
import { buildServer } from '../server.js';
import { testConfig } from '../test-support.js';
import { deriveCredentialKeys } from './keys.js';
import {
  createRedemptionService,
  type CreateAttemptInput,
  type LockedInvitation,
  type RedemptionGateway,
} from './redemption.js';
import type { RedeemResponse, TicketResponse } from './responses.js';
import type { SessionAvailability, SessionGateway } from './sessions.js';
import { memorySingleUseStore } from './single-use.js';
import { createWsTicketService } from './ws-ticket.js';
import { mintAttemptToken } from './attempt-token.js';

const KEYS = deriveCredentialKeys({
  sessionSecret: 'a-session-secret-for-the-route-tests',
  tokenPepper: 'a-token-pepper-for-the-route-tests',
});

const ORG = OrgIdSchema.parse('33333333-3333-4333-8333-333333333333');
const OTHER_ORG = OrgIdSchema.parse('99999999-9999-4999-8999-999999999999');
const SESSION = SessionIdSchema.parse('44444444-4444-4444-8444-444444444444');
const ENDED_SESSION = SessionIdSchema.parse('55555555-5555-4555-8555-555555555555');
const STAFF_USER = UserIdSchema.parse('77777777-7777-4777-8777-777777777777');
const ATTEMPT = AttemptIdSchema.parse('00000000-0000-4000-8000-000000000001');

const NOW = new Date('2026-10-12T09:00:00.000Z');
const PLAINTEXT = 'the-invitation-token-that-was-mailed-to-the-candidate';

const TICKET_PATH = `${API_BASE_PATH}/sessions/${SESSION}/ticket`;

/** The invitation the fake gateway holds, with one sitting to give. */
function anInvitation(): LockedInvitation {
  return {
    invitationId: InvitationIdSchema.parse('66666666-6666-4666-8666-666666666666'),
    orgId: ORG,
    tokenHash: hashToken(PLAINTEXT, KEYS.pepper),
    candidateId: CandidateIdSchema.parse('22222222-2222-4222-8222-222222222222'),
    opensAt: undefined,
    expiresAt: new Date(NOW.getTime() + 7 * 24 * 3_600_000),
    maxAttempts: 1,
    sittingsTaken: 0,
    sentAt: undefined,
    assessment: {
      id: AssessmentIdSchema.parse('88888888-8888-4888-8888-888888888888'),
      name: 'Backend screen',
      durationSeconds: 3600,
      status: 'published',
      versionNo: 3,
      allowBackNav: true,
      sectionCount: 2,
    },
  };
}

/** A gateway holding one invitation, which spends its sitting when redeemed. */
function fakeRedemptionGateway(): RedemptionGateway {
  let invitation = anInvitation();

  return {
    findOrgByTokenHash: (tokenHash: string): Promise<OrgId | undefined> =>
      Promise.resolve(tokenHash === invitation.tokenHash ? invitation.orgId : undefined),

    withLockedInvitation: async <T>(
      _orgId: OrgId,
      _tokenHash: string,
      fn: (locked: LockedInvitation, tx: never) => Promise<T>,
    ): Promise<T | undefined> => {
      const locked = invitation;
      const tx = {
        createAttempt(_input: CreateAttemptInput): Promise<typeof ATTEMPT> {
          invitation = { ...locked, sittingsTaken: locked.sittingsTaken + 1 };
          return Promise.resolve(ATTEMPT);
        },
        recordRedemption(): Promise<void> {
          return Promise.resolve();
        },
      };
      return fn(locked, tx as unknown as never);
    },
  };
}

/** A gateway that knows about one live session and one that has ended, in ORG only. */
const fakeSessions: SessionGateway = {
  findSession(orgId: OrgId, sessionId: SessionId): Promise<SessionAvailability | undefined> {
    if (orgId !== ORG) return Promise.resolve(undefined);
    if (sessionId === SESSION) {
      return Promise.resolve({ sessionId, status: 'live', endedAt: undefined });
    }
    if (sessionId === ENDED_SESSION) {
      return Promise.resolve({ sessionId, status: 'ended', endedAt: NOW });
    }
    return Promise.resolve(undefined);
  },
};

/** A staff principal holding exactly `permissions`. */
function staff(permissions: readonly string[], orgId: OrgId = ORG): StaffPrincipal {
  return { kind: 'staff', userId: STAFF_USER, orgId, permissions: new Set(permissions) };
}

interface ServerOptions {
  /** Deposited by an `onRequest` hook, standing in for the staff session of step 3. */
  readonly principal?: StaffPrincipal | undefined;
}

let servers: FastifyInstance[] = [];

/** Builds a server with the credential flow wired to fakes and a frozen clock. */
function buildTestServer(options: ServerOptions = {}): FastifyInstance {
  const clock = fixedClock(NOW);

  const app = buildServer({
    config: testConfig(),
    logger: false,
    credentials: {
      keys: KEYS,
      clock,
      redemption: createRedemptionService({
        gateway: fakeRedemptionGateway(),
        keys: KEYS,
        clock,
      }),
      tickets: createWsTicketService({
        signingKey: KEYS.wsTicket,
        pepper: KEYS.pepper,
        clock,
        store: memorySingleUseStore(clock),
      }),
      sessions: fakeSessions,
    },
  });

  const principal = options.principal;
  if (principal !== undefined) {
    app.addHook('onRequest', (request, _reply, done) => {
      setPrincipal(request, principal);
      done();
    });
  }

  servers.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(servers.map((app) => app.close()));
  servers = [];
});

describe('POST /candidate/redeem', () => {
  it('exchanges the invitation for an attempt token scoped to one attempt', async () => {
    const app = buildTestServer();

    const response = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/candidate/redeem`,
      payload: { token: PLAINTEXT },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<RedeemResponse>();

    expect(body.attempt.id).toBe(ATTEMPT);
    expect(body.attempt.sitting).toBe(1);
    expect(body.assessment_summary).toEqual({
      id: '88888888-8888-4888-8888-888888888888',
      name: 'Backend screen',
      duration_seconds: 3600,
      section_count: 2,
      allow_back_nav: true,
    });
    expect(body.server_time).toBe(NOW.toISOString());

    const verified = verifyAttemptToken(body.attempt_token, KEYS.attemptToken, fixedClock(NOW));
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    expect(verified.value.attemptId).toBe(ATTEMPT);
    expect(verified.value.orgId).toBe(ORG);
  });

  it('refuses the replay, with the same response a token that never existed gets', async () => {
    const app = buildTestServer();

    const first = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/candidate/redeem`,
      payload: { token: PLAINTEXT },
    });
    expect(first.statusCode).toBe(200);

    const replay = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/candidate/redeem`,
      payload: { token: PLAINTEXT },
    });
    const invented = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/candidate/redeem`,
      payload: { token: 'a-token-that-was-never-issued-by-anyone' },
    });

    expect(replay.statusCode).toBe(404);
    expect(invented.statusCode).toBe(404);

    const replayBody = replay.json<{ error: Record<string, unknown> }>();
    const inventedBody = invented.json<{ error: Record<string, unknown> }>();

    expect(replayBody.error.code).toBe('not_found');
    expect(replayBody.error.details).toBeUndefined();
    // Identical but for the request id, which is per-request by construction.
    expect({ ...replayBody.error, request_id: '' }).toEqual({
      ...inventedBody.error,
      request_id: '',
    });
  });

  it('never returns the attempt token twice', async () => {
    const app = buildTestServer();
    const payload = { token: PLAINTEXT };

    const first = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/candidate/redeem`,
      payload,
    });
    const second = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/candidate/redeem`,
      payload,
    });

    expect(first.json<RedeemResponse>().attempt_token.length).toBeGreaterThan(0);
    expect(second.body).not.toContain('attempt_token');
  });

  it('rejects a body that is not a token', async () => {
    const app = buildTestServer();

    for (const payload of [
      {},
      { token: '' },
      { token: null },
      { token: { nested: 1 } },
      { token: [] },
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: `${API_BASE_PATH}/candidate/redeem`,
        payload,
      });

      expect(response.statusCode).toBe(422);
      expect(response.json<{ error: { code: string } }>().error.code).toBe('validation_failed');
    }
  });

  it('never lets a malformed body become anything but a refusal', async () => {
    // Fastify's Ajv coerces a scalar to the declared type, so `42` arrives as "42" rather
    // than as a validation failure. That is harmless here and asserted rather than
    // assumed: whatever the coercion does, the value is hashed and matches no invitation,
    // so the response is the same uniform 404 as any other wrong token.
    const app = buildTestServer();

    const response = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/candidate/redeem`,
      payload: { token: 42 },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('not_found');
  });

  it('carries the request id a candidate would quote to support', async () => {
    const app = buildTestServer();

    const response = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/candidate/redeem`,
      payload: { token: 'nope' },
    });

    expect(response.headers['x-request-id']).toMatch(/^req_[0-9a-f]{32}$/u);
    expect(response.json<{ error: { request_id: string } }>().error.request_id).toBe(
      response.headers['x-request-id'],
    );
  });
});

describe('POST /sessions/{id}/ticket', () => {
  it('mints a single-use ticket for a host', async () => {
    const app = buildTestServer({ principal: staff(['interview.host']) });

    const response = await app.inject({ method: 'POST', url: TICKET_PATH });

    expect(response.statusCode).toBe(200);
    const body = response.json<TicketResponse>();
    expect(body.expires_in).toBe(60);
    expect(body.session_id).toBe(SESSION);
    expect(body.server_time).toBe(NOW.toISOString());
    expect(body.ticket.startsWith('abwt1.')).toBe(true);
  });

  it('refuses a staff user who may not host interviews', async () => {
    const app = buildTestServer({ principal: staff(['attempt.read', 'report.export']) });

    const response = await app.inject({ method: 'POST', url: TICKET_PATH });

    expect(response.statusCode).toBe(403);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('forbidden');
  });

  it('refuses a request carrying no credential at all', async () => {
    const app = buildTestServer();

    const response = await app.inject({ method: 'POST', url: TICKET_PATH });

    expect(response.statusCode).toBe(401);
  });

  it('refuses an attempt token — authenticated, and still granted nothing', async () => {
    const app = buildTestServer();
    const { token } = mintAttemptToken(
      { attemptId: ATTEMPT, orgId: ORG, durationSeconds: 3600 },
      KEYS.attemptToken,
      fixedClock(NOW),
    );

    const response = await app.inject({
      method: 'POST',
      url: TICKET_PATH,
      headers: { authorization: `Bearer ${token}` },
    });

    // 403, not 401: the hook accepted the credential and turned it into a principal, and
    // the principal held no permission. A 401 here would mean the token was not read at
    // all, which would make this assertion prove nothing about scope.
    expect(response.statusCode).toBe(403);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('forbidden');
  });

  it('answers not_found for a session in another organisation', async () => {
    const app = buildTestServer({ principal: staff(['interview.host'], OTHER_ORG) });

    const response = await app.inject({ method: 'POST', url: TICKET_PATH });

    // Never 403: a 403 would confirm that somebody else holds this id (docs/14 H-154).
    expect(response.statusCode).toBe(404);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('not_found');
  });

  it('answers not_found for an interview that has ended', async () => {
    const app = buildTestServer({ principal: staff(['interview.host']) });

    const response = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/sessions/${ENDED_SESSION}/ticket`,
    });

    expect(response.statusCode).toBe(404);
  });

  it('rejects an id that is not a UUID', async () => {
    const app = buildTestServer({ principal: staff(['interview.host']) });

    const response = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/sessions/not-a-uuid/ticket`,
    });

    expect(response.statusCode).toBe(422);
  });

  it('mints a different ticket every time, so one cannot be spent twice by accident', async () => {
    const app = buildTestServer({ principal: staff(['interview.host']) });

    const first = await app.inject({ method: 'POST', url: TICKET_PATH });
    const second = await app.inject({ method: 'POST', url: TICKET_PATH });

    expect(first.json<TicketResponse>().ticket).not.toBe(second.json<TicketResponse>().ticket);
  });
});

describe('the route table', () => {
  it('records a declaration for both credential routes', async () => {
    const app = buildTestServer();
    await app.ready();

    const report = authorisationReport(app);
    const urls = report.routes.map((route) => `${route.method} ${route.url}`);

    expect(urls).toContain(`POST ${API_BASE_PATH}/candidate/redeem`);
    expect(urls).toContain(`POST ${API_BASE_PATH}/sessions/:id/ticket`);
    // Neither may be the route somebody forgot to declare.
    expect(report.undeclared).toEqual([]);
  });

  it('declares the ticket route with a permission rather than as public', async () => {
    const app = buildTestServer();
    await app.ready();

    const ticketRoute = authorisationReport(app).routes.find(
      (route) => route.url === `${API_BASE_PATH}/sessions/:id/ticket`,
    );

    expect(ticketRoute?.declaration).toEqual({ kind: 'permission', permission: 'interview.host' });
  });
});
