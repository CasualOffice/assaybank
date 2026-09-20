/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The shape a question prompt is allowed to have.
 *
 * This is the allow list. It is expressed as a closed union of node types rather than as a
 * list of permitted tags checked against generated HTML, because the two differ in what
 * happens when they are wrong: a tag allow list that misses a case lets the tag through,
 * whereas a union that misses a case will not compile in the renderer. The parser produces
 * only these nodes and the renderer handles only these nodes, so there is no step at which
 * a string of markup exists to be sanitised — or to escape sanitising (ADR-022).
 *
 * `text` values are raw author text. They are never markup: `<script>` in a prompt arrives
 * here as five characters of text and is rendered as five characters on screen.
 */

/** A hyperlink or image destination that survived {@link import('./url.js').safeUrl}. */
export type SafeUrl = string;

export type Inline =
  | { readonly type: 'text'; readonly value: string }
  /** An inline code span. Its contents are text, never a nested node. */
  | { readonly type: 'code'; readonly value: string }
  | { readonly type: 'strong'; readonly children: readonly Inline[] }
  | { readonly type: 'emphasis'; readonly children: readonly Inline[] }
  | { readonly type: 'link'; readonly href: SafeUrl; readonly children: readonly Inline[] }
  /**
   * `alt` is required and may be empty. An empty alt is the correct markup for a decorative
   * image (WCAG 1.1.1), so the renderer must be able to tell "the author wrote no alt text"
   * from "the author said this image carries no information" — which it cannot do if the
   * field is optional.
   */
  | { readonly type: 'image'; readonly src: SafeUrl; readonly alt: string }
  /** A hard line break — two trailing spaces, or a trailing backslash. */
  | { readonly type: 'break' };

/** Column alignment in a table. `null` is the author declining to specify one. */
export type ColumnAlign = 'left' | 'center' | 'right' | null;

export type Block =
  | {
      readonly type: 'heading';
      /** As the author wrote it. The renderer offsets it into the surrounding page. */
      readonly level: 1 | 2 | 3 | 4 | 5 | 6;
      readonly children: readonly Inline[];
    }
  | { readonly type: 'paragraph'; readonly children: readonly Inline[] }
  /**
   * A fenced code block. `value` is verbatim source text and `language` is the info string's
   * first word, restricted to `[a-z0-9+#-]` so it can be used in a class name without
   * anything else having to escape it.
   */
  | { readonly type: 'code'; readonly language: string | null; readonly value: string }
  | {
      readonly type: 'list';
      readonly ordered: boolean;
      /** The first number of an ordered list; 1 for an unordered one. */
      readonly start: number;
      readonly items: readonly (readonly Block[])[];
    }
  | { readonly type: 'quote'; readonly children: readonly Block[] }
  | { readonly type: 'rule' }
  | {
      readonly type: 'table';
      readonly align: readonly ColumnAlign[];
      readonly head: readonly (readonly Inline[])[];
      readonly rows: readonly (readonly (readonly Inline[])[])[];
    };

/** Raw HTML found in the source, with enough context to show the author what was refused. */
export interface RawHtmlFinding {
  /** The offending fragment, e.g. `<img src=x onerror=…>`, truncated to 80 characters. */
  readonly fragment: string;
  /** 1-based line number in the source. */
  readonly line: number;
}

/** A link or image destination the parser refused, and the reason. */
export interface RejectedUrl {
  readonly url: string;
  readonly reason: 'scheme-not-allowed';
  /** The link text or image alt, so the author can find it in their prompt. */
  readonly label: string;
}

/**
 * A parsed prompt, plus what the parser refused.
 *
 * The refusals are returned rather than logged because T-038 requires the author to see what
 * was removed. A pipeline that silently strips a `javascript:` link teaches nobody anything;
 * the author re-adds it next week in a different shape.
 */
export interface MarkdownDocument {
  readonly blocks: readonly Block[];
  readonly rawHtml: readonly RawHtmlFinding[];
  readonly rejectedUrls: readonly RejectedUrl[];
}
