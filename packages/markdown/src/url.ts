/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The one place a URL from a question prompt is decided on.
 *
 * Markup injection is structurally impossible in this pipeline — nothing ever produces an
 * HTML string (ADR-022) — which leaves exactly one way for author text to become executable:
 * a destination whose scheme runs code. `javascript:`, `data:text/html`, and `vbscript:` on
 * older surfaces all do, and all three arrive as ordinary-looking markdown links.
 *
 * The check is an allow list of schemes, not a block list, for the usual reason: a block list
 * is a list of the attacks somebody thought of. It is applied after two normalisations,
 * because a browser applies them too, and a check that runs on a different string from the
 * one the browser resolves is not a check.
 */

/** Schemes a prompt may link to. Everything else, known or not, is refused. */
const ALLOWED_SCHEMES = new Set(['http:', 'https:', 'mailto:']);

/**
 * `scheme:` at the start of a URL, per RFC 3986 — a letter, then letters, digits, `+`, `-`
 * or `.`. Anything not matching this is a relative reference and inherits the page's origin.
 */
const SCHEME = /^([a-zA-Z][a-zA-Z0-9+\-.]*):/u;

/** Numeric character references, decimal and hexadecimal. */
const NUMERIC_ENTITY = /&#(?:([0-9]{1,7})|[xX]([0-9a-fA-F]{1,6}));/gu;

/** The named references a markdown destination can realistically carry. */
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
  '&colon;': ':',
  '&NewLine;': '\n',
  '&Tab;': '\t',
};

/**
 * Decodes the character references a browser would decode before resolving the URL.
 *
 * A destination written as `&#106;avascript:alert(1)` is a `javascript:` URL to a browser and
 * an unremarkable relative path to a naive scheme check, which is why this runs first.
 * Decoding is applied once rather than to a fixed point: `&amp;#106;` decodes to the literal
 * text `&#106;`, which is exactly what a browser does with it too.
 */
function decodeEntities(input: string): string {
  let out = input.replace(
    NUMERIC_ENTITY,
    (whole: string, dec: string | undefined, hex: string | undefined): string => {
      const code = dec === undefined ? Number.parseInt(hex ?? '', 16) : Number.parseInt(dec, 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    },
  );
  for (const [entity, char] of Object.entries(NAMED_ENTITIES)) {
    out = out.split(entity).join(char);
  }
  return out;
}

/**
 * Removes the characters a browser drops from a URL before parsing it.
 *
 * Tab, line feed and carriage return are stripped from anywhere in a URL by the WHATWG URL
 * parser, so a destination with a tab wedged into the middle of its scheme still navigates.
 * C0 controls and space are stripped from the ends. Both rules are the browser's, restated
 * here so the scheme test below sees the same string the browser will.
 */
function normalise(input: string): string {
  // The end trimming is a loop rather than a character-class regex because the class has
  // to include U+0000, and a NUL inside a regular expression is a lint error everywhere
  // else in this repository for the good reason that it is almost always a typo.
  const stripped = input.replace(/[\t\n\r]/gu, '');
  let start = 0;
  let end = stripped.length;
  while (start < end && stripped.charCodeAt(start) <= 0x20) start += 1;
  while (end > start && stripped.charCodeAt(end - 1) <= 0x20) end -= 1;
  return stripped.slice(start, end);
}

/**
 * The destination to use, or `null` if the prompt may not link to it.
 *
 * A relative reference — `/assets/schema.png`, `diagram.svg`, `#section-2` — carries no
 * scheme and so resolves against the page's own origin, which is ours. It is allowed.
 */
export function safeUrl(raw: string): string | null {
  const url = normalise(decodeEntities(raw));
  if (url === '') return null;

  const match = SCHEME.exec(url);
  if (match === null) {
    // A relative reference — with one shape that is not relative at all. A leading
    // backslash is normalised to a forward slash by browsers, so `\\evil.example/x`
    // becomes the protocol-relative `//evil.example/x` and leaves our origin. Refused
    // rather than reasoned about.
    return url.startsWith('\\') ? null : url;
  }

  const scheme = `${(match[1] ?? '').toLowerCase()}:`;
  return ALLOWED_SCHEMES.has(scheme) ? url : null;
}

/** The scheme allow list, exported so documentation and tests cite one list rather than two. */
export const allowedSchemes: readonly string[] = [...ALLOWED_SCHEMES];
