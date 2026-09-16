/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The API skeleton's integration suite.
 *
 * Everything runs through `app.inject()`: no socket, no port, no Docker. The assertions
 * that matter are the ones about what does *not* come back — no stack, no internal
 * message, no dependency error text — because those are the properties a later change
 * is most likely to break without anybody noticing.
 */

import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { PERMISSIONS, type StaffPrincipal } from '@assaybank/auth';
import { ApiError, ERROR_CODE_MESSAGES, OrgIdSchema, UserIdSchema } from '@assaybank/contracts';
import { createLogger } from '@assaybank/observability';

import { requirePermission } from './authorisation.js';
import type { DependencyProbe } from './health.js';
import { setPrincipal } from './principal.js';
import { RATE_LIMITS } from './rate-limit.js';
import { REQUEST_ID_HEADER, REQUEST_ID_PATTERN } from './request-context.js';
import { buildServer, type BuildServerOptions } from './server.js';
import { captureLog, testConfig } from './test-support.js';

let server: FastifyInstance | undefined;

afterEach(async () => {
  if (server !== undefined) {
    await server.close();
    server = undefined;
  }
});

/**
 * Every route declares the permission it requires, including the synthetic ones below —
 * route-authorisation.test.ts enumerates the table and fails on any that does not, and a
 * route that skipped the declaration would be refused rather than served.
 *
 * `ANY_ACTION` and the principal that holds the whole catalogue are therefore scaffolding
 * for *these* tests, which are about the error envelope, the request id and the limiter:
 * an authorisation refusal would answer every one of them with a 403 and prove nothing.
 * What the check itself does is authorisation.test.ts's subject.
 */
const ANY_ACTION = requirePermission('org.admin');

const TEST_PRINCIPAL: StaffPrincipal = {
  kind: 'staff',
  userId: UserIdSchema.parse('2bb0f1a6-0a8b-4d5e-9c53-9a8f6d2e4b17'),
  orgId: OrgIdSchema.parse('6f1f8c26-0e3a-4a7f-9c1e-5f0a1a8b2c31'),
  permissions: new Set(PERMISSIONS),
};

function build(options: Partial<BuildServerOptions> = {}): FastifyInstance {
  const app = buildServer({ config: testConfig(), logger: false, ...options });
  // Stands in for the authentication plugin: something earlier in the lifecycle than the
  // authorisation check deposits a principal it has already verified.
  app.addHook('onRequest', (request, _reply, done) => {
    setPrincipal(request, TEST_PRINCIPAL);
    done();
  });
  server = app;
  return app;
}

/** A probe that always answers, and remembers whether it was asked. */
function healthyProbe(name: string): DependencyProbe & { calls: number } {
  return {
    name,
    calls: 0,
    probe(): Promise<void> {
      this.calls += 1;
      return Promise.resolve();
    },
  };
}

function failingProbe(name: string, message: string): DependencyProbe {
  return {
    name,
    probe(): Promise<void> {
      return Promise.reject(new Error(message));
    },
  };
}

describe('GET /healthz', () => {
  it('answers 200 with the liveness payload', async () => {
    const app = build();

    const response = await app.inject({ method: 'GET', url: '/healthz' });

    expect(response.statusCode).toBe(200);
    const body = response.json<{ status: string; service: string; uptime_seconds: number }>();
    expect(body.status).toBe('ok');
    expect(body.service).toBe('hiring-api-test');
    expect(body.uptime_seconds).toBeGreaterThanOrEqual(0);
  });

  it('consults no dependency — liveness is not readiness', async () => {
    // The distinction is the point of the two routes: a liveness probe that checked the
    // database would restart every API pod at once during a database blip.
    const postgres = healthyProbe('postgres');
    const app = build({ dependencies: [postgres] });

    await app.inject({ method: 'GET', url: '/healthz' });

    expect(postgres.calls).toBe(0);
  });

  it('stays 200 while the process is draining', async () => {
    const app = build();
    await app.ready();
    app.assaybank.draining = true;

    const response = await app.inject({ method: 'GET', url: '/healthz' });

    // A draining pod is alive. Killing it mid-drain is how in-flight work is lost.
    expect(response.statusCode).toBe(200);
  });
});

