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

import type { ApiServerConfig } from './server.js';

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
    http: { corsAllowedOrigins: ['https://console.example.test'] },
    telemetry: { serviceName: 'hiring-api-test' },
    ...overrides,
  };
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
