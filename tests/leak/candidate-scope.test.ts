/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The leak suite's first real assertion about *authorisation* (P0 step 13).
 *
 * `placeholder.test.ts` guards the other half of FR-12 — that a candidate-scoped
 * response body cannot carry an answer key, a reference solution or a hidden test-case
 * expectation. This file guards the half that comes first: a candidate must never be
 * authorised for a staff action at all. Filtering a response is the second line of
 * defence; the first is that the request was refused.
 *
 * Why it lives in the leak suite rather than beside `packages/auth`'s own unit tests,
 * where a near-identical case also runs: the leak suite is a standing, separately named
 * CI job (docs/17 §8), so this failure is unambiguous in the pull request checks and
 * cannot be read as an incidental unit-test break. The duplication is deliberate — this
 * assertion is supposed to be hard to delete by accident.
 *
 * **What makes this future-proof.** The suite does not enumerate a list of permissions
 * it happens to know about. It iterates `PERMISSIONS`, which is the seed in
 * docs/hiring_platform_schema.sql §13. A permission added in P2 is therefore covered by
 * this test on the day it is added, without anybody remembering to come back here —
 * which is the only kind of coverage worth having for "the one someone forgets".
 *
 * The import is a relative path into the workspace source rather than `@assaybank/auth`,
 * because the leak suite is a root-level Vitest project and is not itself a workspace
 * with dependencies.
 */

import { describe, expect, it } from 'vitest';

import {
  type CandidatePrincipal,
  PERMISSIONS,
  type Permission,
  type StaffPrincipal,
  assertCan,
  can,
} from '../../packages/auth/src/index.js';
import {
  ApiError,
  AttemptIdSchema,
  OrgIdSchema,
  UserIdSchema,
} from '../../packages/contracts/src/index.js';

const ORG = OrgIdSchema.parse('33333333-3333-4333-8333-333333333333');
const ATTEMPT = AttemptIdSchema.parse('11111111-1111-4111-8111-111111111111');
const STAFF_USER = UserIdSchema.parse('77777777-7777-4777-8777-777777777777');

/** The principal a redeemed attempt token produces: one attempt, one org, no roles. */
const candidate: CandidatePrincipal = {
  kind: 'candidate',
  attemptId: ATTEMPT,
  orgId: ORG,
};

describe('a candidate principal is authorised for nothing in the staff permission set', () => {
  it('has a permission set to deny in the first place', () => {
    // A guard against the vacuous pass: if PERMISSIONS were ever empty, every assertion
    // below would succeed while proving nothing.
    expect(PERMISSIONS.length).toBeGreaterThan(0);
  });

  it.each(PERMISSIONS)('is denied %s', (permission) => {
    expect(can(candidate, permission)).toBe(false);
  });

  it.each(PERMISSIONS)('is refused %s by assertCan, with forbidden', (permission) => {
    let thrown: unknown;
    try {
      assertCan(candidate, permission);
    } catch (error) {
      thrown = error;
    }

    expect(ApiError.isApiError(thrown)).toBe(true);
    if (!ApiError.isApiError(thrown)) return;

    expect(thrown.code).toBe('forbidden');
    expect(thrown.status).toBe(403);
    // No details: a 403 that explained which permission was missing would describe the
    // staff surface to somebody who is not supposed to know it exists.
    expect(thrown.details).toBeUndefined();
  });

  it('is denied the entire set at once', () => {
    expect(PERMISSIONS.filter((permission) => can(candidate, permission))).toEqual([]);
  });

  it('is denied permissions that do not exist yet either', () => {
    // The permissions P2 and P6 will add. `can` fails closed on an unknown key, so a
    // candidate is denied a permission before it is even defined.
    const notYetDefined: readonly Permission[] = [
      'question.delete',
      'integrity.review',
      'credential.issue',
      'org.billing',
      '*',
      '',
    ];

    for (const permission of notYetDefined) {
      expect(can(candidate, permission)).toBe(false);
    }
  });

  it('gains nothing from a permission set grafted onto it', () => {
    // What a widened type, a careless object spread or a confused deserialiser would
    // produce. The candidate branch of `can` returns before any set is consulted, so it
    // still grants nothing.
    const grafted = {
      ...candidate,
      permissions: new Set<Permission>(PERMISSIONS),
    } as unknown as CandidatePrincipal;

    for (const permission of PERMISSIONS) {
      expect(can(grafted, permission)).toBe(false);
    }
  });

  it('is denied even where a staff principal in the same org is allowed', () => {
    // Same tenant, same permission, different kind of principal. The denial is about
    // who the candidate is, not about which org the row belongs to — that is RLS's job
    // (ADR-010), and this is the layer above it.
    const colleague: StaffPrincipal = {
      kind: 'staff',
      userId: STAFF_USER,
      orgId: ORG,
      permissions: new Set<Permission>(PERMISSIONS),
    };

    for (const permission of PERMISSIONS) {
      expect(can(colleague, permission)).toBe(true);
      expect(can(candidate, permission)).toBe(false);
    }
  });
});
