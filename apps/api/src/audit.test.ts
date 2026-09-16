/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The request-side half of the audit log.
 *
 * The transactional guarantee — an action and its audit row committing or rolling back
 * together, the append-only trigger, the reason constraint — belongs to a real
 * PostgreSQL and is proven in `packages/db/tests/audit.test.ts` against a container.
 * Repeating it here with a stub would prove nothing: a stub transaction commits whatever
 * it is told to (docs/17 §8).
 *
 * What this file owns is everything that happens *before* the transaction opens, which
 * is where every response a client can see is decided:
 *
 *  - who the row will be attributed to,
 *  - that a request with no principal writes nothing and gets 401,
 *  - and that a reason-requiring action with no reason is refused as `validation_failed`
 *    **without opening a transaction at all** — the database handle used below points
 *    nowhere, so a test that answers 422 rather than 500 is a test that proves the work
 *    was never started.
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import type { CandidatePrincipal, Principal, StaffPrincipal } from '@assaybank/auth';
import { AttemptIdSchema, OrgIdSchema, UserIdSchema } from '@assaybank/contracts';
import { createDb, type Database, type DbTransaction } from '@assaybank/db';

import { auditActorFor, auditClientAddress, type AuditEntry, type AuditSpec } from './audit.js';
import { requirePermission } from './authorisation.js';
import { setPrincipal } from './principal.js';
import { buildServer } from './server.js';
import { testConfig } from './test-support.js';

const ORG_ID = OrgIdSchema.parse('6f1f8c26-0e3a-4a7f-9c1e-5f0a1a8b2c31');
const USER_ID = UserIdSchema.parse('2bb0f1a6-0a8b-4d5e-9c53-9a8f6d2e4b17');
const ATTEMPT_ID = AttemptIdSchema.parse('9c0a3d47-1f2b-4e6a-8d90-3b7c5e1a2f48');

const STAFF: StaffPrincipal = {
  kind: 'staff',
  userId: USER_ID,
  orgId: ORG_ID,
  permissions: new Set(['attempt.void', 'attempt.read']),
};

const CANDIDATE: CandidatePrincipal = { kind: 'candidate', attemptId: ATTEMPT_ID, orgId: ORG_ID };

/**
 * A handle whose pools point at a port nothing listens on.
 *
 * `createDb` opens no connection until the first query, so building one is free — and any
 * code path that actually reaches the database fails loudly instead of quietly passing.
 * That is the assertion: the refusals below must happen before a transaction is opened.
 */
function unreachableDb(): Database {
  return createDb({
    url: 'postgres://nobody:nobody@127.0.0.1:1/nowhere',
    jobUrl: 'postgres://nobody:nobody@127.0.0.1:1/nowhere',
    poolMax: 1,
  });
}

let server: FastifyInstance | undefined;
let handle: Database | undefined;

afterEach(async () => {
  if (server !== undefined) {
    await server.close();
    server = undefined;
  }
  if (handle !== undefined) {
    await handle.close();
    handle = undefined;
  }
});

interface HarnessOptions {
  readonly principal?: Principal | undefined;
  /** Omitted means `buildServer` gets no `db`, so the decorator is never installed. */
  readonly withDb?: boolean | undefined;
  readonly spec?: AuditSpec | undefined;
  readonly work?: ((tx: DbTransaction, entry: AuditEntry) => Promise<unknown>) | undefined;
}

/** A server with one route that performs an audited action. */
function harness(options: HarnessOptions = {}): FastifyInstance {
  const useDb = options.withDb ?? true;
  if (useDb) handle = unreachableDb();

  const app = buildServer({
    config: testConfig(),
    logger: false,
    ...(useDb && handle !== undefined ? { db: handle } : {}),
  });
  server = app;

  const { principal } = options;
  if (principal !== undefined) {
    app.addHook('onRequest', (request, _reply, done) => {
      setPrincipal(request, principal);
      done();
    });
  }

  const spec: AuditSpec = options.spec ?? {
    action: 'attempt.void',
    entityType: 'attempt',
    entityId: ATTEMPT_ID,
  };
  const work = options.work ?? ((): Promise<unknown> => Promise.resolve({ ok: true }));

  void app.register((instance, _opts, done) => {
    instance.post('/test-audited', { config: requirePermission('attempt.void') }, async (request) =>
      request.audited(spec, async (tx, entry) => work(tx, entry)),
    );
    done();
  });

  return app;
}

describe('auditActorFor', () => {
  it('attributes a staff action to the user row behind the session', () => {
    expect(auditActorFor(STAFF)).toEqual({ kind: 'staff', userId: USER_ID });
  });

  it('attributes a candidate action to the attempt, because a candidate has no account', () => {
    // docs/03 §1: candidates have no user row, so `actor_user_id` is null and the attempt
    // is what identifies them. A null actor with nothing else on the row would be a
    // record that says "nobody", which reads like a record and is not one.
    expect(auditActorFor(CANDIDATE)).toEqual({ kind: 'candidate', attemptId: ATTEMPT_ID });
  });
});

