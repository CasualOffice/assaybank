/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The small amount of XML the QTI codec needs, written so that text survives exactly.
 *
 * Three things make XML lossy for question content, and each is handled here rather than hoped
 * away:
 *
 * 1. **Line endings.** A conforming parser normalises `\r\n` and `\r` to `\n` (XML 1.0 §2.11).
 *    A test case whose expected output ends in `\r\n` would silently change.
 * 2. **Characters XML 1.0 cannot carry at all** — most C0 controls, U+FFFE, U+FFFF, and unpaired
 *    surrogates. Test-case stdin is exactly where these turn up.
 * 3. **Whitespace in attributes** is normalised. So free text never goes in an attribute; only
 *    enumerations, numbers and booleans do.
 *
 * A string containing any of the first two is written as base64 of its UTF-16 code units, marked
 * `encoding="utf16le-base64"`, which round-trips every JavaScript string including an unpaired
 * surrogate. Everything else is written as escaped text and stays readable.
 *
 * Parsing refuses a `DOCTYPE` outright. Nothing in QTI or IMS CP needs one, and a document that
 * declares entities is how an XML parser is made to expand a kilobyte into a gigabyte.
 */

import { XMLParser } from 'fast-xml-parser';

export const ENCODED = 'utf16le-base64';

/** True when the string cannot be carried as XML text without loss. */
export function needsEncoding(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const c = value.charCodeAt(i);
    if (c < 0x20 && c !== 0x09 && c !== 0x0a) return true; // includes \r
    if (c === 0xfffe || c === 0xffff) return true;
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i += 1; // a valid pair
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true;
    }
  }
  return false;
}

export function escapeXml(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;');
}

/** An attribute list from pairs, skipping `undefined`. Values must not be free text. */
export function attrs(
  pairs: Readonly<Record<string, string | number | boolean | undefined>>,
): string {
  return Object.entries(pairs)
    .filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined)
    .map(([name, value]) => ` ${name}="${escapeXml(String(value))}"`)
    .join('');
}

/** An element whose content is `value`, exactly. */
export function textElement(
  tag: string,
  value: string,
  attributes: Readonly<Record<string, string | number | boolean | undefined>> = {},
): string {
  if (needsEncoding(value)) {
    const encoded = Buffer.from(value, 'utf16le').toString('base64');
    return `<${tag}${attrs({ ...attributes, encoding: ENCODED })}>${encoded}</${tag}>`;
  }
  return `<${tag}${attrs(attributes)}>${escapeXml(value)}</${tag}>`;
}

// ---------------------------------------------------------------------------- reading

/** A parsed element: attributes as `@_name`, text as `#text`, children by local name. */
export type XmlElement = Readonly<Record<string, unknown>>;

export class MalformedXmlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MalformedXmlError';
  }
}

/**
 * Parses with namespace prefixes removed, values left as strings, and whitespace kept.
 *
 * `repeated` names the elements that may occur more than once, so a single occurrence still
 * arrives as an array and callers never branch on shape.
 */
export function parseXml(text: string, repeated: ReadonlySet<string>): XmlElement {
  if (/<!DOCTYPE/iu.test(text)) {
    throw new MalformedXmlError('A DOCTYPE is not accepted.');
  }
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    removeNSPrefix: true,
    trimValues: false,
    parseTagValue: false,
    parseAttributeValue: false,
    ignoreDeclaration: true,
    ignorePiTags: true,
    textNodeName: '#text',
    isArray: (name) => repeated.has(name),
  });
  let parsed: unknown;
  try {
    parsed = parser.parse(text, true);
  } catch (error) {
    throw new MalformedXmlError(error instanceof Error ? error.message : 'The XML is malformed.');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new MalformedXmlError('The XML has no root element.');
  }
  return parsed as XmlElement;
}

const isElement = (value: unknown): value is XmlElement =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The single child element `name`, or undefined. A text-only child becomes `{#text}`. */
export function child(node: XmlElement | undefined, name: string): XmlElement | undefined {
  const value = node?.[name];
  if (value === undefined) return undefined;
  if (Array.isArray(value)) {
    const first: unknown = value[0];
    return toElement(first);
  }
  return toElement(value);
}

/** Every child element `name`, in document order. */
export function children(node: XmlElement | undefined, name: string): XmlElement[] {
  const value = node?.[name];
  if (value === undefined) return [];
  const list: unknown[] = Array.isArray(value) ? value : [value];
  return list.flatMap((entry) => {
    const element = toElement(entry);
    return element === undefined ? [] : [element];
  });
}

function toElement(value: unknown): XmlElement | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return { '#text': value };
  return isElement(value) ? value : undefined;
}

export function attr(node: XmlElement | undefined, name: string): string | undefined {
  const value = node?.[`@_${name}`];
  return typeof value === 'string' ? value : undefined;
}

/** The element's text, decoded if it was written encoded. An empty element is `''`. */
export function text(node: XmlElement): string {
  const raw = node['#text'];
  const value = typeof raw === 'string' ? raw : '';
  if (attr(node, 'encoding') === ENCODED) {
    return Buffer.from(value.trim(), 'base64').toString('utf16le');
  }
  return value;
}

/** The text of child `name`, or null when the child is absent. */
export function optionalText(node: XmlElement | undefined, name: string): string | null {
  const element = child(node, name);
  return element === undefined ? null : text(element);
}
