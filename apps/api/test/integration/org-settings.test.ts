/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The vertical slice — P1 step 7, and the test the whole phase exists to make possible.
 *
 * The plan states one sentence, and this file asserts every clause of it separately:
 *
 * > A request arrives carrying a session, resolves to an organisation, passes a
 * > per-action permission check, reads a row that row-level security scoped, writes an
 * > audit entry in the same transaction, and returns the standard error envelope when any
 * > step fails.
 *
 * | Stage | The assertion |
 * |---|---|
 * | a session arrives | no cookie is `unauthenticated`, and so is a forged one; a cookie minted by a real login is not |
 * | it resolves to an organisation | the body names the signed-in user's own organisation, read back from the row |
 * | a per-action check passes | a colleague in the same tenant without `org.admin` is `forbidden`, on both verbs |
 * | row-level security scoped the read | two organisations exist; a scoped transaction counts one |
 * | the audit entry shares the transaction | the row is there after a success, and neither half survives a failure of either half |
 * | the envelope on every failure | 401, 403, 404, 422 and the CSRF 403, each checked as a shape rather than as a code |
 * | and the negative | the same request with the other organisation's session sees none of this one's data |
 *
 * ## Nothing here is faked, and that is the point
 *
 * A real PostgreSQL through testcontainers, with the real migrations, the real policies
 * and **the real application role** — `hiring_app`, which row-level security applies to,
 * rather than the owner, which is exempt from its own policies (`./postgres-fixture.ts`).
 * Better Auth runs for real and issues a real cookie from a real Argon2 verification. The
 * only substitution is the session store, a `Map` rather than Valkey, and that
 * substitution is covered by `src/auth/session-store.test.ts`; a second container would
 * buy nothing.
 *
 * The strictness is not thoroughness for its own sake. Every property under test is a
 * property of the *system*: RLS, `SELECT … FOR UPDATE`, `GRANT`, and the atomicity of
 * "the change and its record commit together" do not exist in a fake (docs/17 §8), so a
 * suite built on one would be proving that the fake is isolated.
 *
 * ## Two fault injections, and why they are grants
 *
 * The transactional claim has two directions and only one is reachable by ordinary means.
 * "The work failed, so no record" is easy. "The record failed, so no work" needs the
 * audit insert refused while everything around it succeeds — so the suite revokes
 * `INSERT ON audit_log` from the application role through the owner connection, makes the
 * request, and puts the grant back. That is a real failure mode of the privileges
 * migration 0002 creates, reproduced rather than simulated.
 *
 * ## Why the audit assertions use a watermark instead of a truncate
 *
 * They cannot use a truncate. Migration 0004 puts an `ENABLE ALWAYS` trigger on
 * `audit_log` that rejects `UPDATE`, `DELETE` and `TRUNCATE` from every role **including
 * the owner**, which is exactly the property that makes the table a record rather than a
 * log. So each block notes the highest id before it runs and asserts only on what came
 * after. The inconvenience is the feature working.
 */

import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { hashPassword, type StaffPrincipal } from '@assaybank/auth';
import {
  API_BASE_PATH,
  ORG_SETTINGS_PATH,
  OrgIdSchema,
  UserIdSchema,
  type OrgId,
  type OrgSettingsResponse,
  type UserId,
} from '@assaybank/contracts';
import { withOrg, type Database } from '@assaybank/db';

import { createStaffAuth } from '../../src/auth/better-auth.js';
import { memorySessionStore } from '../../src/auth/session-store.js';
import { ORG_SETTINGS_UPDATE_ACTION } from '../../src/org/routes.js';
import { setPrincipal } from '../../src/principal.js';
import { buildServer } from '../../src/server.js';
import { testConfig } from '../../src/test-support.js';
import { startTestPostgres, type TestPostgres } from './postgres-fixture.js';

const SETTINGS_URL = `${API_BASE_PATH}${ORG_SETTINGS_PATH}`;
const CONSOLE_ORIGIN = 'https://console.example.test';
const API_URL = 'https://api.example.test';
const SESSION_SECRET = 'an-org-settings-integration-session-secret-0123';

/** Long enough for `MIN_PASSWORD_LENGTH`, and not a password anybody would reuse. */
const PASSWORD = 'correct-horse-battery-staple';

/** Injected, and never the wall clock (ADR-006, docs/17 §8). */
const AT = new Date('2026-10-14T09:30:00.000Z');

const ACME: OrgId = OrgIdSchema.parse('4a1c9e70-2b83-4d51-8f6a-0c7d5e91b204');
const RIVAL: OrgId = OrgIdSchema.parse('9f3d81b2-6c47-4e05-9a1d-73b5e0c82f61');

/** An organisation this deployment has no row for. Its only use is the `not_found` case. */
const VANISHED: OrgId = OrgIdSchema.parse('0e5c1a6d-7b24-4f39-8c50-2a6d9b3e41f7');