describe('the client address', () => {
  /**
   * A server on a deployed tier, where `server.ts` turns `trustProxy` on and Fastify
   * therefore reads `request.ip` out of `X-Forwarded-For`.
   */
  function proxiedServer(): FastifyInstance {
    const app = buildServer({
      config: testConfig({ core: { appEnv: 'production', isDeployedTier: true } }),
      logger: false,
    });
    server = app;

    app.addHook('onRequest', (request, _reply, done) => {
      setPrincipal(request, STAFF);
      done();
    });

    void app.register((instance, _opts, done) => {
      instance.get('/test-address', { config: requirePermission('attempt.read') }, (request) => ({
        ip: auditClientAddress(request),
        fastify: request.ip,
      }));
      done();
    });

    return app;
  }

  it('is whatever the trusted proxy reported, when that is an address', async () => {
    const response = await proxiedServer().inject({
      method: 'GET',
      url: '/test-address',
      headers: { 'x-forwarded-for': '203.0.113.7, 198.51.100.1' },
    });

    expect(response.json<{ ip: string | null }>().ip).toBe('203.0.113.7');
  });

  it('falls back to the socket when the forwarded header is not an address', async () => {
    // The bug this closes: with trustProxy on, `request.ip` is the left-most
    // X-Forwarded-For token, unparsed — a client can put any text there. That text used
    // to be handed straight to an `inet` column inside the transaction running the
    // action, so `X-Forwarded-For: nonsense` rolled a void back and answered 500. The
    // address is evidence; the action is the thing that must not be lost to a header.
    const response = await proxiedServer().inject({
      method: 'GET',
      url: '/test-address',
      headers: { 'x-forwarded-for': "nonsense'); DROP TABLE audit_log; --" },
    });

    const body = response.json<{ ip: string | null; fastify: string }>();
    expect(body.fastify, 'fastify no longer passes the header through unparsed').not.toMatch(
      /^[0-9a-f.:]+$/i,
    );
    expect(body.ip).toBe('127.0.0.1');
  });

  it('is null rather than a guess when neither source is an address', () => {
    const request = {
      ip: 'not-an-ip',
      socket: { remoteAddress: undefined },
    } as unknown as Parameters<typeof auditClientAddress>[0];

    expect(auditClientAddress(request)).toBeNull();
  });

  it('accepts an IPv6 client', () => {
    const request = {
      ip: '2001:db8::1',
      socket: { remoteAddress: '127.0.0.1' },
    } as unknown as Parameters<typeof auditClientAddress>[0];

    expect(auditClientAddress(request)).toBe('2001:db8::1');
  });
});

describe('a reason-requiring action with no reason (FR-25)', () => {
  it('is refused as validation_failed, naming the field', async () => {
    // docs/06 §"M4": POST /attempts/{id}/void without a reason returns validation_failed.
    const app = harness({ principal: STAFF });

    const response = await app.inject({ method: 'POST', url: '/test-audited' });

    expect(response.statusCode).toBe(422);
    const body = response.json<{
      error: { code: string; details?: { fields?: { field: string; rule: string }[] } };
    }>();
    expect(body.error.code).toBe('validation_failed');
    expect(body.error.details?.fields).toEqual([{ field: 'body/reason', rule: 'required' }]);
  });

  it('is refused before any transaction opens', async () => {
    // The database handle points at a closed port. A 422 rather than a 500 is the whole
    // assertion: the refusal happened before a connection was asked for, so a void that
    // cannot be recorded never starts the work it would have had to roll back.
    let workRan = false;
    const app = harness({
      principal: STAFF,
      work: (): Promise<unknown> => {
        workRan = true;
        return Promise.resolve({});
      },
    });

    const response = await app.inject({ method: 'POST', url: '/test-audited' });

    expect(response.statusCode).toBe(422);
    expect(workRan, 'the handler ran for an action that could not be recorded').toBe(false);
  });

  it('is refused when the reason is present but blank', async () => {
    const app = harness({
      principal: STAFF,
      spec: { action: 'attempt.void', entityType: 'attempt', entityId: ATTEMPT_ID, reason: '   ' },
    });

    const response = await app.inject({ method: 'POST', url: '/test-audited' });

    expect(response.statusCode).toBe(422);
  });

  it('discloses nothing beyond the field and the action', async () => {
    // docs/14 T-011 and the errors.ts module comment: only text somebody deliberately
    // authored reaches a client. The writer's message cites FR-25 and internal documents.
    const app = harness({ principal: STAFF });

    const response = await app.inject({ method: 'POST', url: '/test-audited' });

    expect(response.body).not.toContain('FR-25');
    expect(response.body).not.toContain('ADR-010');
    expect(response.json<{ error: { message: string } }>().error.message).toBe(
      'This action requires a reason.',
    );
  });
});

describe('a malformed entry', () => {
  it('becomes internal rather than describing itself to the client', async () => {
    // A bad action is a programming mistake, not a caller mistake. Telling the caller
    // which shape the server wanted would hand them the audit model for free.
    const app = harness({
      principal: STAFF,
      spec: { action: 'not an action', entityType: 'attempt' },
    });

    const response = await app.inject({ method: 'POST', url: '/test-audited' });

    expect(response.statusCode).toBe(500);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('internal');
    expect(response.body).not.toContain('not an action');
  });
});

describe('a request with no principal', () => {
  it('is refused with 401 by the route check, before audited() is reached', async () => {
    // The audit trail has no anonymous writer. The permission check gets there first on a
    // declared route; `audited` refuses identically for anything that slips past it.
    const app = harness({});

    const response = await app.inject({ method: 'POST', url: '/test-audited' });

    expect(response.statusCode).toBe(401);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('unauthenticated');
  });
});

describe('a server built without a database', () => {
  it('has no audited decorator at all, so a route cannot silently skip the audit row', async () => {
    // The failure mode this rules out: an instance where `request.audited` exists but
    // quietly does nothing, so the action commits and the record does not.
    const app = buildServer({ config: testConfig(), logger: false });
    server = app;
    await app.ready();

    expect(app.hasRequestDecorator('audited')).toBe(false);
  });

  it('installs it when a database is supplied', async () => {
    const app = harness({ principal: STAFF });
    await app.ready();

    expect(app.hasRequestDecorator('audited')).toBe(true);
  });
});
