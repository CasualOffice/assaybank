#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * check-licences.mjs
 *
 * The dependency licence gate (ADR-001, docs/05-licensing-and-compliance.md §1).
 * Copyleft in the dependency tree of a hosted product is exactly what those
 * licences exist to catch, and discovering it after the fact means removing a
 * dependency the product already depends on. The gate is cheap; the cure is not.
 *
 *   node scripts/check-licences.mjs            check the installed tree
 *   node scripts/check-licences.mjs --json     machine-readable report
 *   node scripts/check-licences.mjs --list     print every package and its licence
 *
 * There is no package tree in this repository yet. When neither pnpm-lock.yaml
 * nor node_modules exists the gate reports that it is armed and exits 0, so it
 * can sit in CI from day one and start enforcing the moment the first
 * dependency lands in M0 (2026-09-21).
 *
 * Reviewed exceptions live in .licence-allowlist.json and require a reason and
 * an approver. An allowlist entry without both is itself a failure.
 *
 * Zero dependencies. Node 22 LTS.
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, sep, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const LOCKFILE = join(ROOT, 'pnpm-lock.yaml');
const NODE_MODULES = join(ROOT, 'node_modules');
const ALLOWLIST = join(ROOT, '.licence-allowlist.json');
const POLICY_DOC = 'docs/05-licensing-and-compliance.md §1';
const M0_START = '2026-09-21';

/* ------------------------------------------------------------------ policy */

/** Permitted SPDX identifiers, lowercased. Anything else needs a decision. */
const PERMITTED = new Set(
  [
    'MIT',
    'MIT-0',
    'Apache-2.0',
    'BSD-2-Clause',
    'BSD-3-Clause',
    'ISC',
    'MPL-2.0',
    'PostgreSQL',
    'Unlicense',
    'CC0-1.0',
    '0BSD',
    'BlueOak-1.0.0',
    'Python-2.0',
    'Zlib',
  ].map((s) => s.toLowerCase()),
);

/**
 * Prohibited families. The matcher is a predicate over the lowercased licence
 * token so that version suffixes and the "-only"/"-or-later" variants are all
 * caught without enumerating them.
 */
const PROHIBITED = [
  { name: 'AGPL', why: 'network-use copyleft; fatal for a web-facing product', test: (t) => t.startsWith('agpl') },
  { name: 'GPL', why: 'copyleft; forecloses commercialisation (ADR-001)', test: (t) => /^gpl(-|$)/.test(t) },
  { name: 'LGPL', why: 'copyleft where static linking applies; needs legal review before any use', test: (t) => t.startsWith('lgpl') },
  { name: 'SSPL', why: 'service-side public licence; not open source and not permitted', test: (t) => t.startsWith('sspl') },
  { name: 'BUSL / BSL', why: 'source-available with a change date and a field-of-use restriction', test: (t) => t.startsWith('busl') || t.startsWith('bsl') || t.includes('business source') },
  { name: 'Commons Clause', why: 'field-of-use restriction bolted onto a permissive licence', test: (t) => t.includes('commons clause') },
  { name: 'Elastic / RSAL / PolyForm', why: 'source-available with field-of-use restrictions', test: (t) => t.startsWith('elastic-') || t.startsWith('rsal') || t.startsWith('polyform') },
  { name: 'CC-BY-NC / non-commercial', why: 'non-commercial restriction', test: (t) => t.includes('-nc') || t.includes('noncommercial') },
];

/* -------------------------------------------------------------------- args */

const argv = process.argv.slice(2);
const opts = { json: argv.includes('--json'), list: argv.includes('--list') };
if (argv.includes('--help') || argv.includes('-h')) {
  console.log('check-licences.mjs — dependency licence gate\n\n  node scripts/check-licences.mjs [--json] [--list]\n');
  process.exit(0);
}
for (const a of argv) {
  if (!['--json', '--list'].includes(a)) {
    console.error(`check-licences: unknown argument ${a}. Try --help.`);
    process.exit(2);
  }
}

const emit = (payload, exitCode) => {
  if (opts.json) console.log(JSON.stringify(payload, null, 2));
  process.exit(exitCode);
};

/* --------------------------------------------------------------- allowlist */

