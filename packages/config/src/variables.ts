/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The variable registry — one entry per row of docs/13-environments-and-release.md §4,
 * in the order that document lists them.
 *
 * Each entry carries three things: the zod schema that parses the raw string, a
 * human description of what is accepted (used verbatim in a {@link ConfigError}), and
 * whether the value is a secret, which decides whether it may appear in an error
 * message, a log line or a dump of the configuration object.
 *
 * Adding a variable is a four-file change — this file, `.env.example`,
 * `docker-compose.yml` and docs/13 §4 — and `env-example.test.ts` fails the build if
 * the first two disagree in either direction.
 */

import { z } from 'zod';

/** A single declared variable: how it parses, how it is described, how it is handled. */
export interface VarSpec<S extends z.ZodType = z.ZodType> {
  /** What a valid value looks like, in English. Quoted in the failure message. */
  readonly expected: string;
  /** Parser for the raw string form. */
  readonly schema: S;
  /** A secret never appears in a log line, an error message or a config dump. */
  readonly secret: boolean;
  /**
   * The development placeholder from `.env.example`. A variable carrying one is
   * rejected in staging and production if the placeholder survived (docs/13 §4.16).
   * `null` where no placeholder applies — notably every §4.15 local-only variable,
   * which is absent from production and therefore falls back to its dev default there.
   */
  readonly placeholder: string | null;
}

// --- primitives ---------------------------------------------------------------

/** Non-empty string, trimmed. */
const str = (): z.ZodType<string, string> => z.string().trim().min(1);

/** Decimal integer inside an inclusive band. Rejects `08`-style octal ambiguity. */
const int = (min: number, max: number): z.ZodType<number, string> =>
  z
    .string()
    .trim()
    .regex(/^(0|[1-9][0-9]*)$/)
    .transform(Number)
    .refine((n) => Number.isSafeInteger(n) && n >= min && n <= max);

/** TCP port. */
const port = (): z.ZodType<number, string> => int(1, 65_535);

/** Float in `[0, 1]`, for a sampling ratio. */
const ratio = (): z.ZodType<number, string> =>
  z
    .string()
    .trim()
    .regex(/^(0|1|0?\.[0-9]+|1\.0+)$/)
    .transform(Number)
    .refine((n) => n >= 0 && n <= 1);

const TRUTHY = new Set(['true', '1', 'yes', 'on']);
const FALSY = new Set(['false', '0', 'no', 'off']);

/** Boolean spelled the way an env file spells it. */
const bool = (): z.ZodType<boolean, string> =>
  z
    .string()
    .trim()
    .refine((v) => TRUTHY.has(v.toLowerCase()) || FALSY.has(v.toLowerCase()))
    .transform((v) => TRUTHY.has(v.toLowerCase()));

/** Parses `value` as an absolute URL restricted to `protocols` (`'https:'` form). */
export function parseUrl(value: string, protocols: readonly string[]): URL | null {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  return protocols.includes(url.protocol) ? url : null;
}

/**
 * Absolute URL with one of `protocols`. The trailing slash is stripped so callers can
 * concatenate a path without producing `//` in an invitation link.
 */
const url = (protocols: readonly string[]): z.ZodType<string, string> =>
  z
    .string()
    .trim()
    .refine((v) => parseUrl(v, protocols) !== null)
    .transform((v) => v.trim().replace(/\/+$/, ''));

/** Connection string with one of `protocols`. Kept byte-for-byte: a DSN is opaque. */
const dsn = (protocols: readonly string[]): z.ZodType<string, string> =>
  z
    .string()
    .trim()
    .refine((v) => parseUrl(v, protocols) !== null);

/** A SQL role name. Unquoted identifier rules, 63 bytes like Postgres itself. */
const identifier = (): z.ZodType<string, string> =>
  z
    .string()
    .trim()
    .regex(/^[A-Za-z_][A-Za-z0-9_$]{0,62}$/);

/**
 * Comma-separated exact origins. No wildcard, ever — the candidate app holds attempt
 * tokens and a `*` here defeats the cookie same-site protection (docs/13 §4.2).
 */
const origins = (): z.ZodType<readonly string[], string> =>
  z
    .string()
    .trim()
    .transform((v) =>
      v
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part.length > 0),
    )
    .refine((list) => list.length > 0)
    .refine((list) =>
      list.every((candidate) => {
        if (candidate.includes('*')) return false;
        const parsed = parseUrl(candidate, ['http:', 'https:']);
        if (parsed === null) return false;
        // An origin is scheme + host + port and nothing else.
        return parsed.pathname === '/' && parsed.search === '' && parsed.hash === '';
      }),
    )
    .transform((list) => Object.freeze(list.map((o) => o.replace(/\/+$/, ''))));

