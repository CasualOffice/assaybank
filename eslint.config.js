/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Flat config. The layering rules of CODE-GRAPH.md §"Layering rules" are enforced
// here rather than in review, so the first violation fails a pull request instead of
// being found six weeks later (P0 step 2).
//
// The layering fixture in tests/fixtures/layering.test.ts proves this file actually
// rejects packages/core-domain importing @assaybank/db. Run it with:
//     pnpm test:fixtures

import js from '@eslint/js';
import importPlugin from 'eslint-plugin-import';
import tseslint from 'typescript-eslint';

const ROOT = import.meta.dirname;

/** Workspace packages that perform I/O, and are therefore closed to the pure packages. */
const IMPURE_PACKAGES = [
  '@assaybank/db',
  '@assaybank/auth',
  '@assaybank/config',
  '@assaybank/observability',
  '@assaybank/exec-adapter',
];

/** Node built-ins and libraries that constitute I/O. */
const IO_MODULES = [
  'node:fs',
  'node:fs/promises',
  'fs',
  'fs/promises',
  'node:http',
  'http',
  'node:http2',
  'node:https',
  'https',
  'node:net',
  'net',
  'node:tls',
  'node:dgram',
  'node:dns',
  'dns',
  'node:child_process',
  'child_process',
  'node:cluster',
  'node:worker_threads',
  'postgres',
  'drizzle-orm',
  'ioredis',
  'bullmq',
  'fastify',
  'pino',
  'ws',
  'y-websocket',
];

/** The five application workspaces. A package may never import one (L1, L4). */
const APP_PACKAGES = [
  '@assaybank/api',
  '@assaybank/worker',
  '@assaybank/collab',
  '@assaybank/web',
  '@assaybank/candidate',
];

const withStar = (names) => names.flatMap((n) => [n, `${n}/*`]);

