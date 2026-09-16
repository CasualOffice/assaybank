/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The seam that carries who is making the request.
 *
 * Three properties, and every one of them is the kind that is asserted by a comment far
 * more often than by a test:
 *
 *  1. **One request, one principal.** Two credentials accepted on one request is refused,
 *     not resolved by last-writer-wins. The dangerous version of this bug is silent —
 *     the request succeeds, as somebody.
 *  2. **No principal outlives its request.** `decorateRequest` puts the default on a
 *     shared shape; a reference default, or an assignment that reached the prototype,
 *     would hand request B the identity of request A. That is a cross-tenant leak with no
 *     database involved at all, so RLS would not catch it.
 *  3. **Absence is a 401, never a guess.** `currentPrincipal` refuses rather than
 *     inventing an anonymous caller a permission check could be handed.
 */

import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import type { CandidatePrincipal, StaffPrincipal } from '@assaybank/auth';
import { ApiError, AttemptIdSchema, OrgIdSchema, UserIdSchema } from '@assaybank/contracts';

import { registerErrorHandling } from './errors.js';
import { currentPrincipal, registerPrincipal, setPrincipal } from './principal.js';
import { registerRequestContext } from './request-context.js';

const ORG_ID = OrgIdSchema.parse('6f1f8c26-0e3a-4a7f-9c1e-5f0a1a8b2c31');
const USER_ID = UserIdSchema.parse('2bb0f1a6-0a8b-4d5e-9c53-9a8f6d2e4b17');
const OTHER_USER_ID = UserIdSchema.parse('7d3e2c11-4b5a-4c8d-9e21-0f6a7b8c9d10');
const ATTEMPT_ID = AttemptIdSchema.parse('9c0a3d47-1f2b-4e6a-8d90-3b7c5e1a2f48');

const ALICE: StaffPrincipal = {
  kind: 'staff',
  userId: USER_ID,
  orgId: ORG_ID,
  permissions: new Set(['question.read']),
};

const BOB: StaffPrincipal = {
  kind: 'staff',
  userId: OTHER_USER_ID,
  orgId: ORG_ID,
  permissions: new Set(['org.admin']),
};

const CANDIDATE: CandidatePrincipal = { kind: 'candidate', attemptId: ATTEMPT_ID, orgId: ORG_ID };

let server: FastifyInstance | undefined;

afterEach(async () => {
  if (server !== undefined) {
    await server.close();
    server = undefined;
  }
});

/** An instance carrying the request id, the error envelope and the decorator. */
function bare(): FastifyInstance {
  const app = Fastify({ logger: false });
  registerRequestContext(app);
  registerErrorHandling(app);
  registerPrincipal(app);
  server = app;
  return app;
}

describe('registerPrincipal', () => {
  it('may be called twice, because two plugins both need the decorator', () => {
    // The authentication plugin and the authorisation plugin each call it and neither
    // knows which was registered first; Fastify throws on a second unconditional
    // decorateRequest, so the guard is the only thing making the order irrelevant.
    const app = bare();

    expect(() => {
      registerPrincipal(app);
    }).not.toThrow();
  });

  it('leaves the principal undefined until something sets it', async () => {
    const app = bare();
    app.get('/who', (request) => ({ present: request.principal !== undefined }));

    const response = await app.inject({ method: 'GET', url: '/who' });

    expect(response.json<{ present: boolean }>().present).toBe(false);
  });
});

