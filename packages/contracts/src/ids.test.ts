/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';

import {
  AttemptIdSchema,
  AttemptQuestionIdSchema,
  ID_SCHEMAS,
  OrgIdSchema,
  type AttemptId,
  type AttemptQuestionId,
} from './index.js';

const V4 = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

describe('branded identifiers', () => {
  it('parses a canonical UUID and returns the same string', () => {
    expect(OrgIdSchema.parse(V4)).toBe(V4);
  });

  it.each([
    ['not a uuid at all', 'org_12345'],
    ['too short', '3f2504e0-4f89-41d3-9a0c-0305e82c330'],
    ['too long', '3f2504e0-4f89-41d3-9a0c-0305e82c33011'],
    ['no hyphens', '3f2504e04f8941d39a0c0305e82c3301'],
    ['non-hex characters', '3f2504e0-4f89-41d3-9a0c-0305e82c33zz'],
    ['an invalid variant nibble', '3f2504e0-4f89-41d3-2a0c-0305e82c3301'],
    ['an invalid version nibble', '3f2504e0-4f89-01d3-9a0c-0305e82c3301'],
    ['surrounding whitespace', ` ${V4} `],
    ['the empty string', ''],
  ])('rejects %s', (_name, value) => {
    expect(OrgIdSchema.safeParse(value).success).toBe(false);
  });

  it.each([
    ['a number', 42],
    ['null', null],
    ['undefined', undefined],
    ['an object', { id: V4 }],
  ])('rejects %s, which is not a string at all', (_name, value) => {
    expect(OrgIdSchema.safeParse(value).success).toBe(false);
  });

  it('accepts the nil and max UUIDs, which are valid RFC 9562 values', () => {
    expect(OrgIdSchema.safeParse('00000000-0000-0000-0000-000000000000').success).toBe(true);
    expect(OrgIdSchema.safeParse('ffffffff-ffff-ffff-ffff-ffffffffffff').success).toBe(true);
  });

  it('reports the failing path so a caller can build details.field', () => {
    const result = OrgIdSchema.safeParse('nope');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toHaveLength(1);
      expect(result.error.issues[0]?.code).toBe('invalid_format');
    }
  });

  it('brands each identifier distinctly, so one cannot stand in for another', () => {
    const attemptId: AttemptId = AttemptIdSchema.parse(V4);
    const attemptQuestionId: AttemptQuestionId = AttemptQuestionIdSchema.parse(V4);

    // @ts-expect-error an AttemptId is not an AttemptQuestionId (docs/17 §1).
    const wrong: AttemptQuestionId = attemptId;
    // @ts-expect-error nor is a bare string either of them.
    const alsoWrong: AttemptId = V4;

    expect(wrong).toBe(attemptQuestionId);
    expect(alsoWrong).toBe(attemptId);
  });

  it('publishes one schema per identifier, each a distinct object', () => {
    const names = Object.keys(ID_SCHEMAS);
    expect(names).toHaveLength(16);
    expect(new Set(Object.values(ID_SCHEMAS)).size).toBe(names.length);
  });

  it('holds every identifier to the same UUID rule', () => {
    for (const [name, schema] of Object.entries(ID_SCHEMAS)) {
      expect(schema.safeParse(V4).success, name).toBe(true);
      expect(schema.safeParse('definitely-not-a-uuid').success, name).toBe(false);
    }
  });
});