describe('GET /readyz', () => {
  it('answers 200 and reports every dependency when all are reachable', async () => {
    const app = build({ dependencies: [healthyProbe('postgres'), healthyProbe('valkey')] });

    const response = await app.inject({ method: 'GET', url: '/readyz' });

    expect(response.statusCode).toBe(200);
    const body = response.json<{
      status: string;
      draining: boolean;
      server_time: string;
      checks: { name: string; status: string; latency_ms: number }[];
    }>();
    expect(body.status).toBe('ready');
    expect(body.draining).toBe(false);
    expect(Date.parse(body.server_time)).not.toBeNaN();
    expect(body.checks.map((check) => check.name)).toEqual(['postgres', 'valkey']);
    expect(body.checks.every((check) => check.status === 'ok')).toBe(true);
    expect(body.checks.every((check) => typeof check.latency_ms === 'number')).toBe(true);
  });

  it('answers 503 with per-dependency detail when one dependency is down', async () => {
    const app = build({
      dependencies: [
        healthyProbe('postgres'),
        failingProbe('valkey', 'connect ECONNREFUSED 10.0.0.4:6379'),
      ],
    });

    const response = await app.inject({ method: 'GET', url: '/readyz' });

    expect(response.statusCode).toBe(503);
    const body = response.json<{ status: string; checks: { name: string; status: string }[] }>();
    expect(body.status).toBe('not_ready');
    expect(body.checks).toEqual([
      expect.objectContaining({ name: 'postgres', status: 'ok' }),
      expect.objectContaining({ name: 'valkey', status: 'down' }),
    ]);
  });

  it('never serves the reason a dependency is down', async () => {
    const app = build({
      dependencies: [failingProbe('postgres', 'password authentication failed for user "hiring"')],
    });

    const response = await app.inject({ method: 'GET', url: '/readyz' });

    // A connection error carries the DSN, the host and sometimes the role name, and
    // /readyz is reachable by anything that can reach the pod.
    expect(response.payload).not.toContain('password');
    expect(response.payload).not.toContain('hiring"');
  });

  it('counts a dependency that never answers as down rather than hanging', async () => {
    const app = build({
      probeTimeoutMs: 10,
      dependencies: [{ name: 'postgres', probe: () => new Promise<void>(() => undefined) }],
    });

    const response = await app.inject({ method: 'GET', url: '/readyz' });

    expect(response.statusCode).toBe(503);
    expect(response.json<{ checks: { status: string }[] }>().checks[0]?.status).toBe('down');
  });

  it('answers 503 while draining even with every dependency healthy', async () => {
    const app = build({ dependencies: [healthyProbe('postgres')] });
    await app.ready();
    app.assaybank.draining = true;

    const response = await app.inject({ method: 'GET', url: '/readyz' });

    expect(response.statusCode).toBe(503);
    expect(response.json<{ draining: boolean }>().draining).toBe(true);
  });
});

