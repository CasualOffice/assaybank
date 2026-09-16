/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What the per-action check does, route by route.
 *
 * The suite is organised around the three ways an authorisation layer fails in practice,
 * in increasing order of how long each survives undetected:
 *
 *  1. It refuses the wrong people. Caught by any test.
 *  2. It checks *a* permission rather than *the* permission. Every single-route test
 *     passes; the eleven-route matrix does not.
 *  3. It says too much when it refuses. A 403 naming the permission it wanted is a free
 *     map of the authorisation model, and it is only ever found by asserting on the whole
 *     body rather than on the status code.
 *
 * The other half of the property — "no route forgot to declare anything" — cannot be
 * tested route by route and lives in route-authorisation.test.ts.
 */

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import {
  PERMISSIONS,
  type CandidatePrincipal,
  type Permission,
  type Principal,
  type StaffPrincipal,
} from '@assaybank/auth';
import {
  AttemptIdSchema,
  ERROR_CODE_MESSAGES,
  OrgIdSchema,
  UserIdSchema,
} from '@assaybank/contracts';
import { metrics } from '@assaybank/observability';

import {
  authorisationDeniedTotal,
  authorisationReport,
  registerAuthorisation,
  requirePermission,
  type PublicRoute,
} from './authorisation.js';
import { registerErrorHandling } from './errors.js';
import { registerRequestContext } from './request-context.js';
import { setPrincipal } from './principal.js';
import { matrixPath, permissionMatrixServer } from './test-support.js';

const ORG_ID = OrgIdSchema.parse('6f1f8c26-0e3a-4a7f-9c1e-5f0a1a8b2c31');
const USER_ID = UserIdSchema.parse('2bb0f1a6-0a8b-4d5e-9c53-9a8f6d2e4b17');
const ATTEMPT_ID = AttemptIdSchema.parse('9c0a3d47-1f2b-4e6a-8d90-3b7c5e1a2f48');

let server: FastifyInstance | undefined;

afterEach(async () => {
  if (server !== undefined) {
    await server.close();
    server = undefined;
  }
});

function staff(permissions: readonly Permission[]): StaffPrincipal {
  return { kind: 'staff', userId: USER_ID, orgId: ORG_ID, permissions: new Set(permissions) };
}

const CANDIDATE: CandidatePrincipal = { kind: 'candidate', attemptId: ATTEMPT_ID, orgId: ORG_ID };

/** A matrix server, remembered so `afterEach` closes it. */
function matrix(principal?: Principal): FastifyInstance {
  const app = permissionMatrixServer(principal === undefined ? {} : { principal });
  server = app;
  return app;
}

/** Which of the eleven permission routes answered 200 for this principal, sorted. */
async function reachable(app: FastifyInstance): Promise<string[]> {
  const granted: string[] = [];
  for (const permission of PERMISSIONS) {
    const response = await app.inject({ method: 'GET', url: matrixPath(permission) });
    if (response.statusCode === 200) granted.push(permission);
  }
  return granted.sort();
}

/**
 * A minimal instance: the request id, the error envelope and the check, with an
 * allow-list of the caller's choosing — which `buildServer` deliberately does not accept,
 * because production has exactly one allow-list.
 */
function bare(publicRoutes: readonly PublicRoute[], principal?: Principal): FastifyInstance {
  const app = Fastify({ logger: false });
  registerRequestContext(app);
  registerErrorHandling(app);
  registerAuthorisation(app, { publicRoutes });
  if (principal !== undefined) {
    // `onRequest` runs before `preValidation` whatever order the two are registered in,
    // so this stands in for the authentication hook exactly as the real one does.
    app.addHook('onRequest', (request, _reply, done) => {
      setPrincipal(request, principal);
      done();
    });
  }
  server = app;
  return app;
}

