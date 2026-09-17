/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The seed's permission catalogue against the schema document that defines it.
 *
 * `docs/hiring_platform_schema.sql` §13 is where the catalogue is specified, and the same list now
 * exists twice in code: here, as the rows that reach the database, and in `packages/auth` as a
 * closed union for code that can be specific. `packages/db` cannot import `packages/auth` — the
 * dependency runs the other way — so the document is the anchor both sides are checked against,
 * and `packages/auth` holds the other half of this assertion.
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { SEED_PERMISSIONS, SEED_ROLES } from './seed.js';

const schemaSql = readFileSync(
  new URL('../../../docs/hiring_platform_schema.sql', import.meta.url),
  'utf8',
);

/** The `(key, description)` pairs of the `INSERT INTO permissions` statement in §13. */
function permissionsFromSchema(): { key: string; description: string }[] {
  const start = schemaSql.indexOf('INSERT INTO permissions (key, description) VALUES');
  expect(start, 'the schema document must still declare the permission seed').toBeGreaterThan(-1);
  const statement = schemaSql.slice(start, schemaSql.indexOf(';', start));
  return [...statement.matchAll(/\('([^']+)',\s*'([^']+)'\)/g)].map((m) => ({
    key: m[1] ?? '',
    description: m[2] ?? '',
  }));
}

describe('the permission catalogue', () => {
  it('matches docs/hiring_platform_schema.sql §13 exactly, in order', () => {
    expect(SEED_PERMISSIONS).toEqual(permissionsFromSchema());
  });

  it('is not vacuous: the document really does list eleven permissions', () => {
    expect(permissionsFromSchema()).toHaveLength(11);
  });

  it('declares each key once', () => {
    const keys = SEED_PERMISSIONS.map((p) => p.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('the system roles', () => {
  it('grants only permissions the catalogue defines', () => {
    const known = new Set(SEED_PERMISSIONS.map((p) => p.key));
    for (const role of SEED_ROLES) {
      for (const permission of role.permissions) {
        expect(known.has(permission), `${role.key} → ${permission}`).toBe(true);
      }
    }
  });

  it('gives the administrator everything, so a new organisation can configure itself', () => {
    const admin = SEED_ROLES.find((r) => r.key === 'admin');
    expect([...(admin?.permissions ?? [])].sort()).toEqual(
      SEED_PERMISSIONS.map((p) => p.key).sort(),
    );
  });

  it('keeps voiding an attempt to the administrator alone (FR-25)', () => {
    const holders = SEED_ROLES.filter((r) => r.permissions.includes('attempt.void')).map(
      (r) => r.key,
    );
    expect(holders).toEqual(['admin']);
  });

  it('never grants a bank write to a role that only runs or reads assessments', () => {
    for (const key of ['recruiter', 'interviewer', 'hiring_manager']) {
      const role = SEED_ROLES.find((r) => r.key === key);
      expect(role?.permissions ?? [], key).not.toContain('question.write');
      expect(role?.permissions ?? [], key).not.toContain('question.publish');
    }
  });

  it('declares each role key once', () => {
    const keys = SEED_ROLES.map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