describe('the error envelope', () => {
  const SECRET = 'relation "attempt_answers" does not exist at 10.0.0.7:5432';

  function withBoom(options: Partial<BuildServerOptions> = {}): FastifyInstance {
    const app = build(options);
    app.get('/__boom', { config: ANY_ACTION }, () => {
      throw new Error(SECRET);
    });
    return app;
  }

  it('turns an unhandled throw into the standard envelope and leaks nothing', async () => {
    const app = withBoom();

    const response = await app.inject({ method: 'GET', url: '/__boom' });

    expect(response.statusCode).toBe(500);

    const body = response.json<{
      error: { code: string; message: string; request_id: string; details?: unknown };
    }>();

    // The exact envelope of docs/03 §2: code, message, request_id, and nothing else.
    expect(Object.keys(body)).toEqual(['error']);
    expect(Object.keys(body.error).sort()).toEqual(['code', 'message', 'request_id']);
    expect(body.error.code).toBe('internal');
    expect(body.error.message).toBe(ERROR_CODE_MESSAGES.internal);
    expect(body.error.request_id).toMatch(REQUEST_ID_PATTERN);

    // Nothing internal reaches the client: docs/14 records error-message leakage as a
    // real path to hidden test-case content.
    const payload = response.payload;
    expect(payload).not.toContain(SECRET);
    expect(payload).not.toContain('attempt_answers');
    expect(payload).not.toContain('5432');
    expect(payload).not.toContain('Error');
    expect(payload).not.toContain('stack');
    expect(payload).not.toMatch(/\bat \S+:\d+:\d+/u);
  });

  it('logs the failure server-side under the same trace id it served', async () => {
    const log = captureLog();
    const app = withBoom({
      logger: createLogger({ service: 'test', level: 'trace', destination: log.destination }),
    });

    const response = await app.inject({ method: 'GET', url: '/__boom' });
    const requestId = response.json<{ error: { request_id: string } }>().error.request_id;

    const failure = log.records().find((record) => record['event'] === 'http.request_failed');

    expect(failure).toBeDefined();
    // The log line and the response are joined by the trace id, which is the whole
    // point of docs/12 §5.3: a support ticket quoting `req_…` resolves to this line.
    expect(failure?.['trace_id']).toBe(requestId.slice('req_'.length));
    expect(failure?.['error_code']).toBe('internal');
    expect(failure?.['status']).toBe(500);

    const err = failure?.['err'] as { type: string; stack_frames: string[] };
    expect(err.type).toBe('Error');
    expect(err.stack_frames[0]).toContain('server.test.ts');

    // The message is withheld even from the log: `@assaybank/observability` serialises an
    // error to an allow-listed field set, because a Postgres error message quotes the
    // failing statement's parameters — which for an answer upsert is the candidate's
    // answer (docs/12 §7.2). The stack frames are what locate the throw.
    expect(JSON.stringify(failure)).not.toContain(SECRET);
  });

  it('serves an authored ApiError exactly as authored', async () => {
    const app = build();
    app.get('/__expired', { config: ANY_ACTION }, () => {
      throw ApiError.attemptExpired(undefined, {
        details: { deadline_at: '2026-09-14T10:30:00Z' },
      });
    });

    const response = await app.inject({ method: 'GET', url: '/__expired' });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: {
        code: 'attempt_expired',
        message: ERROR_CODE_MESSAGES.attempt_expired,
        details: { deadline_at: '2026-09-14T10:30:00Z' },
        request_id: expect.stringMatching(REQUEST_ID_PATTERN) as unknown,
      },
    });
  });

  it('answers an unknown route with the not_found envelope', async () => {
    const app = build();

    const response = await app.inject({ method: 'GET', url: '/does-not-exist' });

    expect(response.statusCode).toBe(404);
    const body = response.json<{ error: { code: string; request_id: string } }>();
    expect(body.error.code).toBe('not_found');
    expect(body.error.request_id).toMatch(REQUEST_ID_PATTERN);
    expect(response.headers[REQUEST_ID_HEADER]).toBe(body.error.request_id);
  });

  it('answers a schema failure with validation_failed and names the field', async () => {
    const app = build();
    app.post(
      '/__validated',
      {
        config: ANY_ACTION,
        schema: {
          body: {
            type: 'object',
            required: ['email'],
            properties: { email: { type: 'string' } },
          },
        },
      },
      () => ({ ok: true }),
    );

    const response = await app.inject({ method: 'POST', url: '/__validated', payload: {} });

    expect(response.statusCode).toBe(422);
    const body = response.json<{
      error: { code: string; details?: { fields: { field: string; rule: string }[] } };
    }>();
    expect(body.error.code).toBe('validation_failed');
    expect(body.error.details?.fields).toEqual([{ field: 'body', rule: 'required' }]);
  });

  it('answers a malformed JSON body with validation_failed, not internal', async () => {
    const app = build();
    app.post('/__json', { config: ANY_ACTION }, () => ({ ok: true }));

    const response = await app.inject({
      method: 'POST',
      url: '/__json',
      headers: { 'content-type': 'application/json' },
      payload: '{"not json',
    });

    expect(response.statusCode).toBe(422);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('validation_failed');
  });
});

