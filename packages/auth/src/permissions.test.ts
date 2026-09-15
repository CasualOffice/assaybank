/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { ApiError, AttemptIdSchema, OrgIdSchema, UserIdSchema } from '@assaybank/contracts';
import { describe, expect, it } from 'vitest';

import {
  type CandidatePrincipal,
  PERMISSION_DESCRIPTIONS,
  PERMISSIONS,
  type Permission,
  type StaffPrincipal,
  assertCan,
  can,
  isPermission,
} from './permissions.js';

const ORG = OrgIdSchema.parse('33333333-3333-4333-8333-333333333333');
const USER = UserIdSchema.parse('77777777-7777-4777-8777-777777777777');
const ATTEMPT = AttemptIdSchema.parse('11111111-1111-4111-8111-111111111111');

/** A candidate mid-attempt: the principal a redeemed attempt token produces. */
const candidate: CandidatePrincipal = {
  kind: 'candidate',
  attemptId: ATTEMPT,
  orgId: ORG,
};

/** A staff principal holding exactly `permissions`. */
function staff(permissions: readonly Permission[]): StaffPrincipal {
  return { kind: 'staff', userId: USER, orgId: ORG, permissions: new Set(permissions) };
}

describe('PERMISSIONS', () => {
  it('is exactly the seed in docs/hiring_platform_schema.sql §13', () => {
    // The schema seeds the `permissions` table and `user_role_permissions` references
    // it, so a key here that the database does not have is a key nobody can be granted,
    // and a key there that is missing here is a route nobody can protect. Reading the
    // file makes the two lists one list: this test fails the moment they drift.
    const schema = readFileSync(
      fileURLToPath(new URL('../../../docs/hiring_platform_schema.sql', import.meta.url)),
      'utf8',
    );

    const seed = /INSERT INTO permissions \(key, description\) VALUES([\s\S]*?)ON CONFLICT/.exec(
      schema,
    );
    expect(seed).not.toBeNull();

    const block = seed?.[1] ?? '';
    const seeded = [...block.matchAll(/\('([^']+)',\s*'([^']*)'\)/g)].map(
      ([, key, description]) => ({ key, description }),
    );

    expect(seeded.length).toBeGreaterThan(0);
    expect(seeded.map((row) => row.key)).toEqual([...PERMISSIONS]);
    expect(seeded.map((row) => row.description)).toEqual(
      PERMISSIONS.map((key) => PERMISSION_DESCRIPTIONS[key]),
    );
  });

  it('has no duplicates', () => {
    expect(new Set(PERMISSIONS).size).toBe(PERMISSIONS.length);
  });

  it('names an action, never a role', () => {
    // FR-27: a check is per action. A key that named a role ("admin", "recruiter")
    // would invite `can(principal, 'recruiter')`, which is the ambient-role path this
    // design does not have.
    for (const permission of PERMISSIONS) {
      expect(permission).toMatch(/^[a-z]+\.[a-z]+$/);
    }
  });
});

describe('a candidate principal can do nothing on the staff permission set', () => {
  // This is the first assertion of the leak suite's concern, made here at the
  // authorisation boundary: the staff domain and the candidate domain do not share
  // credentials (docs/03 §1), and a candidate's entire authorisation is "this one
  // attempt", which lives in the attempt token and not in a permission set.
  it.each(PERMISSIONS)('refuses %s', (permission) => {
    expect(can(candidate, permission)).toBe(false);
  });

  it('refuses every permission at once, including any added after today', () => {
    const granted = PERMISSIONS.filter((permission) => can(candidate, permission));

    expect(granted).toEqual([]);
  });

  it('cannot be granted one by carrying a permission set anyway', () => {
    // A candidate principal has no `permissions` field. Smuggling one in — which is
    // what a widened type or a careless spread would do — still grants nothing,
    // because the candidate branch returns before any set is consulted.
    const smuggled = {
      ...candidate,
      permissions: new Set<Permission>(PERMISSIONS),
    } as unknown as CandidatePrincipal;

    for (const permission of PERMISSIONS) {
      expect(can(smuggled, permission)).toBe(false);
    }
  });

  it('is refused by assertCan with a forbidden ApiError carrying no detail', () => {
    for (const permission of PERMISSIONS) {
      expect(() => {
        assertCan(candidate, permission);
      }).toThrow(ApiError);
    }

    try {
      assertCan(candidate, 'question.read');
      expect.unreachable('assertCan must throw for a candidate');
    } catch (error) {
      expect(ApiError.isApiError(error)).toBe(true);
      if (!ApiError.isApiError(error)) return;
      expect(error.code).toBe('forbidden');
      expect(error.status).toBe(403);
      expect(error.details).toBeUndefined();
    }
  });
});

describe('can', () => {
  it('grants a staff principal exactly what their roles resolved to', () => {
    const author = staff(['question.read', 'question.write']);

    expect(can(author, 'question.read')).toBe(true);
    expect(can(author, 'question.write')).toBe(true);
    expect(can(author, 'question.publish')).toBe(false);
  });

  it('has no ambient admin path: org.admin implies nothing else', () => {
    // FR-27. An implication table is how a role quietly widens; there is not one.
    const admin = staff(['org.admin']);

    expect(can(admin, 'org.admin')).toBe(true);
    for (const permission of PERMISSIONS.filter((key) => key !== 'org.admin')) {
      expect(can(admin, permission)).toBe(false);
    }
  });

  it('refuses a staff principal with no permissions at all', () => {
    const newcomer = staff([]);

    for (const permission of PERMISSIONS) {
      expect(can(newcomer, permission)).toBe(false);
    }
  });

  it('fails closed on a permission key this build does not define', () => {
    // A typo at a call site locks the route rather than opening it. Note that the
    // principal below has been "granted" the typo, and is still refused.
    const confused = staff(['question.pubish', 'QUESTION.PUBLISH', '']);

    expect(can(confused, 'question.pubish')).toBe(false);
    expect(can(confused, 'QUESTION.PUBLISH')).toBe(false);
    expect(can(confused, '')).toBe(false);
    expect(can(confused, 'question.publish')).toBe(false);
  });

  it('is case sensitive, because the database keys are', () => {
    const publisher = staff(['question.publish']);

    expect(can(publisher, 'question.publish')).toBe(true);
    expect(can(publisher, 'Question.Publish')).toBe(false);
  });
});

describe('assertCan', () => {
  it('returns quietly when the principal may act', () => {
    expect(() => {
      assertCan(staff(['attempt.grade']), 'attempt.grade');
    }).not.toThrow();
  });

  it('throws forbidden when they may not', () => {
    expect(() => {
      assertCan(staff(['attempt.read']), 'attempt.void');
    }).toThrow(ApiError);
  });
});

describe('isPermission', () => {
  it('accepts every defined key and nothing else', () => {
    for (const permission of PERMISSIONS) {
      expect(isPermission(permission)).toBe(true);
    }

    expect(isPermission('question.destroy')).toBe(false);
    expect(isPermission(undefined)).toBe(false);
    expect(isPermission(42)).toBe(false);
  });
});
