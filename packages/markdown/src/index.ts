/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `@assaybank/markdown` — the only way author-supplied markdown becomes anything renderable.
 *
 * Question prompts, explanations and scorecard notes are markdown written by one person and
 * rendered in another person's browser, sometimes with a staff session attached and sometimes
 * with an attempt token. That is T-038, and it is the register's most underrated path,
 * because the trust we extend to an *author* does not transfer to the *content* — the import
 * endpoint takes thousands of prompts from datasets nobody has read.
 *
 * The defence is structural rather than filtering: this package parses markdown into a closed
 * union of node types and stops. No stage of it produces an HTML string, so there is no
 * string for a payload to survive in, no sanitiser to get wrong, and no
 * `dangerouslySetInnerHTML` anywhere downstream (ADR-022). Raw HTML in the source is text.
 * Link and image destinations are the one remaining path from author text to browser
 * behaviour, and `safeUrl` is the single gate on it.
 *
 * This package performs no I/O and imports nothing.
 */

export {
  type Block,
  type ColumnAlign,
  type Inline,
  type MarkdownDocument,
  type RawHtmlFinding,
  type RejectedUrl,
  type SafeUrl,
} from './ast.js';
export { findRawHtml } from './raw-html.js';
export { allowedSchemes, safeUrl } from './url.js';
export { textOf } from './inline.js';

import { type MarkdownDocument } from './ast.js';
import { parseBlocks } from './block.js';
import { type InlineContext } from './inline.js';
import { findRawHtml } from './raw-html.js';

/** Line endings, normalised so a CRLF file parses as the same document as an LF one. */
function lines(source: string): readonly string[] {
  return source.replace(/\r\n?/gu, '\n').split('\n');
}

/**
 * Parses author markdown into the document a renderer may display.
 *
 * Total: every input produces a document. Malformed markdown degrades to text rather than
 * throwing, because the alternative is a candidate meeting an error screen in a timed
 * assessment over an unclosed bracket in a prompt.
 */
export function parseMarkdown(source: string): MarkdownDocument {
  const ctx: InlineContext = { rejectedUrls: [] };
  const blocks = parseBlocks(lines(source), ctx);
  return { blocks, rawHtml: findRawHtml(source), rejectedUrls: ctx.rejectedUrls };
}