describe('the request id', () => {
  it('is served on every response and is the id the handler saw', async () => {
    const app = build();
    app.get('/__echo', { config: ANY_ACTION }, (request) => ({
      seen: request.requestId,
      trace: request.traceId,
    }));

    const response = await app.inject({ method: 'GET', url: '/__echo' });
    const header = response.headers[REQUEST_ID_HEADER];
    const body = response.json<{ seen: string; trace: string }>();

    expect(header).toMatch(REQUEST_ID_PATTERN);
    expect(body.seen).toBe(header);
    expect(`req_${body.trace}`).toBe(header);
  });

  it('is present on a success as well as on a failure', async () => {
    const app = build();

    const healthy = await app.inject({ method: 'GET', url: '/healthz' });
    const missing = await app.inject({ method: 'GET', url: '/nope' });

    expect(healthy.headers[REQUEST_ID_HEADER]).toMatch(REQUEST_ID_PATTERN);
    expect(missing.headers[REQUEST_ID_HEADER]).toMatch(REQUEST_ID_PATTERN);
  });

  it('is fresh per request and never adopted from the client', async () => {
    const app = build();

    const first = await app.inject({ method: 'GET', url: '/healthz' });
    const second = await app.inject({
      method: 'GET',
      url: '/healthz',
      // docs/12 §5.2: a candidate's browser is not a trusted source of trace ids.
      headers: { 'request-id': 'req_ffffffffffffffffffffffffffffffff' },
    });

    expect(first.headers[REQUEST_ID_HEADER]).not.toBe(second.headers[REQUEST_ID_HEADER]);
    expect(second.headers[REQUEST_ID_HEADER]).not.toBe('req_ffffffffffffffffffffffffffffffff');
  });
});

