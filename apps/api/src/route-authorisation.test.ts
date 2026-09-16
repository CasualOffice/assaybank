/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The enumeration test — the one that matters.
 *
 * Every other authorisation test asserts something about a route somebody remembered to
 * write a test for. This one asserts something about the routes nobody remembered: it
 * walks the table of *registered* routes and fails on any entry that declared no
 * permission and is not on the public allow-list.
 *
 * **Why enumeration is the only method that works.** A route that forgot its declaration
 * looks, from the outside, exactly like a route that is deliberately public: same status,
 * same body, same everything. Reading the diff does not find it either, because the
 * missing line is not in the diff. The only artefact that can tell you is the route table
 * itself, which is why `registerAuthorisation` records one.
 *
 * docs/14 §"Defaults" asks for exactly this: *"New endpoints require an explicit
 * permission key; a route with no permission check fails a CI lint rather than defaulting
 * to authenticated-is-enough."*
 *
 * The suite also proves it can fail. An assertion that a list is empty is worth nothing
 * until you have watched the same assertion notice something in it, so one case adds an
 * undeclared route to the real server and asserts that it is caught.
 */

import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { isPermission } from '@assaybank/auth';
import type { Database } from '@assaybank/db';

import {
  authorisationReport,
  describeRoutes,
  PUBLIC_ROUTES,
  requirePermission,
  type RouteAuthorisationRecord,
} from './authorisation.js';
import { createStaffAuth } from './auth/better-auth.js';
import type { StaffIdentityServices } from './auth/routes.js';
import { memorySessionStore } from './auth/session-store.js';
import type { CandidateCredentialServices } from './credentials/routes.js';
import { buildServer } from './server.js';
import { testConfig } from './test-support.js';

let server: FastifyInstance | undefined;

afterEach(async () => {
  if (server !== undefined) {
    await server.close();
    server = undefined;
  }
});

/**
 * A handle that satisfies `Database` and opens nothing.
 *
 * `buildServer` registers the audit seam only when a database is supplied, and a route
 * that exists only in that branch is still a route this test has to see. Nothing here
 * ever runs a query: the suite builds the server and reads its route table.
 */
const STUB_DB: Database = { close: (): Promise<void> => Promise.resolve() };

/**
 * A service object that satisfies the credential flow's types and refuses to do anything.
 *
 * Every route `buildServer` can register has to be in the table this suite reads, and two
 * of them — redemption and the WebSocket ticket — exist only when `credentials` is
 * supplied, which boot always does (index.ts). Omitting it here would have hidden the
 * only two non-operational routes in the tree from the enumeration, which is the precise
 * failure this whole file exists to make impossible.
 *
 * Nothing is ever called: the suite builds the server and reads its route table. The
 * clock is a fixed instant rather than `new Date()` all the same (ADR-006) — a fixture
 * that reads the wall clock is a fixture somebody copies into a test that cares.
 */
const STUB_CREDENTIALS: CandidateCredentialServices = {
  keys: { attemptToken: 'route-table-fixture-key' },
  clock: { now: (): Date => new Date('2026-10-05T09:00:00.000Z') },
  redemption: {
    redeem: (): never => {
      throw new Error('the route table is read, never driven');
    },
  },
  tickets: {
    issue: (): never => {
      throw new Error('the route table is read, never driven');
    },
    claim: (): never => {
      throw new Error('the route table is read, never driven');
    },
  },
  sessions: {
    findSession: (): never => {
      throw new Error('the route table is read, never driven');
    },
  },
};

/** The one instant this file admits to. ADR-006: nothing here reads the wall clock. */
const FIXED = new Date('2026-10-05T09:00:00.000Z');

/**
 * Staff identity, constructed for real and driven not at all.
 *
 * The five `/auth/*` routes exist only when `buildServer` is handed this, exactly as the
 * redemption and ticket routes exist only when it is handed `credentials` — so a fixture
 * that omits it hides five routes from the enumeration, and the enumeration is the only
 * thing that can notice a route with no declaration. Boot always supplies it (index.ts).
 *
 * `createStaffAuth` is the real call rather than a stub: it opens no socket and touches
 * no row, and a hand-written stub of `ReturnType<typeof createStaffAuth>` would be four
 * generics deep and would drift from the thing it stands for. The session store is a
 * `Map`, the database handle is {@link STUB_DB}, and no request is ever made.
 */