/** Opaque secret material. Length beyond this is enforced per tier in `load.ts`. */
const secretValue = (): z.ZodType<string, string> => z.string().min(8);

// --- declaration helpers ------------------------------------------------------

function open<S extends z.ZodType>(expected: string, schema: S): VarSpec<S> {
  return { expected, schema, secret: false, placeholder: null };
}

function sealed<S extends z.ZodType>(
  expected: string,
  schema: S,
  placeholder: string | null = null,
): VarSpec<S> {
  return { expected, schema, secret: true, placeholder };
}

// --- the registry -------------------------------------------------------------

/**
 * Every variable this platform reads, grouped exactly as docs/13 §4 groups them.
 *
 * Required-ness follows that table with one deliberate departure: the six variables
 * that carry credentials in every tier — `DATABASE_URL`, `DATABASE_JOB_URL`,
 * `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `SESSION_SECRET`, `TOKEN_PEPPER` — have
 * no default. The table calls their default a "placeholder", and a session-signing key
 * that falls back to a committed constant is a vulnerability, not a default.
 *
 * The §4.15 local-only variables all keep defaults, because they are absent from
 * production by design and must not fail a production boot.
 */
export const VARIABLES = {
  // §4.1 Core ------------------------------------------------------------------
  NODE_ENV: open(
    'one of development | test | production',
    z.enum(['development', 'test', 'production']).default('development'),
  ),
  // No schema default: docs/13 §4.1 documents the default as tier-dependent
  // (debug locally, info in staging and production). load.ts resolves it.
  LOG_LEVEL: open(
    'one of trace | debug | info | warn | error | fatal',
    z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).optional(),
  ),
  APP_ENV: open(
    'one of local | ci | dev | staging | production',
    z.enum(['local', 'ci', 'dev', 'staging', 'production']).default('local'),
  ),

  // §4.2 HTTP surface ----------------------------------------------------------
  API_PORT: open('an integer between 1 and 65535', port().default(8080)),
  API_PUBLIC_URL: open(
    'an absolute http:// or https:// URL',
    url(['http:', 'https:']).default('http://localhost:8080'),
  ),
  WEB_PUBLIC_URL: open(
    'an absolute http:// or https:// URL',
    url(['http:', 'https:']).default('http://localhost:5173'),
  ),
  CANDIDATE_PUBLIC_URL: open(
    'an absolute http:// or https:// URL — invitation links are built from it',
    url(['http:', 'https:']).default('http://localhost:5174'),
  ),
  CORS_ALLOWED_ORIGINS: open(
    'a comma-separated list of exact origins (scheme://host[:port]), never a wildcard',
    origins().default(Object.freeze(['http://localhost:5173', 'http://localhost:5174'])),
  ),

  // §4.3 Database --------------------------------------------------------------
  POSTGRES_USER: open('a SQL identifier', identifier().default('hiring')),
  POSTGRES_PASSWORD: sealed('a non-empty string', str().default('hiring')),
  POSTGRES_DB: open('a SQL identifier', identifier().default('hiring')),
  DATABASE_URL: sealed(
    'a postgres:// or postgresql:// connection string',
    dsn(['postgres:', 'postgresql:']),
  ),
  DATABASE_JOB_URL: sealed(
    'a postgres:// or postgresql:// connection string',
    dsn(['postgres:', 'postgresql:']),
  ),
  // Owner DSN, read only by the migration runner. Separate from DATABASE_URL because
  // the application role must not be able to alter the schema (ADR-010): if it could,
  // a SQL injection in a request path would be a schema-rewrite primitive.
  DATABASE_OWNER_URL: sealed(
    'a postgres:// or postgresql:// connection string',
    dsn(['postgres:', 'postgresql:']),
  ),
  DATABASE_POOL_MAX: open('an integer between 1 and 1000', int(1, 1000).default(10)),
  DATABASE_APP_ROLE: open('a SQL identifier', identifier().default('hiring_app')),
  DATABASE_APP_ROLE_PASSWORD: sealed('a non-empty string', str().default('hiring_app')),
  DATABASE_JOB_ROLE: open('a SQL identifier', identifier().default('hiring_job')),
  DATABASE_JOB_ROLE_PASSWORD: sealed('a non-empty string', str().default('hiring_job')),

  // §4.4 Valkey ----------------------------------------------------------------
  REDIS_URL: sealed(
    'a redis:// or rediss:// connection string',
    dsn(['redis:', 'rediss:']).default('redis://valkey:6379'),
  ),

  // §4.5 Object storage --------------------------------------------------------
  S3_ENDPOINT: open(
    'an absolute http:// or https:// URL',
    url(['http:', 'https:']).default('http://seaweedfs:8333'),
  ),
  S3_REGION: open('a non-empty string', str().default('us-east-1')),
  S3_BUCKET: open(
    'a bucket name: 3-63 lowercase letters, digits, dots or hyphens',
    z
      .string()
      .trim()
      .regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/)
      .default('hiring-dev'),
  ),
  S3_ACCESS_KEY_ID: sealed('a non-empty string', str(), 'hiring-dev-access-key'),
  S3_SECRET_ACCESS_KEY: sealed(
    'a string of at least 8 characters (32 bytes in staging and production)',
    secretValue(),
    'hiring-dev-secret-key',
  ),
  S3_FORCE_PATH_STYLE: open('a boolean: true | false | 1 | 0 | yes | no', bool().default(true)),

  // §4.6 Code execution --------------------------------------------------------
  PISTON_URL: open(
    'an absolute http:// or https:// URL',
    url(['http:', 'https:']).default('http://piston:2000'),
  ),
  EXEC_CPU_TIME_MS: open(
    'an integer between 100 and 600000 (milliseconds)',
    int(100, 600_000).default(5_000),
  ),
  EXEC_WALL_TIME_MS: open(
    'an integer between 100 and 600000 (milliseconds), at least EXEC_CPU_TIME_MS',
    int(100, 600_000).default(10_000),
  ),
  EXEC_MEMORY_MB: open('an integer between 16 and 16384 (megabytes)', int(16, 16_384).default(256)),
  EXEC_MEMORY_MB_BYTES: open(
    'an integer equal to EXEC_MEMORY_MB x 1048576',
    int(16 * 1_048_576, 16_384 * 1_048_576).default(268_435_456),
  ),
  EXEC_MAX_PROCESSES: open('an integer between 1 and 4096', int(1, 4_096).default(64)),
  EXEC_MAX_OUTPUT_BYTES: open(
    'an integer between 1024 and 16777216 (bytes)',
    int(1_024, 16_777_216).default(65_536),
  ),

  // §4.7 Queues ----------------------------------------------------------------
  QUEUE_RUN_CONCURRENCY: open('an integer between 1 and 256', int(1, 256).default(4)),
  QUEUE_SUBMIT_CONCURRENCY: open('an integer between 1 and 256', int(1, 256).default(2)),
  QUEUE_MAX_ATTEMPTS: open('an integer between 1 and 20', int(1, 20).default(3)),
  QUEUE_BACKOFF_MS: open(
    'an integer between 100 and 600000 (milliseconds)',
    int(100, 600_000).default(2_000),
  ),

  // §4.8 Collaboration ---------------------------------------------------------
  COLLAB_PORT: open('an integer between 1 and 65535', port().default(8081)),
  COLLAB_PUBLIC_URL: open(
    'an absolute ws:// or wss:// URL',
    url(['ws:', 'wss:']).default('ws://localhost:8081'),
  ),
  COLLAB_SNAPSHOT_INTERVAL_MS: open(
    'an integer between 1000 and 600000 (milliseconds) — the upper bound on interview work lost to a crash',
    int(1_000, 600_000).default(15_000),
  ),

  // §4.9 Secrets and tokens ----------------------------------------------------
  SESSION_SECRET: sealed(
    'a string of at least 8 characters (32 bytes in staging and production)',
    secretValue(),
    'CHANGE_ME_openssl_rand_hex_32',
  ),
  TOKEN_PEPPER: sealed(
    'a string of at least 8 characters (32 bytes in staging and production)',
    secretValue(),
    'CHANGE_ME_openssl_rand_hex_32',
  ),
  WEBHOOK_SIGNING_SECRET_ROTATION_DAYS: open(
    'an integer between 1 and 365 (days)',
    int(1, 365).default(90),
  ),

  // §4.10 Mail -----------------------------------------------------------------
  SMTP_URL: sealed(
    'an smtp:// or smtps:// connection string',
    dsn(['smtp:', 'smtps:']).default('smtp://mailpit:1025'),
  ),
  MAIL_FROM: open('an email address', z.email().default('no-reply@hiring.localhost')),

  // §4.11 Staff SSO — optional; empty means password-based staff login ---------
  OIDC_ISSUER: open(
    'an absolute https:// URL, or empty to disable staff SSO',
    z.union([z.literal(''), url(['http:', 'https:'])]).default(''),
  ),
  OIDC_CLIENT_ID: open(
    'a non-empty string, or empty to disable staff SSO',
    z.string().trim().default(''),
  ),
  OIDC_CLIENT_SECRET: sealed(
    'a non-empty string, or empty to disable staff SSO',
    z.string().default(''),
  ),

  // §4.12 Live video -----------------------------------------------------------
  LIVEKIT_URL: open(
    'an absolute ws:// or wss:// URL, or empty to disable live video',
    z.union([z.literal(''), url(['ws:', 'wss:'])]).default(''),
  ),
  LIVEKIT_API_KEY: open(
    'a non-empty string, or empty to disable live video',
    z.string().trim().default(''),
  ),
  LIVEKIT_API_SECRET: sealed(
    'a non-empty string, or empty to disable live video',
    z.string().default(''),
  ),

  // §4.13 Telemetry ------------------------------------------------------------
  OTEL_EXPORTER_OTLP_ENDPOINT: open(
    'an absolute http:// or https:// URL',
    url(['http:', 'https:']).default('http://otel-collector:4317'),
  ),
  OTEL_SERVICE_NAME: open('a non-empty string', str().default('hiring-api')),
  OTEL_TRACES_SAMPLER_ARG: open('a number between 0.0 and 1.0', ratio().default(1)),

  // §4.15 Local-only: host port mappings and container-local settings -----------
  POSTGRES_PORT: open('an integer between 1 and 65535', port().default(5432)),
  VALKEY_PORT: open('an integer between 1 and 65535', port().default(6379)),
  S3_PORT: open('an integer between 1 and 65535', port().default(8333)),
  SEAWEEDFS_MASTER_PORT: open('an integer between 1 and 65535', port().default(9333)),
  MAILPIT_UI_PORT: open('an integer between 1 and 65535', port().default(8025)),
  MAILPIT_SMTP_PORT: open('an integer between 1 and 65535', port().default(1025)),
  OTLP_GRPC_PORT: open('an integer between 1 and 65535', port().default(4317)),
  OTLP_HTTP_PORT: open('an integer between 1 and 65535', port().default(4318)),
  PROMETHEUS_PORT: open('an integer between 1 and 65535', port().default(9090)),
  GRAFANA_PORT: open('an integer between 1 and 65535', port().default(3030)),
  WEB_PORT: open('an integer between 1 and 65535', port().default(5173)),
  CANDIDATE_PORT: open('an integer between 1 and 65535', port().default(5174)),
  PISTON_LOG_LEVEL: open('a non-empty string', str().default('INFO')),
  GRAFANA_ADMIN_USER: open('a non-empty string', str().default('admin')),
  GRAFANA_ADMIN_PASSWORD: sealed('a non-empty string', str().default('admin')),

  // §4.14 Retention — bands from docs/11 §4.1 ----------------------------------
  RETENTION_PROCTOR_MEDIA_DAYS: open(
    'an integer between 1 and 30 (days) — 30 is the Article 9 ceiling, docs/11 §4.1',
    int(1, 30).default(30),
  ),
  RETENTION_SESSION_RECORDING_DAYS: open(
    'an integer between 7 and 90 (days), docs/11 §4.1',
    int(7, 90).default(90),
  ),
  RETENTION_ATTEMPT_DATA_MONTHS: open(
    'an integer between 6 and 24 (months), docs/11 §4.1',
    int(6, 24).default(24),
  ),
  RETENTION_CANDIDATE_PII_MONTHS: open(
    'an integer between 1 and 12 (months), docs/11 §4.1',
    int(1, 12).default(12),
  ),
  RETENTION_AUDIT_LOG_YEARS: open(
    'an integer between 7 and 10 (years) — 7 is a floor, not a ceiling, docs/11 §4.1',
    int(7, 10).default(7),
  ),
} satisfies Record<string, VarSpec>;