/** Acme's administrator. Holds `org.admin`. */
const ADA = 'ada@acme.example';
/** Acme's recruiter. A real member of the same tenant, without `org.admin`. */
const RAJ = 'raj@acme.example';
/** Rival's administrator. Holds `org.admin`, in the other tenant. */
const BEA = 'bea@rival.example';

/**
 * A key Acme's settings document carries that this build does not define.
 *
 * It stands in for whatever a past release, a future feature or a hand-run `UPDATE` left
 * in a schemaless column. Two separate properties depend on it: it must never be served,
 * and a `PATCH` must never destroy it.
 */
const UNKNOWN_STORED_KEY = 'internal_billing_plan';

const ACME_INITIAL = {
  branding: { display_name: 'Acme Talent', primary_colour: '#1f6feb', logo_url: null },
  proctoring_defaults: {
    require_webcam: false,
    require_screen_recording: false,
    require_id_check: false,
  },
  [UNKNOWN_STORED_KEY]: 'enterprise',
};

/** Deliberately missing `proctoring_defaults`, as a document written by an older release. */
const RIVAL_INITIAL = {
  branding: { display_name: 'Rival Hiring', primary_colour: '#b02a37', logo_url: null },
};

let pg: TestPostgres | undefined;
let adaId: UserId | undefined;
let app: FastifyInstance | undefined;
/** The highest `audit_log.id` that existed before the current block ran. */
let auditWatermark = '0';

/** What postgres.js's `sql.json()` accepts and returns, named without importing the driver. */
type JsonParameter = Parameters<TestPostgres['owner']['json']>[0];
type JsonFragment = ReturnType<TestPostgres['owner']['json']>;

/** Fails loudly rather than letting an uninitialised fixture become a vacuous pass. */
function required<T>(value: T | undefined, name: string): T {
  if (value === undefined) {
    throw new Error(`fixture ${name} was not initialised; the suite cannot assert anything`);
  }
  return value;
}

function fixture(): TestPostgres {
  return required(pg, 'postgres');
}

function database(): Database {
  return fixture().db;
}

// --- seeding -----------------------------------------------------------------
//
// Through the owner, which is exempt from its own policies (0002 uses no FORCE). Seeding
// through the application role would be circular: the thing under test would be deciding
// what the fixture contains.

/**
 * A settings document as a `jsonb` parameter.
 *
 * `sql.json()` rather than `JSON.stringify(...)::jsonb`, which looks equivalent and is
 * not: postgres.js learns the parameter's type from the prepared statement and then
 * serialises the JavaScript value with that type's encoder, so a string handed to a
 * `jsonb` parameter is JSON-encoded a second time and the column ends up holding a JSON
 * *string* rather than an object. The reads would then compare text against objects and
 * the failure would look like a projection bug rather than a fixture bug.
 */
function jsonDocument(settings: unknown): JsonFragment {
  return fixture().owner.json(settings as JsonParameter);
}

/** Creates one organisation with the settings document it should start with. */
async function seedOrg(orgId: OrgId, slug: string, name: string, settings: unknown): Promise<void> {
  await fixture().owner`
    INSERT INTO organizations (id, name, slug, settings)
    VALUES (${orgId}, ${name}, ${slug}, ${jsonDocument(settings)})
  `;
}

/** Creates one staff member with a credential account, and grants them a role. */
async function seedStaff(options: {
  readonly orgId: OrgId;
  readonly email: string;
  readonly fullName: string;
  readonly roleKey: string;
  readonly roleName: string;
  readonly permissions: readonly string[];
}): Promise<UserId> {
  const owner = fixture().owner;

  const [user] = await owner<{ id: string }[]>`
    INSERT INTO users (org_id, email, full_name, timezone)
    VALUES (${options.orgId}, ${options.email}, ${options.fullName}, 'Europe/London')
    RETURNING id
  `;
  const userId = UserIdSchema.parse(required(user, 'users row').id);

  await owner`
    INSERT INTO staff_accounts (org_id, user_id, account_id, provider_id, password)
    VALUES (${options.orgId}, ${userId}, ${userId}, 'credential', ${await hashPassword(PASSWORD)})
  `;

  const [role] = await owner<{ id: string }[]>`
    INSERT INTO user_roles (org_id, key, name)
    VALUES (${options.orgId}, ${options.roleKey}, ${options.roleName})
    ON CONFLICT (org_id, key) DO UPDATE SET name = EXCLUDED.name
    RETURNING id
  `;
  const roleId = required(role, 'user_roles row').id;

  for (const permission of options.permissions) {
    await owner`
      INSERT INTO user_role_permissions (user_role_id, permission_key)
      VALUES (${roleId}, ${permission})
      ON CONFLICT DO NOTHING
    `;
  }

  await owner`
    INSERT INTO user_role_assignments (user_id, user_role_id) VALUES (${userId}, ${roleId})
  `;

  return userId;
}

