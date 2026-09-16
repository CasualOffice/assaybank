/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Redaction of the configuration object.
 *
 * docs/12 §7.2 forbids a secret from reaching a log line, and the realistic way one
 * gets there is not a deliberate `log.info(config.secrets.sessionSecret)` — it is
 * `console.log(config)` in a boot path, or a config object caught by an error
 * serialiser. So the object itself refuses to render its secrets: `JSON.stringify`,
 * `util.inspect` (what `console.log` uses) and `String()` all go through here.
 *
 * Reading `config.secrets.sessionSecret` still returns the real value. That is a
 * deliberate, greppable access; a dump is not.
 */

import type { AppConfig } from './types.js';

/** What a secret renders as. */
export const REDACTED = '[redacted]';

/** `util.inspect.custom`, without importing `node:util`. */
export const INSPECT_CUSTOM: symbol = Symbol.for('nodejs.util.inspect.custom');

/**
 * Replaces the password component of a connection string, keeping the parts an
 * operator needs in order to recognise which host they are looking at.
 *
 * `postgres://hiring_app:example-password@db:5432/hiring` → `postgres://hiring_app:[redacted]@db:5432/hiring`
 *
 * An unparseable value is redacted whole: if the structure is not understood, no part
 * of it can be shown to be safe.
 */
export function redactDsn(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return REDACTED;
  }
  if (url.password === '') return value;
  url.password = REDACTED;
  // URL encodes the brackets; put the marker back so the output reads cleanly.
  return url.toString().replace(encodeURIComponent(REDACTED), REDACTED);
}

/** The redacted tree: one plain object per configuration group. */
export type RedactedConfig = { readonly [K in keyof AppConfig]: Record<string, unknown> };

/** Builds the redacted view of a whole configuration object. */
export function redactConfig(config: AppConfig): RedactedConfig {
  return {
    core: { ...config.core },
    http: { ...config.http, corsAllowedOrigins: [...config.http.corsAllowedOrigins] },
    database: {
      ...config.database,
      url: redactDsn(config.database.url),
      jobUrl: redactDsn(config.database.jobUrl),
      ownerUrl: redactDsn(config.database.ownerUrl),
      appRolePassword: REDACTED,
      jobRolePassword: REDACTED,
      postgresPassword: REDACTED,
    },
    valkey: { ...config.valkey, url: redactDsn(config.valkey.url) },
    s3: { ...config.s3, accessKeyId: REDACTED, secretAccessKey: REDACTED },
    exec: { ...config.exec },
    queues: { ...config.queues },
    collab: { ...config.collab },
    secrets: { ...config.secrets, sessionSecret: REDACTED, tokenPepper: REDACTED },
    mail: { ...config.mail, smtpUrl: redactDsn(config.mail.smtpUrl) },
    oidc: config.oidc.enabled ? { ...config.oidc, clientSecret: REDACTED } : { ...config.oidc },
    livekit: config.livekit.enabled
      ? { ...config.livekit, apiSecret: REDACTED }
      : { ...config.livekit },
    telemetry: { ...config.telemetry },
    retention: { ...config.retention },
    local: { ...config.local, grafanaAdminPassword: REDACTED },
  };
}

/**
 * Installs `toJSON`, `toString` and the Node inspect hook on `target`, all returning
 * `render()`. The properties are non-enumerable and non-writable, so they neither show
 * up in a spread of the object nor can be removed by a caller that would rather not
 * have them.
 */
export function attachRedaction<T extends object>(
  target: T,
  label: string,
  render: () => unknown,
): T {
  const define = (key: string | symbol, value: unknown): void => {
    Object.defineProperty(target, key, {
      value,
      enumerable: false,
      writable: false,
      configurable: false,
    });
  };

  define('toJSON', () => render());
  define('toString', () => `${label} ${JSON.stringify(render())}`);
  define(INSPECT_CUSTOM, () => render());
  return target;
}