function loadAllowlist() {
  if (!existsSync(ALLOWLIST)) return { entries: [], errors: [] };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(ALLOWLIST, 'utf8'));
  } catch (err) {
    return { entries: [], errors: [`.licence-allowlist.json is not valid JSON: ${err.message}`] };
  }
  const errors = [];
  const entries = Array.isArray(parsed.entries) ? parsed.entries : [];
  if (!Array.isArray(parsed.entries)) errors.push('.licence-allowlist.json must have an "entries" array.');
  for (const [i, e] of entries.entries()) {
    const where = `entries[${i}]${e && e.package ? ` (${e.package})` : ''}`;
    if (!e || typeof e !== 'object') {
      errors.push(`${where}: not an object.`);
      continue;
    }
    for (const field of ['package', 'licence', 'reason', 'approver', 'approved_on']) {
      if (!e[field] || String(e[field]).trim() === '') errors.push(`${where}: missing required field "${field}".`);
    }
    if (e.reason && String(e.reason).trim().length < 20) {
      errors.push(`${where}: "reason" must actually explain the exception. "It was the first result" is not a reason.`);
    }
    if (e.expires_on && !/^\d{4}-\d{2}-\d{2}$/.test(e.expires_on)) {
      errors.push(`${where}: "expires_on" must be an absolute YYYY-MM-DD date.`);
    }
  }
  return { entries, errors };
}

function allowlistMatch(entries, name, version) {
  return entries.find((e) => e.package === name && (!e.version || e.version === version));
}

/* ------------------------------------------------------------- licence read */

/** package.json licence field, in every shape npm has ever accepted. */
function licenceOf(pkg) {
  if (typeof pkg.license === 'string') return pkg.license;
  if (pkg.license && typeof pkg.license === 'object' && pkg.license.type) return pkg.license.type;
  if (Array.isArray(pkg.licenses)) {
    const types = pkg.licenses.map((l) => (typeof l === 'string' ? l : l && l.type)).filter(Boolean);
    if (types.length) return types.length === 1 ? types[0] : `(${types.join(' OR ')})`;
  }
  if (typeof pkg.licence === 'string') return pkg.licence;
  return null;
}

/**
 * Evaluate an SPDX expression. A disjunction passes if any branch is permitted,
 * because the consumer chooses the branch. A conjunction requires every branch.
 * Anything more complex than that is reported as needing a human.
 */
function evaluate(expression) {
  const raw = String(expression).trim();
  const normalised = raw.replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim();
  const lower = normalised.toLowerCase();

  for (const rule of PROHIBITED) {
    for (const token of lower.split(/\s+(?:or|and)\s+/)) {
      if (rule.test(token.replace(/\+$/, ''))) {
        // An OR that offers a permitted alternative is still fine.
        if (/\bor\b/.test(lower)) {
          const branches = lower.split(/\s+or\s+/).map((b) => b.trim().replace(/\+$/, ''));
          if (branches.some((b) => PERMITTED.has(b))) return { verdict: 'permitted', detail: 'dual-licensed; permitted branch chosen' };
        }
        return { verdict: 'prohibited', detail: `${rule.name}: ${rule.why}` };
      }
    }
  }

  if (/\bor\b/.test(lower)) {
    const branches = lower.split(/\s+or\s+/).map((b) => b.trim().replace(/\+$/, ''));
    if (branches.some((b) => PERMITTED.has(b))) return { verdict: 'permitted', detail: 'dual-licensed; permitted branch chosen' };
    return { verdict: 'unknown', detail: 'no branch of the expression is on the permitted list' };
  }
  if (/\band\b/.test(lower)) {
    const branches = lower.split(/\s+and\s+/).map((b) => b.trim().replace(/\+$/, ''));
    if (branches.every((b) => PERMITTED.has(b))) return { verdict: 'permitted', detail: 'every branch permitted' };
    return { verdict: 'unknown', detail: 'at least one branch of the conjunction is not on the permitted list' };
  }
  if (PERMITTED.has(lower.replace(/\+$/, ''))) return { verdict: 'permitted', detail: '' };
  if (lower === 'see license in license' || lower.startsWith('see license')) {
    return { verdict: 'unknown', detail: 'licence text is referenced by file, not declared as an SPDX identifier' };
  }
  return { verdict: 'unknown', detail: 'not on the permitted list and not a recognised prohibited family' };
}

