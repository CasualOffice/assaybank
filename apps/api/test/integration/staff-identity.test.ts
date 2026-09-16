/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Staff identity end to end — P1 step 3.
 *
 * Every property under test here is a property of the *system* rather than of a function:
 * whether a cookie resolves to a principal, whether a privilege change ends a session,
 * whether two organisations holding the same email address can be told apart, whether a
 * failed login discloses anything. None of them survives being faked. Better Auth runs for
 * real against a real PostgreSQL with the real migrations and the real row-level-security
 * policies, and the only substitution is the session store — a `Map` rather than Valkey,
 * because the store's own behaviour is covered by `src/auth/session-store.test.ts` and a
 * second container would buy nothing here.
 *
 * Reading order, and what each block is for:
 *
 * | Block | The claim |
 * |---|---|
 * | login | A correct password issues a session cookie with the attributes `H-123` requires |
 * | enumeration | A failed login is byte-identical whether or not the address exists (`H-118`) |
 * | fixation | An attacker-planted session identifier is not the one that comes back authenticated (T-014) |
 * | CSRF | A cookie-bearing mutation from a hostile origin is refused (T-017) |
 * | /auth/me | The documented `{user, org, permissions[]}` shape, from the database |
 * | rotation | A privilege change ends every session that predates it (`H-123`) |
 * | tenancy | One address in two organisations resolves to neither without a slug |
 * | rate limit | The login window of `src/rate-limit.ts` actually fires |
 *
 * **A fresh server per test.** The rate limiter's default store is per-instance, and a
 * suite that shared one would have its eleventh login refused for reasons that have
 * nothing to do with what it was asserting. Building a server is a few milliseconds; a
 * shared limiter is a flake that takes an afternoon to find.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { hashPassword, type CandidatePrincipal } from '@assaybank/auth';
import {
  API_BASE_PATH,
  AttemptIdSchema,
  OrgIdSchema,
  UserIdSchema,
  type OrgId,
  type UserId,
} from '@assaybank/contracts';
import { sql } from 'drizzle-orm';

import { withOrg } from '@assaybank/db';

import { createStaffAuth } from '../../src/auth/better-auth.js';
import { memorySessionStore } from '../../src/auth/session-store.js';
import { registerStaffAuthentication, revokeStaffSessions } from '../../src/auth/staff-session.js';
import { registerErrorHandling } from '../../src/errors.js';
import { currentPrincipal, registerPrincipal, setPrincipal } from '../../src/principal.js';
import { buildServer } from '../../src/server.js';
import { testConfig } from '../../src/test-support.js';
import { startTestPostgres, type TestPostgres } from './postgres-fixture.js';

const CONSOLE_ORIGIN = 'https://console.example.test';
const API_URL = 'https://api.example.test';
const SESSION_SECRET = 'an-integration-test-session-secret-0123456789';

/** Long enough for `MIN_PASSWORD_LENGTH`, and not a password anybody would reuse. */
const PASSWORD = 'correct-horse-battery-staple';

const ACME: OrgId = OrgIdSchema.parse('4a1c9e70-2b83-4d51-8f6a-0c7d5e91b204');
const RIVAL: OrgId = OrgIdSchema.parse('9f3d81b2-6c47-4e05-9a1d-73b5e0c82f61');

const ADA = 'ada@acme.example';
/** Deliberately present in both organisations — see the tenancy block. */
const SHARED = 'shared@both.example';
/**
 * A staff member with a `users` row and no credential account — the federated case.
 *
 * She exists so that the `password.hash` branch Better Auth takes for "found the user,
 * found no password" is reachable from a test, because that branch and the one for "found
 * no user" are the two the enumeration block below has to prove indistinguishable.
 */
const FEDERATED = 'grace@acme.example';

let pg: TestPostgres | undefined;
let adaId: UserId | undefined;
let recruiterRoleId: string | undefined;

/** Fails loudly rather than letting an uninitialised fixture become a vacuous pass. */
function required<T>(value: T | undefined, name: string): T {
  if (value === undefined) {
    throw new Error(`fixture ${name} was not initialised; the suite cannot assert anything`);
  }
  return value;
}

