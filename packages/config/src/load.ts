/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `loadConfig` — the whole gate.
 *
 * Three passes, in order, each one able to stop the boot:
 *
 * 1. per-variable parsing against `envSchema`;
 * 2. cross-field rules that no single variable can express — derived values that must
 *    agree, and the all-or-nothing optional feature blocks;
 * 3. the staging/production tightenings of docs/13 §4.16 — https and wss, secrets of
 *    real length, and no `.env.example` placeholder that survived a deploy.
 *
 * Every failure is collected before throwing, so one run tells an operator everything
 * that is wrong rather than one thing at a time.
 */

import { ConfigError, type ConfigIssue } from './errors.js';
import { attachRedaction, redactConfig } from './redact.js';
import type {
  AppConfig,
  AppEnv,
  CollabConfig,
  CoreConfig,
  DatabaseConfig,
  ExecConfig,
  HttpConfig,
  LivekitConfig,
  LocalConfig,
  LogLevel,
  MailConfig,
  OidcConfig,
  QueuesConfig,
  RetentionConfig,
  S3Config,
  SecretsConfig,
  TelemetryConfig,
  ValkeyConfig,
} from './types.js';
import {
  ENV_VAR_NAMES,
  envSchema,
  parseUrl,
  VARIABLES,
  type Env,
  type EnvVarName,
} from './variables.js';

/** Bytes per megabyte, for the `EXEC_MEMORY_MB` / `EXEC_MEMORY_MB_BYTES` agreement. */
const BYTES_PER_MB = 1_048_576;

/** Minimum secret length in a deployed tier, in bytes (docs/13 §4.16). */
const MIN_SECRET_BYTES = 32;

/** The dev passwords committed to `.env.example`; they must not reach a deployed tier. */
const DEV_DSN_PASSWORDS: ReadonlySet<string> = new Set(['hiring', 'hiring_app', 'hiring_job']);

/** Values present but empty are treated as absent, so `VAR=` means "unset", not "". */
function normalise(env: NodeJS.ProcessEnv): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const name of ENV_VAR_NAMES) {
    const raw = env[name];
    if (raw === undefined) continue;
    if (raw.trim() === '') continue;
    out[name] = raw;
  }
  return out;
}

/** `1 character` / `2 characters`, so a failure message reads like English. */
function count(n: number, unit: string): string {
  return `${String(n)} ${unit}${n === 1 ? '' : 's'}`;
}

function describeReceived(raw: Readonly<Record<string, string>>, name: EnvVarName): string {
  const value = raw[name];
  if (value === undefined) return 'nothing (the variable is not set)';
  if (VARIABLES[name].secret) {
    return `a secret value of ${count(value.length, 'character')} (not shown)`;
  }
  return JSON.stringify(value);
}

function issue(name: EnvVarName, expected: string, received: string): ConfigIssue {
  return {
    variable: name,
    expected,
    received,
    message: `${name}: expected ${expected}, received ${received}`,
  };
}

/** Builds an issue for a variable using its declared `expected` text. */
function declaredIssue(raw: Readonly<Record<string, string>>, name: EnvVarName): ConfigIssue {
  return issue(name, VARIABLES[name].expected, describeReceived(raw, name));
}

