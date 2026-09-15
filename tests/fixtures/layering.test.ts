/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The layering fixture (P0 step 2).
 *
 * CODE-GRAPH.md declares directions that must hold — apps may import packages,
 * packages never import apps, and `core-domain` and `grading` import no I/O at all.
 * `eslint.config.js` encodes that. This test proves the encoding actually works,
 * because a lint rule nobody has watched fail is a lint rule nobody knows is wired up.
 *
 * How it works. It writes a single-file fixture into `packages/core-domain/src`,
 * shells out to the real ESLint with the real repository configuration, and asserts
 * the exit status and the rule that fired. The fixture is removed again in a `finally`
 * and before every case, so no violating import is ever left standing in the tree; the
 * filename is also in `.gitignore` in case a hard kill interrupts the cleanup.
 *
 * Run it on its own with:
 *
 *     pnpm test:fixtures
 *
 * Expect it to take tens of seconds: it starts a fresh type-aware ESLint process.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const ESLINT_BIN = join(REPO_ROOT, 'node_modules', 'eslint', 'bin', 'eslint.js');
const FIXTURE_PATH = join(
  REPO_ROOT,
  'packages',
  'core-domain',
  'src',
  'layering-fixture.generated.ts',
);

const LICENCE_HEADER = [
  '/* This Source Code Form is subject to the terms of the Mozilla Public',
  ' * License, v. 2.0. If a copy of the MPL was not distributed with this',
  ' * file, You can obtain one at https://mozilla.org/MPL/2.0/. */',
].join('\n');

interface EslintMessage {
  readonly ruleId: string | null;
  readonly message: string;
}

interface EslintFileResult {
  readonly filePath: string;
  readonly errorCount: number;
  readonly messages: readonly EslintMessage[];
}

interface LintOutcome {
  readonly status: number;
  readonly results: readonly EslintFileResult[];
  readonly raw: string;
}

/** Writes the fixture, lints exactly that file, and removes it again. */
function lintFixture(source: string): LintOutcome {
  writeFileSync(FIXTURE_PATH, `${LICENCE_HEADER}\n\n${source}`);

  try {
    const run = spawnSync(
      process.execPath,
      [ESLINT_BIN, '--no-warn-ignored', '--format', 'json', FIXTURE_PATH],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    );

    const raw = `${run.stdout ?? ''}${run.stderr ?? ''}`;
    let results: readonly EslintFileResult[] = [];

    if (typeof run.stdout === 'string' && run.stdout.trim().startsWith('[')) {
      results = JSON.parse(run.stdout) as readonly EslintFileResult[];
    }

    return { status: run.status ?? -1, results, raw };
  } finally {
    rmSync(FIXTURE_PATH, { force: true });
  }
}

function rulesFired(outcome: LintOutcome): string[] {
  return outcome.results.flatMap((file) =>
    file.messages.map((message) => message.ruleId).filter((id): id is string => id !== null),
  );
}

describe('the layering rule', () => {
  beforeEach(() => {
    rmSync(FIXTURE_PATH, { force: true });
  });

  afterEach(() => {
    rmSync(FIXTURE_PATH, { force: true });
  });

  it('is wired up: ESLint is installed at the path this fixture shells out to', () => {
    expect(existsSync(ESLINT_BIN)).toBe(true);
  });

  it('rejects packages/core-domain importing @assaybank/db', () => {
    const outcome = lintFixture(
      [
        "import { WORKSPACE_NAME } from '@assaybank/db';",
        '',
        'export const fixtureValue = WORKSPACE_NAME;',
        '',
      ].join('\n'),
    );

    expect(outcome.status, `eslint output:\n${outcome.raw}`).not.toBe(0);
    expect(rulesFired(outcome)).toContain('no-restricted-imports');

    const messages = outcome.results.flatMap((file) => file.messages.map((m) => m.message));
    expect(messages.join('\n')).toMatch(/core-domain and grading import no I\/O/);
  });

  it('rejects packages/core-domain importing node:fs', () => {
    const outcome = lintFixture(
      [
        "import { readFileSync } from 'node:fs';",
        '',
        'export const fixtureValue = readFileSync;',
        '',
      ].join('\n'),
    );

    expect(outcome.status, `eslint output:\n${outcome.raw}`).not.toBe(0);
    expect(rulesFired(outcome)).toContain('no-restricted-imports');
  });

  it('rejects reading process.env outside packages/config', () => {
    const outcome = lintFixture(
      ['export const fixtureValue = process.env.DATABASE_URL ?? null;', ''].join('\n'),
    );

    expect(outcome.status, `eslint output:\n${outcome.raw}`).not.toBe(0);
    expect(rulesFired(outcome)).toContain('no-restricted-syntax');
  });

  it('accepts the import core-domain is allowed to make, so the rule is not simply "everything fails"', () => {
    const outcome = lintFixture(
      [
        "import { WORKSPACE_NAME } from '@assaybank/contracts';",
        '',
        'export const fixtureValue = WORKSPACE_NAME;',
        '',
      ].join('\n'),
    );

    expect(outcome.status, `eslint output:\n${outcome.raw}`).toBe(0);
    expect(rulesFired(outcome)).toEqual([]);
  });

  it('leaves no violating file behind', () => {
    expect(existsSync(FIXTURE_PATH)).toBe(false);
  });
});
