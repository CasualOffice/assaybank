/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `@assaybank/config` — the only module in this repository permitted to read
 * `process.env` (docs/17 §12, enforced by the ESLint rule in `eslint.config.js`).
 *
 * One zod schema covers every variable in docs/13-environments-and-release.md §4. It
 * is parsed once, at module load, into a frozen typed object. A missing or malformed
 * variable throws a {@link ConfigError} naming the variable, what was expected and what
 * arrived — never an `undefined` that surfaces three layers deep at 02:00.
 *
 * ```ts
 * import { config } from '@assaybank/config';
 * server.listen({ port: config.http.port });
 * ```
 *
 * `console.log(config)` prints a redacted view: `SESSION_SECRET`, `TOKEN_PEPPER`, the
 * S3 credentials, the OIDC and LiveKit secrets and every DSN password render as
 * `[redacted]`. Reading `config.secrets.sessionSecret` still returns the real value.
 *
 * A test — or anything that wants a second environment — calls {@link loadConfig},
 * which is pure given its argument.
 */

import { ConfigError } from './errors.js';
import { loadConfig } from './load.js';
import { attachRedaction, redactConfig } from './redact.js';
import type { AppConfig } from './types.js';

export { ConfigError, type ConfigIssue } from './errors.js';
export { loadConfig } from './load.js';
export { REDACTED, redactDsn } from './redact.js';
export type {
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
  NodeEnv,
  OidcConfig,
  QueuesConfig,
  RetentionConfig,
  S3Config,
  SecretsConfig,
  TelemetryConfig,
  ValkeyConfig,
} from './types.js';
export {
  ENV_VAR_NAMES,
  envSchema,
  isSecretVariable,
  SECRET_ENV_VARS,
  VARIABLES,
  type Env,
  type EnvVarName,
  type VarSpec,
} from './variables.js';

/**
 * The workspace's own package name. Exported so a bootstrap can name itself in a log
 * line or a span resource without a second source of truth.
 */
export const WORKSPACE_NAME = '@assaybank/config';

// --- the process-wide configuration -------------------------------------------
//
// Parsing happens here, at module load, once. A failure is captured rather than
// rethrown from module scope, and every property access rethrows it: importing this
// package must not detonate inside a test file that never touches `config`, while an
// application that reads a single field at boot still fails immediately and loudly.

let loaded: AppConfig | null = null;
let failure: Error | null = null;

try {
  loaded = loadConfig();
} catch (error: unknown) {
  failure =
    error instanceof Error
      ? error
      : new ConfigError([
          {
            variable: '(unknown)',
            expected: 'a valid environment',
            received: String(error),
            message: `the environment could not be parsed: ${String(error)}`,
          },
        ]);
}

function resolved(): AppConfig {
  if (loaded !== null) return loaded;
  throw failure ?? new Error('configuration was neither loaded nor failed');
}

function render(): unknown {
  if (loaded === null) {
    return { error: 'configuration not loaded', reason: failure?.message ?? 'unknown' };
  }
  return redactConfig(loaded);
}

/**
 * The validated environment of this process, frozen.
 *
 * Every property delegates to the object parsed at module load. If that parse failed,
 * the first property read rethrows the {@link ConfigError} it failed with.
 */
export const config: AppConfig = Object.freeze(
  attachRedaction(
    {
      get core() {
        return resolved().core;
      },
      get http() {
        return resolved().http;
      },
      get database() {
        return resolved().database;
      },
      get valkey() {
        return resolved().valkey;
      },
      get s3() {
        return resolved().s3;
      },
      get exec() {
        return resolved().exec;
      },
      get queues() {
        return resolved().queues;
      },
      get collab() {
        return resolved().collab;
      },
      get secrets() {
        return resolved().secrets;
      },
      get mail() {
        return resolved().mail;
      },
      get oidc() {
        return resolved().oidc;
      },
      get livekit() {
        return resolved().livekit;
      },
      get telemetry() {
        return resolved().telemetry;
      },
      get retention() {
        return resolved().retention;
      },
      get local() {
        return resolved().local;
      },
    } satisfies AppConfig,
    'AppConfig',
    render,
  ),
);
