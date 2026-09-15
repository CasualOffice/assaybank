#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * check-links.mjs
 *
 * Walks every markdown file in the repository, extracts relative links and
 * heading anchors, and verifies that each target exists and each anchor
 * resolves. A cross-reference that 404s is the cheapest kind of documentation
 * lie and the easiest to prevent, so this gate is absolute: any break fails.
 *
 *   node scripts/check-links.mjs           check the whole repository
 *   node scripts/check-links.mjs --json    machine-readable report
 *   node scripts/check-links.mjs --list    list every link that was checked
 *   node scripts/check-links.mjs --external
 *       Unimplemented by design. See the note below.
 *
 * External http(s) links are not checked. Doing so makes the gate depend on
 * the network and on other people's uptime, which turns a deterministic check
 * into a flaky one, and a flaky gate is a gate that gets disabled. Link rot in
 * external references is real but it is a periodic review problem, not a
 * per-pull-request one.
 *
 * Zero dependencies. Node 22 LTS.
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

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
  '.turbo',
  '.vscode',
  '.idea',
]);

const SCANNED_DOT_DIRS = new Set(['.claude', '.github']);
const EXTERNAL_SCHEME = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

/* -------------------------------------------------------------------- args */

const argv = process.argv.slice(2);
const opts = {
  json: argv.includes('--json'),
  list: argv.includes('--list'),
  external: argv.includes('--external'),
};
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(
    [
      'check-links.mjs — relative link and anchor checker',
      '',
      '  node scripts/check-links.mjs [--json] [--list]',
      '',
      '  --external   unimplemented by design; see the header comment.',
    ].join('\n'),
  );
  process.exit(0);
}
for (const a of argv) {
  if (!['--json', '--list', '--external'].includes(a)) {
    console.error(`check-links: unknown argument ${a}. Try --help.`);
    process.exit(2);
  }
}

/* -------------------------------------------------------------------- walk */

function walk(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      if (entry.name.startsWith('.') && !SCANNED_DOT_DIRS.has(entry.name)) continue;
      walk(abs, acc);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      acc.push(abs);
    }
  }
  return acc;
}

const relRoot = (abs) => relative(ROOT, abs).split(sep).join(posix.sep);

/* ------------------------------------------------------- markdown scanning */

/**
 * Blank out fenced code blocks and inline code spans, preserving line count and
 * column positions so that reported line numbers stay accurate. Links inside
 * code are examples, not references, and must not be resolved.
 */
