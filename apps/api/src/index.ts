/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The boot entrypoint of `@assaybank/api`.
 *
 * Four things happen here and nowhere else: configuration is resolved and the process
 * refuses to start without it, telemetry is installed before the modules it instruments
 * are loaded, the dependencies `/readyz` reports on are opened, and SIGTERM is turned
 * into an orderly drain.
 *
 * **Why `buildServer` is imported dynamically.** OpenTelemetry's auto-instrumentation
 * patches a module as it is loaded, so anything imported before `initTelemetry()` runs is
 * a module it never gets to patch — the whole HTTP and database call graph, if `server.ts`
 * were a static import at the top of this file. The two static imports are the two
 * packages that are deliberately free of I/O instrumentation: the environment parser and
 * the telemetry bootstrap itself.
 *
 * **Why configuration comes first even so.** `@assaybank/config` parses at module load
 * and rethrows on first property access, so the failure surfaces when the first field is
 * read. Reading it here, immediately, converts "a missing DATABASE_URL" from an
 * exception thrown three layers deep during the first request into a message on stderr
 * naming the variable, before a load balancer has been told this pod exists.
 */

import { config, ConfigError } from '@assaybank/config';
import {
  createLogger,
  initTelemetry,
  shutdownTelemetry,
  type Logger,
} from '@assaybank/observability';

import { DEFAULT_SERVICE_NAME } from './service.js';

/**
 * How long the process will wait for in-flight requests before giving up and exiting
 * non-zero. Shorter than any sane orchestrator's `terminationGracePeriodSeconds`, so the
 * decision to stop waiting is this process's and is logged, rather than arriving as an
 * unexplained SIGKILL.
 */
const SHUTDOWN_TIMEOUT_MS = 25_000;

/**
 * How long a deployed process keeps serving after SIGTERM while still reporting
 * not-ready.
 *
 * A load balancer learns about readiness by polling. Between SIGTERM and the next poll
 * it is still routing requests here, so closing the listener immediately drops exactly
 * those requests — during an exam window, that is candidates losing a submission to a
 * routine deploy. Two seconds covers a typical probe interval. Locally it is zero,
 * because there is no load balancer and a developer pressing Ctrl-C wants the prompt
 * back.
 */
const DRAIN_GRACE_MS = 2000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });
}

/**
 * Resolves configuration, or ends the process with a message a human can act on.
 *
 * `ConfigError` already names every failing variable, what was expected and what
 * arrived; printing it to stderr rather than through the logger is deliberate, because
 * the logger's level comes from the configuration that just failed to parse.
 */