describe('a route declaring a permission', () => {
  it('serves a principal that holds it', async () => {
    const app = matrix(staff(['question.read']));

    const response = await app.inject({ method: 'GET', url: matrixPath('question.read') });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ permission: string }>().permission).toBe('question.read');
  });

  it('refuses a principal that does not, without running the handler', async () => {
    let handlerRan = false;
    const app = matrix(staff(['question.read']));
    void app.register((instance, _opts, done) => {
      instance.get('/guarded', { config: requirePermission('question.publish') }, () => {
        handlerRan = true;
        return { ok: true };
      });
      done();
    });

    const response = await app.inject({ method: 'GET', url: '/guarded' });

    expect(response.statusCode).toBe(403);
    // The point of checking at preValidation: the work is not discarded, it never ran.
    expect(handlerRan).toBe(false);
  });

  it('refuses a request carrying no credential with 401, not 403', async () => {
    // The distinction is the only thing either response tells a client: re-authenticate,
    // or stop asking.
    const app = matrix();

    const response = await app.inject({ method: 'GET', url: matrixPath('question.read') });

    expect(response.statusCode).toBe(401);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('unauthenticated');
  });

  it('checks the HEAD twin Fastify synthesised as well as the GET', async () => {
    const app = matrix(staff([]));

    const response = await app.inject({ method: 'HEAD', url: matrixPath('question.read') });

    expect(response.statusCode).toBe(403);
  });

  it('checks before the body schema, so a refusal never describes the request', async () => {
    const app = matrix(staff([]));
    void app.register((instance, _opts, done) => {
      instance.post(
        '/guarded',
        {
          config: requirePermission('question.write'),
          schema: {
            body: {
              type: 'object',
              required: ['prompt_md'],
              properties: { prompt_md: { type: 'string' } },
            },
          },
        },
        () => ({ ok: true }),
      );
      done();
    });

    const response = await app.inject({ method: 'POST', url: '/guarded', payload: {} });

    // `validation_failed` here would hand an unauthorised caller the field list of an
    // endpoint they may not call.
    expect(response.statusCode).toBe(403);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('forbidden');
  });
});

describe('a custom role', () => {
  it('grants exactly the permission keys it was assembled from, and no others', async () => {
    // FR-27: an organisation composes its own role from the seeded catalogue. `exam-ops`
    // is not a role name this codebase knows, and that is the property under test — the
    // three keys behave identically to the same three held any other way.
    const examOps: readonly Permission[] = ['attempt.read', 'attempt.void', 'report.export'];
    const app = matrix(staff(examOps));

    expect(await reachable(app)).toStrictEqual([...examOps].sort());
  });

  it('grants nothing from a key outside the seeded catalogue', async () => {
    // A typo in a role definition must lock a door, never open one: `question.pubish`
    // matches no route and grants no neighbouring permission either.
    const app = matrix(staff(['question.pubish', 'question.read']));

    expect(await reachable(app)).toStrictEqual(['question.read']);
  });

  it('grants nothing at all when the role carries no keys', async () => {
    const app = matrix(staff([]));

    expect(await reachable(app)).toStrictEqual([]);
  });

  it('does not imply one permission from another, including from org.admin', async () => {
    // There is no ambient administrator. `org.admin` manages users, roles and settings; a
    // role that should also read the bank says so with a second key.
    const app = matrix(staff(['org.admin']));

    expect(await reachable(app)).toStrictEqual(['org.admin']);
  });

  it('grants every route to a role that was assembled from the whole catalogue', async () => {
    // The positive control. Without it, an implementation that refused everything would
    // pass every assertion above.
    const app = matrix(staff([...PERMISSIONS]));

    expect(await reachable(app)).toStrictEqual([...PERMISSIONS].sort());
  });
});

describe('a candidate principal', () => {
  it('reaches no staff route, for any permission', async () => {
    // The standing leak suite's first assertion, applied to all eleven keys at once. A
    // candidate's authorisation is "this one attempt" and it lives in the attempt token.
    const app = matrix(CANDIDATE);

    expect(await reachable(app)).toStrictEqual([]);
  });
});

