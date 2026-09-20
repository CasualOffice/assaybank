/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The composition root of the HTTP surface.
 *
 * {@link buildServer} assembles a fully configured Fastify instance and returns it
 * without listening. That split is what makes the server testable: every assertion in
 * `server.test.ts` runs through `app.inject()`, with no socket, no port and no network,
 * and the same object is what `index.ts` calls `.listen()` on in production. A builder
 * that also listened would force every test to bind a port and would make the error
 * envelope — the thing most worth testing — the hardest thing to reach.
 *
 * Configuration arrives as an argument rather than being imported. `@assaybank/config`
 * parses the environment at module load and rethrows on first access, so a `buildServer`
 * that read it directly could not be exercised without a complete `.env`; boot owns that
 * failure, and owning it in one place is what lets it be reported clearly (see index.ts).
 *
 * Route order below is deliberate. The request context is installed first so that a
 * request refused by the rate limiter — before any handler runs — still carries the
 * `X-Request-Id` a support ticket will quote.
 */

import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import sensible from '@fastify/sensible';
import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyServerOptions,
} from 'fastify';

import type { CoreConfig, HttpConfig, TelemetryConfig } from '@assaybank/config';
import { buildOpenApiDocument, CSRF_HEADER, type OpenApiDocument } from '@assaybank/contracts';
import type { Database } from '@assaybank/db';
import { logger as defaultLogger, metrics, metricsHandler } from '@assaybank/observability';

import { registerAudit } from './audit.js';
import { registerAuthorisation } from './authorisation.js';
import { registerStaffAuthRoutes, type StaffIdentityServices } from './auth/routes.js';
import { registerStaffAuthentication } from './auth/staff-session.js';
import { registerCsrfProtection } from './csrf.js';
import {
  registerCandidateAuthentication,
  registerCredentialRoutes,
  type CandidateCredentialServices,
} from './credentials/routes.js';
import { registerErrorHandling } from './errors.js';
import { registerHealthRoutes, type DependencyProbe } from './health.js';
import { registerHttpMetrics } from './http-metrics.js';
import { registerOrgRoutes } from './org/routes.js';
import { registerQuestionRoutes } from './questions/routes.js';
import { registerAssessmentRoutes } from './assessments/routes.js';
import { registerTaxonomyRoutes } from './taxonomy/routes.js';
import { registerBankJobRoutes } from './bank-jobs/routes.js';
import { registerRateLimit } from './rate-limit.js';
import { newTraceId, registerRequestContext, requestIdFor } from './request-context.js';
import { DEFAULT_SERVICE_NAME } from './service.js';
import { attachState, type ServerState } from './state.js';

export { WORKSPACE_NAME, DEFAULT_SERVICE_NAME } from './service.js';

/**
 * Exactly the configuration this server reads, narrowed from `@assaybank/config`'s types
 * rather than redeclared.
 *
 * `buildServer({ config })` therefore accepts the real frozen `AppConfig` unchanged,
 * while a variable renamed in the config schema becomes a type error here instead of a
 * runtime surprise — and this module cannot so much as name `secrets` or `database`,
 * which is the cheapest possible way of guaranteeing it never logs one.
 */
export interface ApiServerConfig {
  readonly core: Pick<CoreConfig, 'appEnv' | 'isDeployedTier'>;
  readonly http: Pick<HttpConfig, 'corsAllowedOrigins'>;
  readonly telemetry: Pick<TelemetryConfig, 'serviceName'>;
}