function staffIdentityFixture(): StaffIdentityServices {
  const apiUrl = 'https://api.example.test';
  const consoleUrl = 'https://console.example.test';
  const sessionSecret = 'a-route-table-fixture-session-secret';

  return {
    auth: createStaffAuth({
      config: {
        http: { publicUrl: apiUrl, webPublicUrl: consoleUrl, corsAllowedOrigins: [consoleUrl] },
        secrets: { sessionSecret },
        // Off, and the route table is the same either way: the OIDC pair is registered
        // unconditionally and answers `not_found` when no provider is configured, which is
        // what keeps "is this route declared?" independent of how a tier is configured.
        oidc: { enabled: false },
      },
      store: memorySessionStore(() => FIXED),
      secureCookies: true,
    }),
    db: STUB_DB,
    sessionSecret,
    apiUrl,
    consoleUrl,
    secureCookies: true,
    oidcEnabled: false,
    now: () => FIXED,
  };
}

/** The server as boot assembles it, minus the socket and the real dependencies. */
function productionServer(): FastifyInstance {
  const app = buildServer({
    config: testConfig(),
    logger: false,
    db: STUB_DB,
    credentials: STUB_CREDENTIALS,
    staffIdentity: staffIdentityFixture(),
  });
  server = app;
  return app;
}

function permissionRecords(
  records: readonly RouteAuthorisationRecord[],
): { route: string; permission: string }[] {
  return records.flatMap((record) =>
    record.declaration !== undefined && record.declaration.kind === 'permission'
      ? [{ route: `${record.method} ${record.url}`, permission: record.declaration.permission }]
      : [],
  );
}

describe('every registered route', () => {
  it('declares the permission it requires, or is on the public allow-list', async () => {
    const app = productionServer();
    await app.ready();

    const report = authorisationReport(app);

    // Rendered rather than counted: a failure has to name the routes, or the person
    // reading CI learns only that they have a problem.
    expect(describeRoutes(report.undeclared)).toBe('');
  });

  it('is actually in the table, so the assertion above is not vacuous', async () => {
    const app = productionServer();
    await app.ready();

    const report = authorisationReport(app);

    // /healthz, /readyz, /metrics, /openapi.json, their HEAD twins, and the CORS
    // preflight. A build that registered nothing would pass the emptiness assertion.
    expect(report.routes.length).toBeGreaterThanOrEqual(9);

    const registered = report.routes.map((record) => `${record.method} ${record.url}`);
    expect(registered).toContain('GET /healthz');
    // The CORS preflight is registered by a plugin whose child context is created during
    // `ready()`, after this instance's `onRoute` hook exists. If Fastify ever stopped
    // propagating the hook into that context the table would quietly lose routes, and an
    // emptiness assertion over a shrinking table is the definition of a test that passes
    // for the wrong reason.
    expect(registered).toContain('OPTIONS *');
    // The two routes that exist only when `credentials` is supplied. Named so that a
    // fixture which stopped supplying it fails here rather than silently narrowing every
    // assertion in this file to the four operational endpoints.
    expect(registered).toContain('POST /api/v1/candidate/redeem');
    expect(registered).toContain('POST /api/v1/sessions/:id/ticket');
    // And the five that exist only when `staffIdentity` is. Same argument, and it applies
    // with more force: these are the routes that mint and spend a session, so a fixture
    // that quietly dropped them would leave the emptiness assertion above true and the
    // whole authentication surface unenumerated (docs/03 §1).
    for (const route of [
      'POST /api/v1/auth/login',
      'POST /api/v1/auth/logout',
      'GET /api/v1/auth/me',
      'POST /api/v1/auth/oidc/start',
      'GET /api/v1/auth/oidc/callback',
    ]) {
      expect(registered).toContain(route);
    }

    // The staff business surface (P1 step 7). It exists only when `db` is supplied — the
    // same condition as the audit seam, because `PATCH` is one `request.audited` call —
    // so a fixture that stopped supplying one would hide the first permission-checked
    // business route in the tree from the enumeration.
    expect(registered).toContain('GET /api/v1/org/settings');
    expect(registered).toContain('PATCH /api/v1/org/settings');
  });

  it('gates the organisation settings on org.admin, in both directions', async () => {
    // Named rather than left to the emptiness assertion. `GET` and `PATCH` share a path,
    // and a route pair where one half declares a permission and the other does not is
    // both easy to write and invisible in a diff of the file that wrote it.
    const app = productionServer();
    await app.ready();

    const declared = permissionRecords(authorisationReport(app).routes);
    const settings = declared.filter((entry) => entry.route.endsWith('/org/settings'));

    expect(settings).toStrictEqual([
      { route: 'GET /api/v1/org/settings', permission: 'org.admin' },
      { route: 'HEAD /api/v1/org/settings', permission: 'org.admin' },
      { route: 'PATCH /api/v1/org/settings', permission: 'org.admin' },
    ]);
  });

  it('requires a permission key that exists in the seeded catalogue', async () => {
    // A route asking for `question.pubish` is locked for everyone, permanently, and it
    // fails closed — which is the right direction, and completely silent without this.
    const app = productionServer();
    await app.ready();

    const declared = permissionRecords(authorisationReport(app).routes);

    // Non-vacuity first. "No route asks for an unknown key" is true of a server with no
    // permission-checked routes at all, which is what this assertion said for as long as
    // the fixture built the server without its credential flow.
    expect(declared.length).toBeGreaterThan(0);

    expect(declared.filter((entry) => !isPermission(entry.permission))).toStrictEqual([]);
  });

  it('catches an undeclared route added to the real server', async () => {
    // The meta-test. Watch the assertion notice something before trusting it to notice
    // nothing. `/forgotten` is exactly what a route written without a `config` looks like.
    const app = productionServer();
    void app.register((instance, _opts, done) => {
      instance.get('/forgotten', () => ({ ok: true }));
      instance.get('/remembered', { config: requirePermission('question.read') }, () => ({
        ok: true,
      }));
      done();
    });
    await app.ready();

    const report = authorisationReport(app);

    expect(describeRoutes(report.undeclared)).toBe('GET /forgotten\nHEAD /forgotten');
    expect(describeRoutes(report.undeclared)).not.toContain('/remembered');
  });
});

