/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * This package's closed permission union against the rows the seed actually writes.
 *
 * `PERMISSIONS` is what code branches on; `SEED_PERMISSIONS` in `@assaybank/db` is what reaches
 * the `permissions` table, and a grant can only name a row that exists. If the two drift, the
 * symptom is a permission that type-checks everywhere and is unreachable in a running system —
 * `can()` fails closed, so the route just answers 403 and nobody can tell why from the code.
 *
 * The assertion lives here because the dependency runs this way: `packages/auth` imports
 * `packages/db`, never the reverse.
 */

import { SEED_PERMISSIONS } from '@assaybank/db';
import { describe, expect, it } from 'vitest';

import { PERMISSIONS, PERMISSION_DESCRIPTIONS } from './permissions.js';

describe('PERMISSIONS and the database seed', () => {
  it('name exactly the same permissions, in the same order', () => {
    expect([...PERMISSIONS]).toEqual(SEED_PERMISSIONS.map((p) => p.key));
  });

  it('describe each one identically, so the role editor and the database agree', () => {
    for (const permission of SEED_PERMISSIONS) {
      expect(PERMISSION_DESCRIPTIONS[permission.key as keyof typeof PERMISSION_DESCRIPTIONS]).toBe(
        permission.description,
      );
    }
  });
});