describe('setPrincipal', () => {
  it('records the identity for the rest of the request', async () => {
    const app = bare();
    app.addHook('onRequest', (request, _reply, done) => {
      setPrincipal(request, ALICE);
      done();
    });
    app.get('/who', (request) => ({ user: currentPrincipal(request) }));

    const response = await app.inject({ method: 'GET', url: '/who' });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ user: { userId: string } }>().user.userId).toBe(USER_ID);
  });

  it('accepts the same principal twice, so a hook that runs again is not an error', async () => {
    const app = bare();
    app.addHook('onRequest', (request, _reply, done) => {
      setPrincipal(request, ALICE);
      setPrincipal(request, ALICE);
      done();
    });
    app.get('/who', () => ({ ok: true }));

    const response = await app.inject({ method: 'GET', url: '/who' });

    expect(response.statusCode).toBe(200);
  });

  it('refuses a second, different principal rather than keeping the last one', async () => {
    // Two authentication paths that both accepted this request. Whichever one lost was
    // still accepted by something, so the request is refused — it is not silently served
    // as the second identity, and it is emphatically not served as the first while the
    // audit row names the second.
    const app = bare();
    let servedAs: string | undefined;
    app.addHook('onRequest', (request, _reply, done) => {
      setPrincipal(request, ALICE);
      done();
    });
    app.addHook('preValidation', (request, _reply, done) => {
      setPrincipal(request, BOB);
      done();
    });
    app.get('/who', (request) => {
      servedAs = currentPrincipal(request).kind;
      return { ok: true };
    });

    const response = await app.inject({ method: 'GET', url: '/who' });

    expect(response.statusCode).toBe(500);
    expect(servedAs).toBeUndefined();
  });

  it('refuses a principal from the other credential domain just as loudly', async () => {
    // A session cookie and an attempt bearer token on one request. The kinds differ, so a
    // comparison that only looked at `userId` would let this through as nobody in
    // particular.
    const app = bare();
    app.addHook('onRequest', (request, _reply, done) => {
      setPrincipal(request, ALICE);
      done();
    });

    expect(() => {
      const request = { principal: ALICE } as unknown as FastifyRequest;
      setPrincipal(request, CANDIDATE);
    }).toThrow(/already has a principal/u);

    await app.close();
    server = undefined;
  });

  it('says nothing about either identity in the response', async () => {
    // The refusal is a programming error, so it is a 500 — and a 500 that quoted the two
    // principals would put a user id and an attempt id in a body an anonymous caller can
    // read. The envelope is the generic one (docs/03 §2).
    const app = bare();
    app.addHook('onRequest', (request, _reply, done) => {
      setPrincipal(request, ALICE);
      done();
    });
    app.addHook('preValidation', (request, _reply, done) => {
      setPrincipal(request, CANDIDATE);
      done();
    });
    app.get('/who', () => ({ ok: true }));

    const response = await app.inject({ method: 'GET', url: '/who' });
    const body = response.json<{ error: Record<string, unknown> }>();

    expect(response.statusCode).toBe(500);
    expect(Object.keys(body.error).sort()).toStrictEqual(['code', 'message', 'request_id']);
    expect(response.body).not.toContain(USER_ID);
    expect(response.body).not.toContain(ATTEMPT_ID);
    expect(response.body).not.toContain(ORG_ID);
    expect(response.body).not.toContain('already has a principal');
  });

  it('does not leak the principal from one request into the next', async () => {
    // The failure this guards against is `decorateRequest` putting a shared value on the
    // request shape: request two would then be served as request one's user, in another
    // organisation, with no database call involved — so row-level security would never
    // see it. Two requests on one instance, only the first carrying a credential.
    const app = bare();
    app.addHook('onRequest', (request, _reply, done) => {
      if (request.headers['x-test-authenticate'] !== undefined) setPrincipal(request, ALICE);
      done();
    });
    app.get('/who', (request) => ({ user: request.principal?.kind ?? 'none' }));

    const first = await app.inject({
      method: 'GET',
      url: '/who',
      headers: { 'x-test-authenticate': 'yes' },
    });
    const second = await app.inject({ method: 'GET', url: '/who' });

    expect(first.json<{ user: string }>().user).toBe('staff');
    expect(second.json<{ user: string }>().user).toBe('none');
  });
});

describe('currentPrincipal', () => {
  it('answers with the principal when there is one', () => {
    const request = { principal: ALICE } as unknown as FastifyRequest;

    expect(currentPrincipal(request)).toBe(ALICE);
  });

  it('throws unauthenticated rather than inventing an anonymous caller', () => {
    // An "anonymous principal" that satisfied the type is a value that flows into can().
    const request = { principal: undefined } as unknown as FastifyRequest;

    expect(() => currentPrincipal(request)).toThrow(ApiError);
    try {
      currentPrincipal(request);
      expect.unreachable('currentPrincipal returned for a request with no principal');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).code).toBe('unauthenticated');
    }
  });

  it('is a 401 with the standard envelope when it reaches the error handler', async () => {
    const app = bare();
    app.get('/who', (request) => currentPrincipal(request));

    const response = await app.inject({ method: 'GET', url: '/who' });

    expect(response.statusCode).toBe(401);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('unauthenticated');
  });
});
