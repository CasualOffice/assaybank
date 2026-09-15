/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@assaybank/db',
    root: import.meta.dirname,
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts', 'tests/**/*.test.ts'],
    // The isolation suite starts a Postgres container; give it room to pull the image.
    testTimeout: 180_000,
    hookTimeout: 300_000,
  },
});
