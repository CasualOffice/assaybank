/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The cursor codec, and above all its refusals.
 *
 * A cursor arrives from a URL somebody pasted, a bookmark from a previous release, or an
 * attacker. The decoder is therefore total by contract: every malformed input collapses
 * to `undefined` and the caller serves the first page. The cases below are the shapes a
 * cursor is wrong in, and each asserts the same thing — nothing thrown, nothing returned.
 */

import { describe, expect, it } from 'vitest';

import { CursorSchema } from '@assaybank/contracts';

import { decodeKeysetCursor, encodeKeysetCursor } from './cursor.js';

const AT = '2026-10-20 09:00:00.123456+00';
const ID = '7c1a2b3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d';

describe('encodeKeysetCursor', () => {
  it('round-trips a keyset exactly', () => {
    expect(decodeKeysetCursor(encodeKeysetCursor({ at: AT, id: ID }))).toStrictEqual({
      at: AT,
      id: ID,
    });
  });

  it('preserves microsecond precision, which is the whole reason it carries text', () => {
    // A cursor built from a JavaScript Date would round this to `.123`, and the next page
    // would silently skip every row whose instant fell in the discarded microseconds.
    const decoded = decodeKeysetCursor(encodeKeysetCursor({ at: AT, id: ID }));
    expect(decoded?.at).toBe('2026-10-20 09:00:00.123456+00');
    expect(decoded?.at).not.toBe('2026-10-20 09:00:00.123+00');
  });

  it('produces a token the public cursor schema accepts', () => {
    // The contract bounds the character class so the value survives a query string
    // unescaped. base64url is inside it; ordinary base64 would not be.
    expect(CursorSchema.safeParse(encodeKeysetCursor({ at: AT, id: ID })).success).toBe(true);
  });

  it('is deterministic', () => {
    expect(encodeKeysetCursor({ at: AT, id: ID })).toBe(encodeKeysetCursor({ at: AT, id: ID }));
  });

  it('round-trips a whole-second timestamp, which PostgreSQL renders without a fraction', () => {
    const at = '2026-10-20 09:00:00+00';
    expect(decodeKeysetCursor(encodeKeysetCursor({ at, id: ID }))?.at).toBe(at);
  });

  it('round-trips an offset spelled with minutes', () => {
    const at = '2026-10-20 09:00:00.5+05:30';
    expect(decodeKeysetCursor(encodeKeysetCursor({ at, id: ID }))?.at).toBe(at);
  });
});

describe('decodeKeysetCursor refuses, and never throws', () => {
  const rejected: readonly [string, string][] = [
    ['empty', ''],
    ['not base64url at all', '!!!!'],
    ['base64 of nothing', Buffer.from('', 'utf8').toString('base64url')],
    ['no separator', Buffer.from(`${AT}${ID}`, 'utf8').toString('base64url')],
    ['separator first', Buffer.from(`|${ID}`, 'utf8').toString('base64url')],
    ['timestamp is not one', Buffer.from(`tomorrow|${ID}`, 'utf8').toString('base64url')],
    ['id is not a uuid', Buffer.from(`${AT}|not-a-uuid`, 'utf8').toString('base64url')],
    ['id is empty', Buffer.from(`${AT}|`, 'utf8').toString('base64url')],
    [
      'a SQL fragment where the timestamp goes',
      Buffer.from(`2026-10-20'; DROP TABLE questions; --|${ID}`, 'utf8').toString('base64url'),
    ],
    [
      'a payload long enough to be an attack on the parser',
      Buffer.from(`${AT}|${'a'.repeat(4096)}`, 'utf8').toString('base64url'),
    ],
  ];

  it.each(rejected)('refuses a cursor that is %s', (_name, cursor) => {
    expect(decodeKeysetCursor(cursor)).toBeUndefined();
  });

  it('refuses rather than throwing, for every case above', () => {
    // The property the caller depends on: a bad cursor is "no cursor", never a 500.
    for (const [, cursor] of rejected) {
      expect(() => decodeKeysetCursor(cursor)).not.toThrow();
    }
  });

  it('refuses a cursor whose id has the right shape but the wrong alphabet', () => {
    const cursor = Buffer.from(`${AT}|zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz`, 'utf8').toString(
      'base64url',
    );
    expect(decodeKeysetCursor(cursor)).toBeUndefined();
  });
});