describe('the refusal', () => {
  it('is the standard envelope and says nothing about what exists', async () => {
    const app = matrix(staff(['question.read']));

    const response = await app.inject({ method: 'GET', url: matrixPath('attempt.void') });
    const body = response.json<{ error: Record<string, unknown> }>();

    expect(response.statusCode).toBe(403);
    expect(Object.keys(body)).toStrictEqual(['error']);
    // Exactly three members: no details, no cause, no stack, no permission key.
    expect(Object.keys(body.error).sort()).toStrictEqual(['code', 'message', 'request_id']);
    expect(body.error.code).toBe('forbidden');
    expect(body.error.message).toBe(ERROR_CODE_MESSAGES.forbidden);

    expect(response.body).not.toContain('attempt.void');
    expect(response.body).not.toContain('test-matrix');
    expect(response.body).not.toContain(USER_ID);
    expect(response.body).not.toContain(ORG_ID);
  });

  it('is byte-identical whichever permission was required', async () => {
    // Two different missing permissions must not be distinguishable by their responses,
    // or the response is an oracle for the authorisation model.
    const app = matrix(staff([]));

    const first = await app.inject({ method: 'GET', url: matrixPath('question.read') });
    const second = await app.inject({ method: 'GET', url: matrixPath('org.admin') });

    const strip = (body: string): string => body.replace(/req_[0-9a-f]{32}/u, 'req_x');
    expect(strip(first.body)).toBe(strip(second.body));
  });

  it('counts the refusal under the reason it happened for', async () => {
    authorisationDeniedTotal.reset();
    const app = matrix(staff([]));

    await app.inject({ method: 'GET', url: matrixPath('question.read') });
    await app.inject({ method: 'GET', url: matrixPath('question.write') });

    const exposition = await app.inject({ method: 'GET', url: '/metrics' });
    expect(exposition.body).toContain('http_authorisation_denied_total{reason="permission"} 2');
    authorisationDeniedTotal.reset();
  });

  it('counts an unauthenticated request separately from a forbidden one', async () => {
    authorisationDeniedTotal.reset();
    const app = matrix();

    await app.inject({ method: 'GET', url: matrixPath('question.read') });

    const exposition = await app.inject({ method: 'GET', url: '/metrics' });
    expect(exposition.body).toContain(
      'http_authorisation_denied_total{reason="unauthenticated"} 1',
    );
    authorisationDeniedTotal.reset();
  });
});

describe('the public allow-list', () => {
  const OPEN: readonly PublicRoute[] = [
    { method: 'GET', url: '/open', credential: 'none', reason: 'Fixture: deliberately open.' },
    {
      method: 'GET',
      url: '/mine',
      credential: 'session',
      reason: 'Fixture: the subject is the session itself.',
    },
  ];

  it('serves a credential:none route with no principal', async () => {
    const app = bare(OPEN);
    app.get('/open', () => ({ ok: true }));

    const response = await app.inject({ method: 'GET', url: '/open' });

    expect(response.statusCode).toBe(200);
  });

  it('still requires a principal on a credential:session route', async () => {
    const app = bare(OPEN);
    app.get('/mine', () => ({ ok: true }));

    const response = await app.inject({ method: 'GET', url: '/mine' });

    expect(response.statusCode).toBe(401);
  });

  it('serves a credential:session route to a staff principal', async () => {
    // The positive control for the two assertions below: without it, an implementation
    // that refused every session route would pass both of them.
    const app = bare(OPEN, staff([]));
    app.get('/mine', () => ({ ok: true }));

    const response = await app.inject({ method: 'GET', url: '/mine' });

    expect(response.statusCode).toBe(200);
  });

  it('refuses a candidate on a credential:session route', async () => {
    // docs/03 §1: staff and candidates are separate credential domains. `/auth/me` and
    // `/auth/logout` are the only two routes where a principal rather than a permission
    // is the whole test, and a candidate holds no permission — so without a kind check
    // these two would be the only doors an attempt token opens in the entire route table.
    const app = bare(OPEN, CANDIDATE);
    app.get('/mine', () => ({ secret: 'the caller’s own user, org and permissions' }));

    const response = await app.inject({ method: 'GET', url: '/mine' });

    expect(response.statusCode).toBe(403);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('forbidden');
    expect(response.body).not.toContain('secret');
  });

  it('counts a wrong-domain credential under its own reason', async () => {
    // Separate from `permission` because a candidate at a staff session endpoint is a
    // token-scope question, and a staff member missing a key is a role-configuration one.
    authorisationDeniedTotal.reset();
    const app = bare(OPEN, CANDIDATE);
    app.get('/mine', () => ({ ok: true }));

    await app.inject({ method: 'GET', url: '/mine' });

    const exposition = await metrics.metrics();
    expect(exposition).toContain('http_authorisation_denied_total{reason="principal_kind"} 1');
    expect(exposition).not.toContain('http_authorisation_denied_total{reason="permission"} 1');
    authorisationDeniedTotal.reset();
  });

  it('refuses to start when a route is both allow-listed and permission-checked', () => {
    const app = bare(OPEN);

    expect(() => {
      app.get('/open', { config: requirePermission('question.read') }, () => ({ ok: true }));
    }).toThrow(/both requires/u);
  });

  it('refuses to let a route declare itself public', () => {
    const app = bare(OPEN);

    expect(() => {
      app.get(
        '/sneaky',
        { config: { authorisation: { kind: 'public', credential: 'none', reason: 'because' } } },
        () => ({ ok: true }),
      );
    }).toThrow(/PUBLIC_ROUTES/u);
  });

  it('refuses an entry with no reason', () => {
    expect(() => bare([{ method: 'GET', url: '/open', credential: 'none', reason: '  ' }])).toThrow(
      /no reason/u,
    );
  });

  it('refuses two entries for the same route', () => {
    expect(() =>
      bare([
        { method: 'GET', url: '/open', credential: 'none', reason: 'First.' },
        { method: 'GET', url: '/open', credential: 'session', reason: 'Second.' },
      ]),
    ).toThrow(/twice/u);
  });
});