/** One organisation's settings document, as it stands in the database right now. */
async function storedSettings(orgId: OrgId): Promise<Record<string, unknown>> {
  const [row] = await fixture().owner<{ settings: unknown }[]>`
    SELECT settings FROM organizations WHERE id = ${orgId}
  `;
  const value = required(row, 'organizations row').settings;

  // Asserted rather than assumed. `jsonb` will hold a scalar or an array just as happily
  // as an object, and a fixture that stored one would make every comparison below
  // compare text with objects — a failure that reads like a projection bug.
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('the settings column does not hold a JSON object');
  }
  return value as Record<string, unknown>;
}

/** Puts one organisation's settings document back to a known state, through the owner. */
async function resetSettings(orgId: OrgId, settings: unknown): Promise<void> {
  await fixture().owner`
    UPDATE organizations SET settings = ${jsonDocument(settings)} WHERE id = ${orgId}
  `;
}

/** The highest `audit_log.id`, as text because it is a bigserial. */
async function maxAuditId(): Promise<string> {
  const [row] = await fixture().owner<{ id: string }[]>`
    SELECT coalesce(max(id), 0)::text AS id FROM audit_log
  `;
  return required(row, 'the audit watermark').id;
}

// --- the server --------------------------------------------------------------

/**
 * The server as boot assembles it, minus the socket.
 *
 * A fresh one per test: `@fastify/rate-limit`'s default store is per instance, and a
 * shared one would have a login late in the file refused for reasons that have nothing to
 * do with what the test was asserting.
 */
function build(): FastifyInstance {
  const db = database();

  const auth = createStaffAuth({
    config: {
      http: {
        publicUrl: API_URL,
        webPublicUrl: CONSOLE_ORIGIN,
        corsAllowedOrigins: [CONSOLE_ORIGIN],
      },
      secrets: { sessionSecret: SESSION_SECRET },
      oidc: { enabled: false },
    },
    store: memorySessionStore(() => AT),
    // True even though `app.inject()` speaks no scheme: the cookie attributes are a
    // property of this build, and a harness that quietly relaxed them would be asserting
    // against a different one.
    secureCookies: true,
  });

  const instance = buildServer({
    config: testConfig(),
    logger: false,
    db,
    now: () => AT,
    staffIdentity: {
      auth,
      db,
      sessionSecret: SESSION_SECRET,
      apiUrl: API_URL,
      consoleUrl: CONSOLE_ORIGIN,
      secureCookies: true,
      oidcEnabled: false,
      now: () => AT,
    },
  });

  app = instance;
  return instance;
}

/**
 * A server that deposits a principal instead of resolving one from a cookie.
 *
 * Used by exactly one block — the `not_found` case — and the reason is a foreign key. The
 * situation under test is a live session whose organisation row is gone, which happens in
 * production because a session lives eight hours in Valkey and an erasure under docs/11
 * §6 removes the row. It cannot be reached *through a login here*, because `users.org_id`
 * cascades: deleting the organisation deletes the staff member, their role assignment and
 * therefore their permissions, so such a request is refused as `forbidden` before the
 * handler is ever asked to find a row. Depositing the principal skips exactly one stage —
 * authentication — which every other block in this file exercises with a real cookie, and
 * leaves the route, the transaction, the policies and the database real.
 */
function buildWithPrincipal(principal: StaffPrincipal): FastifyInstance {
  const instance = buildServer({
    config: testConfig(),
    logger: false,
    db: database(),
    now: () => AT,
  });

  instance.addHook('onRequest', (request, _reply, done) => {
    setPrincipal(request, principal);
    done();
  });

  app = instance;
  return instance;
}

/** A staff principal holding `org.admin` in an organisation that has no row. */
function ghostPrincipal(): StaffPrincipal {
  return {
    kind: 'staff',
    userId: required(adaId, 'adaId'),
    orgId: VANISHED,
    permissions: new Set(['org.admin']),
  };
}

// --- driving the API ---------------------------------------------------------

/** The session cookie a successful login set, as a browser would send it back. */
function sessionCookie(response: { headers: Record<string, unknown> }): string {
  const raw: unknown = response.headers['set-cookie'];
  const entries = Array.isArray(raw)
    ? raw.map((entry: unknown) => String(entry))
    : typeof raw === 'string'
      ? [raw]
      : [];
  const entry = entries.find(
    (cookie) => cookie.startsWith('__Secure-assaybank.session_token=') && !cookie.includes('=;'),
  );
  if (entry === undefined) throw new Error('the response set no session cookie');
  return entry.split(';', 1)[0] ?? '';
}