/** Options for {@link buildServer}. */
export interface BuildServerOptions {
  readonly config: ApiServerConfig;
  /**
   * The service logger. `false` silences the instance, which is what the unit suite
   * wants. Defaults to the shared `@assaybank/observability` logger; boot passes one
   * configured from `LOG_LEVEL` and `APP_ENV`.
   *
   * Typed as Fastify's own logger interface rather than as pino's: a pino `Logger`
   * satisfies it, and naming the narrower interface keeps the instance's type the plain
   * `FastifyInstance` that every helper in this workspace takes.
   */
  readonly logger?: FastifyBaseLogger | false | undefined;
  /** What `/readyz` is willing to be held responsible for. Boot supplies Postgres and Valkey. */
  readonly dependencies?: readonly DependencyProbe[] | undefined;
  /** Per-dependency readiness budget. See `DEFAULT_PROBE_TIMEOUT_MS`. */
  readonly probeTimeoutMs?: number | undefined;
  /**
   * The clock. docs/17 §8 makes time a parameter wherever it is observable, and ADR-006
   * makes it a correctness boundary rather than a detail.
   */
  readonly now?: (() => Date) | undefined;
  /** Source of the per-request trace id. See `newTraceId`. */
  readonly traceId?: (() => string) | undefined;
  /**
   * The candidate credential flow: invitation redemption and WebSocket tickets (P1
   * step 6).
   *
   * Optional, and absent in the unit suite that exercises the skeleton, because
   * everything in it needs a database and a signing key. When it is absent the two
   * routes are simply not registered — they are not registered in a disabled state,
   * which would be a route answering something other than 404 for reasons no client
   * could work out.
   */
  readonly credentials?: CandidateCredentialServices | undefined;
  /**
   * The database handle, which is what makes `request.audited(...)` available.
   *
   * Optional because the unit suite builds servers that serve `/healthz` and an error
   * envelope and touch no table, and a builder that demanded a connection pool to do
   * that would make the cheapest tests the hardest ones to write. Boot always passes it;
   * a route that calls `request.audited` on an instance built without it fails loudly at
   * the first request rather than quietly skipping the audit row, because the decorator
   * simply is not there.
   */
  readonly db?: Database | undefined;
  /**
   * Staff identity: sessions, password login, OIDC (P1 step 3).
   *
   * Optional for the same reason `credentials` is — everything in it needs a database, a
   * session store and a secret, and the unit suite that exercises the error envelope
   * should not need all three. When it is absent the five `/auth/*` routes are simply not
   * registered, and the cookie-to-principal hook is not installed either: a server built
   * without it cannot authenticate a staff member at all, rather than authenticating them
   * badly.
   */
  readonly staffIdentity?: StaffIdentityServices | undefined;
}

/**
 * The OpenAPI document, generated once per process.
 *
 * `buildOpenApiDocument` is deterministic and free of I/O, so caching it changes nothing
 * a client can observe and keeps a scraper from re-running the generator on every hit.
 */
let openApiDocument: OpenApiDocument | undefined;

function openApi(): OpenApiDocument {
  openApiDocument ??= buildOpenApiDocument();
  return openApiDocument;
}

/**
 * The maximum request body this API will read, in bytes.
 *
 * Bounded by construction: an unbounded body is an unbounded allocation, and docs/17 §10
 * requires every endpoint to have a cost ceiling. Candidate code, the largest legitimate
 * body in the system, is measured in kilobytes.
 */
const BODY_LIMIT_BYTES = 1_048_576;

/**
 * Operational routes log at `warn`.
 *
 * `/healthz` and `/readyz` are probed every few seconds by the orchestrator and
 * `/metrics` is scraped on a fixed interval; at `info` they would be the overwhelming
 * majority of log lines, and a log nobody reads is a log nobody reads during an incident
 * either.
 */
const OPERATIONAL_LOG_LEVEL = 'warn';

