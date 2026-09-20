/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `safeUrl`'s contract, tested directly rather than through the parser.
 *
 * The distinction matters for the entity cases below. In the React renderer a destination is
 * set with `setAttribute`, and a browser does not decode character references in an attribute
 * value it was handed rather than parsed — so `&#106;avascript:alert(1)` is an inert relative
 * path there, and the corpus suite cannot tell whether the decoding in `safeUrl` does
 * anything. It is not the only consumer. The QTI exporter writes destinations into XML, where
 * the same string *is* parsed and *is* decoded, and this is the gate standing in front of
 * that. So the decoding is tested against the function's own contract, where it is
 * load-bearing, instead of through a pipeline that happens to make it redundant.
 */

import { describe, expect, it } from 'vitest';

import { allowedSchemes, safeUrl } from './url.js';

describe('allowed', () => {
  it.each([
    'https://example.com/a?b=1&c=2#d',
    'http://example.com',
    'mailto:hiring@example.com',
    'HTTPS://EXAMPLE.COM',
    '/assets/schema.png',
    'diagram.svg',
    '#section-2',
    '//example.com/protocol-relative',
    'https://example.com/a(b)c',
  ])('%s', (url) => {
    expect(safeUrl(url)).not.toBeNull();
  });
});

describe('refused', () => {
  it.each([
    ['javascript:alert(1)', 'the scheme runs code'],
    ['JaVaScRiPt:alert(1)', 'scheme comparison is case-insensitive'],
    ['\tjavascript:alert(1)', 'leading whitespace is trimmed by the browser too'],
    ['java\tscript:alert(1)', 'a tab inside a scheme is stripped by the browser'],
    ['java\nscript:alert(1)', 'so is a newline'],
    ['java\rscript:alert(1)', 'so is a carriage return'],
    ['\u0000javascript:alert(1)', 'a leading NUL is trimmed'],
    ['  javascript:alert(1)  ', 'so is surrounding space'],
    ['&#106;avascript:alert(1)', 'a decimal character reference'],
    ['&#x6A;avascript:alert(1)', 'a hexadecimal one'],
    ['jav&#x0A;ascript:alert(1)', 'a reference in the middle of the scheme'],
    ['java&Tab;script:alert(1)', 'a named reference in the middle of the scheme'],
    ['data:text/html;base64,PHNjcmlwdD4=', 'a data URL is a document we did not write'],
    ['data:image/svg+xml,<svg onload=alert(1)>', 'including an SVG one, which scripts'],
    ['vbscript:msgbox(1)', 'a scheme that is not on the list, known or not'],
    ['file:///etc/passwd', 'the same, for a local file'],
    ['about:blank', 'and for anything else with a colon'],
    ['\\\\evil.example/share', 'a backslash host normalises to a protocol-relative URL'],
    ['', 'an empty destination is not a link'],
    ['   ', 'nor is whitespace'],
  ])('%s — %s', (url) => {
    expect(safeUrl(url)).toBeNull();
  });
});

describe('the list itself', () => {
  it('is three schemes, and adding one is a deliberate act', () => {
    // Asserted so that widening the allow list is a change to a test as well as to a set,
    // which is the point at which somebody asks why.
    expect(allowedSchemes).toEqual(['http:', 'https:', 'mailto:']);
  });
});
