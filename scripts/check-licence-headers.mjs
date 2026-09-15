#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Enforces the MPL-2.0 Exhibit A notice on every source file (ADR-020).
// MPL is copyleft at FILE granularity, so the header is not decoration: it is
// what marks a file as Covered Software. A file without it has an ambiguous
// licence status, and ambiguity is discovered at the worst possible moment.

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, extname, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const NOTICE = 'subject to the terms of the Mozilla Public';
const URL_LINE = 'mozilla.org/MPL/2.0';

// Comment syntax by extension. A file type absent here is not checked.
const STYLES = {
  '.ts': 'block', '.tsx': 'block', '.js': 'block', '.jsx': 'block',
  '.mjs': 'block', '.cjs': 'block', '.css': 'block',
  '.sql': 'dash', '.sh': 'hash', '.yml': 'hash', '.yaml': 'hash',
};

const SKIP_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'build', 'coverage', '.turbo', '.next',
  'brand',             // generated artwork and its generator carry their own notice
  '.github',           // workflow YAML is configuration, not Covered Software
  'infra',             // third-party service configuration
]);

// Files that are configuration rather than source, or are generated.
const SKIP_FILES = new Set(['pnpm-lock.yaml', 'docker-compose.yml', 'docker-compose.prod.yml']);

const argv = new Set(process.argv.slice(2));
const FIX = argv.has('--fix');
const JSON_OUT = argv.has('--json');

function header(style) {
  if (style === 'block') {
    return '/* This Source Code Form is subject to the terms of the Mozilla Public\n' +
           ' * License, v. 2.0. If a copy of the MPL was not distributed with this\n' +
           ' * file, You can obtain one at https://mozilla.org/MPL/2.0/. */\n';
  }
  const lead = style === 'dash' ? '--' : '#';
  return `${lead} This Source Code Form is subject to the terms of the Mozilla Public\n` +
         `${lead} License, v. 2.0. If a copy of the MPL was not distributed with this\n` +
         `${lead} file, You can obtain one at https://mozilla.org/MPL/2.0/.\n`;
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (STYLES[extname(entry)] && !SKIP_FILES.has(entry)) out.push(full);
  }
  return out;
}

const files = walk(ROOT);
const missing = [];

for (const file of files) {
  const body = readFileSync(file, 'utf8');
  // Only the first 10 lines: a notice buried further down does not serve its purpose.
  const head = body.split('\n').slice(0, 10).join('\n');
  if (head.includes(NOTICE) && head.includes(URL_LINE)) continue;

  if (FIX) {
    const style = STYLES[extname(file)];
    // Preserve a shebang as the first line.
    const shebang = body.startsWith('#!') ? body.slice(0, body.indexOf('\n') + 1) : '';
    const rest = body.slice(shebang.length);
    const sep = rest.startsWith('\n') ? '' : '\n';
    writeFileSync(file, shebang + header(style) + sep + rest);
  }
  missing.push(relative(ROOT, file));
}

if (JSON_OUT) {
  console.log(JSON.stringify({ checked: files.length, missing }, null, 2));
} else if (missing.length === 0) {
  console.log(`\nLicence headers — ${files.length} source file(s) checked, all carry the MPL-2.0 notice.\n`);
} else if (FIX) {
  console.log(`\nLicence headers — added the MPL-2.0 notice to ${missing.length} file(s):\n`);
  for (const m of missing) console.log(`  ${m}`);
  console.log('');
} else {
  console.error(`\nLicence headers — ${missing.length} of ${files.length} source file(s) are missing the MPL-2.0 notice:\n`);
  for (const m of missing) console.error(`  ${m}`);
  console.error(`
Every source file must carry the Exhibit A notice (ADR-020). MPL-2.0 is copyleft
at file granularity, so the header is what marks a file as Covered Software.

Fix: node scripts/check-licence-headers.mjs --fix
`);
  process.exit(1);
}

if (files.length === 0) {
  console.log('No source files yet. The gate is armed and will enforce from P0 onwards.\n');
}
