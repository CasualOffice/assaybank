#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/* global console, process, URL */

/**
 * The candidate bundle content check (ADR-013, P0 step 11).
 *
 * ## Why a lint rule is not enough
 *
 * ADR-013 exists because route guards gate rendering, not the bundle: if the staff
 * console and the candidate runner are one build, then correct-answer keys, scoring
 * weights, bank queries and other candidates' results ship to a candidate's browser and
 * are readable with devtools open. Preventing that by convention means every future
 * developer reasoning correctly about tree-shaking and dynamic import boundaries,
 * forever, and one careless shared import is enough.
 *
 * The ESLint override in this workspace catches the import a developer *writes*. It does
 * not catch:
 *
 *   - a transitive dependency that pulls a forbidden module in behind a barrel file,
 *   - a `packages/ui` component that grows a domain import,
 *   - a build configuration that inlines an environment variable,
 *   - a code path that reaches the forbidden module through a string the linter cannot
 *     resolve.
 *
 * This script checks the artefact instead of the intent. It reads what was actually
 * produced and is actually about to be served, which is the only thing a candidate's
 * browser will see. A lint rule and a bundle check fail for different reasons, and that
 * is the point of having both.
 *
 * ## What counts as a marker
 *
 * Two kinds, and both are exact substrings rather than patterns, because a regex that is
 * clever enough to be thorough is also clever enough to fire on minified library code
 * and get itself disabled:
 *
 *   1. **Workspace names** that must not be in this bundle's dependency closure
 *      (CODE-GRAPH L5) — the packages that know how to reach the database, mint tokens,
 *      resolve a question draw, score an answer or execute code.
 *   2. **Field and column names** that are the answer key itself (FR-12), kept aligned
 *      with `tests/leak/forbidden-fields.ts`, which is the same deny-list applied to
 *      serialised response bodies. The two together cover both ways the secret could
 *      travel: compiled into the bundle, or fetched into it at runtime.
 *
 * Adding a marker is cheap. Removing one requires an argument about why a candidate may
 * now see it.
 *
 * ## Usage
 *
 *     node scripts/check-bundle.mjs                # checks ./dist, the built bundle
 *     node scripts/check-bundle.mjs --dir <path>   # checks somewhere else
 *     node scripts/check-bundle.mjs --json         # machine-readable, for CI
 *
 * Exit status 0 means clean, 1 means a marker was found or the directory was missing.
 * A missing directory is a failure rather than a pass, so that "forgot to build" can
 * never read as "bundle is clean".
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** The workspace root, two levels up from this script. */
const APP_ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * Workspace packages that must not be reachable from the candidate bundle.
 *
 * `@assaybank/contracts` and `@assaybank/ui` are absent because they are this
 * application's two permitted internal dependencies (CODE-GRAPH L5).
 */
export const FORBIDDEN_PACKAGE_MARKERS = Object.freeze([
  '@assaybank/db',
  '@assaybank/auth',
  '@assaybank/core-domain',
  '@assaybank/grading',
  '@assaybank/exec-adapter',
  '@assaybank/web',
  '@assaybank/api',
  '@assaybank/worker',
  '@assaybank/config',
  '@assaybank/observability',
]);

/**
 * Answer-key, hidden-test and integrity identifiers (FR-12).
 *
 * Kept in step with `tests/leak/forbidden-fields.ts`; the schema column names
 * (`solution_code`, `checker_code`, `expected_stdout`) are included because a serialiser
 * that forgets to project away a column leaks the column name along with the value.
 */
export const FORBIDDEN_FIELD_MARKERS = Object.freeze([
  'is_correct',
  'isCorrect',
  'correct_option_ids',
  'correctOptionIds',
  'answer_key',
  'answerKey',
  'reference_solution',
  'referenceSolution',
  'solution_code',
  'solutionCode',
  'checker_code',
  'checkerCode',
  'expected_output',
  'expectedOutput',
  'expected_stdout',
  'expectedStdout',
  'hidden_cases',
  'hiddenCases',
  'test_case_expected',
  'testCaseExpected',
  'grading_notes',
  'gradingNotes',
  'rubric_internal',
  'rubricInternal',
  'integrity_verdict',
  'integrityVerdict',
]);

/**
 * Server-side secrets and infrastructure handles.
 *
 * None of these should ever be compiled into a front-end bundle, but a build tool that
 * inlines environment variables at build time makes it a one-line mistake, and the
 * mistake is invisible in source review because the source only names the variable.
 */
export const FORBIDDEN_SECRET_MARKERS = Object.freeze([
  'SESSION_SECRET',
  'TOKEN_PEPPER',
  'DATABASE_URL',
  'DATABASE_APP_ROLE',
  'DATABASE_JOB_ROLE',
  'S3_SECRET_ACCESS_KEY',
  'postgres://',
  'postgresql://',
  'drizzle-orm',
]);

