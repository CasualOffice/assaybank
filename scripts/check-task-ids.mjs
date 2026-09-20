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
 * 3. **No mis-attributed reference.** A line that cites `docs/14` and an `H-NNN` must name a task
 *    whose tracker row references a `T-` threat. Renumbering the threat model's forty proposals
 *    fixed the document and left forty-nine citations in code pointing at unrelated tasks — every
 *    one of which still existed, so check 2 passed on all of them. This is the check that would
 *    have caught it: a login test citing the checker-sandbox task is wrong in a way an id
 *    existence check cannot see.
 *
 * ## What this cannot check, proved on 2026-09-20
 *
 * Check 3 only looks at lines that mention `docs/14`. That is narrow on purpose — but it is
 * narrower than the bug. Nine more citations from the same renumbering survived it, in the
 * files that *implement* the mitigations rather than name the document:
 *
 *   * `csrf.ts` cited `H-127`, the candidate-bundle task, three times for CSRF.
 *   * `staff-session.ts` cited the worker skeleton for session invalidation.
 *   * `refusal.ts`, `permissions.ts` and an attempt-token test cited the countdown hook for
 *     "return `not_found` rather than `forbidden` across a tenant boundary".
 *
 * Every one named a real task, so check 2 passed; none was on a `docs/14` line, so check 3
 * never looked. Widening to file level was tried and rejected: twenty files legitimately
 * mention `docs/14` and cite an unrelated id, and a gate that cries wolf twenty times is a
 * gate somebody disables. Narrowing to "a foundation task cited from a behavioural comment"
 * found the remaining bugs and two false positives, which is not clean enough to fail a build.
 *
 * So this is the honest position: **"the id names the task this prose is about" is not
 * mechanically checkable, and this script does not check it.** What it checks is that the id
 * exists and, near a `docs/14` reference, that it is a threat-model task. The rest is review —
 * and the thing to look at in review is a comment explaining *why* code behaves a certain way,
 * because that is where an id gets written from memory.
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

  // --- 3. Ids cited against docs/14 must name threat-model tasks ---------------------
  //
  // The tracker's Ref column is the link back to what a task came from. A threat-model task
  // cites its threat there, so an id cited beside `docs/14` and referencing anything else is
  // pointing at the wrong row.
  const refOf = new Map();
  for (const m of tracker.matchAll(/^\|\s*(H-\d{3})\s*\|.*?\|\s*([^|]*?)\s*\|\s*[SML]\s*\|/gm)) {
    refOf.set(m[1], m[2]);
  }

  for (const file of trackedFiles()) {
    if (file === TRACKER || file === 'docs/14-threat-model.md' || file === 'scripts/check-task-ids.mjs') {
      continue;
    }
    let text;
    try {
      text = readFileSync(resolve(ROOT, file), 'utf8');
    } catch {
      continue;
    }
    if (!text.includes('docs/14')) continue;

    text.split('\n').forEach((line, i) => {
      if (!line.includes('docs/14')) return;
      for (const m of line.matchAll(ID)) {
        const ref = refOf.get(m[0]);
        if (ref === undefined || ref.includes('T-')) continue;
        problems.push(
          `${relative('.', file)}:${i + 1}: ${m[0]} is cited beside docs/14, but ${TRACKER} says it is ` +
            `"${ref}" — not a threat-model task.\n    Either the citation is stale (the threat model's ` +
            `ids were renumbered on 2026-09-17) or it belongs to a different document.`,
        );
      }
    });
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
