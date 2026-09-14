#!/usr/bin/env node
/**
 * check-doc-freshness.mjs
 *
 * The documentation freshness gate. docs/DOC-OWNERSHIP.md is the single source of
 * truth: its "## Registry" table is parsed as configuration, so there is no second
 * copy of the rules to drift away from the first.
 *
 *   node scripts/check-doc-freshness.mjs
 *       Registration (both directions), metadata presence, registry agreement,
 *       age against max age, and docs/ index coverage.
 *
 *   node scripts/check-doc-freshness.mjs --changed <path>... [--changed-from <file>]
 *       Everything above, plus the trigger rules: if a changed path matches a
 *       document's trigger pattern, that document must be in the same diff.
 *
 *   node scripts/check-doc-freshness.mjs --sync
 *       Rewrite the registry's "Last updated" column from the document headers.
 *       The header is authoritative; the column is a mirror.
 *
 *   --json      machine-readable report on stdout (for CI annotation)
 *   --today     override today's date, as YYYY-MM-DD (for testing)
 *
 * Zero dependencies. Node 22 LTS.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, sep, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const REGISTRY_PATH = join(ROOT, 'docs', 'DOC-OWNERSHIP.md');
const INDEX_PATH = join(ROOT, 'docs', 'README.md');
const REGISTRY_REL = 'docs/DOC-OWNERSHIP.md';

/** Directories never scanned for registrable documents. */
const IGNORED_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'coverage',
  'sbom',
  'test-results',
  'playwright-report',
  'blob-report',
  '.git',
  '.github', // issue and pull-request templates are forms, not documents
  '.turbo',
  '.vscode',
  '.idea',
]);

/** Dot-directories that ARE scanned, despite the dot-directory skip below. */
const SCANNED_DOT_DIRS = new Set(['.claude']);

const CADENCES = new Set(['on-change', 'monthly', 'quarterly', 'annually']);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const LAST_UPDATED_RE = /^\*\*Last updated:\*\*\s*(\S+)\s*$/m;
const DASHES = new Set(['—', '-', '–', '']);

/* ------------------------------------------------------------------- args */

function parseArgs(argv) {
  const opts = {
    json: false,
    sync: false,
    changedMode: false,
    changed: [],
    today: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a === '--sync') opts.sync = true;
    else if (a === '--changed') {
      opts.changedMode = true;
      // Consume every following non-flag argument as a changed path.
      while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) opts.changed.push(argv[++i]);
    } else if (a.startsWith('--changed=')) {
      opts.changedMode = true;
      opts.changed.push(...a.slice('--changed='.length).split(','));
    } else if (a === '--changed-from' || a.startsWith('--changed-from=')) {
      opts.changedMode = true;
      const file = a.includes('=') ? a.slice(a.indexOf('=') + 1) : argv[++i];
      if (!file) die(`--changed-from needs a file path.`);
      if (!existsSync(file)) die(`--changed-from: ${file} does not exist.`);
      opts.changed.push(...readFileSync(file, 'utf8').split('\n'));
    } else if (a === '--today' || a.startsWith('--today=')) {
      opts.today = a.includes('=') ? a.slice(a.indexOf('=') + 1) : argv[++i];
      if (!DATE_RE.test(opts.today || '')) die(`--today must be YYYY-MM-DD.`);
    } else if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(0);
    } else {
      die(`Unknown argument: ${a}. Try --help.`);
    }
  }
  opts.changed = normalisePaths(opts.changed);
  return opts;
}

function printHelp() {
  console.log(
    [
      'check-doc-freshness.mjs — the documentation freshness gate',
      '',
      'Usage:',
      '  node scripts/check-doc-freshness.mjs [--json] [--today YYYY-MM-DD]',
      '  node scripts/check-doc-freshness.mjs --changed <path>... [--json]',
      '  node scripts/check-doc-freshness.mjs --changed-from changed.txt [--json]',
      '  node scripts/check-doc-freshness.mjs --sync',
      '',
      `Configuration is the "## Registry" table in ${REGISTRY_REL}.`,
    ].join('\n'),
  );
}

function die(message) {
  console.error(`check-doc-freshness: ${message}`);
  process.exit(2);
}