/** Seeds one organisation with one staff member and, unless told otherwise, a credential. */
async function seedStaff(options: {
  readonly orgId: OrgId;
  readonly slug: string;
  readonly email: string;
  readonly name: string;
  /** False for a federated staff member: a `users` row with no password behind it. */
  readonly withCredential?: boolean;
}): Promise<UserId> {
  const owner = required(pg, 'postgres').owner;

  await owner`
    INSERT INTO organizations (id, name, slug)
    VALUES (${options.orgId}, ${options.name}, ${options.slug})
    ON CONFLICT (id) DO NOTHING
  `;

  const [user] = await owner<{ id: string }[]>`
    INSERT INTO users (org_id, email, full_name, timezone)
    VALUES (${options.orgId}, ${options.email}, ${`Staff ${options.slug}`}, 'Europe/London')
    RETURNING id
  `;
  const userId = UserIdSchema.parse(required(user, 'users row').id);

  if (options.withCredential === false) return userId;

  // Better Auth's `account` model. Seeded through the owner, which is exempt from its own
  // policies, so `org_id` is written explicitly rather than falling to its
  // `DEFAULT app_current_org()` — the fixture is not inside `withOrg`.
  await owner`
    INSERT INTO staff_accounts (org_id, user_id, account_id, provider_id, password)
    VALUES (${options.orgId}, ${userId}, ${userId}, 'credential', ${await hashPassword(PASSWORD)})
  `;

  return userId;
}

beforeAll(async () => {
  pg = await startTestPostgres();

  adaId = await seedStaff({ orgId: ACME, slug: 'acme', email: ADA, name: 'Acme' });
  await seedStaff({ orgId: RIVAL, slug: 'rival', email: 'bob@rival.example', name: 'Rival' });

  await seedStaff({
    orgId: ACME,
    slug: 'acme',
    email: FEDERATED,
    name: 'Acme',
    withCredential: false,
  });

  // The same address in both organisations. `users` is unique on (org_id, email), so this
  // is legal, and it is the case the email lookup must refuse to guess at.
  await seedStaff({ orgId: ACME, slug: 'acme', email: SHARED, name: 'Acme' });
  await seedStaff({ orgId: RIVAL, slug: 'rival', email: SHARED, name: 'Rival' });

  const owner = required(pg, 'postgres').owner;
  const [role] = await owner<{ id: string }[]>`
    INSERT INTO user_roles (org_id, key, name) VALUES (${ACME}, 'recruiter', 'Recruiter')
    RETURNING id
  `;
  recruiterRoleId = required(role, 'user_roles row').id;

  await owner`
    INSERT INTO user_role_permissions (user_role_id, permission_key)
    VALUES (${recruiterRoleId}, 'question.read'), (${recruiterRoleId}, 'invite.send')
  `;
}, 180_000);

afterAll(async () => {
  await pg?.stop();
  pg = undefined;
});

let app: FastifyInstance | undefined;

/**
 * The Better Auth instance each built server is using.
 *
 * The rotation tests reach the library directly — `revokeStaffSessions` is called by the
 * role-management endpoints, which are P1 step 4's work rather than this step's — and it
 * has to be the instance this server was built with. A second one would have a second
 * session store and would revoke nothing.
 */
const AUTH_BY_SERVER = new WeakMap<FastifyInstance, ReturnType<typeof createStaffAuth>>();

