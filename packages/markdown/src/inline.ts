/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Inline markdown: code spans, emphasis, links, images, hard breaks.
 *
 * A single left-to-right scan. At each position the character decides which construct might
 * start there, and every construct that does not complete falls back to being literal text —
 * which is the behaviour an author expects and the one that keeps the parser total. There is
 * no input for which this throws, and no input for which it emits a node type outside the
 * union in `ast.ts`.
 *
 * Code spans are checked before everything else, so a backtick run wins over a `*` inside it.
 * That is not a nicety: it is why `SELECT count(*) FROM t` written as inline code survives,
 * and it is worth stating because the first version of the list screen's excerpt helper
 * stripped every asterisk in the prompt and turned that exact expression into `count()`.
 */

import { type Inline, type RejectedUrl } from './ast.js';
import { safeUrl } from './url.js';

/** Characters a backslash may escape, per CommonMark. */
const ESCAPABLE = new Set('\\`*_{}[]()#+-.!|<>~"\'&$%,/:;=?@^');

/** A collector for the destinations the parser refused, shared across one document. */
export interface InlineContext {
  readonly rejectedUrls: RejectedUrl[];
}

/** Flattens a node tree to its text, for the label on a rejected-URL diagnostic. */
export function textOf(nodes: readonly Inline[]): string {
  return nodes
    .map((node) => {
      switch (node.type) {
        case 'text':
        case 'code':
          return node.value;
        case 'strong':
        case 'emphasis':
          return textOf(node.children);
        case 'link':
          return textOf(node.children);
        case 'image':
          return node.alt;
        case 'break':
          return ' ';
      }
    })
    .join('');
}

/** Appends to the trailing text node if there is one, so the output has no adjacent runs. */
function pushText(out: Inline[], value: string): void {
  if (value === '') return;
  const last = out[out.length - 1];
  if (last?.type === 'text') {
    out[out.length - 1] = { type: 'text', value: last.value + value };
    return;
  }
  out.push({ type: 'text', value });
}

/**
 * Finds the `]` that closes the `[` at `open`, respecting nesting and escapes.
 *
 * Returns `-1` when there is none, which makes the `[` literal.
 */