function normalisePaths(list) {
  const out = [];
  for (const raw of list) {
    const p = String(raw).trim().replace(/\\/g, '/').replace(/^\.\//, '');
    if (p) out.push(p);
  }
  return [...new Set(out)];
}

/* --------------------------------------------------------------- registry */

/**
 * Parse the markdown table under "## Registry". Column order is fixed:
 * Path | Purpose | Owner | Cadence | Max age | Triggers | Last updated.
 * The path is the first code span in the first cell, which keeps the cell a
 * readable link while staying machine-parseable.
 */
function parseRegistry(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^##\s+Registry\s*$/.test(l));
  if (start === -1) die(`${REGISTRY_REL} has no "## Registry" heading.`);

  const rows = [];
  let header = false;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim().startsWith('|')) {
      if (rows.length || header) break;
      continue;
    }
    if (!header) {
      header = true;
      continue;
    }
    if (/^\|[\s|:-]+\|$/.test(line.trim())) continue;

    const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
    if (cells.length < 7) die(`${REGISTRY_REL} line ${i + 1}: expected 7 columns, found ${cells.length}.`);

    const path = firstCodeSpan(cells[0]);
    if (!path) die(`${REGISTRY_REL} line ${i + 1}: no code span in the Path cell.`);
    const cadence = cells[3];
    if (!CADENCES.has(cadence)) {
      die(`${REGISTRY_REL} line ${i + 1}: cadence "${cadence}" is not one of ${[...CADENCES].join(', ')}.`);
    }
    const maxAge = Number.parseInt(cells[4], 10);
    if (!Number.isFinite(maxAge) || maxAge <= 0) {
      die(`${REGISTRY_REL} line ${i + 1}: max age "${cells[4]}" is not a positive integer.`);
    }
    const registryDate = DASHES.has(cells[6]) ? null : cells[6];
    if (registryDate && !DATE_RE.test(registryDate)) {
      die(`${REGISTRY_REL} line ${i + 1}: "Last updated" column is not YYYY-MM-DD.`);
    }

    rows.push({
      line: i + 1,
      path,
      purpose: cells[1],
      owner: cells[2],
      cadence,
      maxAge,
      triggers: DASHES.has(cells[5]) ? [] : allCodeSpans(cells[5]),
      registryDate,
      isMarkdown: path.endsWith('.md'),
    });
  }

  if (!rows.length) die(`${REGISTRY_REL}: the Registry table is empty.`);
  const seen = new Set();
  for (const r of rows) {
    if (seen.has(r.path)) die(`${REGISTRY_REL} line ${r.line}: "${r.path}" is registered twice.`);
    seen.add(r.path);
  }
  return rows;
}

function firstCodeSpan(cell) {
  const m = cell.match(/`([^`]+)`/);
  return m ? m[1].trim() : null;
}

function allCodeSpans(cell) {
  return [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1].trim()).filter(Boolean);
}

/* ------------------------------------------------------------------ scan */

function walkMarkdown(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      if (entry.name.startsWith('.') && !SCANNED_DOT_DIRS.has(entry.name)) continue;
      walkMarkdown(abs, acc);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      acc.push(relative(ROOT, abs).split(sep).join(posix.sep));
    }
  }
  return acc;
}

/* ----------------------------------------------------------------- globs */

/** Translate a path pattern into a regular expression. `*` stays inside one
 *  segment; `**` crosses segments; everything else is literal. */
function globToRegExp(pattern) {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        const slashAfter = pattern[i + 2] === '/';
        i += slashAfter ? 2 : 1;
        re += slashAfter ? '(?:.*/)?' : '.*';
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('\\^$.|+()[]{}'.includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

const globCache = new Map();
function matchesGlob(path, pattern) {
  let re = globCache.get(pattern);
  if (!re) {
    re = globToRegExp(pattern);
    globCache.set(pattern, re);
  }
  return re.test(path);
}

/* ------------------------------------------------------------------ dates */

function todayISO(override) {
  if (override) return override;
  // Local date, not UTC: a document dated by someone in UTC+5:30 late in the
  // evening must not read as "tomorrow" to the machine that checks it.
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function isRealDate(iso) {
  if (!DATE_RE.test(iso)) return false;
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function daysBetween(fromISO, toISO) {
  const a = Date.parse(`${fromISO}T00:00:00Z`);
  const b = Date.parse(`${toISO}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

/* ----------------------------------------------------------------- checks */