describe('GET /metrics', () => {
  it('serves a Prometheus exposition containing the http histogram', async () => {
    const app = build();
    await app.inject({ method: 'GET', url: '/healthz' });

    const response = await app.inject({ method: 'GET', url: '/metrics' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/plain');
    expect(response.payload).toContain('# TYPE http_request_duration_seconds histogram');
    expect(response.payload).toContain('http_request_duration_seconds_bucket');
    expect(response.payload).toContain('route_class="/healthz"');
    expect(response.payload).toContain('status_class="2xx"');
  });

  it('labels an unmatched request with a constant, never its URL', async () => {
    const app = build();
    await app.inject({ method: 'GET', url: '/scan/../../etc/passwd' });

    const response = await app.inject({ method: 'GET', url: '/metrics' });

    // One unbounded label destroys the metrics tier, and a scanner would otherwise mint
    // a series per probed path (docs/12 §6).
    expect(response.payload).toContain('route_class="unmatched"');
    expect(response.payload).not.toContain('etc/passwd');
  });
});

describe('GET /openapi.json', () => {
  it('serves the generated 3.1 document', async () => {
    const app = build();

    const response = await app.inject({ method: 'GET', url: '/openapi.json' });

    expect(response.statusCode).toBe(200);
    const document = response.json<{
      openapi: string;
      components: { schemas: Record<string, unknown> };
    }>();
    expect(document.openapi).toBe('3.1.0');
    expect(document.components.schemas).toHaveProperty('ErrorEnvelope');
    expect(document.components.schemas).toHaveProperty('OrgId');
  });
});

describe('security headers and CORS', () => {
  it('sets the helmet headers', async () => {
    const app = build();

    const response = await app.inject({ method: 'GET', url: '/healthz' });

    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['content-security-policy']).toContain("default-src 'none'");
  });

  it('reflects only a configured origin', async () => {
    const app = build();

    const allowed = await app.inject({
      method: 'GET',
      url: '/healthz',
      headers: { origin: 'https://console.example.test' },
    });
    const other = await app.inject({
      method: 'GET',
      url: '/healthz',
      headers: { origin: 'https://evil.example' },
    });

    expect(allowed.headers['access-control-allow-origin']).toBe('https://console.example.test');
    expect(allowed.headers['access-control-expose-headers']).toContain('X-Request-Id');
    expect(other.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('rate limiting', () => {
  /**
   * Routes are registered as a plugin rather than with `app.get()` on the returned
   * instance, because `@fastify/rate-limit` applies itself through a synchronous
   * `onRoute` hook — see the comment above `app.after` in server.ts. Registering the
   * way production registers is the only way this suite could catch that regression.
   */
  function withRoutes(register: (instance: FastifyInstance) => void): FastifyInstance {
    const app = build();
    void app.register((instance, _options, done) => {
      register(instance);
      done();
    });
    return app;
  }

  it('applies the documented staff ceiling to a route that asks for nothing', async () => {
    const app = withRoutes((instance) => {
      instance.get('/__plain', { config: ANY_ACTION }, () => ({ ok: true }));
    });

    const response = await app.inject({ method: 'GET', url: '/__plain' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['x-ratelimit-limit']).toBe(String(RATE_LIMITS.staff_api.max));
  });

  it('refuses an exceeded route with the standard envelope and a Retry-After', async () => {
    const app = withRoutes((instance) => {
      instance.get(
        '/__limited',
        {
          config: {
            ...ANY_ACTION,
            rateLimit: { max: 1, timeWindow: '1 minute' },
            rateLimitScope: 'candidate_autosave',
          },
        },
        () => ({ ok: true }),
      );
    });

    const first = await app.inject({ method: 'GET', url: '/__limited' });
    const second = await app.inject({ method: 'GET', url: '/__limited' });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(429);
    expect(second.headers['retry-after']).toBeDefined();

    const body = second.json<{ error: { code: string; request_id: string; details?: unknown } }>();
    expect(body.error.code).toBe('rate_limited');
    expect(body.error.request_id).toMatch(REQUEST_ID_PATTERN);
    expect(body.error.details).toEqual({ retry_after_seconds: expect.any(Number) as unknown });
  });

  it('records which documented scope refused the request', async () => {
    const app = withRoutes((instance) => {
      instance.get(
        '/__autosave',
        {
          config: {
            ...ANY_ACTION,
            rateLimit: { max: 1, timeWindow: '1 minute' },
            rateLimitScope: 'candidate_autosave',
          },
        },
        () => ({ ok: true }),
      );
    });

    await app.inject({ method: 'GET', url: '/__autosave' });
    await app.inject({ method: 'GET', url: '/__autosave' });

    const exposition = await app.inject({ method: 'GET', url: '/metrics' });

    // A spike on candidate_autosave is a client bug and a candidate losing work; it is
    // indistinguishable from staff traffic without the label (docs/12 §4.6).
    expect(exposition.payload).toContain('http_rate_limited_total{scope="candidate_autosave"}');
  });

  it('never rate limits the operational routes', async () => {
    const app = build();

    // A limited /healthz is a self-inflicted outage: the probe fails, the pod is killed,
    // and its traffic moves to pods whose probes then fail too.
    const response = await app.inject({ method: 'GET', url: '/healthz' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['x-ratelimit-limit']).toBeUndefined();
  });
});