/** Every declared variable name. */
export type EnvVarName = keyof typeof VARIABLES;

type EnvShape = { [K in EnvVarName]: (typeof VARIABLES)[K]['schema'] };

const shape = Object.fromEntries(
  Object.entries(VARIABLES).map(([name, spec]) => [name, spec.schema]),
) as EnvShape;

/**
 * The raw per-variable schema. Cross-field rules (`EXEC_MEMORY_MB_BYTES` consistency,
 * the staging/production tightenings, OIDC and LiveKit all-or-nothing) live in
 * {@link loadConfig}, which is the supported entry point.
 */
export const envSchema = z.object(shape);

/** The parsed-but-not-yet-grouped environment. */
export type Env = z.infer<typeof envSchema>;

/** Declared variable names, in declaration order. */
export const ENV_VAR_NAMES: readonly EnvVarName[] = Object.freeze(
  Object.keys(VARIABLES) as EnvVarName[],
);

/** Names of the variables whose value must never be logged, printed or serialised. */
export const SECRET_ENV_VARS: readonly EnvVarName[] = Object.freeze(
  ENV_VAR_NAMES.filter((name) => VARIABLES[name].secret),
);

/** True when `name` is declared and marked secret. */
export function isSecretVariable(name: string): boolean {
  return Object.hasOwn(VARIABLES, name) && VARIABLES[name as EnvVarName].secret;
}