function run(opts) {
  if (!existsSync(REGISTRY_PATH)) die(`${REGISTRY_REL} does not exist. It is the configuration for this gate.`);
  const registryText = readFileSync(REGISTRY_PATH, 'utf8');
  const rows = parseRegistry(registryText);
  const today = todayISO(opts.today);
  const problems = [];
  const add = (kind, path, message, fix) => problems.push({ kind, path, message, fix });

  /* 1. registration, both directions */
  const registered = new Map(rows.map((r) => [r.path, r]));
  const onDisk = walkMarkdown(ROOT).sort();

  for (const file of onDisk) {
    if (!registered.has(file)) {
      add(
        'unregistered',
        file,
        `is a markdown document but has no row in ${REGISTRY_REL}, so it has no owner and no trigger set.`,
        `Add a row to the Registry table in ${REGISTRY_REL}, or move the content into a document that already has one.`,
      );
    }
  }
  for (const row of rows) {
    if (!existsSync(join(ROOT, row.path))) {
      add(
        'missing-file',
        row.path,
        `is registered in ${REGISTRY_REL} (line ${row.line}) but does not exist on disk.`,
        `Create the document, or delete its registry row and its index line in docs/README.md.`,
      );
    }
  }

  /* 2 and 3. metadata, and agreement with the registry column */
  const docDates = new Map();
  for (const row of rows) {
    if (!row.isMarkdown) continue;
    const abs = join(ROOT, row.path);
    if (!existsSync(abs)) continue;
    const head = readFileSync(abs, 'utf8').split('\n').slice(0, 20).join('\n');
    const m = head.match(LAST_UPDATED_RE);
    if (!m) {
      add(
        'no-metadata',
        row.path,
        `has no "**Last updated:** YYYY-MM-DD" line in its first 20 lines.`,
        `Add the standard header block: H1, then **Status:**, **Owner:**, **Last updated:**, **Companion docs:**, then a --- rule.`,
      );
      continue;
    }
    if (!isRealDate(m[1])) {
      add('bad-date', row.path, `has "**Last updated:** ${m[1]}", which is not a real YYYY-MM-DD date.`, `Use an absolute ISO date.`);
      continue;
    }
    docDates.set(row.path, m[1]);
    if (row.registryDate !== m[1]) {
      add(
        'registry-drift',
        row.path,
        `header says ${m[1]}, the registry column says ${row.registryDate ?? '—'}.`,
        `Run: node scripts/check-doc-freshness.mjs --sync`,
      );
    }
  }

  /* 4. age */
  const ages = [];
  for (const row of rows) {
    const date = docDates.get(row.path);
    if (!date) continue;
    const age = daysBetween(date, today);
    ages.push({ path: row.path, age, maxAge: row.maxAge, owner: row.owner, cadence: row.cadence });
    if (age > row.maxAge) {
      add(
        'stale',
        row.path,
        `is ${age} days old; its maximum is ${row.maxAge} (cadence ${row.cadence}, owner ${row.owner}).`,
        `Re-read it, correct what is no longer true, then bump **Last updated:**. Bumping the date without reading it is the failure this gate exists to prevent.`,
      );
    }
    // One day of slack absorbs timezone differences between author and runner.
    if (age < -1) {
      add('future-date', row.path, `is dated ${date}, which is in the future relative to ${today}.`, `Dates are absolute and are the date of the change.`);
    }
  }

  /* 5. index coverage for docs/ */
  if (existsSync(INDEX_PATH)) {
    const index = readFileSync(INDEX_PATH, 'utf8');
    for (const row of rows) {
      if (!row.path.startsWith('docs/')) continue;
      if (row.path === 'docs/README.md') continue;
      const base = row.path.slice('docs/'.length);
      if (!index.includes(base)) {
        add(
          'not-indexed',
          row.path,
          `is registered but is not referenced from docs/README.md.`,
          `Add a row to the Documents table in docs/README.md.`,
        );
      }
    }
  } else {
    add('missing-file', 'docs/README.md', `does not exist; it is the index the coverage check reads.`, `Restore the index.`);
  }

  /* 6. trigger rules, only in --changed mode */
  const triggerFindings = [];
  if (opts.changedMode) {
    const changedSet = new Set(opts.changed);
    for (const row of rows) {
      if (!row.triggers.length) continue;
      if (changedSet.has(row.path)) continue; // the document changed; nothing to enforce
      const fired = [];
      for (const pattern of row.triggers) {
        for (const file of opts.changed) {
          if (file === row.path) continue;
          if (matchesGlob(file, pattern)) fired.push({ pattern, file });
        }
      }
      if (fired.length) {
        triggerFindings.push({ path: row.path, owner: row.owner, fired });
        const shown = fired.slice(0, 4).map((f) => `${f.file} (matched \`${f.pattern}\`)`);
        add(
          'trigger',
          row.path,
          `was not updated, but this diff changes ${fired.length} file(s) that trigger it: ${shown.join(', ')}${fired.length > 4 ? `, and ${fired.length - 4} more` : ''}.`,
          `Update ${row.path} in this same pull request and bump its **Last updated:**. Owner: ${row.owner}. If the change genuinely does not affect the document, say so in the pull request and remove or narrow the trigger pattern in ${REGISTRY_REL} — do not bypass the gate.`,
        );
      }
    }
  }

  return { rows, today, problems, ages, onDisk, docDates, triggerFindings };
}