/** Builds the server. Does not listen — see the module comment. */
export function buildServer(options: BuildServerOptions): FastifyInstance {
  const { config } = options;
  const now = options.now ?? ((): Date => new Date());
  const mintTraceId = options.traceId ?? newTraceId;
  const service = config.telemetry.serviceName || DEFAULT_SERVICE_NAME;

  const serverOptions: FastifyServerOptions = {
    bodyLimit: BODY_LIMIT_BYTES,
    // The request id is minted here so that Fastify's own `reqId` log field, the
    // X-Request-Id header and `error.request_id` are one value and not three.
    genReqId: (): string => requestIdFor(mintTraceId()),
    // docs/12 §5.2: the API is the trace root for candidate traffic. A client that could
    // choose its own request id could collide two candidates onto one trace or poison a
    // support lookup, so the inbound header is not read at all.
    //
    // Fastify labels the id `reqId` on its own access lines. docs/12 §7.1's canonical
    // field is `trace_id`, and the observability logger's mixin puts it on every line
    // including these, so the two agree without reaching for a deprecated option.
    requestIdHeader: false,
    // `req.ip` feeds the per-address token-redemption limit, so it has to be the client
    // and not the reverse proxy. Trusting X-Forwarded-For is only safe behind a proxy
    // that overwrites it — infra/caddy does — which is why it is off everywhere else:
    // a directly reachable server that trusted the header would let any client choose
    // its own rate-limit bucket.
    trustProxy: config.core.isDeployedTier,
    // Fastify answers 503 to a request that arrives after close() has begun, rather than
    // accepting work it has already decided not to finish.
    return503OnClosing: true,
  };

  if (options.logger === false) {
    serverOptions.logger = false;
  } else {
    serverOptions.loggerInstance = options.logger ?? defaultLogger;
  }

  const app = Fastify(serverOptions);

  const state: ServerState = attachState(app, service, now());

  // --- cross-cutting, in the order a request meets them ------------------------
  //
  // These are plain functions rather than `app.register` plugins on purpose: a Fastify
  // plugin is an encapsulation context, so a decorator declared inside one is invisible
  // to routes outside it. `fastify-plugin` exists to break that encapsulation and is not
  // on the approved dependency list (ADR-001); a function that takes the instance needs
  // nothing installed and has no such subtlety.
  registerRequestContext(app, { traceId: mintTraceId });
  registerHttpMetrics(app);
  registerErrorHandling(app);

  void app.register(sensible);

  void app.register(helmet, {
    global: true,
    // A JSON API renders nothing, so the policy that fits it is "nothing is allowed".
    // It matters for the case where a browser is pointed at a response directly, and it
    // costs nothing here because no page is ever served from this origin.
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        'default-src': ["'none'"],
        'frame-ancestors': ["'none'"],
        'base-uri': ["'none'"],
        'form-action': ["'none'"],
      },
    },
    // HSTS pins a browser to https for a year. Correct in a deployed tier, actively
    // harmful on a developer's machine, where it would pin `localhost` itself.
    hsts: config.core.isDeployedTier ? { maxAge: 31_536_000, includeSubDomains: true } : false,
  });

  void app.register(cors, {
    // Exact origins, never a wildcard: the candidate app holds attempt tokens, and
    // `credentials: true` with a reflected wildcard is how a staff session becomes
    // readable from any site the browser visits (docs/13 §4.2).
    origin: [...config.http.corsAllowedOrigins],
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Authorization',
      'Content-Type',
      'Idempotency-Key',
      'Accept-Language',
      // The double-submit CSRF token (`H-153`). A header the browser blocks is a
      // header the console cannot send, and every staff mutation would be refused.
      CSRF_HEADER,
    ],
    // Without this the browser hides the header, and the candidate app cannot show the
    // request id on its error screen — which docs/12 §5.3 requires it to do.
    exposedHeaders: ['X-Request-Id', 'Retry-After'],
    maxAge: 600,
  });

  registerRateLimit(app);

  // docs/14 T-017 / `H-153`. Before the routes and before body parsing: a forged
  // state-changing request should not reach a handler, a rate-limit bucket or an
  // allocator. It covers every route on the instance, not only the authentication ones —
  // `POST /user-roles` and `PATCH /attempts/{id}` are the examples the threat model gives.
  //
  // The double-submit half is configured only when this instance issues staff sessions,
  // because the session cookie is the only ambient credential there is to forge with. See
  // `CsrfOptions.token`.
  const staffIdentity = options.staffIdentity;
  registerCsrfProtection(app, {
    allowedOrigins: config.http.corsAllowedOrigins,
    token:
      staffIdentity === undefined
        ? undefined
        : { secret: staffIdentity.sessionSecret, secure: staffIdentity.secureCookies },
  });

  // The bearer-token hook goes in before authorisation, so `request.principal` is
  // established by the time a route's declaration is enforced. It refuses nothing on its
  // own — see credentials/routes.ts.
  const credentials = options.credentials;
  if (credentials !== undefined) {
    registerCandidateAuthentication(app, { keys: credentials.keys, clock: credentials.clock });
  }

  // The session-cookie hook. After the bearer-token hook, so a request carrying both
  // credentials is seen as such, and before `registerAuthorisation`, so that
  // `request.principal` exists by the time a route's declaration is enforced — Fastify
  // runs same-phase hooks in registration order, which is what makes "before" mean
  // something here. Like the bearer hook, it refuses nothing on its own.
  if (staffIdentity !== undefined) {
    registerStaffAuthentication(app, { auth: staffIdentity.auth, db: staffIdentity.db });
  }

  // Last of the cross-cutting registrations, and before any route is added — the route
  // table is built by an `onRoute` hook, which Fastify runs synchronously as each route
  // is declared, so a route registered before this call would be absent from the table
  // and, worse, unchecked. Every route added from here on either names the permission it
  // requires or appears in the public allow-list; anything else is refused at runtime and
  // fails the enumeration test (docs/14 §"Defaults").
  registerAuthorisation(app);

  // The audit seam. After `registerAuthorisation`, which is what declares the `principal`
  // decorator that `request.audited` reads, and before any route is added, so that every
  // route can reach it. A request with no principal gets the same `unauthenticated`
  // envelope as everything else — the audit trail has no anonymous writer.
  if (options.db !== undefined) {
    registerAudit(app, { db: options.db, now });
  }

  // --- operational routes ------------------------------------------------------
  //
  // **Inside `after`, and that is load-bearing.** `@fastify/rate-limit` applies itself
  // through an `onRoute` hook, and Fastify runs `onRoute` hooks synchronously, at the
  // moment `.get()` is called, against the hooks that exist *then*. `app.register()` is
  // deferred, so a route added synchronously here would be added before the limiter's
  // hook existed and would silently have no rate limit at all — not an error, not a
  // warning, just an endpoint outside the limits table. `after` runs once everything
  // registered above has loaded, which puts the limiter's hook in place first.
  //
  // The same rule governs every route added later: register them as a plugin
  // (`app.register(questionRoutes)`), which is deferred and therefore ordered, rather
  // than calling `app.get()` on the returned instance.
  app.after(() => {
    registerHealthRoutes(app, {
      state,
      ...(options.dependencies === undefined ? {} : { dependencies: options.dependencies }),
      ...(options.probeTimeoutMs === undefined ? {} : { probeTimeoutMs: options.probeTimeoutMs }),
      now,
    });

    const serveMetrics = metricsHandler(metrics);
    app.get('/metrics', { logLevel: OPERATIONAL_LOG_LEVEL }, (request, reply) => {
      // The exposition is written straight to the raw response by the observability
      // package, which owns the content type and the "fail visibly rather than serve a
      // truncated exposition" rule. Hijacking tells Fastify the reply is somebody else's.
      reply.hijack();
      serveMetrics(request.raw, reply.raw);
    });

    app.get('/openapi.json', { logLevel: OPERATIONAL_LOG_LEVEL }, (_request, reply) => {
      void reply.type('application/json; charset=utf-8');
      return openApi();
    });

    if (credentials !== undefined) {
      registerCredentialRoutes(app, credentials);
    }

    if (staffIdentity !== undefined) {
      registerStaffAuthRoutes(app, staffIdentity);
    }

    // The staff business surface. Registered on the same condition as the audit seam
    // above, and for the same reason: `PATCH /org/settings` is one `request.audited`
    // call, so a server built without a database would register a route whose only
    // possible answer is a 500. Boot always supplies one (index.ts).
    if (options.db !== undefined) {
      registerOrgRoutes(app, { db: options.db, now });
      // The question bank (P2, docs/03 §4). Registered on the same condition and in the
      // same place as the settings routes: every one of its ten handlers is either a
      // `withOrg` read or a `request.audited` write, so a server built without a database
      // would register ten routes whose only possible answer is a 500.
      registerQuestionRoutes(app, { db: options.db, now });
      registerTaxonomyRoutes(app, { db: options.db, now });
      // Composition reads roles and the bank and writes assessments, so it lands with the
      // taxonomy routes rather than with the bank ones: a role is what it composes from.
      registerAssessmentRoutes(app, { db: options.db });
      registerBankJobRoutes(app, { db: options.db, now });
    }
  });

  return app;
}