function staffAuthFor(instance: FastifyInstance): ReturnType<typeof createStaffAuth> {
  const held = AUTH_BY_SERVER.get(instance);
  if (held === undefined) throw new Error('this server was not built by build()');
  return held;
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

/**
 * A server with staff identity wired up, and its own session store and rate-limit window.
 *
 * `secureCookies: true` even though `app.inject()` speaks no scheme, because the cookie
 * attributes are one of the things under test and a harness that quietly relaxed them
 * would be asserting the wrong build.
 */
function build(oidcIssuer?: string): FastifyInstance {
  const db = required(pg, 'postgres').db;

  const auth = createStaffAuth({
    config: {
      http: {
        publicUrl: API_URL,
        webPublicUrl: CONSOLE_ORIGIN,
        corsAllowedOrigins: [CONSOLE_ORIGIN],
      },
      secrets: { sessionSecret: SESSION_SECRET },
      oidc:
        oidcIssuer === undefined
          ? { enabled: false }
          : {
              enabled: true,
              issuer: oidcIssuer,
              clientId: 'assaybank',
              clientSecret: 'an-oidc-client-secret',
            },
    },
    store: memorySessionStore(),
    secureCookies: true,
  });

  const instance = buildServer({
    config: testConfig(),
    logger: false,
    db,
    staffIdentity: {
      auth,
      db,
      sessionSecret: SESSION_SECRET,
      apiUrl: API_URL,
      consoleUrl: CONSOLE_ORIGIN,
      secureCookies: true,
      oidcEnabled: oidcIssuer !== undefined,
      now: () => new Date('2026-10-13T09:00:00.000Z'),
    },
  });

  AUTH_BY_SERVER.set(instance, auth);
  app = instance;
  return instance;
}

/** The `Set-Cookie` entries of a response, which Fastify may hand back as one or many. */
function setCookies(response: { headers: Record<string, unknown> }): string[] {
  const raw: unknown = response.headers['set-cookie'];
  if (raw === undefined) return [];
  if (Array.isArray(raw)) return raw.map((entry: unknown) => String(entry));
  return typeof raw === 'string' ? [raw] : [];
}

/** The session cookie as a browser would send it back. */
function sessionCookie(response: { headers: Record<string, unknown> }): string {
  const entry = setCookies(response).find(
    (cookie) => cookie.startsWith('__Secure-assaybank.session_token=') && !cookie.includes('=;'),
  );
  if (entry === undefined) throw new Error('the response set no session cookie');
  return entry.split(';', 1)[0] ?? '';
}

interface Profile {
  user: { id: string; email: string; full_name: string; timezone: string };
  org: { id: string; name: string; slug: string };
  permissions: string[];
  server_time: string;
}

const login = async (
  instance: FastifyInstance,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
) =>
  instance.inject({
    method: 'POST',
    url: `${API_BASE_PATH}/auth/login`,
    headers: { origin: CONSOLE_ORIGIN, ...headers },
    payload: body,
  });

describe('POST /auth/login', () => {
  it('issues a session cookie with the attributes docs/14 H-123 requires', async () => {
    const response = await login(build(), { email: ADA, password: PASSWORD });

    expect(response.statusCode).toBe(200);

    const cookie = setCookies(response).find((c) => c.includes('session_token='));
    expect(cookie).toBeDefined();
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Lax');
    // Host-prefixed, which a browser refuses to accept without `Secure` — so the prefix
    // and the attribute cannot drift apart.
    expect(cookie).toContain('__Secure-');
  });

  it('answers with the documented profile, not with a token in the body', async () => {
    const response = await login(build(), { email: ADA, password: PASSWORD });
    const body = response.json<Profile>();

    expect(body.user.email).toBe(ADA);
    expect(body.org.slug).toBe('acme');
    // The session identifier belongs in the cookie and nowhere else: a token in a JSON
    // body is a token in a log, a screenshot and an XHR-capture browser extension.
    expect(JSON.stringify(body)).not.toContain('session_token');
  });

  it('refuses a wrong password with the standard envelope', async () => {
    const response = await login(build(), { email: ADA, password: 'not-the-password' });

    expect(response.statusCode).toBe(401);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('unauthenticated');
    expect(setCookies(response).some((c) => c.includes('session_token='))).toBe(false);
  });

  it('refuses a password for the wrong organisation', async () => {
    // Ada exists, and the password is hers, but she is not in `rival`. Naming another
    // organisation must not authenticate her there.
    const response = await login(build(), { email: ADA, password: PASSWORD, org: 'rival' });
    expect(response.statusCode).toBe(401);
  });

  it('rejects a password past the length ceiling before any hashing happens', async () => {
    const response = await login(build(), { email: ADA, password: 'a'.repeat(129) });
    // 422, which is what `validation_failed` maps to in @assaybank/contracts. The point is
    // that the schema refuses it before the handler runs, so an unauthenticated caller
    // cannot make the server do 19 MiB of Argon2 work per megabyte they send.
    expect(response.statusCode).toBe(422);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('validation_failed');
  });
});

describe('a failed login discloses nothing about whether the address exists (docs/14 H-118)', () => {
  it('answers identically for a wrong password and for no such account', async () => {
    const instance = build();

    const wrongPassword = await login(instance, { email: ADA, password: 'not-the-password' });
    const noSuchUser = await login(instance, {
      email: 'nobody@acme.example',
      password: 'not-the-password',
    });

    expect(noSuchUser.statusCode).toBe(wrongPassword.statusCode);

    // Byte-identical apart from the request id, which is per-request by construction.
    const scrub = (raw: string): string => raw.replace(/req_[0-9a-f]{32}/gu, 'req_x');
    expect(scrub(noSuchUser.body)).toBe(scrub(wrongPassword.body));

    // And identical on the wire, not only in the body. The two paths are different code —
    // one never reaches Better Auth at all — so a cookie set by one and not the other
    // would be an oracle made of a response header.
    expect(setCookies(noSuchUser)).toEqual(setCookies(wrongPassword));
    expect(Object.keys(noSuchUser.headers).sort()).toEqual(
      Object.keys(wrongPassword.headers).sort(),
    );
  });

  it('answers identically for an address held by two organisations', async () => {
    // Otherwise "this address is ambiguous" would itself be a fact about the other tenant.
    const instance = build();

    const ambiguous = await login(instance, { email: SHARED, password: PASSWORD });
    const missing = await login(instance, { email: 'nobody@acme.example', password: PASSWORD });

    expect(ambiguous.statusCode).toBe(401);
    const scrub = (raw: string): string => raw.replace(/req_[0-9a-f]{32}/gu, 'req_x');
    expect(scrub(ambiguous.body)).toBe(scrub(missing.body));
  });

  it('answers identically for a password too short to be anybody\u2019s', async () => {
    // The regression this closes. `hashPassword` refuses a password below the policy floor
    // with a `RangeError`, and Better Auth calls `password.hash` on the address-not-found
    // branch as its dummy hash — so a four-character password used to leave as `500` for
    // an address with no credential account and `401` for one with. That is the whole
    // enumeration oracle back again, made of an exception, and readable without ever
    // guessing a password. See `hashForBetterAuth` in src/auth/better-auth.ts.
    const instance = build();
    const scrub = (raw: string): string => raw.replace(/req_[0-9a-f]{32}/gu, 'req_x');

    const known = await login(instance, { email: ADA, password: 'short' });
    const unknown = await login(instance, {
      email: 'nobody@acme.example',
      password: 'short',
      org: 'acme',
    });
    // Found the user, found no password: Better Auth's other dummy-hash branch.
    const federated = await login(instance, { email: FEDERATED, password: 'short' });

    for (const response of [known, unknown, federated]) {
      expect(response.statusCode).toBe(401);
      expect(response.json<{ error: { code: string } }>().error.code).toBe('unauthenticated');
    }
    expect(scrub(unknown.body)).toBe(scrub(known.body));
    expect(scrub(federated.body)).toBe(scrub(known.body));
  });

  it('refuses a federated account\u2019s address with a well-formed password, too', async () => {
    // No `staff_accounts` row with `provider_id = 'credential'`, so there is nothing for a
    // password to match — and the refusal is the ordinary one rather than a hint that this
    // address signs in another way.
    const response = await login(build(), { email: FEDERATED, password: PASSWORD });

    expect(response.statusCode).toBe(401);
    expect(setCookies(response).some((c) => c.includes('session_token='))).toBe(false);
  });

  it('signs the same address in, once the organisation is named', async () => {
    // The ambiguity is resolved by the client, not by the server guessing.
    const response = await login(build(), { email: SHARED, password: PASSWORD, org: 'rival' });

    expect(response.statusCode).toBe(200);
    expect(response.json<Profile>().org.slug).toBe('rival');
  });
});

describe('session fixation (docs/14 T-014)', () => {
  it('does not authenticate an identifier the attacker planted', async () => {
    const instance = build();
    const planted = '__Secure-assaybank.session_token=attacker-chosen-value.forged-signature';

    // The attacker's cookie is already in the browser when the victim signs in, so the
    // sign-in arrives carrying it — from the real console, which is what makes this a
    // fixation attempt rather than the forgery the previous block covers.
    const response = await login(instance, { email: ADA, password: PASSWORD }, { cookie: planted });

    expect(response.statusCode).toBe(200);

    const issued = sessionCookie(response);
    expect(issued).not.toContain('attacker-chosen-value');

    // And the planted identifier is not a session afterwards, which is the property that
    // matters: the attacker holds it and it authenticates nobody.
    const asPlanted = await instance.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/auth/me`,
      headers: { cookie: planted },
    });
    expect(asPlanted.statusCode).toBe(401);

    const asIssued = await instance.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/auth/me`,
      headers: { cookie: issued },
    });
    expect(asIssued.statusCode).toBe(200);
  });

  it('issues a different identifier on every sign-in', async () => {
    const instance = build();
    const first = sessionCookie(await login(instance, { email: ADA, password: PASSWORD }));
    const second = sessionCookie(await login(instance, { email: ADA, password: PASSWORD }));

    expect(second).not.toBe(first);
  });
});

