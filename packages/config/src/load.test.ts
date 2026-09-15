/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';

import { ConfigError, loadConfig } from './index.js';

import { envWith, productionEnv, REAL_SECRET } from '../test/env-fixture.js';

/** Runs `loadConfig` and returns the `ConfigError` it must have thrown. */
function expectFailure(env: NodeJS.ProcessEnv): ConfigError {
  try {
    loadConfig(env);
  } catch (error: unknown) {
    if (error instanceof ConfigError) return error;
    throw error;
  }
  throw new Error('loadConfig resolved, but the environment should have been rejected');
}

describe('loadConfig — the happy path', () => {
  it('parses the committed example environment into a typed object', () => {
    const config = loadConfig(envWith());

    expect(config.core).toEqual({
      nodeEnv: 'development',
      logLevel: 'debug',
      appEnv: 'local',
      isDeployedTier: false,
    });
    expect(config.http.port).toBe(8080);
    expect(config.http.corsAllowedOrigins).toEqual([
      'http://localhost:5173',
      'http://localhost:5174',
    ]);
    expect(config.database.poolMax).toBe(10);
    expect(config.exec.memoryBytes).toBe(268_435_456);
    expect(config.queues.maxAttempts).toBe(3);
    expect(config.telemetry.tracesSamplerArg).toBe(1);
    expect(config.retention.auditLogYears).toBe(7);
    expect(config.local.webPort).toBe(5173);
  });

  it('freezes the object and every group inside it', () => {
    const config = loadConfig(envWith());

    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.secrets)).toBe(true);
    expect(Object.isFrozen(config.http.corsAllowedOrigins)).toBe(true);
  });

  it('coerces strings to the declared types rather than leaving them as strings', () => {
    const config = loadConfig(
      envWith({ S3_FORCE_PATH_STYLE: 'no', OTEL_TRACES_SAMPLER_ARG: '0.25' }),
    );

    expect(config.s3.forcePathStyle).toBe(false);
    expect(config.telemetry.tracesSamplerArg).toBe(0.25);
    expect(typeof config.collab.port).toBe('number');
  });

  it('strips a trailing slash so an invitation link never contains "//"', () => {
    const config = loadConfig(envWith({ CANDIDATE_PUBLIC_URL: 'http://localhost:5174/' }));

    expect(config.http.candidatePublicUrl).toBe('http://localhost:5174');
  });

  it('applies the tier-dependent LOG_LEVEL default of docs/13 §4.1', () => {
    expect(loadConfig(envWith({ LOG_LEVEL: undefined })).core.logLevel).toBe('debug');
    expect(loadConfig(productionEnv({ LOG_LEVEL: undefined })).core.logLevel).toBe('info');
  });
});

describe('loadConfig — a missing required variable', () => {
  it('names the variable rather than letting an undefined escape', () => {
    const error = expectFailure(envWith({ SESSION_SECRET: undefined }));

    expect(error).toBeInstanceOf(ConfigError);
    expect(error.variable).toBe('SESSION_SECRET');
    expect(error.variables).toEqual(['SESSION_SECRET']);
    expect(error.message).toContain('SESSION_SECRET');
    expect(error.message).toContain('the variable is not set');
  });

  it('treats an empty value as missing, because VAR= means unset in an env file', () => {
    expect(expectFailure(envWith({ TOKEN_PEPPER: '' })).variable).toBe('TOKEN_PEPPER');
  });

  it('reports every missing credential at once, not one per run', () => {
    const error = expectFailure({});

    expect([...error.variables].sort()).toEqual([
      'DATABASE_JOB_URL',
      'DATABASE_OWNER_URL',
      'DATABASE_URL',
      'S3_ACCESS_KEY_ID',
      'S3_SECRET_ACCESS_KEY',
      'SESSION_SECRET',
      'TOKEN_PEPPER',
    ]);
  });
});