/* ------------------------------------------------------------------- scan */

/** Every installed package.json, pnpm's .pnpm store included. */
function collectPackages(dir, acc = new Map(), depth = 0) {
  if (depth > 12) return acc;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const abs = join(dir, entry.name);
    if (entry.name === '.bin') continue;

    if (entry.name.startsWith('@')) {
      collectPackages(abs, acc, depth + 1);
      continue;
    }
    if (entry.name === '.pnpm') {
      let stores;
      try {
        stores = readdirSync(abs, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const store of stores) {
        if (!store.isDirectory()) continue;
        collectPackages(join(abs, store.name, 'node_modules'), acc, depth + 1);
      }
      continue;
    }

    const manifest = join(abs, 'package.json');
    if (existsSync(manifest)) {
      try {
        const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
        if (pkg.name) {
          const key = `${pkg.name}@${pkg.version ?? '0.0.0'}`;
          if (!acc.has(key)) {
            acc.set(key, {
              name: pkg.name,
              version: pkg.version ?? '0.0.0',
              licence: licenceOf(pkg),
              private: pkg.private === true,
              path: relative(ROOT, abs).split(sep).join(posix.sep),
            });
          }
        }
      } catch {
        /* an unreadable manifest is reported by the caller as unknown */
      }
    }
    const nested = join(abs, 'node_modules');
    if (existsSync(nested)) collectPackages(nested, acc, depth + 1);
  }
  return acc;
}

