/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Better Auth, wired directly.
 *
 * There is no `IdentityProvider` interface here, no `SessionStore` abstraction and no
 * strategy to select. docs/17 forbids wrapping a library used exactly once, and the P1
 * plan names "auth over-abstracted" as one of the two ways this phase fails: *"One
 * identity provider, one session store, no plugin architecture, no strategy pattern.
 * There is no second implementation and there is no evidence there will be."* So this
 * file is a configuration object with its reasoning attached, and the routes in
 * `routes.ts` call `auth.api.*` by name.
 *
 * What follows is every non-default option and why it is set.
 *
 * ## Storage: three models in Postgres, one in Valkey
 *
 * `user` maps onto the existing `users` table, `account` onto `staff_accounts` and
 * `verification` onto `staff_verifications` (migration 0006). `session` is not a table at
 * all — it lives in Valkey through `secondaryStorage`, because a session table would have
 * to be read before the organisation is known in order to discover the organisation. See
 * `packages/db/src/schema/staff-identity.ts` for the full argument; the consequence here
 * is that resolving a cookie to a principal touches no tenant row, and the blob Valkey
 * holds already carries `orgId` on the cached user.
 *
 * Every Postgres statement the adapter issues goes through `tenantScopedDb()`, so it runs
 * inside whatever `withOrg` transaction the route opened. See `./tenant-db.ts`.
 *
 * ## Field names are not a style choice
 *
 * The Drizzle adapter resolves a model field to `table[fieldName]` — the *property* name
 * on the Drizzle object, not the SQL column. `staff_accounts` and `staff_verifications`
 * are therefore declared with Better Auth's own field names as their properties, and only
 * `users.full_name` needs an entry in `fields` because that name predates the library. A
 * missing entry is not a compile error; it is a `BetterAuthError` thrown during a login.
 *
 * ## Sign-up is off, everywhere, on purpose
 *
 * `disableSignUp` on the credential provider and on the OIDC provider. Staff accounts are
 * created by an administrator inside an organisation, because `users.org_id` is `NOT
 * NULL` and nothing in a sign-up form knows which tenant to write. docs/14 `H-124` puts
 * it as a security property rather than a modelling one: *"email claims map to an
 * existing `users` row rather than auto-provisioning, so an IdP that lets anyone sign up
 * cannot mint staff accounts."*
 *
 * ## What this file deliberately does not do
 *
 * It does not check CSRF. `auth.api.*` called in-process bypasses Better Auth's router
 * middleware, which is where its own Origin and Fetch Metadata checks live — so relying
 * on them would be relying on a control that is not running. The check is ours, in
 * `../csrf.ts`, applied to *every* state-changing staff route rather than only to the
 * authentication ones, which is what docs/14 `H-127` actually asks for.
 *
 * It does not rate limit. Better Auth has its own limiter; the API already has one keyed
 * and labelled per docs/03 §2, and two limiters on one route means two ceilings, two
 * counters and one of them wrong. See `../rate-limit.ts`.
 */

import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { genericOAuth } from 'better-auth/plugins/generic-oauth';

import type { HttpConfig, OidcConfig, SecretsConfig } from '@assaybank/config';
import { API_BASE_PATH } from '@assaybank/contracts';
import { schema } from '@assaybank/db';
import {
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  hashPassword,
  hashPasswordUnchecked,
  verifyPassword,
} from '@assaybank/auth';

import type { SessionStore } from './session-store.js';
import { tenantScopedDb } from './tenant-db.js';

/**
 * The path Better Auth believes it is mounted at.
 *
 * Nothing is actually served from it — the documented surface is `/auth/login`,
 * `/auth/logout`, `/auth/me` and the OIDC pair (docs/03 §1), and those are Fastify routes
 * in `routes.ts`. It still has to be set, because it is what the OIDC state cookie's
 * `Path` and the library's internal URL construction are derived from, and leaving it at
 * the default would put the state cookie on a path the callback never visits.
 */