async function readSettings(instance: FastifyInstance, cookie?: string) {
  return instance.inject({
    method: 'GET',
    url: SETTINGS_URL,
    headers: cookie === undefined ? {} : { cookie },
  });
}

async function patchSettings(
  instance: FastifyInstance,
  cookie: string | undefined,
  payload: unknown,
  origin: string = CONSOLE_ORIGIN,
) {
  return instance.inject({
    method: 'PATCH',
    url: SETTINGS_URL,
    headers: { origin, ...(cookie === undefined ? {} : { cookie }) },
    payload: payload as Record<string, unknown>,
  });
}

/** Whatever `app.inject()` hands back, named once rather than at six call sites. */
type Injected = Awaited<ReturnType<typeof readSettings>>;

/** Signs in and returns the cookie. A real password against a real Argon2 hash. */
async function login(instance: FastifyInstance, email: string): Promise<string> {
  const response = await instance.inject({
    method: 'POST',
    url: `${API_BASE_PATH}/auth/login`,
    headers: { origin: CONSOLE_ORIGIN },
    payload: { email, password: PASSWORD },
  });

  expect(response.statusCode, `login for ${email}`).toBe(200);
  return sessionCookie(response);
}

// --- assertions --------------------------------------------------------------

interface Envelope {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details?: Record<string, unknown>;
    readonly request_id: string;
  };
}

/**
 * Asserts the whole envelope of docs/03 §2, not only the code.
 *
 * The `request_id` check is the part easiest to leave out and the part support depends
 * on: the value in the body has to be the value in the header the customer can see, or a
 * quoted request id resolves to nothing (docs/12 §5.3).
 */
function expectEnvelope(response: Injected, code: string, status: number): Envelope {
  expect(response.statusCode).toBe(status);

  const body = response.json<Envelope>();
  expect(Object.keys(body)).toEqual(['error']);
  expect(body.error.code).toBe(code);
  expect(typeof body.error.message).toBe('string');
  expect(body.error.message.length).toBeGreaterThan(0);
  expect(body.error.request_id).toBe(response.headers['x-request-id']);

  return body;
}

/** One `audit_log` row, read back through a transaction scoped to its own organisation. */
interface AuditRow {
  readonly [column: string]: unknown;
  readonly org_id: string;
  readonly actor_user_id: string | null;
  readonly action: string;
  readonly entity_type: string;
  readonly entity_id: string | null;
  readonly before: Record<string, unknown> | null;
  readonly after: Record<string, unknown> | null;
  readonly ip: string | null;
  /** Rendered as UTC text by the query rather than left to whatever the driver made of it. */
  readonly at: string;
}

/**
 * The settings-change audit rows this organisation can see, written since the block began.
 *
 * Read through `withOrg` and therefore through the policy, which makes this both an
 * assertion about the audit trail and an assertion about its isolation: the rows another
 * tenant wrote are not filtered out here, they are invisible.
 */
function auditRows(orgId: OrgId): Promise<AuditRow[]> {
  return withOrg(database(), orgId, (tx) =>
    tx.execute<AuditRow>(sql`
      SELECT org_id, actor_user_id, action, entity_type, entity_id,
             before, after, host(ip) AS ip,
             to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS at
        FROM audit_log
       WHERE action = ${ORG_SETTINGS_UPDATE_ACTION}
         AND id > ${auditWatermark}::bigint
       ORDER BY id
    `),
  );
}

/** How many organisations a transaction scoped to `orgId` can see at all. */
async function visibleOrgCount(orgId: OrgId): Promise<number> {
  const rows = await withOrg(database(), orgId, (tx) =>
    tx.execute<{ count: number }>(sql`SELECT count(*)::int AS count FROM organizations`),
  );
  return required(rows[0], 'the count row').count;
}

// --- lifecycle ---------------------------------------------------------------

beforeAll(async () => {
  pg = await startTestPostgres();

  await seedOrg(ACME, 'acme', 'Acme Ltd', ACME_INITIAL);
  await seedOrg(RIVAL, 'rival', 'Rival Ltd', RIVAL_INITIAL);

  adaId = await seedStaff({
    orgId: ACME,
    email: ADA,
    fullName: 'Ada Admin',
    roleKey: 'admin',
    roleName: 'Administrator',
    permissions: ['org.admin', 'attempt.read'],
  });

  await seedStaff({
    orgId: ACME,
    email: RAJ,
    fullName: 'Raj Recruiter',
    roleKey: 'recruiter',
    roleName: 'Recruiter',
    // A real permission set, and deliberately not `org.admin`: the check under test is
    // per action, not "is this person authenticated".
    permissions: ['question.read', 'invite.send'],
  });

  await seedStaff({
    orgId: RIVAL,
    email: BEA,
    fullName: 'Bea Admin',
    roleKey: 'admin',
    roleName: 'Administrator',
    permissions: ['org.admin'],
  });
}, 300_000);