/** Package count from the lockfile, used only to sanity-check coverage. */
function lockfilePackageCount() {
  try {
    const text = readFileSync(LOCKFILE, 'utf8');
    const section = text.split(/^packages:\s*$/m)[1];
    if (!section) return null;
    return (section.match(/^\s{2}['"]?[^'":\s][^:]*:\s*$/gm) || []).length;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------- main */

const hasLock = existsSync(LOCKFILE);
const hasModules = existsSync(NODE_MODULES);

if (!hasLock && !hasModules) {
  const message = [
    '',
    'Licence gate: no dependency tree yet — nothing to check.',
    '',
    `  Neither pnpm-lock.yaml nor node_modules/ exists. The gate is armed and will enforce`,
    `  from M0 (workspace bootstrap, ${M0_START}) onwards, on the first pull request that`,
    '  installs a dependency. It exits 0 today so it can sit in CI from day one rather than',
    '  being added later, which is how licence problems reach main.',
    '',
    `  Policy: ${POLICY_DOC}. Permitted: MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC,`,
    '  MPL-2.0, PostgreSQL, Unlicense, CC0-1.0. Prohibited: GPL, LGPL (static), AGPL, SSPL,',
    '  BSL/BUSL, Commons Clause, and anything with a field-of-use restriction.',
    '',
    '  Two named traps to check by hand until the tree exists: MinIO is AGPL-3.0 (use',
    '  SeaweedFS) and Redis above 7.2 is RSALv2/SSPL (use Valkey 8).',
    '',
  ].join('\n');
  if (opts.json) emit({ ok: true, state: 'armed', reason: 'no dependency tree', policy: POLICY_DOC, enforcesFrom: M0_START }, 0);
  console.log(message);
  process.exit(0);
}

if (hasLock && !hasModules) {
  const message = [
    '',
    'Licence gate: pnpm-lock.yaml exists but node_modules/ does not.',
    '',
    '  The gate reads declared licences from the installed tree, so it cannot run here.',
    '  Run `pnpm install --frozen-lockfile` first. This is a failure rather than a skip:',
    '  a lockfile with no install is the one state in which silently passing would let an',
    '  unreviewed licence through.',
    '',
  ].join('\n');
  if (opts.json) emit({ ok: false, state: 'not-installed', reason: 'lockfile present, node_modules missing' }, 1);
  console.error(message);
  process.exit(1);
}

const { entries: allowEntries, errors: allowErrors } = loadAllowlist();
const packages = [...collectPackages(NODE_MODULES).values()]
  .filter((p) => !p.private)
  .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));

const results = [];
const counts = new Map();
for (const pkg of packages) {
  const declared = pkg.licence;
  const verdict = declared ? evaluate(declared) : { verdict: 'unknown', detail: 'no "license" field in package.json' };
  const allowed = verdict.verdict === 'permitted' ? null : allowlistMatch(allowEntries, pkg.name, pkg.version);
  const final = allowed ? 'allowlisted' : verdict.verdict;
  counts.set(declared ?? '(none)', (counts.get(declared ?? '(none)') ?? 0) + 1);
  results.push({ ...pkg, declared: declared ?? '(none)', verdict: final, detail: allowed ? `allowlisted by ${allowed.approver}: ${allowed.reason}` : verdict.detail });
}

const prohibited = results.filter((r) => r.verdict === 'prohibited');
const unknown = results.filter((r) => r.verdict === 'unknown');
const allowlisted = results.filter((r) => r.verdict === 'allowlisted');
const lockCount = hasLock ? lockfilePackageCount() : null;
const ok = prohibited.length === 0 && unknown.length === 0 && allowErrors.length === 0;

if (opts.json) {
  emit(
    {
      ok,
      state: 'enforced',
      policy: POLICY_DOC,
      packages: results.length,
      lockfilePackages: lockCount,
      allowlistErrors: allowErrors,
      prohibited,
      unknown,
      allowlisted,
      byLicence: Object.fromEntries([...counts].sort((a, b) => b[1] - a[1])),
    },
    ok ? 0 : 1,
  );
}

const pad = (s, n) => String(s).padEnd(n);
console.log('');
console.log(`Licence gate — ${results.length} package(s) inspected under node_modules/${lockCount ? `, ${lockCount} in pnpm-lock.yaml` : ''}.`);
console.log(`Policy: ${POLICY_DOC}. Allowlist: .licence-allowlist.json (${allowEntries.length} entr${allowEntries.length === 1 ? 'y' : 'ies'}).`);
console.log('');
console.log(`  ${pad('Licence', 38)} ${pad('Count', 7)} Verdict`);
console.log(`  ${'-'.repeat(38)} ${'-'.repeat(7)} -------`);
for (const [licence, count] of [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
  const sample = results.find((r) => r.declared === licence);
  console.log(`  ${pad(licence.slice(0, 38), 38)} ${pad(count, 7)} ${sample.verdict}`);
}

if (opts.list) {
  console.log('');
  for (const r of results) console.log(`  ${pad(r.verdict, 12)} ${pad(`${r.name}@${r.version}`, 48)} ${r.declared}`);
}

if (allowErrors.length) {
  console.log('');
  console.log('Allowlist is invalid:');
  for (const e of allowErrors) console.log(`  - ${e}`);
}

if (prohibited.length) {
  console.log('');
  console.log(`PROHIBITED (${prohibited.length}) — the build fails on these:`);
  for (const r of prohibited) {
    console.log(`  ${r.name}@${r.version}  ${r.declared}`);
    console.log(`    ${r.detail}`);
    console.log(`    at ${r.path}`);
  }
  console.log('');
  console.log('  Remove the dependency, replace it with a permissively licensed equivalent, or — if');
  console.log('  and only if counsel has reviewed it — add an entry to .licence-allowlist.json with a');
  console.log('  reason and an approver. Do not disable the gate.');
}

if (unknown.length) {
  console.log('');
  console.log(`UNDECLARED OR UNRECOGNISED (${unknown.length}) — these need a human:`);
  for (const r of unknown) console.log(`  ${pad(`${r.name}@${r.version}`, 48)} ${pad(r.declared, 24)} ${r.detail}`);
  console.log('');
  console.log('  An unrecognised licence is not a pass. Read the licence text, then either add the');
  console.log('  SPDX identifier upstream or record the exception in .licence-allowlist.json.');
}

if (allowlisted.length) {
  console.log('');
  console.log(`Allowlisted exceptions (${allowlisted.length}):`);
  for (const r of allowlisted) console.log(`  ${pad(`${r.name}@${r.version}`, 48)} ${r.declared} — ${r.detail}`);
}

console.log('');
console.log(ok ? 'Licence gate passed.' : 'Licence gate failed.');
console.log('');
process.exit(ok ? 0 : 1);