export const AUTH_BASE_PATH = `${API_BASE_PATH}/auth`;

/** The `providerId` the OIDC provider is registered under. One IdP per deployment. */
export const OIDC_PROVIDER_ID = 'oidc';

/** Where the identity provider is told to send the browser back to (docs/03 §1). */
export const OIDC_CALLBACK_PATH = `${AUTH_BASE_PATH}/oidc/callback`;

/**
 * How long a staff session lasts, in seconds.
 *
 * Eight hours: one working day, so a recruiter is not re-authenticating at lunchtime and
 * a session left on an unlocked laptop does not survive until morning. docs/03 §1 fixes
 * no number, so this is a judgement rather than a requirement, and it is one line to
 * change because it is one line.
 */
export const SESSION_TTL_SECONDS = 8 * 60 * 60;

/**
 * How often an in-use session is extended.
 *
 * Hourly rather than on every request: the extension is a Valkey write, and doing it per
 * request would make an idle console tab the busiest writer in the system for no gain.
 */
export const SESSION_UPDATE_AGE_SECONDS = 60 * 60;

/** Exactly the configuration this module reads, narrowed from `@assaybank/config`. */
export interface StaffAuthConfig {
  readonly http: Pick<HttpConfig, 'publicUrl' | 'webPublicUrl' | 'corsAllowedOrigins'>;
  readonly secrets: Pick<SecretsConfig, 'sessionSecret'>;
  readonly oidc: OidcConfig;
}

/** What {@link createStaffAuth} needs that is not configuration. */
export interface StaffAuthOptions {
  readonly config: StaffAuthConfig;
  /**
   * Where sessions live. Valkey in every deployed tier; an in-memory map in the unit
   * suite, which is the one place a second implementation genuinely exists and is
   * therefore the one place an interface is justified (docs/17 §8).
   */
  readonly store: SessionStore;
  /**
   * Whether cookies carry `Secure` and the `__Secure-` prefix.
   *
   * Defaults to `true`, and should stay `true` in every environment that speaks https —
   * which, for a browser, includes `localhost`. It exists as an option only because a
   * test harness injecting cookies over `app.inject()` has no scheme at all.
   */
  readonly secureCookies?: boolean | undefined;
}

/** The instance `routes.ts` calls into. */
export type StaffAuth = ReturnType<typeof createStaffAuth>;

/**
 * Builds the Better Auth instance for staff identity.
 *
 * A function rather than a module-level constant because the configuration arrives as an
 * argument: `@assaybank/config` parses the environment at module load and rethrows on
 * first access, so a module-level `betterAuth({ secret: config.secrets.sessionSecret })`
 * would make every test in this workspace need a complete `.env` (see the note in
 * `server.ts`).
 */
