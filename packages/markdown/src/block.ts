/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Block markdown: headings, paragraphs, fenced code, lists, quotes, rules, tables.
 *
 * A deliberately small subset of CommonMark, and the smallness is the design rather than an
 * unfinished edge of it. What is left out — setext headings, indented code blocks, reference
 * links, footnotes, raw HTML — is either ambiguous to read in source (four spaces meaning
 * "code" is how a mis-indented list becomes a code block), or a second place to express
 * something the subset already expresses, or the threat itself.
 *
 * The subset is documented in `docs/17-engineering-standards.md` so that an author has
 * something to read other than this file.
 */

import { type Block, type ColumnAlign, type Inline } from './ast.js';
import { parseInline, type InlineContext } from './inline.js';

const BLANK = /^[ \t]*$/u;
const FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*([^`\n]*)$/u;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/u;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/u;
const QUOTE = /^ {0,3}> ?(.*)$/u;
const BULLET = /^( {0,3})([-*+])([ \t]+)(.*)$/u;
const ORDERED = /^( {0,3})(\d{1,9})([.)])([ \t]+)(.*)$/u;
/** The delimiter row of a table: pipes, dashes, colons and spaces, with at least one dash. */
const DELIMITER = /^ {0,3}\|?(?:[ \t]*:?-+:?[ \t]*\|)+[ \t]*:?-*:?[ \t]*\|?[ \t]*$/u;

/** A language name safe to interpolate into a class attribute without further escaping. */
const LANGUAGE = /^[a-z0-9][a-z0-9+#.-]*$/u;

/** True when the line begins a block that a paragraph cannot absorb as a continuation. */
function interruptsParagraph(line: string): boolean {
  return (
    FENCE.test(line) ||
    HEADING.test(line) ||
    RULE.test(line) ||
    QUOTE.test(line) ||
    BULLET.test(line) ||
    // Only `1.` may interrupt a paragraph; `7.` in running prose is a sentence.
    /^( {0,3})1[.)]([ \t]+)/u.test(line)
  );
}

/** Splits a table row on unescaped pipes, discarding the optional leading and trailing one. */
function splitRow(line: string): readonly string[] {
  const cells: string[] = [];
  let cell = '';
  const trimmed = line.trim();
  const body = trimmed.replace(/^\|/u, '').replace(/(?<!\\)\|[ \t]*$/u, '');
  for (let i = 0; i < body.length; i += 1) {
    const char = body[i] ?? '';
    if (char === '\\' && body[i + 1] === '|') {
      cell += '|';
      i += 1;
      continue;
    }
    if (char === '|') {
      cells.push(cell.trim());
      cell = '';
      continue;
    }
    cell += char;
  }
  cells.push(cell.trim());
  return cells;
}

function alignOf(cell: string): ColumnAlign {
  const left = cell.startsWith(':');
  const right = cell.endsWith(':');
  if (left && right) return 'center';
  if (right) return 'right';
  if (left) return 'left';
  return null;
}

/** Parses a sequence of lines into blocks. Recursive for quotes and list items. */
export function parseBlocks(lines: readonly string[], ctx: InlineContext): readonly Block[] {
  const blocks: Block[] = [];
  const inline = (text: string): readonly Inline[] => parseInline(text, ctx);
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? '';

    if (BLANK.test(line)) {
      i += 1;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence !== null) {
      const marker = (fence[1] ?? '```')[0] ?? '`';
      const info = (fence[2] ?? '').trim().split(/\s+/u)[0] ?? '';
      const body: string[] = [];
      i += 1;
      while (i < lines.length) {
        const current = lines[i] ?? '';
        const closing = FENCE.exec(current);
        if (closing !== null && (closing[1] ?? '')[0] === marker && (closing[2] ?? '') === '') {
          i += 1;
          break;
        }
        body.push(current);
        i += 1;
      }
      const language = info.toLowerCase();
      blocks.push({
        type: 'code',
        language: LANGUAGE.test(language) ? language : null,
        value: body.join('\n'),
      });
      continue;
    }

    if (RULE.test(line)) {
      blocks.push({ type: 'rule' });
      i += 1;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading !== null) {
      const level = (heading[1] ?? '#').length as 1 | 2 | 3 | 4 | 5 | 6;
      // A closing run of `#` is decoration, not content.
      const text = (heading[2] ?? '').replace(/[ \t]+#+[ \t]*$/u, '');
      blocks.push({ type: 'heading', level, children: inline(text) });
      i += 1;
      continue;
    }

    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (i < lines.length) {
        const current = lines[i] ?? '';
        const quoted = QUOTE.exec(current);
        if (quoted !== null) {
          body.push(quoted[1] ?? '');
          i += 1;
          continue;
        }
        // Lazy continuation: a plain line inside a quote belongs to its last paragraph.
        if (!BLANK.test(current) && !interruptsParagraph(current)) {
          body.push(current);
          i += 1;
          continue;
        }
        break;
      }
      blocks.push({ type: 'quote', children: parseBlocks(body, ctx) });
      continue;
    }

    const bullet = BULLET.exec(line);
    const ordered = ORDERED.exec(line);
    if (bullet !== null || ordered !== null) {
      const isOrdered = ordered !== null;
      const start = isOrdered ? Number.parseInt(ordered[2] ?? '1', 10) : 1;
      const items: (readonly Block[])[] = [];
      let itemLines: string[] = [];
      let contentIndent = 0;

      const flush = (): void => {
        if (itemLines.length > 0) items.push(parseBlocks(itemLines, ctx));
        itemLines = [];
      };

      while (i < lines.length) {
        const current = lines[i] ?? '';
        const nextBullet = isOrdered ? ORDERED.exec(current) : BULLET.exec(current);
        // A rule wins over a list item: `***` is a break, not a bullet with no content.
        // And a bullet indented past this list's content column is a *nested* list inside
        // the current item, not the next sibling — which is the difference between two
        // levels of a list and four flat items.
        const sibling =
          nextBullet !== null &&
          (items.length === 0 && itemLines.length === 0
            ? true
            : (nextBullet[1] ?? '').length < contentIndent);
        if (nextBullet !== null && sibling && !RULE.test(current)) {
          flush();
          const indent = (nextBullet[1] ?? '').length;
          const markerWidth = isOrdered
            ? (nextBullet[2] ?? '').length + 1 + (nextBullet[4] ?? ' ').length
            : 1 + (nextBullet[3] ?? ' ').length;
          contentIndent = indent + markerWidth;
          itemLines.push(isOrdered ? (nextBullet[5] ?? '') : (nextBullet[4] ?? ''));
          i += 1;
          continue;
        }
        if (BLANK.test(current)) {
          // A blank line ends the list unless the next line continues the current item.
          const next = lines[i + 1] ?? '';
          const continues =
            next !== '' &&
            (next.startsWith(' '.repeat(contentIndent)) ||
              (isOrdered ? ORDERED.test(next) : BULLET.test(next)));
          if (!continues) break;
          itemLines.push('');
          i += 1;
          continue;
        }
        if (current.startsWith(' '.repeat(contentIndent))) {
          itemLines.push(current.slice(contentIndent));
          i += 1;
          continue;
        }
        if (!interruptsParagraph(current) && itemLines.length > 0) {
          itemLines.push(current);
          i += 1;
          continue;
        }
        break;
      }
      flush();
      blocks.push({ type: 'list', ordered: isOrdered, start, items });
      continue;
    }

    if (line.includes('|') && DELIMITER.test(lines[i + 1] ?? '')) {
      const head = splitRow(line);
      const align = splitRow(lines[i + 1] ?? '').map(alignOf);
      if (align.length === head.length) {
        i += 2;
        const rows: (readonly (readonly Inline[])[])[] = [];
        while (i < lines.length) {
          const current = lines[i] ?? '';
          if (BLANK.test(current) || !current.includes('|')) break;
          const cells = splitRow(current);
          // Short rows are padded and long ones truncated, so the table stays rectangular
          // and a screen reader's column announcements keep matching the headers.
          rows.push(head.map((_, column) => inline(cells[column] ?? '')));
          i += 1;
        }
        blocks.push({ type: 'table', align, head: head.map(inline), rows });
        continue;
      }
    }

    const paragraph: string[] = [];
    while (i < lines.length) {
      const current = lines[i] ?? '';
      if (BLANK.test(current) || interruptsParagraph(current)) break;
      if (current.includes('|') && DELIMITER.test(lines[i + 1] ?? '')) break;
      paragraph.push(current.replace(/^[ \t]+/u, ''));
      i += 1;
    }
    blocks.push({ type: 'paragraph', children: inline(paragraph.join('\n')) });
  }

  return blocks;
}