function maskCode(text) {
  const lines = text.split('\n');
  let fence = null;
  return lines.map((line) => {
    const fenceMatch = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (fence) {
      if (fenceMatch && fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length) fence = null;
      return '';
    }
    if (fenceMatch) {
      fence = fenceMatch[1];
      return '';
    }
    // Inline code spans, longest run of backticks first.
    return line.replace(/(`+)(?:[^`]|(?!\1)`)*\1/g, (m) => ' '.repeat(m.length));
  });
}

/** GitHub heading-anchor slug: lowercase, drop punctuation, spaces to hyphens. */
function slugify(headingText) {
  const text = headingText
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_~]/g, '')
    .trim();
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

/** Every anchor a markdown file offers: heading slugs plus explicit HTML ids. */
function anchorsOf(absPath) {
  const raw = readFileSync(absPath, 'utf8');
  const masked = maskCode(raw);
  const rawLines = raw.split('\n');
  const seen = new Map();
  const anchors = new Set();

  for (const [i, line] of masked.entries()) {
    const m = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (m) {
      const base = slugify(m[2]);
      if (base) {
        const n = seen.get(base) ?? 0;
        seen.set(base, n + 1);
        anchors.add(n === 0 ? base : `${base}-${n}`);
      }
    }
    // Explicit anchors survive in the raw line even where code was masked.
    for (const a of rawLines[i].matchAll(/<a\s+[^>]*(?:name|id)\s*=\s*["']([^"']+)["']/gi)) {
      anchors.add(a[1].toLowerCase());
    }
  }
  return anchors;
}

const anchorCache = new Map();
function anchorsFor(absPath) {
  if (!anchorCache.has(absPath)) anchorCache.set(absPath, anchorsOf(absPath));
  return anchorCache.get(absPath);
}

/** Extract every link target from one markdown file. */
function linksOf(absPath) {
  const masked = maskCode(readFileSync(absPath, 'utf8'));
  const out = [];

  for (const [i, line] of masked.entries()) {
    if (!line) continue;

    // Inline links and images: [text](target) / ![alt](target "title")
    for (const m of line.matchAll(/!?\[(?:[^\]]*)\]\(\s*(<[^>]*>|[^()\s]+(?:\([^()]*\)[^()\s]*)*)\s*(?:"[^"]*"|'[^']*')?\s*\)/g)) {
      out.push({ target: m[1].replace(/^<|>$/g, ''), line: i + 1, kind: 'inline' });
    }
    // Reference definitions: [label]: target
    const ref = line.match(/^\s{0,3}\[([^\]^]+)\]:\s*(<[^>]*>|\S+)/);
    if (ref) out.push({ target: ref[2].replace(/^<|>$/g, ''), line: i + 1, kind: 'reference' });
  }
  return out;
}

/* ------------------------------------------------------------------ checks */

const files = walk(ROOT).sort();
const problems = [];
const checked = [];
let internalCount = 0;
let externalCount = 0;
let anchorCount = 0;

for (const abs of files) {
  const source = relRoot(abs);
  for (const link of linksOf(abs)) {
    const target = link.target.trim();
    if (!target) continue;

    if (EXTERNAL_SCHEME.test(target)) {
      externalCount++;
      continue;
    }

    internalCount++;
    const hashAt = target.indexOf('#');
    const pathPart = hashAt === -1 ? target : target.slice(0, hashAt);
    const anchor = hashAt === -1 ? '' : decodeURIComponent(target.slice(hashAt + 1)).toLowerCase();

    let targetAbs;
    if (pathPart === '') {
      targetAbs = abs; // same-file anchor
    } else {
      const decoded = decodeURIComponent(pathPart);
      targetAbs = decoded.startsWith('/') ? join(ROOT, decoded.slice(1)) : resolve(dirname(abs), decoded);
    }

    if (!existsSync(targetAbs)) {
      problems.push({
        source,
        line: link.line,
        target,
        kind: 'missing-target',
        message: `target does not exist: ${relRoot(targetAbs)}`,
      });
      continue;
    }

    const isDir = statSync(targetAbs).isDirectory();
    if (isDir && anchor) {
      problems.push({
        source,
        line: link.line,
        target,
        kind: 'anchor-on-directory',
        message: `anchor "#${anchor}" points at a directory`,
      });
      continue;
    }

    if (anchor && !isDir) {
      if (targetAbs.toLowerCase().endsWith('.md')) {
        anchorCount++;
        const anchors = anchorsFor(targetAbs);
        if (!anchors.has(anchor)) {
          const near = [...anchors].filter((a) => a.includes(anchor.split('-')[0])).slice(0, 3);
          problems.push({
            source,
            line: link.line,
            target,
            kind: 'missing-anchor',
            message:
              `no heading in ${relRoot(targetAbs)} slugifies to "#${anchor}"` +
              (near.length ? `. Closest: ${near.map((n) => `#${n}`).join(', ')}` : ''),
          });
          continue;
        }
      }
      // Anchors into non-markdown files are not resolvable here and are left alone.
    }

    checked.push({ source, line: link.line, target, resolved: relRoot(targetAbs) });
  }
}

/* ------------------------------------------------------------------ output */

if (opts.json) {
  console.log(
    JSON.stringify(
      {
        ok: problems.length === 0,
        files: files.length,
        internalLinks: internalCount,
        externalLinksSkipped: externalCount,
        anchorsResolved: anchorCount,
        problems,
      },
      null,
      2,
    ),
  );
  process.exit(problems.length ? 1 : 0);
}

console.log('');
if (opts.external) {
  console.log('--external is unimplemented by design: an external link check makes CI depend on the');
  console.log('network and on third-party uptime, which makes the gate flaky, and a flaky gate gets');
  console.log('disabled. External link rot is handled by the review cadence in docs/DOC-OWNERSHIP.md.');
  console.log('');
}
console.log(
  `Link check — ${files.length} markdown file(s), ${internalCount} relative link(s), ` +
    `${anchorCount} anchor(s) resolved, ${externalCount} external link(s) skipped.`,
);

if (opts.list) {
  console.log('');
  for (const c of checked) console.log(`  ok  ${c.source}:${c.line}  ${c.target}`);
}

if (!problems.length) {
  console.log('');
  console.log('No broken relative links.');
  console.log('');
  process.exit(0);
}

const bySource = new Map();
for (const p of problems) {
  if (!bySource.has(p.source)) bySource.set(p.source, []);
  bySource.get(p.source).push(p);
}

console.log('');
console.log(`${problems.length} broken link(s) in ${bySource.size} file(s):`);
for (const [source, items] of bySource) {
  console.log('');
  console.log(`  ${source}`);
  for (const item of items) {
    console.log(`    line ${item.line}: ${item.target}`);
    console.log(`      ${item.message}`);
  }
}
console.log('');
console.log('Fix the path, or fix the heading the anchor points at. Do not create a document to satisfy a link.');
console.log('');
process.exit(1);
