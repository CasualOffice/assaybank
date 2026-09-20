/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@assaybank/api',
    root: import.meta.dirname,
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    // Vitest's default is 5s, which is generous for a unit test and marginal for these.
    // `test/integration/` drives a real Fargate-less PostgreSQL in a container through the
    // real Fastify app, and the login suite verifies Argon2id at the OWASP cost — work that
    // is *deliberately* slow, and whose first call also pays for loading the native module.
    // On an unloaded laptop the whole file passes in about a second of test time; on a
    // shared CI runner the first login exceeded 5s and failed a suite that was not broken.
    //
    // Raising the ceiling hides nothing: a test that genuinely hangs still fails, twelve
    // seconds later. Leaving it at 5s buys a flake, and docs/17 §8 does not tolerate one.
    testTimeout: 30_000,
    hookTimeout: 300_000,
  },
});
