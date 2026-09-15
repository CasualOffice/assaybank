/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Root Vitest configuration (P0 step 12).
//
// Every workspace is its own project, discovered by glob, so adding a directory under
// apps/ or packages/ is all that is needed to have its tests run from the root.
//
// 'leak' and 'fixtures' are separate named projects on purpose: the leak suite is a
// standing, separately named CI job so a failure is unambiguous in the pull request
// checks (P0 step 13, docs/17 §8), and the layering fixture shells out to ESLint and
// is far slower than a unit test.

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      'packages/*',
      'apps/*',
      {
        test: {
          name: 'leak',
          root: import.meta.dirname,
          environment: 'node',
          include: ['tests/leak/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'fixtures',
          root: import.meta.dirname,
          environment: 'node',
          include: ['tests/fixtures/**/*.test.ts'],
          testTimeout: 300_000,
          hookTimeout: 300_000,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      reportsDirectory: './coverage',
      include: ['packages/*/src/**/*.ts', 'apps/*/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/*.test.tsx', '**/dist/**'],
    },
  },
});
