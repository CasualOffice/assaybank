/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The shape of the parsed configuration.
 *
 * Grouped exactly as docs/13-environments-and-release.md §4 groups the variable
 * reference, so a field here is one table row there. Every property is `readonly`,
 * every group is frozen, and there is no index signature: a name that is not declared
 * is a type error, not an `undefined` discovered at 03:00.
 */

/** `NODE_ENV` — the Node runtime mode. Distinct from {@link AppEnv}. */
export type NodeEnv = 'development' | 'test' | 'production';

/**
 * `APP_ENV` — the deployment tier this process believes it is in. Tags every log line,
 * metric and span; staging runs `NODE_ENV=production` with `APP_ENV=staging`.
 */
export type AppEnv = 'local' | 'ci' | 'dev' | 'staging' | 'production';

/** `LOG_LEVEL` — a pino level. */
export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

/** docs/13 §4.1. */
export interface CoreConfig {
  readonly nodeEnv: NodeEnv;
  readonly logLevel: LogLevel;
  readonly appEnv: AppEnv;
  /** True for `staging` and `production` — the tiers the tightened rules apply to. */
  readonly isDeployedTier: boolean;
}

/** docs/13 §4.2. */
export interface HttpConfig {
  readonly port: number;
  /** Base URL clients reach the API on. No trailing slash. */
  readonly publicUrl: string;
  /** Base URL of the staff console. No trailing slash. */
  readonly webPublicUrl: string;
  /** Base URL of the candidate app — every invitation link is built from it. */
  readonly candidatePublicUrl: string;
  /** Exact origins, never a wildcard: the candidate app holds attempt tokens. */
  readonly corsAllowedOrigins: readonly string[];
}

/** docs/13 §4.3. The `postgres*` fields bootstrap the container; no app connects as them. */
export interface DatabaseConfig {
  readonly url: string;
  readonly jobUrl: string;
  /** Owner DSN. Used only by the migration runner, never by a request path. */
  readonly ownerUrl: string;
  readonly poolMax: number;
  readonly appRole: string;
  readonly jobRole: string;
  readonly appRolePassword: string;
  readonly jobRolePassword: string;
  readonly postgresUser: string;
  readonly postgresPassword: string;
  readonly postgresDb: string;
}

/** docs/13 §4.4. Valkey 8 — the variable keeps the Redis name so clients work unchanged. */
export interface ValkeyConfig {
  readonly url: string;
}

/** docs/13 §4.5. */
export interface S3Config {
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly forcePathStyle: boolean;
}

/**
 * docs/13 §4.6. Changing any of these changes what counts as a passing solution: it is
 * a scoring change wearing a configuration costume, never a live tuning knob.
 */
export interface ExecConfig {
  readonly pistonUrl: string;
  readonly cpuTimeMs: number;
  readonly wallTimeMs: number;
  readonly memoryMb: number;
  readonly memoryBytes: number;
  readonly maxProcesses: number;
  readonly maxOutputBytes: number;
}

/** docs/13 §4.7. */
export interface QueuesConfig {
  readonly runConcurrency: number;
  readonly submitConcurrency: number;
  readonly maxAttempts: number;
  readonly backoffMs: number;
}

/** docs/13 §4.8. */
export interface CollabConfig {
  readonly port: number;
  readonly publicUrl: string;
  /** Upper bound on interview work lost to a node crash or a rolling restart. */
  readonly snapshotIntervalMs: number;
}

/** docs/13 §4.9. */
export interface SecretsConfig {
  readonly sessionSecret: string;
  readonly tokenPepper: string;
  readonly webhookSigningSecretRotationDays: number;
}

/** docs/13 §4.10. */
export interface MailConfig {
  readonly smtpUrl: string;
  readonly from: string;
}

/**
 * docs/13 §4.11. Disabled means password-based staff login; candidate authentication
 * never uses OIDC — candidates hold attempt tokens.
 *
 * A discriminated union rather than three nullable fields, so a caller cannot read
 * `issuer` without having established that SSO is configured at all.
 */
export type OidcConfig =
  | { readonly enabled: false }
  | {
      readonly enabled: true;
      readonly issuer: string;
      readonly clientId: string;
      readonly clientSecret: string;
    };

/** docs/13 §4.12. Disabled outside the tiers that run live video. */
export type LivekitConfig =
  | { readonly enabled: false }
  | {
      readonly enabled: true;
      readonly url: string;
      readonly apiKey: string;
      /** Mints room tokens. Never reaches a browser. */
      readonly apiSecret: string;
    };

/** docs/13 §4.13. */
export interface TelemetryConfig {
  readonly otlpEndpoint: string;
  readonly serviceName: string;
  readonly tracesSamplerArg: number;
}

/**
 * docs/13 §4.14. Policy values enforced by the worker sweeps. Each band comes from
 * docs/11 §4.1; changing one changes a commitment made to candidates.
 */
export interface RetentionConfig {
  readonly proctorMediaDays: number;
  readonly sessionRecordingDays: number;
  readonly attemptDataMonths: number;
  readonly candidatePiiMonths: number;
  readonly auditLogYears: number;
}

/**
 * docs/13 §4.15. Host port mappings and container-local settings. Meaningful only for
 * the development compose stack and absent from production, which is why every one of
 * them has a default: their absence must never fail a production boot.
 */
export interface LocalConfig {
  readonly postgresPort: number;
  readonly valkeyPort: number;
  readonly s3Port: number;
  readonly seaweedfsMasterPort: number;
  readonly mailpitUiPort: number;
  readonly mailpitSmtpPort: number;
  readonly otlpGrpcPort: number;
  readonly otlpHttpPort: number;
  readonly prometheusPort: number;
  readonly grafanaPort: number;
  readonly webPort: number;
  readonly candidatePort: number;
  readonly pistonLogLevel: string;
  readonly grafanaAdminUser: string;
  readonly grafanaAdminPassword: string;
}

/**
 * The whole validated environment, frozen.
 *
 * `JSON.stringify`, `util.inspect` and `String()` on this object — or on any group
 * inside it — return a redacted view, so an accidental `console.log(config)` cannot
 * leak `SESSION_SECRET`, `TOKEN_PEPPER` or a DSN password.
 */
export interface AppConfig {
  readonly core: CoreConfig;
  readonly http: HttpConfig;
  readonly database: DatabaseConfig;
  readonly valkey: ValkeyConfig;
  readonly s3: S3Config;
  readonly exec: ExecConfig;
  readonly queues: QueuesConfig;
  readonly collab: CollabConfig;
  readonly secrets: SecretsConfig;
  readonly mail: MailConfig;
  readonly oidc: OidcConfig;
  readonly livekit: LivekitConfig;
  readonly telemetry: TelemetryConfig;
  readonly retention: RetentionConfig;
  readonly local: LocalConfig;
}
