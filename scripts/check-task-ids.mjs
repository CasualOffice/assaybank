#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Every `H-NNN` written anywhere names a row that exists in the tracker, exactly once.
 *
 * This gate exists because of a real failure. `docs/14-threat-model.md` was written when the
 * tracker's highest id was `H-109`, and it allocated `H-110` onwards for the forty mitigations it
 * proposed. The tracker then grew past `H-109` on unrelated work, and twenty-six of those
 * references quietly came to name other people's finished tasks — so the threat model's mitigation
 * plan pointed at the wrong rows, and nothing failed, because prose does not fail.
 *
 * Two checks, and the second is the one that would have caught it:
 *
 * 1. **No duplicate ids in the tracker.** Two rows with one id is an ambiguous reference.
 * 2. **No dangling reference.** An `H-NNN` in any tracked file must exist in the tracker. A
 *    document may cite an id; it may never mint one, because minting is how you collide with a
 *    backlog that has not grown into that number yet.
 *
 * Run: `node scripts/check-task-ids.mjs`
 */

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { relative, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const TRACKER = 'project/TRACKER.md';

/** `H-042`. Three digits, so a hex string or a hyphenated word cannot match. */
const ID = /\bH-\d{3}\b/g;
/** The id column of a tracker row: `| H-042 | P1 | …`. */
const ROW = /^\|\s*(H-\d{3})\s*\|/gm;

/** Files git tracks, minus the lockfile and anything generated or binary. */
function trackedFiles() {
  const out = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' });
  return out
    .split('\0')
    .filter(Boolean)
    .filter((f) => /\.(md|ts|tsx|mjs|js|json|sql|ya?ml)$/.test(f))
    .filter((f) => f !== 'pnpm-lock.yaml');
}

function main() {
  const tracker = readFileSync(resolve(ROOT, TRACKER), 'utf8');

  const declared = [];
  for (const m of tracker.matchAll(ROW)) declared.push(m[1]);

  const problems = [];

  const seen = new Set();
  const duplicated = new Set();
  for (const id of declared) {
    if (seen.has(id)) duplicated.add(id);
    seen.add(id);
  }
  for (const id of [...duplicated].sort()) {
    problems.push(`${TRACKER}: ${id} is declared by more than one row. An id names one task, for its life.`);
  }

  // Where each unknown id is written, so the message names a file rather than a number.
  const dangling = new Map();
  for (const file of trackedFiles()) {
    let text;
    try {
      text = readFileSync(resolve(ROOT, file), 'utf8');
    } catch {
      continue;
    }
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      for (const m of line.matchAll(ID)) {
        const id = m[0];
        if (seen.has(id)) continue;
        const where = `${relative('.', file)}:${i + 1}`;
        const at = dangling.get(id) ?? [];
        at.push(where);
        dangling.set(id, at);
      }
    });
  }

  for (const [id, where] of [...dangling.entries()].sort()) {
    problems.push(
      `${id} is referenced but is not a row in ${TRACKER} — ${where.slice(0, 4).join(', ')}` +
        (where.length > 4 ? ` and ${where.length - 4} more` : '') +
        `.\n    Add the row first: ids are allocated in the tracker and nowhere else. A document that ` +
        `mints one collides with the backlog as soon as it grows that far.`,
    );
  }

  const highest = declared.reduce((max, id) => Math.max(max, Number(id.slice(2))), 0);
  process.stdout.write(
    `Task ids — ${String(seen.size)} declared in ${TRACKER}, highest H-${String(highest).padStart(3, '0')}, ` +
      `${String(trackedFiles().length)} files scanned.\n`,
  );

  if (problems.length > 0) {
    process.stdout.write(`\n${String(problems.length)} problem(s):\n\n`);
    for (const p of problems) process.stdout.write(`  - ${p}\n`);
    process.stdout.write('\n');
    process.exitCode = 1;
    return;
  }
  process.stdout.write('Every reference names a real task.\n');
}

main();
