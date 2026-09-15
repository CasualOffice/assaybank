/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The candidate bundle's own lint configuration (ADR-013, P0 step 11).
 *
 * ## Why this file exists when the root config already has the rule
 *
 * The root `eslint.config.js` carries an L5 block for `apps/candidate`, and it fires when
 * `pnpm lint` runs from the repository root. This file fires when ESLint runs from inside
 * this workspace — `pnpm --filter @assaybank/candidate lint`, `turbo run lint`, and every
 * editor integration, all of which resolve the nearest `eslint.config.js` and use it
 * alone.
 *
 * So this is not redundancy for its own sake. It means the guarantee ADR-013 makes
 * survives an edit to a file this workspace does not own. The root config belongs to the
 * whole repository and is modified by every agent and every phase; the check that a
 * candidate's browser cannot receive an answer key should not be one careless edit to
 * somebody else's file away from being switched off. Two independent configurations have
 * to both be wrong before the bundle opens up, and the third check — the built-artefact
 * scan in `scripts/check-bundle.mjs` — does not depend on ESLint at all.
 *
 * ## What is forbidden here
 *
 * - `@assaybank/db` — bank and answer-key access must not exist in this bundle.
 * - `@assaybank/auth`, **including its internals** — server-side token minting and
 *   permission evaluation must not exist in a browser bundle. The deep-path patterns
 *   matter: a barrel file can be made to look innocent, and `@assaybank/auth/tokens` is
 *   the import someone reaches for when they want "just the one helper".
 * - `@assaybank/core-domain` — the question draw and the attempt state machine are
 *   server decisions (ADR-004, ADR-006).
 * - `@assaybank/grading` — scoring rules in the client are a leak of correct answers.
 * - `@assaybank/exec-adapter` — candidates never address the sandbox directly.
 * - `@assaybank/api`, `@assaybank/worker`, `@assaybank/collab`, `@assaybank/web`, and any
 *   relative path under `apps/` — an app must never import another app (L4). A direct
 *   app-to-app import is how a staff-only module ends up in the candidate bundle, and
 *   relative-path escapes (`../../web/src/...`) are covered because a package-name ban
 *   alone is an invitation to write the relative form.
 *
 * `@assaybank/contracts` and `@assaybank/ui` are the two internal dependencies this
 * workspace may have, and they are the two it declares.
 */

import js from '@eslint/js';
import tseslint from 'typescript-eslint';

const APP_ROOT = import.meta.dirname;

/** The packages whose presence in this bundle would defeat ADR-013. */
const FORBIDDEN_PACKAGES = [
  '@assaybank/db',
  '@assaybank/auth',
  '@assaybank/core-domain',
  '@assaybank/grading',
  '@assaybank/exec-adapter',
  '@assaybank/api',
  '@assaybank/worker',
  '@assaybank/collab',
  '@assaybank/web',
  '@assaybank/config',
  '@assaybank/observability',
];

/**
 * Both the bare name and every path under it.
 *
 * `@assaybank/auth` alone does not stop `@assaybank/auth/src/tokens`, and "internals"
 * is exactly where someone goes when the barrel file looks too heavy to import.
 */
const withSubpaths = (names) => names.flatMap((name) => [name, `${name}/*`, `${name}/**`]);

const L5_MESSAGE =
  'ADR-013 / CODE-GRAPH L5: apps/candidate is a separate bundle so that staff-only code, ' +
  'correct-answer handling and question-bank access cannot reach a candidate browser. ' +
  'Route guards gate rendering, not the bundle — whatever this module links is readable ' +
  'with devtools open on an internet-facing origin. Move the behaviour behind the API ' +
  'and fetch a candidate-scoped response instead.';

const PROCESS_ENV_MESSAGE =
  'Read configuration through @assaybank/config on the server. In a browser bundle, ' +
  'process.env is inlined at build time, which is how a server secret ends up in a ' +
  'candidate download (docs/17 §12).';

export default tseslint.config(
  {
    ignores: ['dist/**', 'coverage/**', 'node_modules/**', '.turbo/**', '**/*.d.ts'],
  },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,

  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: APP_ROOT,
      },
    },
    rules: {
      // docs/17 §1, restated so this workspace's baseline does not depend on the root.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      eqeqeq: ['error', 'always', { null: 'ignore' }],

      'no-restricted-properties': [
        'error',
        { object: 'process', property: 'env', message: PROCESS_ENV_MESSAGE },
      ],

      // The enforcement. Deep paths and relative escapes included, because a ban that
      // only covers the tidy form of the import is a ban on tidiness.
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: withSubpaths(FORBIDDEN_PACKAGES), message: L5_MESSAGE },
            {
              group: ['**/apps/web/**', '**/apps/api/**', '**/apps/worker/**', '**/apps/collab/**'],
              message: L5_MESSAGE,
            },
            {
              group: [
                '**/packages/db/**',
                '**/packages/auth/**',
                '**/packages/core-domain/**',
                '**/packages/grading/**',
                '**/packages/exec-adapter/**',
              ],
              message: L5_MESSAGE,
            },
            {
              // Reaching sideways out of the workspace at all. Anything shared belongs in
              // a package, and the only two packages this bundle may have are declared in
              // package.json.
              group: ['../../*', '../../**'],
              message:
                'ADR-013: apps/candidate may not reach outside its own workspace by ' +
                'relative path. Its dependency closure is the enforcement mechanism, and ' +
                'a relative escape is a dependency the closure does not record.',
            },
          ],
        },
      ],

      // `no-restricted-syntax` is the belt to the import ban's braces: a dynamic
      // `import('@assaybank/db')` or `require('@assaybank/db')` is not an import
      // declaration and slips past `no-restricted-imports` entirely.
      'no-restricted-syntax': [
        'error',
        {
          selector:
            'ImportExpression > Literal[value=/^@assaybank\\u002F(db|auth|core-domain|grading|exec-adapter|api|worker|collab|web|config|observability)/]',
          message: L5_MESSAGE,
        },
        {
          selector:
            'CallExpression[callee.name="require"] > Literal[value=/^@assaybank\\u002F(db|auth|core-domain|grading|exec-adapter|api|worker|collab|web|config|observability)/]',
          message: L5_MESSAGE,
        },
        {
          // `import('../../web/src/thing')` — the relative form of the same escape.
          // `no-restricted-imports` covers the static spelling; this covers the dynamic
          // one, which is the spelling someone reaches for when the static one is
          // rejected.
          selector: 'ImportExpression > Literal[value=/^\\.\\.\\u002F\\.\\./]',
          message:
            'ADR-013: apps/candidate may not reach outside its own workspace by relative ' +
            'path, statically or dynamically. Its dependency closure is the enforcement ' +
            'mechanism, and a relative escape is a dependency the closure does not record.',
        },
        {
          selector: 'MemberExpression[object.name="process"][property.name="env"]',
          message: PROCESS_ENV_MESSAGE,
        },
      ],
    },
  },

  // Vite and Vitest configuration files run in Node and legitimately name the workspace's
  // own tooling; they are still covered by the import ban above.
  {
    files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
    extends: [tseslint.configs.disableTypeChecked],
    rules: {
      // The bundle check is a Node script: it names every forbidden marker as a string
      // literal on purpose, and it is never part of the bundle.
      'no-restricted-imports': 'off',
      'no-restricted-syntax': 'off',
    },
  },
);