describe('the public allow-list', () => {
  it('is exactly the routes that were reviewed as public', () => {
    // Pinned deliberately. Adding an entry is a security decision, and a decision that
    // changes a test is a decision somebody reads; a decision that changes nothing is a
    // decision that happens in a diff about something else.
    expect(PUBLIC_ROUTES.map((route) => `${route.method} ${route.url}`)).toStrictEqual([
      'GET /healthz',
      'GET /readyz',
      'GET /metrics',
      'GET /openapi.json',
      'OPTIONS *',
      'POST /api/v1/auth/login',
      'POST /api/v1/auth/oidc/start',
      'GET /api/v1/auth/oidc/callback',
      'POST /api/v1/candidate/redeem',
      'POST /api/v1/auth/logout',
      'GET /api/v1/auth/me',
    ]);
  });

  it('gives a reason for every entry', () => {
    for (const route of PUBLIC_ROUTES) {
      expect(route.reason.trim().length, `${route.method} ${route.url}`).toBeGreaterThan(20);
    }
  });

  it('requires a principal on every entry whose subject is the caller’s own session', () => {
    // `credential: 'session'` is not "authenticated is enough" for business routes. The
    // only two entries carrying it are the two endpoints where the principal is both the
    // actor and the resource, and there is no action for a permission key to name.
    const session = PUBLIC_ROUTES.filter((route) => route.credential === 'session');

    expect(session.map((route) => route.url)).toStrictEqual([
      '/api/v1/auth/logout',
      '/api/v1/auth/me',
    ]);
  });

  it('names no business route', () => {
    // The list a security review reads. Anything under these prefixes would be an
    // organisation's data reachable without a permission.
    for (const route of PUBLIC_ROUTES) {
      expect(route.url).not.toMatch(/\/(questions|assessments|attempts|reports|users)\b/u);
    }
  });
});
