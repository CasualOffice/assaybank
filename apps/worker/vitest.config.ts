/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@assaybank/worker',
    root: import.meta.dirname,
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    // The same reasoning as `apps/api` and `packages/db`: `test/integration/` drives a real
    // PostgreSQL in a container, and the bank-import suites write a question at a time in
    // their own transactions. Vitest's 5s default is a flake waiting for a loaded CI runner,
    // and the failure it produces blames the suite rather than the machine.
    testTimeout: 30_000,
    hookTimeout: 300_000,
  },
});