function resolveConfig(): typeof config {
  try {
    // Touch one field to force the parse. Any field would do.
    void config.core.appEnv;
    return config;
  } catch (err: unknown) {
    const message =
      err instanceof ConfigError
        ? err.message
        : `The environment could not be read: ${err instanceof Error ? err.message : String(err)}`;
    process.stderr.write(`${message}\n`);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const cfg = resolveConfig();
  const serviceName = cfg.telemetry.serviceName || DEFAULT_SERVICE_NAME;

  const logger: Logger = createLogger({
    service: serviceName,
    env: cfg.core.appEnv,
    level: cfg.core.logLevel,
    pretty: cfg.core.appEnv === 'local',
  });

  // Before the database client, the queue client and the HTTP framework are loaded.
  await initTelemetry(serviceName);

  const [
    { buildServer },
    { createDb, withOrg },
    { OrgIdSchema },
    { Redis },
    { systemClock },
    credentialFlow,
    { createStaffAuth },
    { valkeySessionStore },
  ] = await Promise.all([
    import('./server.js'),
    import('@assaybank/db'),
    import('@assaybank/contracts'),
    import('ioredis'),
    import('@assaybank/auth'),
    import('./credentials/index.js'),
    import('./auth/better-auth.js'),
    import('./auth/session-store.js'),
  ]);

  /**
   * The organisation the readiness probe runs as.
   *
   * The probe deliberately goes through `withOrg` rather than through the elevated
   * background-job role: it exercises the exact path a real request takes — a checkout
   * from the application pool, a transaction, `set_config('app.current_org', …)` — so a
   * database that is reachable but refusing that setting is reported as down rather than
   * as healthy. The nil organisation owns no rows by construction, so even a table with
   * a missing policy could not leak one to a health check, and no elevation audit record
   * is written every few seconds for something that reads nothing.
   */
  const probeOrgId = OrgIdSchema.parse('00000000-0000-0000-0000-000000000000');

  const db = createDb(cfg.database, {
    applicationName: serviceName,
    onElevation: (record) => {
      // ADR-010: the job role bypasses row-level security, and what it owes in exchange
      // is a record of every time it was used. There are two records and they answer
      // different questions — the audit_log row written inside the transaction says what
      // *committed*, and this line, which fires whether or not the block goes on to
      // succeed, says what was *attempted*. A job that elevates and then fails every
      // time is invisible in the first and obvious in the second.
      logger.info(
        { event: 'db.elevated', reason: record.reason, at: record.at.toISOString() },
        'elevated database role used',
      );
    },
  });

  const valkey = new Redis(cfg.valkey.url, {
    lazyConnect: true,
    // A readiness probe must fail fast and say so, not queue behind a reconnect loop and
    // make the orchestrator's own timeout the thing that decides.
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
  });

  // ioredis emits `error` on every failed connection attempt, and an EventEmitter with no
  // `error` listener throws — so the alternative to this handler is not "quieter logs",
  // it is the API process dying because Valkey restarted. The event is informational:
  // /readyz is what decides whether this pod should be sent traffic.
  valkey.on('error', (err: unknown) => {
    logger.warn({ event: 'valkey.connection_error', err }, 'valkey connection error');
  });

  /**
   * The candidate credential flow (P1 step 6), assembled here because this is the only
   * place allowed to read the environment.
   *
   * `systemClock` is passed in rather than reached for: every expiry downstream — the
   * attempt token's life, the ticket's sixty seconds, the invitation's window — is
   * measured against this one object, which is what makes each of them a deterministic
   * assertion in a test rather than a sleep (ADR-006, docs/17 §8).
   */
  const credentialKeys = credentialFlow.deriveCredentialKeys(cfg.secrets);

  const candidateCredentials = {
    keys: credentialKeys,
    clock: systemClock,
    redemption: credentialFlow.createRedemptionService({
      gateway: credentialFlow.createPostgresRedemptionGateway({ db, clock: systemClock }),
      keys: credentialKeys,
      clock: systemClock,
    }),
    tickets: credentialFlow.createWsTicketService({
      signingKey: credentialKeys.wsTicket,
      pepper: credentialKeys.pepper,
      clock: systemClock,
      // Valkey rather than this process's memory: single use has to hold across every
      // replica, and a check-and-set only one instance can see stops being single use
      // the moment there are two (docs/14 T-013, H-148).
      store: credentialFlow.valkeySingleUseStore(valkey),
    }),
    sessions: credentialFlow.createPostgresSessionGateway(db),
  };

  /**
   * Staff identity (P1 step 3), assembled here for the same reason as the credential
   * flow: this is the only place allowed to read the environment, and Better Auth needs
   * `SESSION_SECRET`, the public URLs and the OIDC triple.
   *
   * Sessions go to Valkey rather than to Postgres — the reasoning is in
   * `packages/db/src/schema/staff-identity.ts`, and the short version is that a session
   * table would have to be read before the organisation is known in order to discover the
   * organisation. It is the same Valkey client the queues and the ticket store use, with
   * its own key prefix.
   */
  const staffAuth = createStaffAuth({
    config: cfg,
    store: valkeySessionStore(valkey),
    // Every deployed tier speaks https, and so does a browser talking to `localhost`.
    // The flag exists for the test harness, which has no scheme at all.
    secureCookies: true,
  });

  const app = buildServer({
    config: cfg,
    logger,
    credentials: candidateCredentials,
    staffIdentity: {
      auth: staffAuth,
      db,
      sessionSecret: cfg.secrets.sessionSecret,
      apiUrl: cfg.http.publicUrl,
      consoleUrl: cfg.http.webPublicUrl,
      secureCookies: true,
      oidcEnabled: cfg.oidc.enabled,
      now: () => systemClock.now(),
    },
    // What makes `request.audited(...)` exist on this instance: one transaction per
    // audited action, carrying both the work and its audit_log row (P1 step 5).
    db,
    dependencies: [
      {
        name: 'postgres',
        probe: async (): Promise<void> => {
          await withOrg(db, probeOrgId, async (tx) => {
            await tx.execute('select 1');
          });
        },
      },
      {
        name: 'valkey',
        probe: async (): Promise<void> => {
          await valkey.ping();
        },
      },
    ],
  });

  let stopping = false;

  async function shutdown(signal: string): Promise<void> {
    if (stopping) return;
    stopping = true;

    logger.info({ event: 'api.shutdown_started', signal }, 'shutting down');

    // Nothing is closed yet. /readyz starts answering 503 so the load balancer stops
    // sending new work, while /healthz keeps answering 200 so the orchestrator does not
    // kill the process in the middle of the drain.
    app.assaybank.draining = true;

    const hardStop = setTimeout(() => {
      logger.fatal(
        { event: 'api.shutdown_timeout', timeout_ms: SHUTDOWN_TIMEOUT_MS },
        'shutdown did not complete in time; exiting',
      );
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    hardStop.unref();

    try {
      if (cfg.core.isDeployedTier) await delay(DRAIN_GRACE_MS);

      // Stops accepting connections and waits for in-flight requests to finish.
      await app.close();
      await db.close();
      valkey.disconnect();
      // Last, so the spans describing the shutdown itself are exported rather than lost
      // — which is exactly the window in which an incident's evidence disappears.
      await shutdownTelemetry();

      clearTimeout(hardStop);
      logger.info({ event: 'api.shutdown_complete', signal }, 'shutdown complete');
      process.exit(0);
    } catch (err: unknown) {
      logger.error({ event: 'api.shutdown_failed', err }, 'shutdown failed');
      process.exit(1);
    }
  }

  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });

  // A process that keeps running after an unhandled rejection is a process in a state
  // nobody reasoned about. Log it with the full cause, then let the orchestrator replace
  // it — a restarted pod is recoverable, a silently wrong one is not.
  process.on('unhandledRejection', (reason: unknown) => {
    logger.fatal({ event: 'api.unhandled_rejection', err: reason }, 'unhandled rejection');
    void shutdown('unhandledRejection');
  });
  process.on('uncaughtException', (err: Error) => {
    logger.fatal({ event: 'api.uncaught_exception', err }, 'uncaught exception');
    void shutdown('uncaughtException');
  });

  await app.listen({ port: cfg.http.port, host: '0.0.0.0' });

  logger.info(
    {
      event: 'api.started',
      port: cfg.http.port,
      app_env: cfg.core.appEnv,
      otel_service_name: serviceName,
    },
    'api listening',
  );
}

await main();
