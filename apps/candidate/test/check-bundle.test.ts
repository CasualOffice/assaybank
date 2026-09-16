/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The fixture test for the candidate bundle check (ADR-013, P0 step 11).
 *
 * P0 step 2 records the principle this follows: *write the deliberate violation as a
 * fixture test, do not just try it once by hand*. A guard that has never been watched to
 * fail is a guard nobody knows is wired up, and a build-time check that silently stopped
 * working is worse than no check at all — it is a check the team is relying on.
 *
 * So this suite builds small fixture directories on disk, runs the real script as a child
 * process the way the build runs it, and asserts on the exit status and the message. It
 * deliberately does *not* import the script's internals and test them in isolation: the
 * thing that must work is `node scripts/check-bundle.mjs` returning a non-zero exit
 * status, because that is what fails the build. Testing the matcher while leaving the
 * exit path untested is how a check ends up reporting findings and exiting 0.
 *
 * The fixtures are written to a temporary directory rather than into `dist/`, so a
 * failure here can never leave a poisoned artefact behind for the real check to find.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const APP_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = join(APP_ROOT, 'scripts', 'check-bundle.mjs');

const created: string[] = [];

/** A throwaway directory standing in for a built bundle. */
function fixtureBundle(files: Readonly<Record<string, string>>): string {
  const dir = mkdtempSync(join(tmpdir(), 'assaybank-bundle-'));
  created.push(dir);
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(dir, name), contents, 'utf8');
  }
  return dir;
}

function runCheck(dir: string, extra: readonly string[] = []) {
  return spawnSync(process.execPath, [SCRIPT, '--dir', dir, ...extra], { encoding: 'utf8' });
}

afterEach(() => {
  while (created.length > 0) {
    const dir = created.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe('check-bundle — a clean bundle', () => {
  it('passes a bundle that carries only candidate-safe content', () => {
    const dir = fixtureBundle({
      'index.html': '<!doctype html><div id="root"></div>',
      'app.js': 'const a={remaining:1800000,label:"Assessment"};export default a;',
      'app.css': '.time-remaining{font-variant-numeric:tabular-nums}',
    });

    const result = runCheck(dir);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('clean');
  });
});

describe('check-bundle — the deliberate violation', () => {
  it('fails when a forbidden workspace name reaches the bundle', () => {
    // The shape of the real accident: a barrel import resolves and the bundler happily
    // inlines a module that knows how to reach the question bank.
    const dir = fixtureBundle({
      'app.js': 'import{query}from"@assaybank/db";export const load=()=>query("questions");',
    });

    const result = runCheck(dir);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('STAFF-ONLY CONTENT FOUND');
    expect(result.stderr).toContain('@assaybank/db');
    expect(result.stderr).toContain('CODE-GRAPH L5');
  });

  it('fails when an answer-key field name reaches the bundle', () => {
    const dir = fixtureBundle({
      'chunk.js': 'const o=[{id:"a",body:"2",is_correct:true},{id:"b",body:"3"}];',
    });

    const result = runCheck(dir);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('is_correct');
    expect(result.stderr).toContain('FR-12');
  });

  it('fails when hidden test-case expectations reach the bundle', () => {
    const dir = fixtureBundle({
      'chunk.js': 'const t={stdin:"3 4",expectedStdout:"7",isSample:false};',
    });

    const result = runCheck(dir);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('expectedStdout');
  });

  it('fails when a server secret was inlined at build time', () => {
    const dir = fixtureBundle({
      'app.js': 'const c={url:"postgres://app:example-inlined-secret@db:5432/assaybank"};',
    });

    const result = runCheck(dir);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('postgres://');
  });

  it('finds a marker in CSS and HTML, not only in JavaScript', () => {
    const cssOnly = fixtureBundle({
      'app.css': '.answer[data-answer_key="1"]{display:none}',
    });
    const htmlOnly = fixtureBundle({
      'index.html': '<script>window.__BOOT__={solution_code:{}}</script>',
    });

    expect(runCheck(cssOnly).status).toBe(1);
    expect(runCheck(htmlOnly).status).toBe(1);
  });

  it('reports the file and the line so the offending import can be found', () => {
    const dir = fixtureBundle({
      'app.js': ['// line one', '// line two', 'export{x}from"@assaybank/grading";'].join('\n'),
    });

    const result = runCheck(dir);

    expect(result.stderr).toContain('app.js:3');
  });

  it('emits machine-readable findings for CI', () => {
    const dir = fixtureBundle({ 'app.js': 'import"@assaybank/exec-adapter";' });

    const result = runCheck(dir, ['--json']);

    expect(result.status).toBe(1);
    const parsed: unknown = JSON.parse(result.stdout);
    expect(parsed).toMatchObject({ ok: false });
  });
});

describe('check-bundle — it cannot pass by doing nothing', () => {
  it('fails when the bundle directory does not exist', () => {
    // "Forgot to build" must never read as "bundle is clean". A check that passes when
    // there is nothing to check is a check that passes forever once someone breaks the
    // build step.
    const result = runCheck(join(tmpdir(), 'assaybank-bundle-does-not-exist'));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('run the build first');
  });

  it('fails when the bundle directory is empty', () => {
    const result = runCheck(fixtureBundle({}));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('produced nothing');
  });
});

describe('check-bundle — the two permitted internal dependencies', () => {
  it('does not object to @assaybank/contracts or @assaybank/ui', () => {
    const dir = fixtureBundle({
      'app.js': 'const p={ui:"@assaybank/ui",contracts:"@assaybank/contracts"};export default p;',
    });

    expect(runCheck(dir).status).toBe(0);
  });
});
