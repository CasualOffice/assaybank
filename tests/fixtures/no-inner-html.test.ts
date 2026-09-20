/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The structural half of the XSS defence for question content (T-038, ADR-022).
 *
 * `packages/markdown` proves that what comes *out* of the parser is safe. That proof is only
 * worth something while the parser is the only way author content reaches the page, and
 * nothing in a type system stops a future screen from reaching for `dangerouslySetInnerHTML`
 * or pulling in a markdown library with an `html: true` option — both of which are one line,
 * both of which look reasonable in a diff, and both of which silently retire the argument.
 *
 * So this asserts the two facts the argument rests on:
 *
 *   1. No front-end source assigns HTML from a string.
 *   2. No workspace depends on a markdown or HTML-sanitising library.
 *
 * The second is the surprising one. A sanitiser in the tree is not reassuring here, it is the
 * signal that somebody is generating markup to sanitise — which is the design this repository
 * decided against, because a sanitiser is a filter that has to be right about every browser
 * parsing quirk forever, and a parser that never emits markup has nothing to be right about.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');

/** This file names every pattern it bans, so it must exempt itself from its own scan. */
const SELF = 'tests/fixtures/no-inner-html.test.ts';

/** Source that renders into a browser. The server-side apps have no DOM to injure. */
const RENDERING_SOURCE = /^(?:packages\/ui|apps\/web|apps\/candidate)\/.*\.tsx?$/u;

/** Ways a string becomes markup. Each is a real API; none has a safe use here. */
const HTML_SINKS: readonly { readonly pattern: RegExp; readonly why: string }[] = [
  {
    pattern: /dangerouslySetInnerHTML/u,
    why: 'React names it that way because it is that. Render nodes, not markup.',
  },
  {
    pattern: /\.innerHTML\s*=/u,
    why: 'Assigning innerHTML parses the string as HTML, which is the whole threat.',
  },
  { pattern: /\.outerHTML\s*=/u, why: 'Same parser, same threat.' },
  { pattern: /insertAdjacentHTML/u, why: 'Same parser, same threat.' },
  {
    pattern: /document\s*\.\s*write\s*\(/u,
    why: 'Same parser, and it also blocks the page while it runs.',
  },
  {
    pattern: /createContextualFragment/u,
    why: 'Range.createContextualFragment parses HTML with no CSP check.',
  },
];

/**
 * Libraries whose presence means markup is being generated somewhere.
 *
 * Not a licence question — most of these are MIT. It is a question of which design is in
 * force, and a second markdown pipeline in the tree means the answer is "both", which is the
 * same as "neither".
 */
const MARKUP_LIBRARIES: readonly string[] = [
  'marked',
  'markdown-it',
  'showdown',
  'remark',
  'remark-html',
  'rehype',
  'react-markdown',
  'micromark',
  'snarkdown',
  'commonmark',
  'dompurify',
  'isomorphic-dompurify',
  'sanitize-html',
  'xss',
  'html-react-parser',
];

/**
 * A file's code with its comments removed.
 *
 * Necessary because the files that implement this design explain it, and explaining it means
 * naming `dangerouslySetInnerHTML` and quoting the payloads. A scan that could not tell a
 * warning from a use would force the code to stop saying why — the opposite of the point.
 */
function codeOf(file: string): string {
  return readFileSync(resolve(ROOT, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/^\s*\/\/.*$/gmu, '');
}

function trackedFiles(): readonly string[] {
  return execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
}

describe('author markdown never becomes a string of markup', () => {
  const files = trackedFiles();

  it('finds the rendering source it is meant to be scanning', () => {
    // Without this, a change to the layout would turn the suite below into zero assertions
    // that pass — the failure mode of every "assert nothing matches" test.
    const scanned = files.filter((file) => RENDERING_SOURCE.test(file));
    expect(scanned.length).toBeGreaterThan(20);
    expect(scanned).toContain('packages/ui/src/components/Markdown.tsx');
  });

  it.each(HTML_SINKS)('no front-end source uses $pattern — $why', ({ pattern }) => {
    const offenders = files
      .filter((file) => RENDERING_SOURCE.test(file) && file !== SELF)
      .filter((file) => pattern.test(codeOf(file)));

    expect(offenders).toEqual([]);
  });

  it('no workspace depends on a markdown or HTML-sanitising library', () => {
    const found: string[] = [];
    for (const file of files.filter((f) => f.endsWith('package.json'))) {
      const manifest = JSON.parse(readFileSync(resolve(ROOT, file), 'utf8')) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const names = [
        ...Object.keys(manifest.dependencies ?? {}),
        ...Object.keys(manifest.devDependencies ?? {}),
      ];
      for (const name of names) {
        if (MARKUP_LIBRARIES.includes(name)) found.push(`${file}: ${name}`);
      }
    }

    expect(found).toEqual([]);
  });

  it('the parser itself emits no markup — it has no string of tags to emit', () => {
    // A belt-and-braces read of the one package that could quietly start producing HTML.
    const parser = files.filter((f) => f.startsWith('packages/markdown/src/') && f.endsWith('.ts'));
    expect(parser.length).toBeGreaterThan(3);

    for (const file of parser) {
      if (file.endsWith('.test.ts')) continue;
      expect(codeOf(file)).not.toMatch(/['"`]<\/?[a-zA-Z]/u);
    }
  });
});