afterAll(async () => {
  await pg?.stop();
  pg = undefined;
}, 120_000);

beforeEach(async () => {
  // Each block starts from the same two documents and the same watermark, so a failure
  // names one cause rather than the accumulated state of whatever ran before it.
  await resetSettings(ACME, ACME_INITIAL);
  await resetSettings(RIVAL, RIVAL_INITIAL);
  auditWatermark = await maxAuditId();
});

afterEach(async () => {
  await app?.close();
  app = undefined;
});

// --- stage 1: a session arrives ----------------------------------------------

describe('a request carrying a session', () => {
  it('is refused with the unauthenticated envelope when it carries none', async () => {
    const body = expectEnvelope(await readSettings(build()), 'unauthenticated', 401);

    // No details, ever. A 401 that explained itself would distinguish "no cookie" from
    // "expired cookie" from "revoked session" — three facts a caller holding none of them
    // should not be handed (docs/14 T-011).
    expect(body.error.details).toBeUndefined();
  });

  it('is refused identically when the cookie is a forgery rather than a session', async () => {
    const response = await readSettings(
      build(),
      '__Secure-assaybank.session_token=not-a-token-this-server-ever-issued',
    );

    // Byte-identical to the previous case by design: a distinguishable answer here is an
    // oracle for whether a guessed token exists.
    expect(expectEnvelope(response, 'unauthenticated', 401).error.message).toBe(
      'Authentication is required.',
    );
  });

  it('is accepted when the cookie came from a real login', async () => {
    const instance = build();
    expect((await readSettings(instance, await login(instance, ADA))).statusCode).toBe(200);
  });
});

// --- stage 2: it resolves to an organisation ---------------------------------

describe('the session resolves to exactly one organisation', () => {
  it('serves the organisation the signed-in user belongs to', async () => {
    const instance = build();
    const body = (
      await readSettings(instance, await login(instance, ADA))
    ).json<OrgSettingsResponse>();

    expect(body.org).toEqual({ id: ACME, name: 'Acme Ltd', slug: 'acme' });
    expect(body.settings.branding.display_name).toBe('Acme Talent');
  });

  it('answers with the server’s own clock, injected (ADR-006)', async () => {
    const instance = build();
    const response = await readSettings(instance, await login(instance, ADA));

    expect(response.json<OrgSettingsResponse>().server_time).toBe('2026-10-14T09:30:00.000Z');
  });

  it('serves a projection of the stored document rather than the document', async () => {
    const instance = build();
    const response = await readSettings(instance, await login(instance, ADA));

    // The column is schemaless and carries a key this build has never heard of. A handler
    // that returned the row would ship it, and nothing in the type system would notice.
    expect(response.body).not.toContain(UNKNOWN_STORED_KEY);
    expect(response.body).not.toContain('enterprise');

    const body = response.json<OrgSettingsResponse>();
    expect(Object.keys(body).sort()).toEqual(['org', 'server_time', 'settings']);
    expect(Object.keys(body.settings).sort()).toEqual(['branding', 'proctoring_defaults']);
    expect(Object.keys(body.org).sort()).toEqual(['id', 'name', 'slug']);
  });

  it('fills a section the stored document predates rather than omitting it', async () => {
    // Rival's document has no `proctoring_defaults` at all. The response shape must not
    // depend on which release last wrote the column.
    const instance = build();
    const response = await readSettings(instance, await login(instance, BEA));

    expect(response.json<OrgSettingsResponse>().settings.proctoring_defaults).toEqual({
      require_webcam: false,
      require_screen_recording: false,
      require_id_check: false,
    });
  });
});

// --- stage 3: the per-action permission check --------------------------------

describe('the per-action permission check', () => {
  it('refuses a staff member of the same organisation who does not hold org.admin', async () => {
    const instance = build();
    const body = expectEnvelope(
      await readSettings(instance, await login(instance, RAJ)),
      'forbidden',
      403,
    );

    // 403 and not 401: Raj's credential was read, accepted and turned into a principal.
    // What he lacks is the permission, and re-authenticating would not help.
    expect(body.error.details).toBeUndefined();
  });

  it('names neither the permission nor the organisation in the refusal', async () => {
    const instance = build();
    const response = await readSettings(instance, await login(instance, RAJ));

    // A 403 that said `org.admin` would hand an attacker a map of the authorisation model
    // one request at a time. The key is in the log line, under the same trace id.
    expect(response.body).not.toContain('org.admin');
    expect(response.body).not.toContain(ACME);
    expect(response.body).not.toContain('Acme');
  });

  it('refuses the write for the same reason it refuses the read', async () => {
    const instance = build();
    const cookie = await login(instance, RAJ);

    expectEnvelope(
      await patchSettings(instance, cookie, { branding: { display_name: 'Not Allowed' } }),
      'forbidden',
      403,
    );

    // And the refusal came before the handler: the document is untouched and no audit row
    // exists, because no transaction was ever opened.
    expect(await storedSettings(ACME)).toEqual(ACME_INITIAL);
    expect(await auditRows(ACME)).toHaveLength(0);
  });
});

