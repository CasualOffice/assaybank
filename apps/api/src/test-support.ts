/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Fixtures shared by this workspace's tests.
 *
 * It lives under `src/` rather than under `test/` so that the type checker sees it with
 * the same project as the code it exercises; `tsconfig.build.json` excludes it from the
 * emitted bundle alongside the tests themselves.
 */

import type { FastifyBaseLogger, FastifyInstance } from 'fastify';

import { PERMISSIONS, type KnownPermission, type Principal } from '@assaybank/auth';

import { requirePermission } from './authorisation.js';
import { setPrincipal } from './principal.js';
import { buildServer, type ApiServerConfig } from './server.js';

/**
 * A configuration literal that satisfies exactly what the server reads.
 *
 * Typed as {@link ApiServerConfig} so that it fails to compile the day the server starts
 * reading a field the real `AppConfig` renamed — which is the only reason to have a
 * fixture rather than a cast.
 */
export function testConfig(overrides: Partial<ApiServerConfig> = {}): ApiServerConfig {
  return {
    core: { appEnv: 'ci', isDeployedTier: false },
    http: {
      corsAllowedOrigins: ['https://console.example.test'],
      candidatePublicUrl: 'https://sit.example.test',
    },
    telemetry: { serviceName: 'hiring-api-test' },
    ...overrides,
  };
}

/** The path the permission-matrix server serves for one permission key. */
export function matrixPath(permission: KnownPermission): string {
  return `/test-matrix/${permission}`;
}

/** Options for {@link permissionMatrixServer}. */
export interface PermissionMatrixOptions {
  /** Attached to every request by an `onRequest` hook. Omitted means no credential. */
  readonly principal?: Principal | undefined;
  /** Passed through to `buildServer`, for a suite that wants to read the log. */
  readonly logger?: FastifyBaseLogger | false | undefined;
}

/**
 * A real server carrying one route per seeded permission, each declaring exactly that
 * permission and nothing else.
 *
 * The shape every authorisation assertion wants: drive all eleven routes with one
 * principal and compare the set that answered 200 against the set the principal holds.
 * A per-test bespoke route proves that *a* permission is checked; the matrix proves that
 * the *right* one is, which is the failure a single route cannot see — a check that
 * accidentally asks for `question.read` everywhere passes every single-route test ever
 * written.
 *
 * The routes are registered as a plugin, deferred, for the reason server.ts gives: a
 * route added synchronously to a returned instance is added before the deferred
 * `onRoute` hooks of the plugins registered above it exist.
 */
export function permissionMatrixServer(options: PermissionMatrixOptions = {}): FastifyInstance {
  const app = buildServer({ config: testConfig(), logger: options.logger ?? false });

  const { principal } = options;
  if (principal !== undefined) {
    // Stands in for the authentication plugin of P1 step 3: something earlier in the
    // lifecycle than the check deposits a principal it has already verified.
    app.addHook('onRequest', (request, _reply, done) => {
      setPrincipal(request, principal);
      done();
    });
  }

  void app.register((instance, _opts, done) => {
    for (const permission of PERMISSIONS) {
      instance.get(matrixPath(permission), { config: requirePermission(permission) }, () => ({
        permission,
      }));
    }
    done();
  });

  return app;
}

/** A pino destination that keeps every line in memory, for asserting on what was logged. */
export interface CapturedLog {
  readonly lines: string[];
  readonly destination: { write(chunk: string): void };
  /** Every captured line parsed as JSON. */
  records(): Record<string, unknown>[];
}

/** Creates a {@link CapturedLog}. */
export function captureLog(): CapturedLog {
  const lines: string[] = [];
  return {
    lines,
    destination: {
      write(chunk: string): void {
        lines.push(chunk);
      },
    },
    records(): Record<string, unknown>[] {
      return lines
        .flatMap((line) => line.split('\n'))
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line) as Record<string, unknown>);
    },
  };
}