describe('loadConfig — a malformed value', () => {
  it('rejects a URL that is not a URL', () => {
    const error = expectFailure(envWith({ API_PUBLIC_URL: 'localhost:8080' }));

    expect(error.variable).toBe('API_PUBLIC_URL');
    expect(error.message).toContain('an absolute http:// or https:// URL');
    expect(error.message).toContain('"localhost:8080"');
  });

  it('rejects a URL with the wrong scheme', () => {
    expect(expectFailure(envWith({ COLLAB_PUBLIC_URL: 'http://localhost:8081' })).variable).toBe(
      'COLLAB_PUBLIC_URL',
    );
    expect(expectFailure(envWith({ DATABASE_URL: 'mysql://h/db' })).variable).toBe('DATABASE_URL');
  });

  it('rejects a wildcard origin — the candidate app holds attempt tokens', () => {
    expect(expectFailure(envWith({ CORS_ALLOWED_ORIGINS: '*' })).variable).toBe(
      'CORS_ALLOWED_ORIGINS',
    );
    expect(expectFailure(envWith({ CORS_ALLOWED_ORIGINS: 'https://*.example.com' })).variable).toBe(
      'CORS_ALLOWED_ORIGINS',
    );
  });

  it('rejects an origin carrying a path, which is not an origin', () => {
    expect(
      expectFailure(envWith({ CORS_ALLOWED_ORIGINS: 'http://localhost:5173/app' })).variable,
    ).toBe('CORS_ALLOWED_ORIGINS');
  });

  it('rejects a value outside the declared enum', () => {
    expect(expectFailure(envWith({ LOG_LEVEL: 'verbose' })).variable).toBe('LOG_LEVEL');
    expect(expectFailure(envWith({ APP_ENV: 'prod' })).variable).toBe('APP_ENV');
  });

  it('rejects a non-numeric value where a number is declared', () => {
    const error = expectFailure(envWith({ API_PORT: 'eighty-eighty' }));

    expect(error.variable).toBe('API_PORT');
    expect(error.message).toContain('an integer between 1 and 65535');
  });
});

describe('loadConfig — an out-of-range number', () => {
  it('rejects a pool size of zero', () => {
    const error = expectFailure(envWith({ DATABASE_POOL_MAX: '0' }));

    expect(error.variable).toBe('DATABASE_POOL_MAX');
    expect(error.message).toContain('an integer between 1 and 1000');
    expect(error.message).toContain('"0"');
  });

  it('rejects a port above 65535', () => {
    expect(expectFailure(envWith({ API_PORT: '70000' })).variable).toBe('API_PORT');
  });

  it('rejects a sampling ratio above 1.0', () => {
    expect(expectFailure(envWith({ OTEL_TRACES_SAMPLER_ARG: '2.5' })).variable).toBe(
      'OTEL_TRACES_SAMPLER_ARG',
    );
  });

  it('rejects a retention clock above its docs/11 §4.1 ceiling', () => {
    // Article 9 biometric data. The ceiling is a legal position, not a preference.
    expect(expectFailure(envWith({ RETENTION_PROCTOR_MEDIA_DAYS: '60' })).variable).toBe(
      'RETENTION_PROCTOR_MEDIA_DAYS',
    );
    expect(expectFailure(envWith({ RETENTION_CANDIDATE_PII_MONTHS: '36' })).variable).toBe(
      'RETENTION_CANDIDATE_PII_MONTHS',
    );
  });

  it('rejects an audit-log retention below its floor', () => {
    expect(expectFailure(envWith({ RETENTION_AUDIT_LOG_YEARS: '1' })).variable).toBe(
      'RETENTION_AUDIT_LOG_YEARS',
    );
  });
});

describe('loadConfig — cross-field rules', () => {
  it('rejects EXEC_MEMORY_MB_BYTES that disagrees with EXEC_MEMORY_MB', () => {
    const error = expectFailure(envWith({ EXEC_MEMORY_MB: '512' }));

    expect(error.variable).toBe('EXEC_MEMORY_MB_BYTES');
    expect(error.message).toContain('536870912');
  });

  it('accepts the two exec memory limits when they agree', () => {
    const config = loadConfig(
      envWith({ EXEC_MEMORY_MB: '512', EXEC_MEMORY_MB_BYTES: '536870912' }),
    );

    expect(config.exec.memoryMb).toBe(512);
    expect(config.exec.memoryBytes).toBe(536_870_912);
  });

  it('rejects a wall-clock ceiling below the CPU ceiling', () => {
    const error = expectFailure(envWith({ EXEC_WALL_TIME_MS: '1000' }));

    expect(error.variable).toBe('EXEC_WALL_TIME_MS');
    expect(error.message).toContain('at least EXEC_CPU_TIME_MS');
  });

  it('leaves staff SSO disabled when every OIDC variable is empty', () => {
    const config = loadConfig(envWith());

    expect(config.oidc).toEqual({ enabled: false });
  });

  it('rejects half-configured staff SSO', () => {
    const error = expectFailure(envWith({ OIDC_ISSUER: 'https://idp.example' }));

    expect([...error.variables].sort()).toEqual(['OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET']);
  });

  it('enables staff SSO when all three OIDC variables are present', () => {
    const config = loadConfig(
      envWith({
        OIDC_ISSUER: 'https://idp.example',
        OIDC_CLIENT_ID: 'assaybank',
        OIDC_CLIENT_SECRET: 'a-client-secret',
      }),
    );

    expect(config.oidc.enabled).toBe(true);
    expect(config.oidc.enabled ? config.oidc.issuer : null).toBe('https://idp.example');
  });

  it('rejects half-configured live video', () => {
    const error = expectFailure(envWith({ LIVEKIT_API_KEY: 'key' }));

    expect([...error.variables].sort()).toEqual(['LIVEKIT_API_SECRET', 'LIVEKIT_URL']);
  });

  it('enables live video when all three LiveKit variables are present', () => {
    const config = loadConfig(
      envWith({
        LIVEKIT_URL: 'wss://sfu.example',
        LIVEKIT_API_KEY: 'key',
        LIVEKIT_API_SECRET: 'secret-value',
      }),
    );

    expect(config.livekit.enabled).toBe(true);
  });
});