describe('a route that declared nothing', () => {
  it('is refused rather than served, and is recorded as undeclared', async () => {
    const app = matrix(staff([...PERMISSIONS]));
    void app.register((instance, _opts, done) => {
      instance.get('/forgotten', () => ({ secret: true }));
      done();
    });
    await app.ready();

    const response = await app.inject({ method: 'GET', url: '/forgotten' });

    // A principal holding every permission in the catalogue still cannot reach it. The
    // check has nothing to check, so it refuses — the only safe reading of silence.
    expect(response.statusCode).toBe(403);
    expect(response.body).not.toContain('secret');
    expect(authorisationReport(app).undeclared.map((record) => record.url)).toContain('/forgotten');
  });

  it('counts its refusal under a reason an alarm can watch', async () => {
    authorisationDeniedTotal.reset();
    const app = matrix(staff([]));
    void app.register((instance, _opts, done) => {
      instance.get('/forgotten', () => ({ ok: true }));
      done();
    });

    await app.inject({ method: 'GET', url: '/forgotten' });

    const exposition = await app.inject({ method: 'GET', url: '/metrics' });
    // Expected to be flat zero in production forever; an alarm on it catches the route
    // that shipped without a declaration before a customer does.
    expect(exposition.body).toContain('http_authorisation_denied_total{reason="undeclared"} 1');
    authorisationDeniedTotal.reset();
  });
});

describe('a path that matches no route', () => {
  it('still answers not_found, with or without a credential', async () => {
    // Fastify models "no route" as a route, so the check runs for it. Refusing there
    // would turn every unknown path into a 403 — which contradicts docs/03 §2 and is
    // *less* private, because a real route the caller may not touch would stop answering
    // identically to a path that does not exist. That is the oracle ADR-010's
    // "not_found, never forbidden" rule exists to close.
    const anonymous = await (async (): Promise<string> => {
      const app = matrix();
      const response = await app.inject({ method: 'GET', url: '/does-not-exist' });
      expect(response.statusCode).toBe(404);
      return response.body;
    })();
    await server?.close();
    server = undefined;

    const app = matrix(staff([...PERMISSIONS]));
    const response = await app.inject({ method: 'GET', url: '/does-not-exist' });

    expect(response.statusCode).toBe(404);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('not_found');

    const strip = (body: string): string => body.replace(/req_[0-9a-f]{32}/u, 'req_x');
    expect(strip(response.body)).toBe(strip(anonymous));
  });
});

describe('authorisationReport', () => {
  it('refuses to answer for an instance that was never registered', () => {
    const app = Fastify({ logger: false });
    server = app;

    expect(() => authorisationReport(app)).toThrow(/never called/u);
  });

  it('records the declaration a route made, including on its HEAD twin', async () => {
    const app = bare([]);
    app.get('/guarded', { config: requirePermission('attempt.read') }, () => ({ ok: true }));
    await app.ready();

    const records = authorisationReport(app).routes.filter((route) => route.url === '/guarded');

    expect(records.map((route) => route.method).sort()).toStrictEqual(['GET', 'HEAD']);
    for (const record of records) {
      expect(record.declaration).toStrictEqual({ kind: 'permission', permission: 'attempt.read' });
    }
  });
});
