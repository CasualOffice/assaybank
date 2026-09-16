#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Finds credential-shaped passwords committed to the repository — inside connection
// strings, and assigned to password-named constants and properties.
//
// Written after an external scanner reported a "Generic Password" on the public
// repository on 2026-09-17. The strings it found were test fixtures — random-looking
// twelve-character passwords against the non-existent host `db.internal` — and
// authenticated to nothing. They were still a defect: a fixture that cannot be told
// apart from a real credential trains everyone to dismiss the next alert, and the
// next one may be real.
//
// So the rule is not "no passwords in connection strings". Tests and local development
// need them. The rule is: **a committed password must look fake on sight.** Either it is
// on the allow-list of documented development defaults, or it announces itself as a
// fixture (contains example / fixture / placeholder / redacted / test / ...), or it is
// a template the environment fills in. A value that could plausibly be real fails,
// because a scanner — and a person skimming a diff — cannot tell the difference either.
//
// This complements the pattern scan in .github/workflows/security.yml, which catches
// provider tokens (AKIA…, ghp_…, sk-…) by format. Passwords have no format.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// Documented development defaults. packages/config refuses every one of these in
// staging and production (DEV_DSN_PASSWORDS in packages/config/src/load.ts), so their
// presence in .env.example and docker-compose.yml is safe by construction.
const DEV_DEFAULTS = new Set(['hiring', 'hiring_app', 'hiring_job']);

// Textbook illustrations in prose — `user:pass@host` — and elided placeholders. None of
// these is a credential anyone guards, and rewriting documentation to avoid them would
// make the documentation worse.
const ILLUSTRATIVE = new Set(['pass', 'pw', 'password', '…', '...']);

// A committed password containing one of these words is self-evidently not real.
// `test` is anchored to a separator (`hiring_app_test`), so a real password that merely
// contains the letters — `Latest#2026` — is not waved through.
const FAKE_MARKERS =
  /example|fixture|placeholder|redacted|dummy|fake|not-a-real|nobody|must-never|change-?me|too-short|(?:^|[-_.])test(?:[-_.]|$)/iu;

// user:password@host inside a postgres/redis/amqp/http-style URL.
const DSN = /[a-z][a-z0-9+.-]*:\/\/([A-Za-z0-9_.-]+):([^@\s/'"`]+)@/gu;

// A password-named constant or property assigned a string literal. Passwords have no
// format, so the name is the only signal — which is exactly what a generic detector
// keys on, and why a memorable-phrase test password assigned to PASSWORD got flagged.
const ASSIGNMENT = /\b([A-Za-z_]*(?:PASSWORD|PASSWD|Password|password|passwd)[A-Za-z_]*)\s*[:=]\s*(['"`])([^'"`$]{4,})\2/gu;

const argv = new Set(process.argv.slice(2));
const JSON_OUT = argv.has('--json');

function trackedFiles() {
  const out = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' });
  return out
    .split('\0')
    .filter((f) => f.length > 0)
    // The lockfile holds integrity hashes, not URLs with credentials.
    .filter((f) => f !== 'pnpm-lock.yaml')
    .filter((f) => !/\.(png|jpg|jpeg|gif|ico|woff2?|pdf)$/iu.test(f));
}

function isAcceptable(password) {
  if (password.includes('${') || password.startsWith('$')) return true; // template
  if (DEV_DEFAULTS.has(password)) return true;
  if (ILLUSTRATIVE.has(password)) return true;
  if (FAKE_MARKERS.test(password)) return true;
  if (/^\[.*\]$/u.test(password)) return true; // [redacted]-style output in a doc or test
  return false;
}

const findings = [];
for (const file of trackedFiles()) {
  // The working tree, not the index: a local run must see the edit you have not staged
  // yet, or it reports a problem you already fixed. In CI the two are identical.
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    continue; // tracked but deleted in the working tree
  }
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    for (const m of line.matchAll(DSN)) {
      const [, user, password] = m;
      if (password === undefined || isAcceptable(password)) continue;
      findings.push({ file, line: i + 1, user, password });
    }
    // Assignments are checked in code only. Prose that discusses a password field is
    // not a credential, and scanning markdown for the word would drown the signal.
    if (/\.(m?[jt]sx?|c[jt]s|ya?ml|json|sql|sh)$/u.test(file)) {
      for (const m of line.matchAll(ASSIGNMENT)) {
        const [whole, name, , value] = m;
        if (value === undefined || isAcceptable(value)) continue;
        // psql variable substitution — a colon then a quoted variable name after the
        // PASSWORD keyword — is filled from the environment at load time. The quoted word
        // is a variable name, not a value.
        if (file.endsWith('.sql') && /:\s*'/u.test(whole)) continue;
        // A URL in a comment is judged by the DSN rule above, not by this one.
        if (value.includes('://')) continue;
        // A human-readable validation message is not a password.
        if (/\s/u.test(value.trim()) && value.trim().split(/\s+/u).length > 2) continue;
        findings.push({ file, line: i + 1, user: name ?? 'password', password: value });
      }
    }
  });
}

if (JSON_OUT) {
  console.log(JSON.stringify({ findings }, null, 2));
} else if (findings.length === 0) {
  console.log('\nSecret check — no committed password that could be mistaken for a real one.\n');
} else {
  console.error(`\nSecret check — ${findings.length} committed password(s) could be mistaken for real ones:\n`);
  for (const f of findings) {
    // The value is masked in output: if it *is* real, CI logs are another place it leaks.
    const masked = `${f.password.slice(0, 2)}${'*'.repeat(Math.max(0, f.password.length - 2))}`;
    console.error(`  ${f.file}:${f.line}  ${f.user} = ${masked}`);
  }
  console.error(`
A committed password must look fake on sight. If this is a test fixture, rename the
value so it says so — e.g. example-fixture-password. If it is a real credential,
rotate it first, then remove it: reverting the commit does not un-publish it.
`);
  process.exit(1);
}