/* ------------------------------------------------------------------- sync */

function sync(docDates) {
  const text = readFileSync(REGISTRY_PATH, 'utf8');
  const lines = text.split('\n');
  let changed = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim().startsWith('|')) continue;
    const path = firstCodeSpan(line);
    if (!path || !docDates.has(path)) continue;
    const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|');
    if (cells.length < 7) continue;
    const want = docDates.get(path);
    if (cells[6].trim() === want) continue;
    cells[6] = ` ${want} `;
    lines[i] = `|${cells.join('|')}|`;
    changed++;
  }
  if (changed) writeFileSync(REGISTRY_PATH, lines.join('\n'), 'utf8');
  return changed;
}

/* ----------------------------------------------------------------- output */

const KIND_LABEL = {
  unregistered: 'Unregistered document',
  'missing-file': 'Registered file missing',
  'no-metadata': 'No Last updated line',
  'bad-date': 'Unparseable date',
  'registry-drift': 'Registry column out of date',
  stale: 'Stale',
  'future-date': 'Date in the future',
  'not-indexed': 'Missing from the docs index',
  trigger: 'Trigger rule violated',
};

function report(result, opts) {
  const { problems, rows, today, ages } = result;

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          ok: problems.length === 0,
          today,
          registry: REGISTRY_REL,
          registered: rows.length,
          scanned: result.onDisk.length,
          changedMode: opts.changedMode,
          changedFiles: opts.changed,
          problems,
        },
        null,
        2,
      ),
    );
    return;
  }

  const oldest = [...ages].sort((a, b) => b.age - a.age)[0];
  console.log('');
  console.log(`Doc freshness — ${rows.length} registered, ${result.onDisk.length} markdown files scanned, today ${today}.`);
  if (oldest) console.log(`Oldest document: ${oldest.path} at ${oldest.age} day(s), limit ${oldest.maxAge}.`);
  if (opts.changedMode) console.log(`Changed-file mode: ${opts.changed.length} path(s) in the diff.`);

  if (!problems.length) {
    console.log('');
    console.log('All checks passed: registration, metadata, registry agreement, age, index coverage' + (opts.changedMode ? ', trigger rules.' : '.'));
    console.log('');
    return;
  }

  const byKind = new Map();
  for (const p of problems) {
    if (!byKind.has(p.kind)) byKind.set(p.kind, []);
    byKind.get(p.kind).push(p);
  }

  console.log('');
  console.log(`${problems.length} problem(s):`);
  for (const [kind, items] of byKind) {
    console.log('');
    console.log(`  ${KIND_LABEL[kind] ?? kind} (${items.length})`);
    for (const item of items) {
      console.log(`    ${item.path}`);
      console.log(`      ${item.message}`);
      console.log(`      Fix: ${item.fix}`);
    }
  }
  console.log('');
  console.log(`Configuration: ${REGISTRY_REL}. The doctrine and the escalation path are in the same file.`);
  console.log('');
}

/* ------------------------------------------------------------------- main */

const opts = parseArgs(process.argv.slice(2));

if (opts.sync) {
  const pre = run({ ...opts, changedMode: false, changed: [] });
  const n = sync(pre.docDates);
  console.log(n ? `Synced ${n} "Last updated" cell(s) in ${REGISTRY_REL} from the document headers.` : `${REGISTRY_REL} already agrees with every document header.`);
  process.exit(0);
}

const result = run(opts);
report(result, opts);
process.exit(result.problems.length ? 1 : 0);