describe('cross-site request forgery (docs/14 T-017)', () => {
  it('refuses a cookie-bearing login submitted from a hostile page', async () => {
    const instance = build();
    const cookie = sessionCookie(await login(instance, { email: ADA, password: PASSWORD }));

    const forged = await instance.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/auth/login`,
      headers: { origin: 'https://evil.example', cookie },
      payload: { email: ADA, password: PASSWORD },
    });

    expect(forged.statusCode).toBe(403);
    expect(forged.json<{ error: { code: string } }>().error.code).toBe('forbidden');
  });

  it('refuses a cookie-bearing logout submitted from a hostile page', async () => {
    // Logging somebody out is a state change too, and a forced logout mid-interview is a
    // real nuisance even though it steals nothing.
    const instance = build();
    const cookie = sessionCookie(await login(instance, { email: ADA, password: PASSWORD }));

    const forged = await instance.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/auth/logout`,
      headers: { origin: 'https://evil.example', cookie },
    });

    expect(forged.statusCode).toBe(403);

    // The session survived the attempt.
    const me = await instance.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/auth/me`,
      headers: { cookie },
    });
    expect(me.statusCode).toBe(200);
  });

  it('allows the same request from the console', async () => {
    const instance = build();
    const cookie = sessionCookie(await login(instance, { email: ADA, password: PASSWORD }));

    const honest = await instance.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/auth/logout`,
      headers: { origin: CONSOLE_ORIGIN, cookie, 'sec-fetch-site': 'same-origin' },
    });

    expect(honest.statusCode).toBe(204);
  });
});

