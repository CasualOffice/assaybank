/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Finding raw HTML in markdown source, so the author is told rather than corrected.
 *
 * The renderer does not need this. It never interprets HTML, so `<img src=x onerror=…>` in a
 * prompt renders as that text and does nothing. What needs it is the import path: T-038's
 * scenario is thousands of prompts arriving from a public dataset or a customer's legacy
 * bank, and a prompt written against a renderer that *did* interpret HTML is not inert, it is
 * *wrong* — a table that was markup becomes a paragraph of angle brackets in front of a
 * candidate under time pressure.
 *
 * So the import job refuses the row and names the fragment (`H-032`), and the authoring
 * editor warns while the author can still fix it. Silently stripping would leave a prompt
 * that looks fine to the importer and is missing its diagram.
 */

import { type RawHtmlFinding } from './ast.js';

/**
 * An HTML tag, comment, declaration or processing instruction.
 *
 * A markdown autolink, `<https://example.com>`, does not match: the tag-name group is
 * `[a-zA-Z][a-zA-Z0-9-]*` and must be followed by whitespace, `/` or `>`, and a scheme is
 * followed by `:`. Nor does arithmetic — `a < b` has no tag name after the `<`.
 */
const HTML_LIKE =
  /<(?:\/?[a-zA-Z][a-zA-Z0-9-]*(?:\s[^<>]*)?\/?>|!--[\s\S]*?--!?>|![^<>]*>|\?[\s\S]*?\?>)/gu;

/** How much of an offending fragment is worth showing. */
const FRAGMENT_LIMIT = 80;

/**
 * Blanks out code spans and fenced code blocks, preserving length.
 *
 * A prompt that teaches HTML is a normal prompt — "what does this `<div>` do?" — and the
 * whole point of a code fence is that its contents are not markup. Offsets are preserved so
 * the line number reported below is the line in the author's source, not in a rewritten copy.
 */
function maskCode(source: string): string {
  const blank = (text: string): string => text.replace(/[^\n]/gu, ' ');
  let out = '';
  let index = 0;

  const fence = /^[ ]{0,3}(`{3,}|~{3,})[^\n]*$/gmu;
  const spans: { start: number; end: number }[] = [];
  let open: { start: number; marker: string } | null = null;
  for (const match of source.matchAll(fence)) {
    const marker = match[1] ?? '';
    const start = match.index;
    if (open === null) {
      open = { start, marker: marker[0] ?? '`' };
      continue;
    }
    if ((marker[0] ?? '') === open.marker) {
      spans.push({ start: open.start, end: start + match[0].length });
      open = null;
    }
  }
  // An unclosed fence runs to the end of the document, which is what a renderer does too.
  if (open !== null) spans.push({ start: open.start, end: source.length });

  for (const span of spans) {
    out += source.slice(index, span.start) + blank(source.slice(span.start, span.end));
    index = span.end;
  }
  out += source.slice(index);

  // Inline code spans, after the fences, so a backtick inside a fence cannot open one.
  return out.replace(/(`+)(?:[^`]|(?!\1)`)*\1/gu, blank);
}

/** Every raw-HTML fragment in the source, outside code, with the line it is on. */
export function findRawHtml(source: string): readonly RawHtmlFinding[] {
  const masked = maskCode(source);
  const findings: RawHtmlFinding[] = [];

  for (const match of masked.matchAll(HTML_LIKE)) {
    const start = match.index;
    const fragment = source.slice(start, start + match[0].length);
    findings.push({
      fragment:
        fragment.length > FRAGMENT_LIMIT ? `${fragment.slice(0, FRAGMENT_LIMIT)}…` : fragment,
      line: source.slice(0, start).split('\n').length,
    });
  }

  return findings;
}