function isDeclared(name: string): name is EnvVarName {
  return Object.hasOwn(VARIABLES, name);
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

// --- pass 2: cross-field rules ------------------------------------------------

function crossFieldIssues(env: Env, raw: Readonly<Record<string, string>>): ConfigIssue[] {
  const issues: ConfigIssue[] = [];

  // A derived value that disagrees with the value it derives from is worse than no
  // value at all: the cgroup limit and the limit the grader believes in diverge, and
  // a solution passes or fails depending on which one it met.
  if (env.EXEC_MEMORY_MB_BYTES !== env.EXEC_MEMORY_MB * BYTES_PER_MB) {
    issues.push(
      issue(
        'EXEC_MEMORY_MB_BYTES',
        `${String(env.EXEC_MEMORY_MB * BYTES_PER_MB)} — EXEC_MEMORY_MB (${String(env.EXEC_MEMORY_MB)}) x ${String(BYTES_PER_MB)}`,
        describeReceived(raw, 'EXEC_MEMORY_MB_BYTES'),
      ),
    );
  }

  // Wall time below CPU time means a process blocked on I/O is killed by the wall
  // clock before it has used its CPU budget, which reads to a candidate as a flaky
  // grader rather than as a limit.
  if (env.EXEC_WALL_TIME_MS < env.EXEC_CPU_TIME_MS) {
    issues.push(
      issue(
        'EXEC_WALL_TIME_MS',
        `at least EXEC_CPU_TIME_MS (${String(env.EXEC_CPU_TIME_MS)})`,
        describeReceived(raw, 'EXEC_WALL_TIME_MS'),
      ),
    );
  }

  // Optional feature blocks are all-or-nothing. Half-configured SSO fails at the
  // redirect, for one user, hours after the deploy.
  const oidcFields = ['OIDC_ISSUER', 'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET'] as const;
  if (oidcFields.some((name) => env[name] !== '')) {
    for (const name of oidcFields) {
      if (env[name] === '') {
        issues.push(
          issue(
            name,
            'a value, because staff SSO is partly configured — set all three OIDC_* variables or none',
            'an empty value',
          ),
        );
      }
    }
  }

  const livekitFields = ['LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET'] as const;
  if (livekitFields.some((name) => env[name] !== '')) {
    for (const name of livekitFields) {
      if (env[name] === '') {
        issues.push(
          issue(
            name,
            'a value, because live video is partly configured — set all three LIVEKIT_* variables or none',
            'an empty value',
          ),
        );
      }
    }
  }

  return issues;
}

// --- pass 3: staging and production tightenings -------------------------------

function requireProtocol(
  appEnv: AppEnv,
  name: EnvVarName,
  value: string,
  protocol: string,
): ConfigIssue | null {
  if (parseUrl(value, [protocol]) !== null) return null;
  // The effective value is reported, not the raw one: where the variable was omitted
  // the development default applied, and "not set" would hide which URL is in force.
  return issue(name, `a ${protocol}// URL in ${appEnv}`, JSON.stringify(value));
}

function deployedTierIssues(env: Env, raw: Readonly<Record<string, string>>): ConfigIssue[] {
  const issues: ConfigIssue[] = [];

  // docs/13 §2: staging runs NODE_ENV=production with APP_ENV=staging. Anything else
  // means development middleware, verbose errors or disabled caching in a tier that
  // real candidates or a rehearsal depend on.
  if (env.NODE_ENV !== 'production') {
    issues.push(
      issue(
        'NODE_ENV',
        `"production" when APP_ENV is ${env.APP_ENV}`,
        describeReceived(raw, 'NODE_ENV'),
      ),
    );
  }

  const https: readonly (readonly [EnvVarName, string])[] = [
    ['API_PUBLIC_URL', env.API_PUBLIC_URL],
    ['WEB_PUBLIC_URL', env.WEB_PUBLIC_URL],
    ['CANDIDATE_PUBLIC_URL', env.CANDIDATE_PUBLIC_URL],
  ];
  for (const [name, value] of https) {
    const bad = requireProtocol(env.APP_ENV, name, value, 'https:');
    if (bad !== null) issues.push(bad);
  }

  const wss = requireProtocol(env.APP_ENV, 'COLLAB_PUBLIC_URL', env.COLLAB_PUBLIC_URL, 'wss:');
  if (wss !== null) issues.push(wss);

  if (env.LIVEKIT_URL !== '') {
    const bad = requireProtocol(env.APP_ENV, 'LIVEKIT_URL', env.LIVEKIT_URL, 'wss:');
    if (bad !== null) issues.push(bad);
  }

  if (env.OIDC_ISSUER !== '') {
    const bad = requireProtocol(env.APP_ENV, 'OIDC_ISSUER', env.OIDC_ISSUER, 'https:');
    if (bad !== null) issues.push(bad);
  }

  // Secret strength. A 32-byte floor is the point below which a signing key is worth
  // attacking rather than stealing.
  const strength: readonly (readonly [EnvVarName, string])[] = [
    ['SESSION_SECRET', env.SESSION_SECRET],
    ['TOKEN_PEPPER', env.TOKEN_PEPPER],
    ['S3_SECRET_ACCESS_KEY', env.S3_SECRET_ACCESS_KEY],
    ...(env.OIDC_CLIENT_SECRET === ''
      ? []
      : ([['OIDC_CLIENT_SECRET', env.OIDC_CLIENT_SECRET]] as const)),
    ...(env.LIVEKIT_API_SECRET === ''
      ? []
      : ([['LIVEKIT_API_SECRET', env.LIVEKIT_API_SECRET]] as const)),
  ];
  for (const [name, value] of strength) {
    if (byteLength(value) < MIN_SECRET_BYTES) {
      issues.push(
        issue(
          name,
          `at least ${String(MIN_SECRET_BYTES)} bytes in ${env.APP_ENV} — generate with: openssl rand -hex 32`,
          `a secret value of ${count(byteLength(value), 'byte')} (not shown)`,
        ),
      );
    }
  }

  // A committed placeholder that reached a deployed tier is a secret everyone has.
  for (const name of ENV_VAR_NAMES) {
    const { placeholder } = VARIABLES[name];
    if (placeholder === null || placeholder === '') continue;
    if (env[name] === placeholder) {
      issues.push(
        issue(
          name,
          `a real value in ${env.APP_ENV} — the .env.example placeholder is public`,
          'the .env.example placeholder (not shown)',
        ),
      );
    }
  }

  // The same argument, for the password inside a DSN.
  const dsns: readonly (readonly [EnvVarName, string])[] = [
    ['DATABASE_URL', env.DATABASE_URL],
    ['DATABASE_JOB_URL', env.DATABASE_JOB_URL],
    ['DATABASE_OWNER_URL', env.DATABASE_OWNER_URL],
  ];
  for (const [name, value] of dsns) {
    const parsed = parseUrl(value, ['postgres:', 'postgresql:']);
    if (parsed === null) continue;
    if (parsed.password === '' || DEV_DSN_PASSWORDS.has(parsed.password)) {
      issues.push(
        issue(
          name,
          `a connection string carrying a real password in ${env.APP_ENV}, not the .env.example development one`,
          'a connection string with a missing or placeholder password (not shown)',
        ),
      );
    }
  }

  return issues;
}

// --- shaping ------------------------------------------------------------------

function toOidc(env: Env): OidcConfig {
  if (env.OIDC_ISSUER === '' || env.OIDC_CLIENT_ID === '' || env.OIDC_CLIENT_SECRET === '') {
    return { enabled: false };
  }
  return {
    enabled: true,
    issuer: env.OIDC_ISSUER,
    clientId: env.OIDC_CLIENT_ID,
    clientSecret: env.OIDC_CLIENT_SECRET,
  };
}

function toLivekit(env: Env): LivekitConfig {
  if (env.LIVEKIT_URL === '' || env.LIVEKIT_API_KEY === '' || env.LIVEKIT_API_SECRET === '') {
    return { enabled: false };
  }
  return {
    enabled: true,
    url: env.LIVEKIT_URL,
    apiKey: env.LIVEKIT_API_KEY,
    apiSecret: env.LIVEKIT_API_SECRET,
  };
}

function isDeployed(appEnv: AppEnv): boolean {
  return appEnv === 'staging' || appEnv === 'production';
}

function shape(env: Env): AppConfig {
  const deployed = isDeployed(env.APP_ENV);
  const logLevel: LogLevel = env.LOG_LEVEL ?? (deployed ? 'info' : 'debug');

  const core: CoreConfig = {
    nodeEnv: env.NODE_ENV,
    logLevel,
    appEnv: env.APP_ENV,
    isDeployedTier: deployed,
  };
  const http: HttpConfig = {
    port: env.API_PORT,
    publicUrl: env.API_PUBLIC_URL,
    webPublicUrl: env.WEB_PUBLIC_URL,
    candidatePublicUrl: env.CANDIDATE_PUBLIC_URL,
    corsAllowedOrigins: env.CORS_ALLOWED_ORIGINS,
  };
  const database: DatabaseConfig = {
    url: env.DATABASE_URL,
    jobUrl: env.DATABASE_JOB_URL,
    ownerUrl: env.DATABASE_OWNER_URL,
    poolMax: env.DATABASE_POOL_MAX,
    appRole: env.DATABASE_APP_ROLE,
    jobRole: env.DATABASE_JOB_ROLE,
    appRolePassword: env.DATABASE_APP_ROLE_PASSWORD,
    jobRolePassword: env.DATABASE_JOB_ROLE_PASSWORD,
    postgresUser: env.POSTGRES_USER,
    postgresPassword: env.POSTGRES_PASSWORD,
    postgresDb: env.POSTGRES_DB,
  };
  const valkey: ValkeyConfig = { url: env.REDIS_URL };
  const s3: S3Config = {
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION,
    bucket: env.S3_BUCKET,
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
  };
  const exec: ExecConfig = {
    pistonUrl: env.PISTON_URL,
    cpuTimeMs: env.EXEC_CPU_TIME_MS,
    wallTimeMs: env.EXEC_WALL_TIME_MS,
    memoryMb: env.EXEC_MEMORY_MB,
    memoryBytes: env.EXEC_MEMORY_MB_BYTES,
    maxProcesses: env.EXEC_MAX_PROCESSES,
    maxOutputBytes: env.EXEC_MAX_OUTPUT_BYTES,
  };
  const queues: QueuesConfig = {
    runConcurrency: env.QUEUE_RUN_CONCURRENCY,
    submitConcurrency: env.QUEUE_SUBMIT_CONCURRENCY,
    maxAttempts: env.QUEUE_MAX_ATTEMPTS,
    backoffMs: env.QUEUE_BACKOFF_MS,
  };
  const collab: CollabConfig = {
    port: env.COLLAB_PORT,
    publicUrl: env.COLLAB_PUBLIC_URL,
    snapshotIntervalMs: env.COLLAB_SNAPSHOT_INTERVAL_MS,
  };
  const secrets: SecretsConfig = {
    sessionSecret: env.SESSION_SECRET,
    tokenPepper: env.TOKEN_PEPPER,
    webhookSigningSecretRotationDays: env.WEBHOOK_SIGNING_SECRET_ROTATION_DAYS,
  };
  const mail: MailConfig = { smtpUrl: env.SMTP_URL, from: env.MAIL_FROM };
  const telemetry: TelemetryConfig = {
    otlpEndpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
    serviceName: env.OTEL_SERVICE_NAME,
    tracesSamplerArg: env.OTEL_TRACES_SAMPLER_ARG,
  };
  const retention: RetentionConfig = {
    proctorMediaDays: env.RETENTION_PROCTOR_MEDIA_DAYS,
    sessionRecordingDays: env.RETENTION_SESSION_RECORDING_DAYS,
    attemptDataMonths: env.RETENTION_ATTEMPT_DATA_MONTHS,
    candidatePiiMonths: env.RETENTION_CANDIDATE_PII_MONTHS,
    auditLogYears: env.RETENTION_AUDIT_LOG_YEARS,
  };
  const local: LocalConfig = {
    postgresPort: env.POSTGRES_PORT,
    valkeyPort: env.VALKEY_PORT,
    s3Port: env.S3_PORT,
    seaweedfsMasterPort: env.SEAWEEDFS_MASTER_PORT,
    mailpitUiPort: env.MAILPIT_UI_PORT,
    mailpitSmtpPort: env.MAILPIT_SMTP_PORT,
    otlpGrpcPort: env.OTLP_GRPC_PORT,
    otlpHttpPort: env.OTLP_HTTP_PORT,
    prometheusPort: env.PROMETHEUS_PORT,
    grafanaPort: env.GRAFANA_PORT,
    webPort: env.WEB_PORT,
    candidatePort: env.CANDIDATE_PORT,
    pistonLogLevel: env.PISTON_LOG_LEVEL,
    grafanaAdminUser: env.GRAFANA_ADMIN_USER,
    grafanaAdminPassword: env.GRAFANA_ADMIN_PASSWORD,
  };

  const config: AppConfig = {
    core,
    http,
    database,
    valkey,
    s3,
    exec,
    queues,
    collab,
    secrets,
    mail,
    oidc: toOidc(env),
    livekit: toLivekit(env),
    telemetry,
    retention,
    local,
  };

  // Redaction is installed before the freeze, on the root and on every group, so a
  // dump of any part of the tree is as safe as a dump of the whole of it.
  const groups = Object.keys(config) as (keyof AppConfig)[];
  for (const key of groups) {
    attachRedaction(config[key], `${key} config`, () => redactConfig(config)[key]);
    Object.freeze(config[key]);
  }
  attachRedaction(config, 'AppConfig', () => redactConfig(config));
  Object.freeze(config.http.corsAllowedOrigins);
  return Object.freeze(config);
}

/**
 * Parses an environment into a validated, frozen {@link AppConfig}.
 *
 * Pure given `env`: no file is read, no clock is consulted and nothing is cached, so a
 * test can hand it any environment it likes. `env` defaults to `process.env` — this
 * module is the only place in the repository permitted to touch it (docs/17 §12).
 *
 * @throws {ConfigError} naming every variable that failed, what was expected and what
 * arrived. Secret values are never included in the message.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const raw = normalise(env);
  const parsed = envSchema.safeParse(raw);

  if (!parsed.success) {
    const seen = new Set<string>();
    const issues: ConfigIssue[] = [];
    for (const zodIssue of parsed.error.issues) {
      const name = zodIssue.path[0];
      if (typeof name !== 'string' || !isDeclared(name) || seen.has(name)) continue;
      seen.add(name);
      issues.push(declaredIssue(raw, name));
    }
    // A zod issue with no usable path would leave nothing to report; never throw an
    // empty ConfigError, because a failure with no named variable is the exact thing
    // this package exists to prevent.
    if (issues.length === 0) {
      issues.push({
        variable: '(unknown)',
        expected: 'a valid environment',
        received: parsed.error.issues.map((i) => i.message).join('; '),
        message: `the environment failed validation: ${parsed.error.issues
          .map((i) => i.message)
          .join('; ')}`,
      });
    }
    throw new ConfigError(issues);
  }

  const parsedEnv: Env = parsed.data;
  const issues = crossFieldIssues(parsedEnv, raw);
  if (isDeployed(parsedEnv.APP_ENV)) {
    issues.push(...deployedTierIssues(parsedEnv, raw));
  }
  if (issues.length > 0) throw new ConfigError(issues);

  return shape(parsedEnv);
}