export function createStaffAuth(options: StaffAuthOptions) {
  const { config, store } = options;
  const secureCookies = options.secureCookies ?? true;

  return betterAuth({
    appName: 'assaybank',
    baseURL: config.http.publicUrl,
    basePath: AUTH_BASE_PATH,
    // Better Auth falls back to reading BETTER_AUTH_SECRET from the environment when this
    // is absent. Passing it explicitly is not politeness: process.env is off-limits
    // outside packages/config (docs/17 §12), and a secret that can arrive by two routes is
    // a secret that is set in staging and unset in production.
    secret: config.secrets.sessionSecret,
    // Off. It phones home with anonymised configuration, and a self-hosted hiring platform
    // holding candidate data does not make outbound calls nobody asked for (docs/05).
    telemetry: { enabled: false },
    // The console is a different origin from the API, so it has to be listed for the
    // redirect targets Better Auth validates. Same list the CORS layer uses — one source
    // of truth for "which origins are ours" (docs/13 §4.2).
    trustedOrigins: [...config.http.corsAllowedOrigins],

    database: drizzleAdapter(tenantScopedDb(), {
      provider: 'pg',
      schema,
      // The schema object is keyed by Drizzle export name (`staffAccounts`), which is
      // what `modelName` below refers to. `usePlural` would make the adapter guess at
      // names instead, and guessing is what the explicit `modelName` entries remove.
      usePlural: false,
      // Postgres. The adapter's transaction paths are MySQL-only, and enabling this would
      // call `db.transaction()` on the forwarder — which has no such method, deliberately,
      // because the transaction is already open and is owned by `withOrg`.
      transaction: false,
    }),

    secondaryStorage: store,

    advanced: {
      // docs/14 `H-123`: HttpOnly, Secure, SameSite=Lax, host-prefixed. `useSecureCookies`
      // is what produces the `__Secure-` prefix as well as the attribute.
      useSecureCookies: secureCookies,
      cookiePrefix: 'assaybank',
      defaultCookieAttributes: {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
      },
      database: {
        // uuid, because every id in this schema is a uuid and `gen_random_uuid()` is what
        // the columns default to. Better Auth's own id format would produce a text
        // primary key that no foreign key in the model could reference.
        generateId: 'uuid',
        // The adapter compares the Drizzle metadata against its models at startup and
        // refuses to serve requests if they disagree — which is how `staff_accounts.org_id`
        // having no default would be caught at boot rather than on the first login.
        validateSchema: true,
      },
    },

    emailAndPassword: {
      enabled: true,
      // See the module comment: staff are provisioned inside an organisation.
      disableSignUp: true,
      // Nothing gates on `users.email_verified`; an administrator or an IdP created the
      // row, and that act is the verification. Turning this on without an email sender
      // configured would lock every existing account out.
      requireEmailVerification: false,
      minPasswordLength: 12,
      maxPasswordLength: 128,
      password: {
        // Argon2id, from packages/auth. Better Auth's default is scrypt — a respectable
        // choice, not a mistake — and this is a deliberate move to the algorithm OWASP
        // names first. The reasoning, the parameters and the bcrypt comparison are all in
        // `packages/auth/src/password.ts`; keeping them there rather than here means the
        // admin provisioning path and the login path cannot disagree about how a password
        // is stored.
        hash: hashForBetterAuth,
        // Better Auth passes an object; packages/auth takes the password first so that the
        // argument order matches `hashPassword`'s. One adaptor line beats two functions
        // with different conventions.
        verify: ({ hash, password }) => verifyPassword(password, hash),
      },
    },

    user: {
      modelName: 'users',
      // `name` is the only field whose Drizzle property differs from Better Auth's: the
      // column is `full_name` and predates the library. Everything else lines up because
      // migration 0006 chose the library's spelling for the new columns.
      fields: { name: 'fullName' },
      additionalFields: {
        // The tenant key, carried on the user object Better Auth returns and caches in the
        // session blob. `input: false` means a request body can never set it — the value
        // comes from the row, which is the only place it is allowed to come from.
        orgId: { type: 'string', required: true, input: false },
      },
    },

    account: { modelName: 'staffAccounts' },
    verification: { modelName: 'staffVerifications' },

    session: {
      expiresIn: SESSION_TTL_SECONDS,
      updateAge: SESSION_UPDATE_AGE_SECONDS,
      // Off. The cookie cache trades a Valkey read for a signed copy of the session in a
      // second cookie, and a revoked session would keep working until that copy expired.
      // docs/14 §10's incident response is "invalidate all sessions for the affected user;
      // force re-authentication", and a cache with its own lifetime makes that a promise
      // we cannot keep for up to five minutes.
      cookieCache: { enabled: false },
    },

    plugins: oidcPlugins(config),
  });
}

