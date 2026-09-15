/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A minimal tag scanner for component tests.
 *
 * Component tests in this package render with `react-dom/server` and assert on the
 * markup, because jsdom is not on the ADR-001 approved dependency list and neither is a
 * testing-library. That is a real constraint rather than a preference, and it shapes
 * what these tests can claim: they verify **the accessible markup** — the label
 * association, the `aria-describedby` targets, the roles, the DOM order that focus order
 * follows — and they do not verify behaviour that needs a live document, such as what
 * happens when the skip link is actually activated. docs/15 §15.1 puts that second half
 * in the `@axe-core/playwright` end-to-end suite, where it belongs anyway, since a real
 * browser is the only place a focus assertion means anything.
 *
 * Not exported from `src/index.ts` and excluded from the build: this is test scaffolding,
 * not public API.
 */

/** One opening tag from the rendered markup. */
export interface ScannedTag {
  /** The lower-cased element name. */
  readonly name: string;
  /** Attributes, by lower-cased name. A valueless attribute maps to `''`. */
  readonly attrs: Readonly<Record<string, string>>;
  /** Character offset of the tag, so DOM order can be asserted. */
  readonly at: number;
}

const TAG = /<([a-zA-Z][\w:-]*)((?:\s+[^\s=/>]+(?:=(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*\/?>/g;
const ATTR = /([^\s=/>]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

const ENTITIES: Readonly<Record<string, string>> = Object.freeze({
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  '#39': "'",
  '#x27': "'",
  nbsp: ' ',
});

/** Decodes the entity subset `react-dom/server` emits. */
export function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole: string, name: string) => {
    const named = ENTITIES[name];
    if (named !== undefined) {
      return named;
    }
    if (name.startsWith('#x') || name.startsWith('#X')) {
      return String.fromCodePoint(Number.parseInt(name.slice(2), 16));
    }
    if (name.startsWith('#')) {
      return String.fromCodePoint(Number.parseInt(name.slice(1), 10));
    }
    return whole;
  });
}

/** Every opening tag in the markup, in document order. */
export function scanTags(markup: string): readonly ScannedTag[] {
  const tags: ScannedTag[] = [];

  for (const match of markup.matchAll(TAG)) {
    const name = match[1];
    const rawAttrs = match[2];
    if (name === undefined) {
      continue;
    }

    const attrs: Record<string, string> = {};
    for (const attr of (rawAttrs ?? '').matchAll(ATTR)) {
      const attrName = attr[1];
      if (attrName === undefined) {
        continue;
      }
      const value = attr[2] ?? attr[3] ?? attr[4] ?? '';
      attrs[attrName.toLowerCase()] = decodeEntities(value);
    }

    tags.push({ name: name.toLowerCase(), attrs, at: match.index ?? 0 });
  }

  return tags;
}

/**
 * The first tag matching `predicate`.
 *
 * Throws rather than returning `undefined`: a test that asserts on a tag which is not
 * there should fail with "no <label> in the markup", not with "cannot read property of
 * undefined" three lines later.
 */
export function findTag(
  markup: string,
  predicate: (tag: ScannedTag) => boolean,
  description = 'matching tag',
): ScannedTag {
  const found = scanTags(markup).find(predicate);

  if (found === undefined) {
    throw new Error(`No ${description} in markup:\n${markup}`);
  }

  return found;
}

/** The first tag with the given element name. */
export function findElement(markup: string, name: string): ScannedTag {
  return findTag(markup, (tag) => tag.name === name, `<${name}>`);
}

/** The first tag carrying the given `id`. */
export function findById(markup: string, id: string): ScannedTag {
  return findTag(markup, (tag) => tag.attrs['id'] === id, `element with id="${id}"`);
}

/** True when the markup contains an element with the given `id`. */
export function hasId(markup: string, id: string): boolean {
  return scanTags(markup).some((tag) => tag.attrs['id'] === id);
}

/** The text content of the markup, with tags removed and entities decoded. */
export function textOf(markup: string): string {
  return decodeEntities(markup.replace(/<[^>]*>/g, '')).trim();
}

/**
 * The text content of the element with the given `id`, tags removed.
 *
 * Assumes the element has no same-named descendant, which is true of everything in this
 * package; a general solution would be a parser, and a parser is a dependency.
 */
export function textOfId(markup: string, id: string): string {
  const open = findById(markup, id);
  const after = markup.slice(open.at);
  const closeAt = after.indexOf(`</${open.name}>`);

  return textOf(closeAt === -1 ? after : after.slice(0, closeAt));
}

/** The ids listed in an element's `aria-describedby`, in order. */
export function describedByIds(tag: ScannedTag): readonly string[] {
  const value = tag.attrs['aria-describedby'];
  return value === undefined || value.length === 0 ? [] : value.split(/\s+/);
}
