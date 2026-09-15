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
import { buildOpenApiDocument, type OpenApiDocument } from '@assaybank/contracts';
import { logger as defaultLogger, metrics, metricsHandler } from '@assaybank/observability';

import { registerErrorHandling } from './errors.js';
import { registerHealthRoutes, type DependencyProbe } from './health.js';
import { registerHttpMetrics } from './http-metrics.js';
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
    allowedHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key', 'Accept-Language'],
    // Without this the browser hides the header, and the candidate app cannot show the
    // request id on its error screen — which docs/12 §5.3 requires it to do.
    exposedHeaders: ['X-Request-Id', 'Retry-After'],
    maxAge: 600,
  });

  registerRateLimit(app);

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
  });

  return app;
}