describe('GET /auth/me', () => {
  it('returns {user, org, permissions[]} as docs/03 §1 documents it', async () => {
    const instance = build();
    const cookie = sessionCookie(await login(instance, { email: ADA, password: PASSWORD }));

    const response = await instance.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/auth/me`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<Profile>();

    expect(Object.keys(body).sort()).toEqual(['org', 'permissions', 'server_time', 'user']);
    expect(body.user).toEqual({
      id: required(adaId, 'adaId'),
      email: ADA,
      full_name: 'Staff acme',
      timezone: 'Europe/London',
    });
    expect(body.org).toEqual({ id: ACME, name: 'Acme', slug: 'acme' });
    expect(Array.isArray(body.permissions)).toBe(true);
    // ADR-006: the server owns the clock and says so, from the injected one.
    expect(body.server_time).toBe('2026-10-13T09:00:00.000Z');
  });

  it('carries no password hash, no session token and no other tenant', async () => {
    const instance = build();
    const cookie = sessionCookie(await login(instance, { email: ADA, password: PASSWORD }));

    const response = await instance.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/auth/me`,
      headers: { cookie },
    });

    const raw = response.body;
    expect(raw).not.toContain('argon2');
    expect(raw).not.toContain('session_token');
    expect(raw).not.toContain('rival');
    expect(raw).not.toContain(RIVAL);
  });

  it('refuses a request with no cookie', async () => {
    const response = await build().inject({ method: 'GET', url: `${API_BASE_PATH}/auth/me` });

    expect(response.statusCode).toBe(401);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('unauthenticated');
  });

  it('refuses a cookie that was never issued', async () => {
    const response = await build().inject({
      method: 'GET',
      url: `${API_BASE_PATH}/auth/me`,
      headers: { cookie: '__Secure-assaybank.session_token=made.up' },
    });

    expect(response.statusCode).toBe(401);
  });

  it('reports permissions read from the database, not from the session', async () => {
    const instance = build();
    const owner = required(pg, 'postgres').owner;
    const roleId = required(recruiterRoleId, 'recruiterRoleId');
    const userId = required(adaId, 'adaId');

    const cookie = sessionCookie(await login(instance, { email: ADA, password: PASSWORD }));

    const before = await instance.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/auth/me`,
      headers: { cookie },
    });
    expect(before.json<Profile>().permissions).toEqual([]);

    await owner`
      INSERT INTO user_role_assignments (user_id, user_role_id) VALUES (${userId}, ${roleId})
    `;
    try {
      const after = await instance.inject({
        method: 'GET',
        url: `${API_BASE_PATH}/auth/me`,
        headers: { cookie },
      });
      // No new session, no re-login: the set is resolved per request, which is what makes
      // a revoked permission take effect immediately rather than at the end of a session.
      expect(after.json<Profile>().permissions).toEqual(['invite.send', 'question.read']);
    } finally {
      await owner`DELETE FROM user_role_assignments WHERE user_id = ${userId}`;
    }
  });
});

describe('POST /auth/logout', () => {
  it('ends the session and clears the cookie', async () => {
    const instance = build();
    const cookie = sessionCookie(await login(instance, { email: ADA, password: PASSWORD }));

    const response = await instance.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/auth/logout`,
      headers: { origin: CONSOLE_ORIGIN, cookie },
    });

    expect(response.statusCode).toBe(204);
    expect(setCookies(response).some((c) => c.includes('session_token=;'))).toBe(true);

    // Server-side, not only in the browser: a copy of the cookie taken before the logout
    // is dead too (docs/14 H-123).
    const after = await instance.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/auth/me`,
      headers: { cookie },
    });
    expect(after.statusCode).toBe(401);
  });

  it('refuses a logout with no session', async () => {
    const response = await build().inject({
      method: 'POST',
      url: `${API_BASE_PATH}/auth/logout`,
      headers: { origin: CONSOLE_ORIGIN },
    });

    expect(response.statusCode).toBe(401);
  });
});

describe('session rotation on privilege change (docs/14 H-123)', () => {
  it('ends every session that predates the change, and the next one is a different identifier', async () => {
    const instance = build();
    const owner = required(pg, 'postgres').owner;
    const roleId = required(recruiterRoleId, 'recruiterRoleId');
    const userId = required(adaId, 'adaId');

    // Two sessions, because a rotation that only ends the one in front of it leaves the
    // attacker's other tab signed in.
    const laptop = sessionCookie(await login(instance, { email: ADA, password: PASSWORD }));
    const phone = sessionCookie(await login(instance, { email: ADA, password: PASSWORD }));
    expect(laptop).not.toBe(phone);

    const auth = staffAuthFor(instance);

    await owner`
      INSERT INTO user_role_assignments (user_id, user_role_id) VALUES (${userId}, ${roleId})
    `;
    try {
      await revokeStaffSessions(auth, userId);

      for (const cookie of [laptop, phone]) {
        const response = await instance.inject({
          method: 'GET',
          url: `${API_BASE_PATH}/auth/me`,
          headers: { cookie },
        });
        expect(response.statusCode).toBe(401);
      }

      const reissued = await login(instance, { email: ADA, password: PASSWORD });
      const fresh = sessionCookie(reissued);
      expect(fresh).not.toBe(laptop);
      expect(fresh).not.toBe(phone);

      // And the new session sees the new privilege.
      expect(reissued.json<Profile>().permissions).toEqual(['invite.send', 'question.read']);
    } finally {
      await owner`DELETE FROM user_role_assignments WHERE user_id = ${userId}`;
    }
  });

  it('leaves another user’s sessions alone', async () => {
    const instance = build();
    const cookie = sessionCookie(await login(instance, { email: ADA, password: PASSWORD }));

    // Revoking for somebody else must not be a denial of service against everyone.
    await revokeStaffSessions(
      staffAuthFor(instance),
      UserIdSchema.parse('00000000-0000-4000-8000-000000000001'),
    );

    const response = await instance.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/auth/me`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
  });
});