/**
 * The hasher Better Auth is given, and why it is not {@link hashPassword} directly.
 *
 * `password.hash` is reached from two places inside the library and only one of them is
 * about storing anything.
 *
 * **Setting a password** — sign-up, `update-user`, reset, admin set-password. Each of
 * those routes compares against `minPasswordLength`/`maxPasswordLength` (configured above
 * as 12 and 128, the same two numbers packages/auth enforces) and refuses before the
 * hasher is called, so anything that gets this far is inside the policy and
 * {@link hashPassword} runs.
 *
 * **The dummy hash on sign-in** — an address with no `users` row, or a row whose
 * `staff_accounts.password` is null because the account is federated. Better Auth hashes
 * whatever the caller sent and throws the result away, so that the not-found path costs
 * what the wrong-password path costs. That call carries an *unauthenticated* caller's raw
 * input, and `POST /auth/login` accepts a password of one character.
 *
 * Handing that to {@link hashPassword} was an account-enumeration oracle, which is the
 * reason this function exists. A four-character password threw a `RangeError`, the throw
 * left as the fixed `internal` envelope, and the shape of the answer then depended on the
 * address: `500` for an address with no credential account, `401` for one with. An
 * attacker with a list of addresses and a deliberately short password could read the
 * staff directory off the status code — defeating `verifyPasswordAgainstNothing`,
 * defeating the uniform envelope in `routes.ts`, and defeating docs/14 `H-118`, all
 * without ever guessing a password.
 *
 * So out-of-policy input is hashed rather than refused. The policy still exists and is
 * still enforced — at the two places a password is *chosen*, which is where a length rule
 * belongs, and never on the path where the answer must not depend on who is asking.
 */
function hashForBetterAuth(password: string): Promise<string> {
  if (password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
    return hashPasswordUnchecked(password);
  }
  return hashPassword(password);
}

/**
 * The OIDC provider, when one is configured.
 *
 * `config.oidc` is a discriminated union, so `enabled: false` is not three empty strings
 * to guard against — it is a branch the type checker enforces, and a deployment with no
 * IdP simply has no provider registered. The OIDC routes then answer `not_found`, which
 * is the honest answer to "start a flow with a provider that does not exist".
 *
 * `genericOAuth` rather than a named social provider: the IdP is whatever the customer
 * runs — Keycloak, Entra, Okta, Authentik — and it is described by
 * `OIDC_ISSUER`/`OIDC_CLIENT_ID`/`OIDC_CLIENT_SECRET` (docs/13 §4.11). Discovery off the
 * issuer is what makes those three variables sufficient.
 */
function oidcPlugins(config: StaffAuthConfig) {
  if (!config.oidc.enabled) return [];

  return [
    genericOAuth({
      config: [
        {
          providerId: OIDC_PROVIDER_ID,
          // The library appends `/.well-known/openid-configuration` and reads the
          // authorisation, token and userinfo endpoints plus the JWKS from the document.
          // Deriving them beats configuring them: an IdP that rotates a key or moves an
          // endpoint keeps working, and there is no way to configure a token endpoint
          // belonging to a different issuer than the one whose assertions are trusted.
          discoveryUrl: `${config.oidc.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`,
          clientId: config.oidc.clientId,
          clientSecret: config.oidc.clientSecret,
          scopes: ['openid', 'email', 'profile'],
          // PKCE on a confidential client is belt and braces, and it is the mechanism that
          // makes an intercepted `code` useless without the verifier this server holds
          // (docs/14 `H-124`).
          pkce: true,
          // Fixed rather than derived from the request, so a Host header cannot redirect
          // the flow somewhere else. It matches the route in `routes.ts` and is the value
          // registered with the IdP.
          redirectURI: `${config.http.publicUrl}${OIDC_CALLBACK_PATH}`,
          // No auto-provisioning: an assertion for an address with no `users` row is
          // refused rather than turned into a staff account (docs/14 `H-124`).
          disableSignUp: true,
          disableImplicitSignUp: true,
        },
      ],
    }),
  ];
}
