/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { inspect } from 'node:util';

import { describe, expect, it } from 'vitest';

import { loadConfig, redactDsn, REDACTED, type AppConfig } from './index.js';

import { envWith } from '../test/env-fixture.js';

const SESSION = 'session-secret-that-must-never-be-logged';
const PEPPER = 'token-pepper-that-must-never-be-logged';
const S3_KEY = 'access-key-that-must-never-be-logged';
const S3_SECRET = 'secret-access-key-that-must-never-be-logged';
const DB_PASSWORD = 'database-password-that-must-never-be-logged';
const SMTP_PASSWORD = 'smtp-password-that-must-never-be-logged';
const OIDC_SECRET = 'oidc-secret-that-must-never-be-logged';
const LIVEKIT_SECRET = 'livekit-secret-that-must-never-be-logged';
const GRAFANA_PASSWORD = 'grafana-password-that-must-never-be-logged';
const ROLE_PASSWORD = 'role-password-that-must-never-be-logged';

const EVERY_SECRET = [
  SESSION,
  PEPPER,
  S3_KEY,
  S3_SECRET,
  DB_PASSWORD,
  SMTP_PASSWORD,
  OIDC_SECRET,
  LIVEKIT_SECRET,
  GRAFANA_PASSWORD,
  ROLE_PASSWORD,
];

function configWithSecrets(): AppConfig {
  return loadConfig(
    envWith({
      SESSION_SECRET: SESSION,
      TOKEN_PEPPER: PEPPER,
      S3_ACCESS_KEY_ID: S3_KEY,
      S3_SECRET_ACCESS_KEY: S3_SECRET,
      DATABASE_URL: `postgres://hiring_app:${DB_PASSWORD}@postgres:5432/hiring`,
      DATABASE_JOB_URL: `postgres://hiring_job:${DB_PASSWORD}@postgres:5432/hiring`,
      DATABASE_OWNER_URL: `postgres://hiring_owner:${DB_PASSWORD}@postgres:5432/hiring`,
      DATABASE_APP_ROLE_PASSWORD: ROLE_PASSWORD,
      DATABASE_JOB_ROLE_PASSWORD: ROLE_PASSWORD,
      POSTGRES_PASSWORD: ROLE_PASSWORD,
      SMTP_URL: `smtp://mailer:${SMTP_PASSWORD}@mail.internal:587`,
      OIDC_ISSUER: 'https://idp.example',
      OIDC_CLIENT_ID: 'assaybank',
      OIDC_CLIENT_SECRET: OIDC_SECRET,
      LIVEKIT_URL: 'wss://sfu.example',
      LIVEKIT_API_KEY: 'livekit-key',
      LIVEKIT_API_SECRET: LIVEKIT_SECRET,
      GRAFANA_ADMIN_PASSWORD: GRAFANA_PASSWORD,
    }),
  );
}

describe('redaction — console.log(config) cannot leak a secret', () => {
  it('redacts every secret from JSON.stringify', () => {
    const serialised = JSON.stringify(configWithSecrets());

    for (const secret of EVERY_SECRET) {
      expect(serialised).not.toContain(secret);
    }
    expect(serialised).toContain(REDACTED);
  });

  it('redacts every secret from util.inspect, which is what console.log uses', () => {
    const rendered = inspect(configWithSecrets(), { depth: null });

    for (const secret of EVERY_SECRET) {
      expect(rendered).not.toContain(secret);
    }
  });

  it('redacts every secret from String() and from template interpolation', () => {
    const config = configWithSecrets();
    /* eslint-disable @typescript-eslint/no-base-to-string -- the redacted toString is
       installed at runtime by attachRedaction, which is exactly what this asserts. */
    const rendered = `${String(config)} ${String(config.secrets)}`;
    /* eslint-enable @typescript-eslint/no-base-to-string */

    for (const secret of EVERY_SECRET) {
      expect(rendered).not.toContain(secret);
    }
    expect(rendered).toContain('AppConfig');
  });

  it('redacts a group dumped on its own, not only the whole object', () => {
    const config = configWithSecrets();

    expect(JSON.stringify(config.secrets)).not.toContain(SESSION);
    expect(JSON.stringify(config.database)).not.toContain(DB_PASSWORD);
    expect(JSON.stringify(config.s3)).not.toContain(S3_SECRET);
    expect(JSON.stringify(config.mail)).not.toContain(SMTP_PASSWORD);
    expect(JSON.stringify(config.oidc)).not.toContain(OIDC_SECRET);
    expect(JSON.stringify(config.livekit)).not.toContain(LIVEKIT_SECRET);
    expect(JSON.stringify(config.local)).not.toContain(GRAFANA_PASSWORD);
    expect(inspect(config.secrets)).not.toContain(PEPPER);
  });

  it('still returns the real value to code that asks for it by name', () => {
    const config = configWithSecrets();

    expect(config.secrets.sessionSecret).toBe(SESSION);
    expect(config.secrets.tokenPepper).toBe(PEPPER);
    expect(config.s3.secretAccessKey).toBe(S3_SECRET);
    expect(config.oidc.enabled ? config.oidc.clientSecret : null).toBe(OIDC_SECRET);
  });

  it('keeps the non-secret fields legible — a redacted dump is still useful', () => {
    const dumped: unknown = JSON.parse(JSON.stringify(configWithSecrets()));

    expect(dumped).toMatchObject({
      core: { appEnv: 'local' },
      http: { port: 8080 },
      database: { appRole: 'hiring_app', poolMax: 10 },
      exec: { memoryMb: 256 },
    });
  });

  it('cannot have its redaction removed or overwritten', () => {
    const config = configWithSecrets();

    expect(Object.isFrozen(config)).toBe(true);
    expect(() => {
      Object.defineProperty(config, 'toJSON', { value: () => config });
    }).toThrow();
  });

  it('does not expose the redaction hooks as enumerable properties', () => {
    const config = configWithSecrets();

    expect(Object.keys(config)).not.toContain('toJSON');
    expect(Object.keys(config.secrets)).toEqual([
      'sessionSecret',
      'tokenPepper',
      'webhookSigningSecretRotationDays',
    ]);
  });
});

describe('redactDsn', () => {
  it('replaces the password and keeps everything an operator needs to recognise', () => {
    expect(redactDsn('postgres://hiring_app:example-dsn-password@db.internal:5432/hiring')).toBe(
      'postgres://hiring_app:[redacted]@db.internal:5432/hiring',
    );
  });

  it('leaves a password-less DSN alone', () => {
    expect(redactDsn('redis://valkey:6379')).toBe('redis://valkey:6379');
  });

  it('redacts an unparseable value whole rather than guessing at its shape', () => {
    expect(redactDsn('not a dsn')).toBe(REDACTED);
  });
});