describe('loadConfig — the staging and production tightenings (docs/13 §4.16)', () => {
  it('accepts a well-formed production environment', () => {
    const config = loadConfig(productionEnv());

    expect(config.core.appEnv).toBe('production');
    expect(config.core.isDeployedTier).toBe(true);
    expect(config.http.candidatePublicUrl).toBe('https://assess.assaybank.example');
  });

  it('requires NODE_ENV=production in a deployed tier', () => {
    const error = expectFailure(envWith({ APP_ENV: 'staging' }));

    expect(error.variables).toContain('NODE_ENV');
  });

  it('requires https on every public URL', () => {
    const error = expectFailure(
      productionEnv({ CANDIDATE_PUBLIC_URL: 'http://assess.assaybank.example' }),
    );

    expect(error.variables).toEqual(['CANDIDATE_PUBLIC_URL']);
    expect(error.message).toContain('https:// URL in production');
  });

  it('requires wss on the collaboration URL', () => {
    const error = expectFailure(productionEnv({ COLLAB_PUBLIC_URL: 'ws://collab.example' }));

    expect(error.variables).toEqual(['COLLAB_PUBLIC_URL']);
  });

  it('requires a secret of at least 32 bytes', () => {
    const error = expectFailure(productionEnv({ TOKEN_PEPPER: 'too-short-but-valid' }));

    expect(error.variables).toEqual(['TOKEN_PEPPER']);
    expect(error.message).toContain('openssl rand -hex 32');
  });

  it('rejects a .env.example placeholder that survived the deploy', () => {
    const error = expectFailure(productionEnv({ SESSION_SECRET: 'CHANGE_ME_openssl_rand_hex_32' }));

    expect(error.variables).toContain('SESSION_SECRET');
    expect(error.message).toContain('the .env.example placeholder is public');
  });

  it('rejects the committed development password inside a database DSN', () => {
    const error = expectFailure(
      productionEnv({ DATABASE_URL: 'postgres://hiring_app:hiring_app@db.internal:5432/hiring' }),
    );

    expect(error.variables).toEqual(['DATABASE_URL']);
  });

  it('leaves the local tier alone — the example file is a valid local environment', () => {
    expect(() => loadConfig(envWith())).not.toThrow();
  });
});

describe('ConfigError', () => {
  it('never puts a secret value in the message', () => {
    const error = expectFailure(envWith({ SESSION_SECRET: 'sekrit' }));

    expect(error.message).not.toContain('sekrit');
    expect(error.message).toContain('a secret value of 6 characters (not shown)');
    expect(error.issues[0]?.received).not.toContain('sekrit');
  });

  it('never puts a real secret in the message when the tightenings reject it', () => {
    const error = expectFailure(productionEnv({ SESSION_SECRET: 'short-but-eight' }));

    expect(error.message).not.toContain('short-but-eight');
  });

  it('carries the expected and received detail per variable', () => {
    const error = expectFailure(envWith({ QUEUE_MAX_ATTEMPTS: '99' }));

    expect(error.issues).toHaveLength(1);
    expect(error.issues[0]).toMatchObject({
      variable: 'QUEUE_MAX_ATTEMPTS',
      expected: 'an integer between 1 and 20',
      received: '"99"',
    });
  });

  it('is an Error with a stable name, so a catch site can identify it', () => {
    const error = expectFailure({});

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('ConfigError');
  });

  it('collects unrelated failures into one report', () => {
    const error = expectFailure(envWith({ API_PORT: '0', LOG_LEVEL: 'shout', S3_BUCKET: 'A' }));

    expect([...error.variables].sort()).toEqual(['API_PORT', 'LOG_LEVEL', 'S3_BUCKET']);
    expect(error.message).toContain('3 problems found');
  });
});

describe('loadConfig is pure given its argument', () => {
  it('returns an equal object for an equal environment and shares no state', () => {
    const first = loadConfig(envWith({ SESSION_SECRET: REAL_SECRET }));
    const second = loadConfig(envWith({ SESSION_SECRET: REAL_SECRET }));

    expect(first).not.toBe(second);
    expect(JSON.parse(JSON.stringify(first))).toEqual(JSON.parse(JSON.stringify(second)));
  });

  it('does not mutate the environment it is given', () => {
    const env = envWith();
    const before = { ...env };

    loadConfig(env);

    expect(env).toEqual(before);
  });
});
