/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What the OIDC callback refuses (`H-150`, docs/14 T-015).
 *
 * The row claims six things: the callback validates issuer, audience, `nonce`, `exp` and
 * the PKCE verifier, with `state` bound to the originating session, and an email claim maps
 * to an existing user rather than provisioning one. Until now every one of those was a
 * claim about configuration — `pkce: true`, `disableSignUp: true` — read from the file that
 * sets it. A configuration comment is not evidence. The library could ignore the option,
 * the discovery document could fail to supply what verification needs, or the flow could
 * take a path where the check is never reached, and the file would read exactly the same.
 *
 * So each one is a token that is correct in every respect but one, presented to the real
 * callback against a real PostgreSQL, and asserted to be refused. The happy path is here
 * too and it is load-bearing: without it, a server that refused *everything* would pass
 * every negative test in this file.
 *
 * ## The shape of a flow
 *
 * `POST /auth/oidc/start` mints the `state`, the PKCE verifier and the `nonce`, stores them
 * in `staff_verifications` and hands back the authorisation URL plus our own organisation
 * cookie. The test reads `state` and `nonce` out of that URL, tells the fake provider what
 * to sign, and calls `GET /auth/oidc/callback` itself rather than following redirects —
 * there is no browser here and the redirect goes to a consent screen that does not exist.
 *
 * Better Auth answers the callback with a redirect either way: to the console on success,
 * to its error URL on failure. So the assertion is never on the status — it is on
 * **whether a session cookie was set**, which is the only thing that actually differs and
 * the only thing that matters.
 */

import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { API_BASE_PATH, OrgIdSchema, type OrgId } from '@assaybank/contracts';
import { withOrg } from '@assaybank/db';

import { createStaffAuth } from '../../src/auth/better-auth.js';
import { memorySessionStore } from '../../src/auth/session-store.js';
import { buildServer } from '../../src/server.js';
import { testConfig } from '../../src/test-support.js';
import { startFakeIdp, type FakeIdp } from './fake-idp.js';
import { startTestPostgres, type TestPostgres } from './postgres-fixture.js';

const ACME: OrgId = OrgIdSchema.parse('11111111-0000-4000-8000-0000000000aa');
const FEDERATED = 'federated@acme.example';
const CONSOLE_ORIGIN = 'https://console.example.test';
const API_URL = 'https://api.example.test';
const SESSION_SECRET = 'an-example-session-secret-for-tests';
const CLIENT_ID = 'assaybank';

let pg: TestPostgres | undefined;
let idp: FakeIdp | undefined;
let app: FastifyInstance | undefined;

function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`${what} is not ready`);
  return value;
}

beforeAll(async () => {
  pg = await startTestPostgres();
  idp = await startFakeIdp({ clientId: CLIENT_ID, email: FEDERATED });

  const owner = required(pg, 'postgres').owner;
  await owner`
    INSERT INTO organizations (id, name, slug) VALUES (${ACME}, 'Acme', 'acme')
    ON CONFLICT (id) DO NOTHING
  `;
  // A federated user: a row in `users` with no credential account. The address exists, and
  // there is no password for it — which is the state an IdP-only staff member is in.
  await owner`
    INSERT INTO users (id, org_id, email, full_name, timezone)
    VALUES (gen_random_uuid(), ${ACME}, ${FEDERATED}, 'Ada Lovelace', 'Europe/London')
    ON CONFLICT DO NOTHING
  `;
}, 120_000);

afterAll(async () => {
  await idp?.close();
  idp = undefined;
  await pg?.stop();
  pg = undefined;
});

afterEach(async () => {
  await app?.close();
  app = undefined;
});