function closingBracket(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    const char = src[i];
    if (char === '\\') {
      i += 1;
      continue;
    }
    if (char === '[') depth += 1;
    else if (char === ']') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Reads the `(destination "title")` after a link label.
 *
 * The title is parsed so that it can be discarded: a `title` attribute is a tooltip that
 * never appears on a keyboard or a touch device and is not an accessible name (WCAG 1.3.1),
 * so carrying it into the AST would invite the renderer to put information there that a
 * third of users cannot reach.
 */
function readDestination(src: string, from: number): { dest: string; end: number } | null {
  if (src[from] !== '(') return null;
  let i = from + 1;
  let depth = 1;
  let dest = '';
  let inTitle: string | null = null;

  for (; i < src.length; i += 1) {
    const char = src[i] ?? '';
    if (char === '\\' && i + 1 < src.length) {
      const next = src[i + 1] ?? '';
      if (inTitle === null) dest += ESCAPABLE.has(next) ? next : `\\${next}`;
      i += 1;
      continue;
    }
    if (inTitle !== null) {
      if (char === inTitle) inTitle = null;
      continue;
    }
    if (char === '"' || char === "'") {
      inTitle = char;
      continue;
    }
    if (char === '(') depth += 1;
    else if (char === ')') {
      depth -= 1;
      if (depth === 0) return { dest: dest.trim(), end: i + 1 };
    }
    if (char === '\n') return null;
    dest += char;
  }
  return null;
}

/**
 * The length of the emphasis span opening at `start`, or `-1`.
 *
 * A simplification of CommonMark's flanking rules, kept because the full algorithm is a
 * delimiter stack whose behaviour nobody can predict from reading a prompt. The rule here is
 * one an author can hold in their head: a run opens only when the character after it is not
 * whitespace, and closes only when the character before it is not whitespace. Underscores
 * additionally never open or close inside a word, so `max_score_delta` is a name and not an
 * italicised fragment.
 */
function emphasisRun(src: string, start: number, marker: string, length: number): number {
  const opensWith = src[start + length];
  if (opensWith === undefined || /\s/u.test(opensWith)) return -1;
  if (marker === '_') {
    const before = src[start - 1];
    if (before !== undefined && /[\p{L}\p{N}]/u.test(before)) return -1;
  }

  const run = marker.repeat(length);
  let i = start + length;
  while (i < src.length) {
    const found = src.indexOf(run, i);
    if (found === -1) return -1;
    // A longer run of the same marker is not this delimiter.
    if (src[found + length] === marker && marker !== '_') {
      i = found + length + 1;
      continue;
    }
    const before = src[found - 1] ?? '';
    const after = src[found + length];
    const closes =
      !/\s/u.test(before) &&
      before !== marker &&
      (marker !== '_' || after === undefined || !/[\p{L}\p{N}]/u.test(after));
    if (closes) return found;
    i = found + length;
  }
  return -1;
}

/** Parses one run of inline markdown into nodes. */
export function parseInline(src: string, ctx: InlineContext): readonly Inline[] {
  const out: Inline[] = [];
  let i = 0;

  const link = (labelSrc: string, dest: string, isImage: boolean): boolean => {
    const href = safeUrl(dest);
    const children = isImage ? [] : parseInline(labelSrc, ctx);
    const label = isImage ? labelSrc : textOf(children);
    if (href === null) {
      ctx.rejectedUrls.push({ url: dest, reason: 'scheme-not-allowed', label });
      // The words stay. Removing them too would delete the author's sentence in order to
      // remove its link, and the reader would never know a word was missing.
      if (isImage) pushText(out, label);
      else out.push(...children);
      return true;
    }
    if (isImage) out.push({ type: 'image', src: href, alt: label });
    else out.push({ type: 'link', href, children });
    return true;
  };

  while (i < src.length) {
    const char = src[i] ?? '';

    if (char === '\\') {
      const next = src[i + 1];
      if (next === '\n') {
        out.push({ type: 'break' });
        i += 2;
        continue;
      }
      if (next !== undefined && ESCAPABLE.has(next)) {
        pushText(out, next);
        i += 2;
        continue;
      }
      pushText(out, char);
      i += 1;
      continue;
    }

    if (char === '`') {
      let length = 0;
      while (src[i + length] === '`') length += 1;
      const run = '`'.repeat(length);
      let search = i + length;
      let close = -1;
      while (search < src.length) {
        const found = src.indexOf(run, search);
        if (found === -1) break;
        if (src[found + length] === '`') {
          search = found + length;
          while (src[search] === '`') search += 1;
          continue;
        }
        close = found;
        break;
      }
      if (close !== -1) {
        let value = src.slice(i + length, close);
        // CommonMark: one space is stripped from each end when both are present, so that
        // `` ` `` can hold a literal backtick.
        if (
          value.length > 2 &&
          value.startsWith(' ') &&
          value.endsWith(' ') &&
          value.trim() !== ''
        ) {
          value = value.slice(1, -1);
        }
        out.push({ type: 'code', value: value.replace(/\n/gu, ' ') });
        i = close + length;
        continue;
      }
      pushText(out, run);
      i += length;
      continue;
    }

    if (char === '!' && src[i + 1] === '[') {
      const close = closingBracket(src, i + 1);
      const dest = close === -1 ? null : readDestination(src, close + 1);
      if (close !== -1 && dest !== null) {
        link(src.slice(i + 2, close), dest.dest, true);
        i = dest.end;
        continue;
      }
    }

    if (char === '[') {
      const close = closingBracket(src, i);
      const dest = close === -1 ? null : readDestination(src, close + 1);
      if (close !== -1 && dest !== null) {
        link(src.slice(i + 1, close), dest.dest, false);
        i = dest.end;
        continue;
      }
    }

    if (char === '<') {
      // An autolink: `<https://example.com>`. The angle brackets are the syntax, so this is
      // not raw HTML — and `findRawHtml` agrees, or a prompt could not cite a URL.
      const close = src.indexOf('>', i);
      const body = close === -1 ? '' : src.slice(i + 1, close);
      if (
        close !== -1 &&
        body !== '' &&
        !/[\s<]/u.test(body) &&
        /^[a-zA-Z][a-zA-Z0-9+\-.]*:/u.test(body)
      ) {
        const href = safeUrl(body);
        if (href === null) {
          ctx.rejectedUrls.push({ url: body, reason: 'scheme-not-allowed', label: body });
          pushText(out, body);
        } else {
          out.push({ type: 'link', href, children: [{ type: 'text', value: body }] });
        }
        i = close + 1;
        continue;
      }
    }

    if (char === '*' || char === '_') {
      let length = 0;
      while (src[i + length] === char) length += 1;
      const width = length >= 2 ? 2 : 1;
      const close = emphasisRun(src, i, char, width);
      if (close !== -1) {
        const children = parseInline(src.slice(i + width, close), ctx);
        out.push(width === 2 ? { type: 'strong', children } : { type: 'emphasis', children });
        i = close + width;
        continue;
      }
      pushText(out, char.repeat(length));
      i += length;
      continue;
    }

    if (char === '\n') {
      // Two trailing spaces is a hard break; anything else is a soft one, which is a space.
      const hard = src.slice(0, i).endsWith('  ');
      if (hard) {
        while (out.length > 0 && out[out.length - 1]?.type === 'text') {
          const last = out[out.length - 1];
          if (last?.type !== 'text') break;
          const trimmed = last.value.replace(/[ ]+$/u, '');
          if (trimmed === '') out.pop();
          else {
            out[out.length - 1] = { type: 'text', value: trimmed };
            break;
          }
        }
        out.push({ type: 'break' });
      } else {
        pushText(out, ' ');
      }
      i += 1;
      continue;
    }

    pushText(out, char);
    i += 1;
  }

  return out;
}
