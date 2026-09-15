/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The module-level `config` object — the one an application imports.
 *
 * It lives in `src/` rather than in `test/` because it is the one test that has to
 * manipulate the process environment, and `packages/config/src` is the only place the
 * `no-restricted-properties` rule in `eslint.config.js` permits that.
 *
 * Each case re-imports the module under a different environment, because parsing
 * happens once, at module load, by design.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import type * as ConfigModule from './index.js';

/** The six variables with no default: credentials that must never fall back. */
const CREDENTIALS: Readonly<Record<string, string>> = {
  DATABASE_URL: 'postgres://hiring_app:hiring_app@postgres:5432/hiring',
  DATABASE_JOB_URL: 'postgres://hiring_job:hiring_job@postgres:5432/hiring',
  DATABASE_OWNER_URL: 'postgres://hiring:hiring@postgres:5432/hiring',
  S3_ACCESS_KEY_ID: 'hiring-dev-access-key',
  S3_SECRET_ACCESS_KEY: 'hiring-dev-secret-key',
  SESSION_SECRET: 'a-local-development-session-secret',
  TOKEN_PEPPER: 'a-local-development-token-pepper',
};

async function importFresh(env: Readonly<Record<string, string>>): Promise<typeof ConfigModule> {
  vi.resetModules();
  vi.unstubAllEnvs();
  for (const [name, value] of Object.entries(env)) {
    vi.stubEnv(name, value);
  }
  return import('./index.js');
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('config', () => {
  it('names itself with the workspace name declared in package.json', async () => {
    const { WORKSPACE_NAME } = await importFresh(CREDENTIALS);

    expect(WORKSPACE_NAME).toBe('@assaybank/config');
  });

  it('exposes the parsed environment of this process', async () => {
    const { config } = await importFresh({ ...CREDENTIALS, APP_ENV: 'ci', API_PORT: '9090' });

    expect(config.core.appEnv).toBe('ci');
    expect(config.http.port).toBe(9090);
    expect(config.secrets.tokenPepper).toBe(CREDENTIALS.TOKEN_PEPPER);
  });

  it('is frozen', async () => {
    const { config } = await importFresh(CREDENTIALS);

    expect(Object.isFrozen(config)).toBe(true);
  });

  it('is redacted when printed, exactly like a configuration built by loadConfig', async () => {
    const { config } = await importFresh({
      ...CREDENTIALS,
      SESSION_SECRET: 'module-level-secret-value',
    });

    expect(JSON.stringify(config)).not.toContain('module-level-secret-value');
    expect(JSON.stringify(config)).toContain('[redacted]');
    /* eslint-disable @typescript-eslint/no-base-to-string -- the redacted toString is
       installed at runtime by attachRedaction, which is exactly what this asserts. */
    expect(String(config)).toContain('AppConfig');
    /* eslint-enable @typescript-eslint/no-base-to-string */
  });

  it('throws the ConfigError on first access when the environment is invalid', async () => {
    const { config, ConfigError } = await importFresh({ ...CREDENTIALS, SESSION_SECRET: '' });

    // The failure is captured at module load and rethrown on use, so importing this
    // package never detonates inside a module that does not read configuration — but
    // an application that reads one field at boot still fails immediately.
    expect(() => config.secrets).toThrow(ConfigError);
    expect(() => config.http).toThrow(/SESSION_SECRET/);
  });

  it('renders a diagnostic rather than throwing when an unloaded config is printed', async () => {
    const { config } = await importFresh({ ...CREDENTIALS, DATABASE_URL: '' });

    const dumped: unknown = JSON.parse(JSON.stringify(config));

    expect(dumped).toMatchObject({ error: 'configuration not loaded' });
    expect(JSON.stringify(dumped)).toContain('DATABASE_URL');
  });
});