/** A server wired to the fake provider. `issuer` overridable so a bad one can be tested. */
function build(issuer?: string): FastifyInstance {
  const db = required(pg, 'postgres').db;
  const auth = createStaffAuth({
    config: {
      http: {
        publicUrl: API_URL,
        webPublicUrl: CONSOLE_ORIGIN,
        corsAllowedOrigins: [CONSOLE_ORIGIN],
      },
      secrets: { sessionSecret: SESSION_SECRET },
      oidc: {
        enabled: true,
        issuer: issuer ?? required(idp, 'idp').issuer,
        clientId: CLIENT_ID,
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
      oidcEnabled: true,
      now: () => new Date('2026-10-13T09:00:00.000Z'),
    },
  });

  app = instance;
  return instance;
}

function setCookies(response: { headers: Record<string, unknown> }): string[] {
  const raw: unknown = response.headers['set-cookie'];
  if (raw === undefined) return [];
  if (Array.isArray(raw)) return raw.map((entry: unknown) => String(entry));
  return typeof raw === 'string' ? [raw] : [];
}

/** Whether a response handed the browser a staff session. The only outcome that differs. */
function issuedSession(response: { headers: Record<string, unknown> }): boolean {
  return setCookies(response).some(
    (cookie) => cookie.startsWith('__Host-assaybank.session_token=') && !cookie.includes('=;'),
  );
}

interface StartedFlow {
  readonly state: string;
  readonly nonce: string | undefined;
  /**
   * Every cookie the start set, as a browser would send them back.
   *
   * Two of them, and both are required: Better Auth's signed `state`, which the callback
   * checks against the `state` parameter, and ours carrying the organisation across the
   * round trip. Collecting them wholesale rather than naming them is deliberate — a flow
   * that grows a third cookie should not need this helper edited to keep working.
   */
  readonly cookies: string;
}

/** Runs `POST /auth/oidc/start` and reads back what the callback will need. */
async function startFlow(instance: FastifyInstance): Promise<StartedFlow> {
  const response = await instance.inject({
    method: 'POST',
    url: `${API_BASE_PATH}/auth/oidc/start`,
    headers: { origin: CONSOLE_ORIGIN },
    payload: { provider: 'oidc', org: 'acme' },
  });

  expect(response.statusCode, 'the flow should start').toBe(200);

  const url = new URL(response.json<{ url: string }>().url);
  const cookies = setCookies(response)
    .map((cookie) => cookie.split(';', 1)[0] ?? '')
    .filter((pair) => pair !== '' && !pair.endsWith('='))
    .join('; ');

  return {
    state: url.searchParams.get('state') ?? '',
    nonce: url.searchParams.get('nonce') ?? undefined,
    cookies,
  };
}

/** Completes a flow, with the provider told to sign whatever `overrides` say. */
async function callback(
  instance: FastifyInstance,
  flow: StartedFlow,
  overrides: Parameters<FakeIdp['next']>[0] = {},
) {
  const claims = {
    ...(flow.nonce === undefined ? {} : { nonce: flow.nonce }),
    ...(overrides.claims ?? {}),
  };
  required(idp, 'idp').next({ ...overrides, claims });

  return instance.inject({
    method: 'GET',
    url: `${API_BASE_PATH}/auth/oidc/callback?code=a-code&state=${encodeURIComponent(flow.state)}`,
    headers: { cookie: flow.cookies },
  });
}

describe('the flow this product asks for', () => {
  it('asks for a code with PKCE and a nonce, which is what every check below rests on', async () => {
    const instance = build();
    const flow = await startFlow(instance);

    const authorization = required(idp, 'idp').authorizations.at(-1);
    // The authorisation request never reaches the provider in these tests — the console
    // navigates to it — so this reads the URL the server produced instead.
    expect(flow.state).not.toBe('');
    // A nonce is what binds the returned assertion to *this* flow. Without one the token
    // check below cannot be a replay check, only a signature check.
    expect(flow.nonce, 'the authorisation request must carry a nonce').toBeDefined();
    expect(authorization).toBeUndefined();
  });

  it('signs a known federated user in, which is what makes every refusal below mean something', async () => {
    const instance = build();
    const response = await callback(instance, await startFlow(instance));

    expect(issuedSession(response)).toBe(true);
  });

  it('sends the PKCE verifier to the token endpoint, not just the challenge to the IdP', async () => {
    // `pkce: true` is a line of configuration; this is the wire. An intercepted `code` is
    // useless without the verifier, and the verifier only leaves this server here.
    const instance = build();
    await callback(instance, await startFlow(instance));

    const token = required(idp, 'idp').lastTokenRequest();
    expect(token?.['grant_type']).toBe('authorization_code');
    expect(token?.['code_verifier'], 'the token request must carry the PKCE verifier').toBeTruthy();
  });
});

describe('an assertion that is wrong in exactly one way', () => {
  let instance: FastifyInstance;
  let flow: StartedFlow;

  beforeEach(async () => {
    instance = build();
    flow = await startFlow(instance);
  });

  it('refuses a token signed by a key the JWKS does not publish', async () => {
    // The root of all of it. Everything else is a claim inside a document whose only
    // authority is the signature over it.
    expect(issuedSession(await callback(instance, flow, { wrongKey: true }))).toBe(false);
  });

  it('refuses a token from another issuer', async () => {
    // The multi-tenant IdP case T-015 describes: a token minted by a different tenant of
    // the same provider, signed by a key that genuinely verifies.
    expect(
      issuedSession(await callback(instance, flow, { claims: { iss: 'https://someone.else' } })),
    ).toBe(false);
  });

  it('refuses a token minted for another audience', async () => {
    // An assertion for a *different application* at the same issuer. It is correctly
    // signed, correctly issued, and not for us.
    expect(
      issuedSession(await callback(instance, flow, { claims: { aud: 'some-other-client' } })),
    ).toBe(false);
  });

  it('refuses a token whose nonce belongs to another flow', async () => {
    // Replay. The nonce is what ties the assertion to the `state` this server minted, and
    // an attacker holding a valid token from elsewhere has the wrong one.
    expect(
      issuedSession(
        await callback(instance, flow, { claims: { nonce: 'a-nonce-from-elsewhere' } }),
      ),
    ).toBe(false);
  });

  it('refuses a token carrying no nonce at all', async () => {
    // The downgrade of the case above: an IdP that simply omits the claim must not be
    // treated as one that matched it.
    expect(issuedSession(await callback(instance, flow, { claims: { nonce: undefined } }))).toBe(
      false,
    );
  });

  it('refuses an expired token', async () => {
    const past = Math.floor(Date.now() / 1000) - 3600;
    expect(
      issuedSession(await callback(instance, flow, { claims: { exp: past, iat: past - 60 } })),
    ).toBe(false);
  });

  it('refuses a token that is not valid yet', async () => {
    const future = Math.floor(Date.now() / 1000) + 3600;
    expect(issuedSession(await callback(instance, flow, { claims: { nbf: future } }))).toBe(false);
  });

  it('refuses a token exchange that returns no assertion at all', async () => {
    // The downgrade that `requireIdTokenVerification` exists to stop, arriving at run time
    // rather than at boot: an access token with no `id_token`, which without a verified
    // assertion would leave identity coming from an unauthenticated userinfo response.
    expect(issuedSession(await callback(instance, flow, { omitIdToken: true }))).toBe(false);
  });
});

describe('the state, and what it is bound to', () => {
  it('refuses a callback whose state was never minted here', async () => {
    const instance = build();
    const flow = await startFlow(instance);

    const response = await callback(instance, { ...flow, state: 'a-state-we-never-issued' });
    expect(issuedSession(response)).toBe(false);
  });

  it('refuses a state that has already been spent', async () => {
    // Single use. Without this an intercepted callback URL is replayable for as long as the
    // verification row survives.
    const instance = build();
    const flow = await startFlow(instance);

    expect(issuedSession(await callback(instance, flow))).toBe(true);
    expect(issuedSession(await callback(instance, flow))).toBe(false);
  });
});

describe('an address the IdP asserts and this organisation does not know', () => {
  it('signs nobody in, and creates no user', async () => {
    // docs/14 `H-150` as a security property rather than a modelling one: an IdP that lets
    // anyone sign up must not be able to mint staff accounts here. The assertion is
    // perfectly valid — correct issuer, audience, nonce and signature — and names somebody
    // who does not work here.
    const instance = build();
    const flow = await startFlow(instance);

    const response = await callback(instance, flow, {
      claims: { email: 'stranger@example.test', sub: 'a-different-subject' },
    });

    expect(issuedSession(response)).toBe(false);

    const owner = required(pg, 'postgres').owner;
    const rows = await owner<{ n: string }[]>`
      SELECT count(*)::text AS n FROM users WHERE email = 'stranger@example.test'
    `;
    expect(rows[0]?.n, 'no user may be provisioned by an assertion').toBe('0');
  });

  it('signs the known address in through the assertion, not through userinfo', async () => {
    // The fake provider's userinfo endpoint claims a different address on purpose. If the
    // identity ever came from there instead of from the verified token, this is what says
    // so — and it would say so quietly otherwise, because both paths produce a session.
    const instance = build();
    const flow = await startFlow(instance);

    expect(issuedSession(await callback(instance, flow))).toBe(true);

    const db = required(pg, 'postgres').db;
    const rows = await withOrg(db, ACME, (tx) =>
      tx.execute<{ n: string }>(
        sql`SELECT count(*)::text AS n FROM users WHERE email = 'userinfo-should-not-win@example.test'`,
      ),
    );
    expect(rows[0]?.n).toBe('0');
  });
});

describe('a discovery document that cannot support verification', () => {
  it('starts no flow rather than one that cannot be verified', async () => {
    // `requireIdTokenVerification`. Without `jwks_uri` the library would otherwise register
    // the provider with no signature check and take identity from userinfo — a downgrade
    // with no symptom at all. The provider is not registered, so no flow can begin.
    //
    // `internal`, not `not_found`. Both refuse, and only one of them is honest: a 404 says
    // "this deployment has no OIDC", which is what an operator who has configured OIDC
    // would read as "my variable did not take effect" and go looking in the wrong file.
    // The 500 carries a log line naming the discovery document.
    const bare = await startFakeIdp({ clientId: CLIENT_ID, email: FEDERATED, omitJwks: true });
    try {
      const instance = build(bare.issuer);

      const response = await instance.inject({
        method: 'POST',
        url: `${API_BASE_PATH}/auth/oidc/start`,
        headers: { origin: CONSOLE_ORIGIN },
        payload: { provider: 'oidc', org: 'acme' },
      });

      expect(response.statusCode).toBe(500);
      expect(response.json<{ error: { code: string } }>().error.code).toBe('internal');
      // Nothing about the identity provider reaches the caller: the envelope is the fixed
      // one, and the detail is in the log under this request's trace id.
      expect(response.body).not.toContain(bare.issuer);
      expect(issuedSession(response)).toBe(false);
    } finally {
      await bare.close();
    }
  });
});