describe('tenancy', () => {
  it('runs every Better Auth statement inside the organisation it resolved', async () => {
    // The proof is indirect and it is the strongest one available: the sign-in inserts and
    // reads `staff_accounts`, which is row-level-security scoped with no default org, so a
    // statement issued outside `withOrg` would see zero rows and the login would fail. It
    // succeeds, so the context was set — and the account row it found belongs to Acme.
    const instance = build();
    const response = await login(instance, { email: ADA, password: PASSWORD });
    expect(response.statusCode).toBe(200);
    expect(response.json<Profile>().org.id).toBe(ACME);
  });

  it('cannot see another organisation through a session it holds', async () => {
    const instance = build();
    const cookie = sessionCookie(
      await login(instance, { email: 'bob@rival.example', password: PASSWORD }),
    );

    const me = await instance.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/auth/me`,
      headers: { cookie },
    });

    expect(me.json<Profile>().org.id).toBe(RIVAL);

    // And Acme's rows are genuinely unreachable in that context: the same query that
    // found Bob finds no Acme user.
    const rows = await withOrg(required(pg, 'postgres').db, RIVAL, async (tx) =>
      tx.execute<{ n: string }>(
        sql`SELECT count(*)::text AS n FROM users WHERE email = ${ADA}::citext`,
      ),
    );
    expect(rows[0]?.n).toBe('0');
  });
});

/**
 * A candidate principal, as the bearer-token hook would have left it.
 *
 * The attempt and organisation do not have to exist: the property under test is what the
 * staff hook does when it finds a principal already in place, and it decides that before
 * any row is read.
 */
const CANDIDATE: CandidatePrincipal = {
  kind: 'candidate',
  attemptId: AttemptIdSchema.parse('2f0b8c41-6d5e-4a23-9b17-8e4c0d3a5f62'),
  orgId: ACME,
};

describe('the two credential domains on one request (docs/03 §1)', () => {
  /**
   * A bare instance carrying a candidate principal before the staff hook runs.
   *
   * Not `buildServer`, because the candidate half of that wiring is P1 step 6's and would
   * drag a redemption service, a ticket store and a signing key into a test about one
   * `if`. The hook under test reads `request.principal` and the `Cookie` header and
   * nothing else, so a hook that plants the principal is the same input by construction —
   * and the staff half is the real Better Auth instance holding the real session.
   */
  const withBothCredentials = (instance: FastifyInstance): FastifyInstance => {
    const bare = Fastify({ logger: false });
    registerErrorHandling(bare);
    registerPrincipal(bare);
    // `onRequest`, which is the phase the real bearer-token hook uses, so it lands before
    // the `preValidation` hook below exactly as it does on the built server.
    bare.addHook('onRequest', (request, _reply, done) => {
      setPrincipal(request, CANDIDATE);
      done();
    });
    registerStaffAuthentication(bare, {
      auth: staffAuthFor(instance),
      db: required(pg, 'postgres').db,
    });
    bare.get('/probe', (request) => ({ kind: currentPrincipal(request).kind }));
    return bare;
  };

  it('leaves a candidate-only request alone, so the refusal below means something', async () => {
    const bare = withBothCredentials(build());
    try {
      const response = await bare.inject({ method: 'GET', url: '/probe' });

      expect(response.statusCode).toBe(200);
      expect(response.json<{ kind: string }>().kind).toBe('candidate');
    } finally {
      await bare.close();
    }
  });

  it('refuses a request presenting a candidate token and a staff session at once', async () => {
    const instance = build();
    const cookie = sessionCookie(await login(instance, { email: ADA, password: PASSWORD }));

    const bare = withBothCredentials(instance);
    try {
      const response = await bare.inject({
        method: 'GET',
        url: '/probe',
        headers: { cookie },
      });

      // Not a precedence question. Whichever credential lost was still accepted by
      // something, so the request is refused outright rather than resolved.
      expect(response.statusCode).toBe(401);
      expect(response.json<{ error: { code: string } }>().error.code).toBe('unauthenticated');
      expect(response.body).not.toContain('staff');
    } finally {
      await bare.close();
    }
  });

  it('is not tripped by a cookie that is not a session', async () => {
    // The check is "a staff session resolved", not "a cookie header exists". A candidate
    // whose browser happens to hold any other cookie must still be served.
    const bare = withBothCredentials(build());
    try {
      const response = await bare.inject({
        method: 'GET',
        url: '/probe',
        headers: { cookie: '__Secure-assaybank.session_token=never.issued; other=1' },
      });

      expect(response.statusCode).toBe(200);
    } finally {
      await bare.close();
    }
  });
});

describe('the login rate limit', () => {
  it('refuses the eleventh attempt from one address within the window', async () => {
    const instance = build();

    for (let i = 0; i < 10; i += 1) {
      const response = await login(instance, { email: ADA, password: 'wrong-password-here' });
      expect(response.statusCode).toBe(401);
    }

    const refused = await login(instance, { email: ADA, password: PASSWORD });
    expect(refused.statusCode).toBe(429);
    expect(refused.json<{ error: { code: string } }>().error.code).toBe('rate_limited');
    expect(refused.headers['retry-after']).toBeDefined();
  });
});

/**
 * A stand-in identity provider that serves one document: its discovery metadata.
 *
 * That is all `POST /auth/oidc/start` needs. The flow past the redirect — the token
 * exchange, the id-token signature, the userinfo call — is Better Auth's and is covered by
 * its own suite; what is ours, and what is asserted below, is that the organisation is
 * resolved before anything is written, that the state cookie binds the flow, and that a
 * callback which cannot prove which organisation it belongs to is refused before a single
 * tenant row is read.
 */
function fakeIdentityProvider(): Promise<{ issuer: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server: Server = createServer((request, response) => {
      const issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      if (request.url === '/.well-known/openid-configuration') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            issuer,
            authorization_endpoint: `${issuer}/authorize`,
            token_endpoint: `${issuer}/token`,
            userinfo_endpoint: `${issuer}/userinfo`,
            jwks_uri: `${issuer}/jwks`,
            response_types_supported: ['code'],
            subject_types_supported: ['public'],
            id_token_signing_alg_values_supported: ['RS256'],
            code_challenge_methods_supported: ['S256'],
          }),
        );
        return;
      }
      response.writeHead(404).end();
    });

    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        issuer: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => {
              done();
            });
          }),
      });
    });
  });
}

describe('OIDC (docs/03 §1, docs/14 T-015 and H-124)', () => {
  let idp: { issuer: string; close: () => Promise<void> } | undefined;

  beforeAll(async () => {
    idp = await fakeIdentityProvider();
  });

  afterAll(async () => {
    await idp?.close();
    idp = undefined;
  });

  const issuer = (): string => required(idp, 'identity provider').issuer;

  it('has no OIDC endpoints at all when no provider is configured', async () => {
    const instance = build();

    const start = await instance.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/auth/oidc/start`,
      headers: { origin: CONSOLE_ORIGIN },
      payload: { provider: 'oidc' },
    });
    expect(start.statusCode).toBe(404);

    const callback = await instance.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/auth/oidc/callback?code=x&state=y`,
    });
    expect(callback.statusCode).toBe(404);
  });

  it('redirects to the identity provider with PKCE and a state-bound organisation cookie', async () => {
    const response = await build(issuer()).inject({
      method: 'POST',
      url: `${API_BASE_PATH}/auth/oidc/start`,
      headers: { origin: CONSOLE_ORIGIN },
      payload: { provider: 'oidc', org: 'acme' },
    });

    expect(response.statusCode).toBe(200);
    const url = new URL(response.json<{ url: string }>().url);

    expect(url.origin).toBe(issuer());
    expect(url.pathname).toBe('/authorize');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('assaybank');
    // PKCE: an intercepted `code` is useless without the verifier this server kept.
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBeTruthy();
    // Fixed from API_PUBLIC_URL, never from a Host header.
    expect(url.searchParams.get('redirect_uri')).toBe(
      `${API_URL}${API_BASE_PATH}/auth/oidc/callback`,
    );

    const state = url.searchParams.get('state');
    expect(state).toBeTruthy();

    // Our own cookie, carrying the organisation across the round trip, scoped to the one
    // route that reads it and bound to this flow.
    const orgCookie = setCookies(response).find((c) => c.includes('oidc_org='));
    expect(orgCookie).toBeDefined();
    expect(orgCookie).toContain('HttpOnly');
    expect(orgCookie).toContain('Secure');
    expect(orgCookie).toContain('SameSite=Lax');
    expect(orgCookie).toContain(`Path=${API_BASE_PATH}/auth/oidc/callback`);
    // The organisation is in it, but so is a signature over it and the state.
    expect(orgCookie).toContain(ACME);
  });

  it('refuses a provider it does not have', async () => {
    const response = await build(issuer()).inject({
      method: 'POST',
      url: `${API_BASE_PATH}/auth/oidc/start`,
      headers: { origin: CONSOLE_ORIGIN },
      payload: { provider: 'some-other-idp', org: 'acme' },
    });

    expect(response.statusCode).toBe(404);
  });

  it('refuses to guess which organisation, when the deployment has more than one', async () => {
    // Two organisations are seeded, so `{provider}` alone is not enough — and guessing
    // would redirect somebody to another tenant's identity provider.
    const response = await build(issuer()).inject({
      method: 'POST',
      url: `${API_BASE_PATH}/auth/oidc/start`,
      headers: { origin: CONSOLE_ORIGIN },
      payload: { provider: 'oidc' },
    });

    expect(response.statusCode).toBe(404);
  });

  it('refuses a callback with no organisation cookie, before reading any row', async () => {
    const response = await build(issuer()).inject({
      method: 'GET',
      url: `${API_BASE_PATH}/auth/oidc/callback?code=anything&state=anything`,
    });

    expect(response.statusCode).toBe(401);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('unauthenticated');
  });

  it('refuses a callback whose organisation cookie was minted for a different flow', async () => {
    const instance = build(issuer());

    const start = await instance.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/auth/oidc/start`,
      headers: { origin: CONSOLE_ORIGIN },
      payload: { provider: 'oidc', org: 'acme' },
    });
    const orgCookie = (setCookies(start).find((c) => c.includes('oidc_org=')) ?? '').split(
      ';',
      1,
    )[0];

    // The cookie is genuine and the signature is intact; only the state differs, which is
    // exactly the replay the binding exists to stop.
    const response = await instance.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/auth/oidc/callback?code=anything&state=a-state-from-another-flow`,
      headers: { cookie: orgCookie ?? '' },
    });

    expect(response.statusCode).toBe(401);
  });

  it('turns a forged state into a redirect to the error page, not into a session', async () => {
    const instance = build(issuer());

    const start = await instance.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/auth/oidc/start`,
      headers: { origin: CONSOLE_ORIGIN },
      payload: { provider: 'oidc', org: 'acme' },
    });
    const url = new URL(start.json<{ url: string }>().url);
    const state = url.searchParams.get('state') ?? '';
    const orgCookie = (setCookies(start).find((c) => c.includes('oidc_org=')) ?? '').split(
      ';',
      1,
    )[0];

    // The organisation cookie matches the state, so the tenant context opens — and Better
    // Auth then rejects the flow itself, because the `code` was not issued against the
    // state it stored. The session cookie is never set.
    const response = await instance.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/auth/oidc/callback?code=not-a-real-code&state=${state}`,
      headers: { cookie: orgCookie ?? '' },
    });

    expect(response.statusCode).toBe(302);
    expect(setCookies(response).some((c) => c.includes('session_token='))).toBe(false);
    // And the organisation cookie is cleared either way: the flow is over.
    expect(setCookies(response).some((c) => c.includes('oidc_org=;'))).toBe(true);
  });
});