const PROCESS_ENV_MESSAGE =
  'Read configuration through @assaybank/config. process.env outside packages/config is ' +
  'untyped, unvalidated, and fails at 02:00 rather than at boot (docs/17 §12).';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      '**/.turbo/**',
      '**/*.d.ts',
      'brand/**',
      'infra/**',
      'scripts/**',
      '.github/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,

  // --- baseline for every TypeScript file --------------------------------------
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: ROOT,
      },
    },
    plugins: { import: importPlugin },
    rules: {
      // docs/17 §1. `unknown` at boundaries, narrowed by a zod parse.
      '@typescript-eslint/no-explicit-any': 'error',
      // docs/17 §1. `!` in scoring or draw-resolution code is how a candidate gets NaN.
      '@typescript-eslint/no-non-null-assertion': 'error',
      // verbatimModuleSyntax keeps every import in the emitted JavaScript, so a
      // type-only import that is not marked as one becomes a real runtime require.
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      eqeqeq: ['error', 'always', { null: 'ignore' }],

      // docs/17 §12: reading process.env outside packages/config is an anti-pattern
      // with a named failure mode. Both forms are covered — member access and
      // computed access — because only banning the first is an invitation.
      'no-restricted-properties': [
        'error',
        { object: 'process', property: 'env', message: PROCESS_ENV_MESSAGE },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: 'MemberExpression[object.name="process"][property.name="env"]',
          message: PROCESS_ENV_MESSAGE,
        },
        {
          selector: 'MemberExpression[object.name="process"][property.value="env"]',
          message: PROCESS_ENV_MESSAGE,
        },
      ],

      // L1 and L4, for relative-path crossings. The package-name form is covered by
      // the no-restricted-imports blocks below.
      'import/no-restricted-paths': [
        'error',
        {
          zones: [
            {
              target: './packages',
              from: './apps',
              message: 'L1: a package must never import an app (CODE-GRAPH.md).',
            },
            {
              target: './packages/core-domain',
              from: './packages/db',
              message: 'L2: core-domain is pure and may not reach the database.',
            },
            {
              target: './packages/grading',
              from: './packages/db',
              message: 'L2: grading is pure and may not reach the database.',
            },
            {
              target: './apps/api',
              from: './packages/exec-adapter',
              message: 'L6: the API must not execute code on the request path.',
            },
            {
              target: './apps/collab',
              from: './packages/exec-adapter',
              message: 'L6: in-session runs go through the API and grading.run.',
            },
            {
              target: './apps/candidate',
              from: './packages/db',
              message: 'L5: the candidate bundle must be incapable of bank access.',
            },
          ],
        },
      ],
    },
  },

  // --- L1/L4: no package may import an app -------------------------------------
  {
    files: ['packages/*/src/**/*.ts', 'packages/*/src/**/*.tsx'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: withStar(APP_PACKAGES),
              message: 'L1: a package must never import an app (CODE-GRAPH.md).',
            },
          ],
        },
      ],
    },
  },

  // --- L2: core-domain, grading and markdown stay pure -------------------------
  // This block deliberately restates the app ban: no-restricted-imports is replaced
  // wholesale by a later matching config, never merged, so the stricter list has to
  // be a superset.
  {
    files: [
      'packages/core-domain/**/*.ts',
      'packages/grading/**/*.ts',
      'packages/markdown/**/*.ts',
      'packages/core-domain/**/*.tsx',
      'packages/grading/**/*.tsx',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: withStar(APP_PACKAGES),
              message: 'L1: a package must never import an app (CODE-GRAPH.md).',
            },
            {
              group: withStar(IMPURE_PACKAGES),
              message:
                'L2: core-domain, grading and markdown import no I/O. Scoring and the ' +
                'attempt state machine must be reproducible from their inputs alone, which is ' +
                'what makes a re-grade deterministic (ADR-008), and the markdown parser must ' +
                'be safe to run in a candidate bundle. Pass the value in as an argument.',
            },
            {
              group: IO_MODULES,
              message:
                'L2: core-domain, grading and markdown import no I/O — no filesystem, no ' +
                'network, no database client, no clock that was not passed in (CODE-GRAPH.md).',
            },
            {
              group: ['**/apps/**'],
              message: 'L1: a package must never import an app (CODE-GRAPH.md).',
            },
          ],
        },
      ],
    },
  },

  // --- L5: the candidate bundle and the shared component library ---------------
  {
    files: ['apps/candidate/src/**/*.ts', 'apps/candidate/src/**/*.tsx'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: withStar([
                '@assaybank/db',
                '@assaybank/auth',
                '@assaybank/core-domain',
                '@assaybank/grading',
                '@assaybank/exec-adapter',
                '@assaybank/web',
              ]),
              message:
                'L5: the candidate bundle must be incapable of carrying bank access, ' +
                'correct-answer logic or scoring rules, whatever a future refactor does ' +
                '(CODE-GRAPH.md, ADR-013).',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['apps/web/src/**/*.ts', 'apps/web/src/**/*.tsx'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: withStar(['@assaybank/db', '@assaybank/exec-adapter', '@assaybank/candidate']),
              message:
                'L5/L6: the console talks to the API, never to Postgres, and execution goes ' +
                'through the API and the queue (CODE-GRAPH.md).',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['packages/ui/src/**/*.ts', 'packages/ui/src/**/*.tsx'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: withStar([
                ...APP_PACKAGES,
                ...IMPURE_PACKAGES,
                '@assaybank/core-domain',
                '@assaybank/grading',
              ]),
              message:
                'L5: packages/ui is presentation only and imports no workspace package other ' +
                'than contracts (types only) and markdown (pure, no I/O), so it can never ' +
                'drag server code into a candidate bundle (CODE-GRAPH.md).',
            },
          ],
        },
      ],
    },
  },

  // --- L6: only apps/worker may import the execution adapter -------------------
  {
    files: ['apps/api/src/**/*.ts', 'apps/collab/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: withStar(['@assaybank/exec-adapter']),
              message:
                'L6: execution belongs behind the queue. If the API could call execute() ' +
                'directly, a slow sandbox would become a slow request (CODE-GRAPH.md).',
            },
          ],
        },
      ],
    },
  },

  // --- packages/config is the one place process.env is legal -------------------
  {
    files: ['packages/config/src/**/*.ts'],
    rules: {
      'no-restricted-properties': 'off',
      'no-restricted-syntax': 'off',
    },
  },

  // --- plain JavaScript configuration files need no type information -----------
  {
    files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
    extends: [tseslint.configs.disableTypeChecked],
  },
);