// --- stage 4: row-level security scoped the read -----------------------------

describe('row-level security, not the WHERE clause, is what scopes the read', () => {
  it('shows one organisation to a scoped transaction and two to the owner', async () => {
    const [ownerRow] = await fixture().owner<{ count: number }[]>`
      SELECT count(*)::int AS count FROM organizations
    `;

    expect(required(ownerRow, 'the owner count').count).toBe(2);
    // The same table, through the same pool, with no `WHERE` clause anywhere in the
    // statement. The only difference is `app.current_org`, set transaction-locally by
    // `withOrg` (ADR-010).
    expect(await visibleOrgCount(ACME)).toBe(1);
    expect(await visibleOrgCount(RIVAL)).toBe(1);
  });
});

// --- stage 5: the audit entry shares the transaction -------------------------

describe('a settings change', () => {
  it('applies the change and answers with the settings as they now stand', async () => {
    const instance = build();
    const cookie = await login(instance, ADA);

    const response = await patchSettings(instance, cookie, {
      branding: { display_name: 'Acme Assessments', logo_url: 'https://cdn.acme.test/logo.svg' },
      proctoring_defaults: { require_webcam: true },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<OrgSettingsResponse>();

    expect(body.settings.branding).toEqual({
      display_name: 'Acme Assessments',
      // Untouched by a patch that did not name it.
      primary_colour: '#1f6feb',
      logo_url: 'https://cdn.acme.test/logo.svg',
    });
    expect(body.settings.proctoring_defaults.require_webcam).toBe(true);
    expect(body.settings.proctoring_defaults.require_id_check).toBe(false);
  });

  it('is what the next read sees, which is what makes it a change and not a reply', async () => {
    const instance = build();
    const cookie = await login(instance, ADA);

    await patchSettings(instance, cookie, { branding: { primary_colour: '#0b7285' } });
    const after = await readSettings(instance, cookie);

    expect(after.json<OrgSettingsResponse>().settings.branding.primary_colour).toBe('#0b7285');
  });

  it('preserves the keys of the stored document that this build does not define', async () => {
    const instance = build();
    const cookie = await login(instance, ADA);

    await patchSettings(instance, cookie, { branding: { display_name: 'Acme Assessments' } });

    // The endpoint serves a projection and writes a merge. Writing the projection would
    // make every settings change a destructive write for data nobody here has heard of,
    // which is the opposite of what expand-contract asks for (docs/17 §4).
    expect((await storedSettings(ACME))[UNKNOWN_STORED_KEY]).toBe('enterprise');
  });

  it('clears a field with null rather than treating null as absent', async () => {
    const instance = build();
    const cookie = await login(instance, ADA);

    const branding = (
      await patchSettings(instance, cookie, { branding: { primary_colour: null } })
    ).json<OrgSettingsResponse>().settings.branding;

    expect(branding.primary_colour).toBeNull();
    expect(branding.display_name, 'clearing one field cleared another').toBe('Acme Talent');
  });

  it('writes exactly one audit row, carrying the actor, the entity and the instant', async () => {
    const instance = build();
    const cookie = await login(instance, ADA);

    await patchSettings(instance, cookie, { proctoring_defaults: { require_webcam: true } });

    const rows = await auditRows(ACME);
    expect(rows).toHaveLength(1);
    const row = required(rows[0], 'the audit row');

    expect(row.org_id).toBe(ACME);
    expect(row.actor_user_id, 'the acting staff user was not recorded').toBe(adaId);
    expect(row.action).toBe(ORG_SETTINGS_UPDATE_ACTION);
    expect(row.entity_type).toBe('organization');
    expect(row.entity_id).toBe(ACME);
    // `app.inject()` speaks over a socket whose peer is the loopback address.
    expect(row.ip).toBe('127.0.0.1');
    // ADR-006: the instant is the server's injected clock, not `now()` in SQL. Without the
    // injection this assertion could not exist at all.
    expect(row.at).toBe('2026-10-14T09:30:00Z');
  });

  it('records both states, so “what was it before” is answerable years later', async () => {
    const instance = build();
    const cookie = await login(instance, ADA);

    await patchSettings(instance, cookie, {
      branding: { display_name: 'Acme Assessments' },
      proctoring_defaults: { require_webcam: true },
    });

    const row = required((await auditRows(ACME))[0], 'the audit row');

    expect(row.before).toEqual({
      branding: { display_name: 'Acme Talent', primary_colour: '#1f6feb', logo_url: null },
      proctoring_defaults: {
        require_webcam: false,
        require_screen_recording: false,
        require_id_check: false,
      },
    });
    expect(row.after).toEqual({
      branding: { display_name: 'Acme Assessments', primary_colour: '#1f6feb', logo_url: null },
      proctoring_defaults: {
        require_webcam: true,
        require_screen_recording: false,
        require_id_check: false,
      },
    });
    // The record is a projection too: a key this build does not define is not copied into
    // a row that is kept for seven years.
    expect(JSON.stringify(row.before)).not.toContain(UNKNOWN_STORED_KEY);
  });

  it('records the second change against the first, not against the original', async () => {
    const instance = build();
    const cookie = await login(instance, ADA);

    await patchSettings(instance, cookie, { branding: { display_name: 'First' } });
    await patchSettings(instance, cookie, { branding: { display_name: 'Second' } });

    const rows = await auditRows(ACME);
    expect(rows).toHaveLength(2);
    expect(required(rows[1], 'the second audit row').before).toMatchObject({
      branding: { display_name: 'First' },
    });
  });
});

describe('the change and its record commit together, or neither does', () => {
  it('leaves the document untouched when the audit row cannot be written', async () => {
    const instance = build();
    const cookie = await login(instance, ADA);

    // The real failure, reproduced rather than simulated: migration 0002 gives the
    // application role narrow rights on `audit_log`, and this takes the last of them
    // away. Everything else in the request still succeeds.
    await fixture().owner.unsafe('REVOKE INSERT ON audit_log FROM hiring_app');

    try {
      const response = await patchSettings(instance, cookie, {
        branding: { display_name: 'Changed Without A Record' },
      });

      // `internal`, with no detail: the caller learns nothing about the database, the
      // statement or the grant (docs/14, error-message leakage).
      const body = expectEnvelope(response, 'internal', 500);
      expect(body.error.message).toBe('An unexpected error occurred.');
      expect(body.error.details).toBeUndefined();
      expect(response.body).not.toContain('audit_log');
      expect(response.body).not.toContain('permission denied');

      // The point of the whole design: an action that could not be recorded did not
      // happen. Had the audit row been written on a second connection, the settings would
      // now say one thing and history another.
      expect(await storedSettings(ACME)).toEqual(ACME_INITIAL);
    } finally {
      await fixture().owner.unsafe('GRANT INSERT ON audit_log TO hiring_app');
    }

    expect(await auditRows(ACME)).toHaveLength(0);
  });

  it('writes no audit row when the change itself is refused', async () => {
    const instance = build();
    const cookie = await login(instance, ADA);

    // The other direction. The row lock is taken, the merge happens, and the `UPDATE` is
    // refused — so the record that would have described it rolls back unwritten.
    await fixture().owner.unsafe('REVOKE UPDATE ON organizations FROM hiring_app');

    try {
      expectEnvelope(
        await patchSettings(instance, cookie, { branding: { display_name: 'Never Applied' } }),
        'internal',
        500,
      );
      expect(await storedSettings(ACME)).toEqual(ACME_INITIAL);
    } finally {
      await fixture().owner.unsafe('GRANT UPDATE ON organizations TO hiring_app');
    }

    expect(await auditRows(ACME), 'history claims a change that never committed').toHaveLength(0);
  });
});

// --- stage 6: the envelope on every failure ----------------------------------

describe('the validation failure', () => {
  it('names an unrecognised field rather than silently discarding it', async () => {
    const instance = build();
    const cookie = await login(instance, ADA);

    const body = expectEnvelope(
      await patchSettings(instance, cookie, {
        branding: { display_name: 'Acme Assessments' },
        retention_days: 30,
      }),
      'validation_failed',
      422,
    );

    // docs/11 §4.2 moved the retention clocks to a constrained table, so this endpoint
    // declines the field. Declining is the point: Fastify's ajv is configured with
    // `removeAdditional: true`, so a body schema would have stripped it and answered 200,
    // telling an administrator their retention policy had changed when nothing had.
    expect(body.error.details).toEqual({
      fields: [{ field: 'body/retention_days', rule: 'unrecognized_keys' }],
      truncated: false,
    });
  });

  it('names the failing field for a value that breaks its rule', async () => {
    const instance = build();
    const cookie = await login(instance, ADA);

    const body = expectEnvelope(
      await patchSettings(instance, cookie, { branding: { primary_colour: 'chartreuse' } }),
      'validation_failed',
      422,
    );

    expect(body.error.details?.['fields']).toEqual([
      { field: 'body/branding/primary_colour', rule: 'invalid_format' },
    ]);

    // Neither the rule's own text nor the value the caller sent: one hands over the shape
    // of a check, the other makes a 422 a reflection.
    const text = JSON.stringify(body);
    expect(text).not.toContain('chartreuse');
    expect(text).not.toContain('hexadecimal');
  });

  it('refuses a body that names no section at all', async () => {
    const instance = build();
    const cookie = await login(instance, ADA);

    expectEnvelope(await patchSettings(instance, cookie, {}), 'validation_failed', 422);
  });

  it('refuses before opening a transaction, so nothing changed and nothing was recorded', async () => {
    const instance = build();
    const cookie = await login(instance, ADA);

    await patchSettings(instance, cookie, { branding: { logo_url: 'javascript:alert(1)' } });

    expect(await storedSettings(ACME)).toEqual(ACME_INITIAL);
    expect(await auditRows(ACME)).toHaveLength(0);
  });
});

describe('the not-found failure', () => {
  it('answers not_found, never forbidden, when the session’s organisation has no row', async () => {
    const body = expectEnvelope(
      await readSettings(buildWithPrincipal(ghostPrincipal())),
      'not_found',
      404,
    );

    // A 403 here would confirm that somebody holds the row, which is a cross-tenant
    // disclosure made of nothing but a status code (ADR-010, docs/14 `H-128`).
    expect(body.error.details).toBeUndefined();
    expect(body.error.message).toBe('The requested resource does not exist.');
  });

  it('answers the same on the write path, and writes nothing', async () => {
    const instance = buildWithPrincipal(ghostPrincipal());

    expectEnvelope(
      await patchSettings(instance, undefined, { branding: { display_name: 'Ghost' } }),
      'not_found',
      404,
    );

    // The audit row is written after the work; the work threw first, so the transaction
    // committed nothing at all.
    expect(await auditRows(VANISHED)).toHaveLength(0);
  });
});

describe('the forged-origin failure', () => {
  it('refuses a cookie-bearing write from an origin this deployment does not know', async () => {
    const instance = build();
    const cookie = await login(instance, ADA);

    const body = expectEnvelope(
      await patchSettings(
        instance,
        cookie,
        { branding: { display_name: 'From A Hostile Page' } },
        'https://attacker.example',
      ),
      'forbidden',
      403,
    );

    // docs/14 T-017 / `H-127`. `forbidden` rather than `unauthenticated`: the credential
    // was fine, the context was not, and signing in again would not help.
    expect(body.error.details).toBeUndefined();
    expect(await storedSettings(ACME)).toEqual(ACME_INITIAL);
    expect(await auditRows(ACME)).toHaveLength(0);
  });
});

// --- the negative ------------------------------------------------------------

describe('the same request with another organisation’s session', () => {
  it('sees that organisation’s settings and none of this one’s', async () => {
    const instance = build();
    const response = await readSettings(instance, await login(instance, BEA));
    const body = response.json<OrgSettingsResponse>();

    expect(body.org).toEqual({ id: RIVAL, name: 'Rival Ltd', slug: 'rival' });
    expect(body.settings.branding.display_name).toBe('Rival Hiring');

    // Not a byte of the other tenant crosses: not its name, not its slug, not its
    // identifier, not its branding, not the key in its settings document.
    for (const acme of ['Acme', 'acme', ACME, '#1f6feb', UNKNOWN_STORED_KEY]) {
      expect(response.body, `the response carried ${acme}`).not.toContain(acme);
    }
  });

  it('changes its own row and leaves the other organisation’s untouched', async () => {
    const instance = build();

    const response = await patchSettings(instance, await login(instance, BEA), {
      branding: { display_name: 'Rival Assessments' },
    });

    expect(response.statusCode).toBe(200);
    expect((await storedSettings(RIVAL))['branding']).toMatchObject({
      display_name: 'Rival Assessments',
    });
    expect(await storedSettings(ACME)).toEqual(ACME_INITIAL);
  });

  it('writes an audit row the other organisation cannot see', async () => {
    const instance = build();
    await patchSettings(instance, await login(instance, BEA), {
      proctoring_defaults: { require_id_check: true },
    });

    // Read through the policy rather than filtered by a predicate: Acme's query is not
    // "the rows of mine", it is every row that transaction can reach at all.
    expect(await auditRows(ACME)).toHaveLength(0);
    expect(await auditRows(RIVAL)).toHaveLength(1);
  });

  it('cannot reach the other organisation even holding a valid session of its own', async () => {
    // The whole slice, driven twice. Both administrators hold `org.admin`; the permission
    // is identical and the answer is not, because the answer is the tenant's own row.
    const instance = build();

    const acme = (
      await readSettings(instance, await login(instance, ADA))
    ).json<OrgSettingsResponse>();
    const rival = (
      await readSettings(instance, await login(instance, BEA))
    ).json<OrgSettingsResponse>();

    expect(acme.org.id).toBe(ACME);
    expect(rival.org.id).toBe(RIVAL);
    expect(acme.settings).not.toEqual(rival.settings);
  });
});
