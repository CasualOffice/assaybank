/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  AttemptIdSchema,
  CursorSchema,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  PaginationQuerySchema,
  Rfc3339Schema,
  UuidSchema,
  paginated,
} from './index.js';

describe('UuidSchema', () => {
  it('accepts a canonical UUID in either case', () => {
    expect(UuidSchema.parse('3f2504e0-4f89-41d3-9a0c-0305e82c3301')).toBe(
      '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
    );
    expect(UuidSchema.safeParse('3F2504E0-4F89-41D3-9A0C-0305E82C3301').success).toBe(true);
  });

  it('rejects a braced or urn-prefixed form', () => {
    expect(UuidSchema.safeParse('{3f2504e0-4f89-41d3-9a0c-0305e82c3301}').success).toBe(false);
    expect(UuidSchema.safeParse('urn:uuid:3f2504e0-4f89-41d3-9a0c-0305e82c3301').success).toBe(
      false,
    );
  });
});

describe('Rfc3339Schema', () => {
  it('accepts UTC timestamps, with and without fractional seconds', () => {
    expect(Rfc3339Schema.parse('2026-09-14T10:30:00Z')).toBe('2026-09-14T10:30:00Z');
    expect(Rfc3339Schema.safeParse('2026-09-14T10:30:00.123Z').success).toBe(true);
  });

  it.each([
    ['a numeric offset, which is not UTC (ADR-006)', '2026-09-14T12:30:00+02:00'],
    ['no timezone at all', '2026-09-14T10:30:00'],
    ['a date with no time', '2026-09-14'],
    ['a space separator instead of T', '2026-09-14 10:30:00Z'],
    ['epoch milliseconds', '1789453800000'],
  ])('rejects %s', (_name, value) => {
    expect(Rfc3339Schema.safeParse(value).success).toBe(false);
  });
});

describe('CursorSchema', () => {
  it('accepts an opaque URL-safe token', () => {
    expect(CursorSchema.parse('eyJpZCI6IjNmMjUwNGUwIn0')).toBe('eyJpZCI6IjNmMjUwNGUwIn0');
  });

  it.each([
    ['the empty string', ''],
    ['a token with a space', 'abc def'],
    ['a token with a slash, which would need escaping in a query', 'abc/def'],
    ['a token longer than the 1024-character ceiling', 'a'.repeat(1025)],
  ])('rejects %s', (_name, value) => {
    expect(CursorSchema.safeParse(value).success).toBe(false);
  });

  it('accepts a token exactly at the ceiling', () => {
    expect(CursorSchema.safeParse('a'.repeat(1024)).success).toBe(true);
  });
});

describe('PaginationQuerySchema', () => {
  it('defaults the page size when the client does not ask for one', () => {
    expect(PaginationQuerySchema.parse({})).toEqual({ limit: DEFAULT_PAGE_SIZE });
  });

  it('coerces limit from the string a query parameter actually is', () => {
    expect(PaginationQuerySchema.parse({ limit: '25' })).toEqual({ limit: 25 });
  });

  it('carries the cursor through unchanged', () => {
    expect(PaginationQuerySchema.parse({ limit: '10', cursor: 'abc-123' })).toEqual({
      limit: 10,
      cursor: 'abc-123',
    });
  });

  it.each([
    ['zero', '0'],
    ['a negative number', '-1'],
    ['a fraction', '2.5'],
    ['a value above the ceiling', String(MAX_PAGE_SIZE + 1)],
    ['prose', 'all'],
  ])('rejects a limit of %s, so no client can ask for an unbounded set', (_name, limit) => {
    expect(PaginationQuerySchema.safeParse({ limit }).success).toBe(false);
  });

  it('rejects a malformed cursor rather than ignoring it', () => {
    expect(PaginationQuerySchema.safeParse({ cursor: 'has a space' }).success).toBe(false);
  });
});

describe('paginated()', () => {
  const schema = paginated(AttemptIdSchema);

  it('wraps an item schema in { data, next_cursor }', () => {
    const page = schema.parse({
      data: ['3f2504e0-4f89-41d3-9a0c-0305e82c3301'],
      next_cursor: 'eyJhZnRlciI6MX0',
    });
    expect(page).toEqual({
      data: ['3f2504e0-4f89-41d3-9a0c-0305e82c3301'],
      next_cursor: 'eyJhZnRlciI6MX0',
    });
  });

  it('accepts null for the last page', () => {
    expect(schema.parse({ data: [], next_cursor: null })).toEqual({ data: [], next_cursor: null });
  });

  it('requires next_cursor to be present, so a client loop is a value check', () => {
    expect(schema.safeParse({ data: [] }).success).toBe(false);
  });

  it('validates every item against the item schema', () => {
    expect(schema.safeParse({ data: ['not-a-uuid'], next_cursor: null }).success).toBe(false);
  });

  it('preserves the item type, branded identifiers included', () => {
    const page = schema.parse({
      data: ['3f2504e0-4f89-41d3-9a0c-0305e82c3301'],
      next_cursor: null,
    });
    const first = page.data[0];
    expect(first).toBe('3f2504e0-4f89-41d3-9a0c-0305e82c3301');
    // The element type is AttemptId, not string: this assignment is what proves it.
    const asAttemptId: typeof first = first;
    expect(asAttemptId).toBe(first);
  });

  it('works with an object item schema too', () => {
    const rows = paginated(z.object({ id: AttemptIdSchema, name: z.string() }));
    const page = rows.parse({
      data: [{ id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301', name: 'Backend screen' }],
      next_cursor: null,
    });
    expect(page.data[0]?.name).toBe('Backend screen');
  });
});