/** Every marker, with the reason it is forbidden, for the failure message. */
export const STAFF_ONLY_MARKERS = Object.freeze([
  ...FORBIDDEN_PACKAGE_MARKERS.map((marker) => ({
    marker,
    reason: 'CODE-GRAPH L5: this package must not be in the candidate bundle closure',
  })),
  ...FORBIDDEN_FIELD_MARKERS.map((marker) => ({
    marker,
    reason: 'FR-12: answer keys and hidden test content never reach a candidate',
  })),
  ...FORBIDDEN_SECRET_MARKERS.map((marker) => ({
    marker,
    reason: 'A server-side secret or datastore handle was compiled into a browser bundle',
  })),
]);

/**
 * Extensions that are served to a browser and are therefore in scope.
 *
 * `.map` is deliberately absent, and the candidate build sets `sourcemap: false` for the
 * same reason: a source map republishes the original source, comments included, which
 * would both leak more than the bundle does and make this check fire on its own
 * documentation.
 */
const SCANNED_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.css', '.html', '.json']);

/** Recursively list files under a directory. */
function listFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) listFiles(full, out);
    else out.push(full);
  }
  return out;
}

/**
 * Find every marker present in a string.
 *
 * Exported and pure so the fixture test can exercise the matching without a build. The
 * excerpt is trimmed hard: the failure message goes into CI logs, and echoing a large
 * span of a bundle that may itself contain the secret is not an improvement.
 */
export function scanText(text, markers = STAFF_ONLY_MARKERS) {
  const findings = [];
  for (const { marker, reason } of markers) {
    const index = text.indexOf(marker);
    if (index === -1) continue;
    const line = text.slice(0, index).split('\n').length;
    findings.push({
      marker,
      reason,
      line,
      excerpt: text.slice(Math.max(0, index - 24), index + marker.length + 24).replace(/\s+/g, ' '),
    });
  }
  return findings;
}

/**
 * Scan a built bundle directory.
 *
 * Returns `{ ok, scanned, findings }`. `scanned === 0` with `ok === true` is impossible:
 * an empty or absent directory is reported as a failure by the caller, because a check
 * that passes when there is nothing to check is a check that passes forever once someone
 * breaks the build step.
 */
export function scanBundleDirectory(dir, markers = STAFF_ONLY_MARKERS) {
  const findings = [];
  let scanned = 0;

  for (const file of listFiles(dir)) {
    if (!SCANNED_EXTENSIONS.has(extname(file))) continue;
    scanned += 1;
    const text = readFileSync(file, 'utf8');
    for (const finding of scanText(text, markers)) {
      findings.push({ ...finding, file: relative(dir, file) });
    }
  }

  return { ok: findings.length === 0, scanned, findings };
}

function parseArgs(argv) {
  const args = { dir: join(APP_ROOT, 'dist'), json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') args.json = true;
    else if (arg === '--dir') {
      const value = argv[i + 1];
      if (value === undefined) throw new Error('--dir requires a path');
      args.dir = resolve(value);
      i += 1;
    } else throw new Error(`unrecognised argument: ${arg}`);
  }
  return args;
}

function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    console.error(`check-bundle: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }

  let stats;
  try {
    stats = statSync(args.dir);
  } catch {
    stats = null;
  }

  if (stats === null || !stats.isDirectory()) {
    const message = `check-bundle: ${args.dir} does not exist — run the build first.`;
    if (args.json) console.log(JSON.stringify({ ok: false, error: 'missing-bundle' }, null, 2));
    else console.error(message);
    return 1;
  }

  const result = scanBundleDirectory(args.dir);

  if (result.scanned === 0) {
    const message = `check-bundle: no scannable files in ${args.dir} — the build produced nothing.`;
    if (args.json) console.log(JSON.stringify({ ok: false, error: 'empty-bundle' }, null, 2));
    else console.error(message);
    return 1;
  }

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    return result.ok ? 0 : 1;
  }

  if (result.ok) {
    console.log(
      `check-bundle: clean — ${String(result.scanned)} files scanned for ` +
        `${String(STAFF_ONLY_MARKERS.length)} staff-only markers (ADR-013).`,
    );
    return 0;
  }

  console.error('check-bundle: STAFF-ONLY CONTENT FOUND IN THE CANDIDATE BUNDLE (ADR-013)\n');
  for (const finding of result.findings) {
    console.error(`  ${finding.file}:${String(finding.line)}  ${finding.marker}`);
    console.error(`      ${finding.reason}`);
    console.error(`      ...${finding.excerpt}...`);
  }
  console.error(
    '\nThe candidate bundle is served to an untrusted browser on an internet-facing\n' +
      'origin. Whatever reached it is readable with devtools open. Find the import that\n' +
      'pulled it in — start from the file above — and move the code behind the API.',
  );
  return 1;
}

// Only run when invoked directly, so the test can import the scanners.
const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  process.exit(main(process.argv.slice(2)));
}
