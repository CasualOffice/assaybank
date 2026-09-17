/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The seed against a real PostgreSQL (H-018), and the constraint that makes it idempotent.
 *
 * Three things are worth proving and one of them is not obvious. The obvious two: the seed writes
 * what the product needs, and a second run writes nothing. The third is why the second is true at
 * all — `UNIQUE (org_id, key)` does **not** constrain a row whose `org_id` is NULL, because
 * PostgreSQL treats NULLs as distinct for uniqueness. Without the partial indexes migration 0011
 * adds, `make seed` twice would leave two of every global skill and every system role, and every
 * later key lookup would resolve to whichever row it happened to read.
 *
 * So the suite asserts the constraint directly, both ways: a duplicate per-tenant row is refused
 * by the original constraint, and a duplicate global row is refused by the new index.
 */

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import postgres from 'postgres';
import { getContainerRuntimeClient } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migrate } from '../src/migrate.js';
import { seed, SEED_PERMISSIONS, SEED_ROLES, SEED_SKILLS } from '../src/seed.js';

const IMAGE = 'postgres:16-alpine';
const OWNER = 'hiring';
const OWNER_PASSWORD = 'hiring';
const DATABASE = 'hiring';

const runtime = await (async () => {
  try {
    await getContainerRuntimeClient();
    return { available: true };
  } catch {
    return { available: false };
  }
})();

function required<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new Error(`fixture did not produce ${name}`);
  return value;
}

describe.skipIf(!runtime.available)('the seed (H-018)', () => {
  let container: StartedPostgreSqlContainer;
  let owner: postgres.Sql;
  let url = '';

  beforeAll(async () => {
    container = await new PostgreSqlContainer(IMAGE)
      .withDatabase(DATABASE)
      .withUsername(OWNER)
      .withPassword(OWNER_PASSWORD)
      .start();
    url = `postgres://${OWNER}:${OWNER_PASSWORD}@${container.getHost()}:${String(container.getPort())}/${DATABASE}`;
    await migrate({ url });
    owner = postgres(url, { max: 2 });
  }, 240_000);

  afterAll(async () => {
    await owner?.end();
    await container?.stop();
  });

  const count = async (table: string, where = 'true'): Promise<number> => {
    const rows = await owner.unsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM ${table} WHERE ${where}`,
    );
    return required(rows[0], 'count').n;
  };

  it('finds the permission catalogue already written by migration 0001, and agrees with it', async () => {
    // 0001 seeds the catalogue, so a freshly migrated database already has it and the seed writes
    // none. What matters is that the two lists are the same list: this asserts the rows the
    // migration wrote equal the rows the seed would have written, which is the drift that would
    // otherwise surface as a permission that exists in code and not in the database.
    const rows = await owner<{ key: string; description: string }[]>`
      SELECT key, description FROM permissions ORDER BY key`;
    expect(rows).toEqual([...SEED_PERMISSIONS].sort((a, b) => a.key.localeCompare(b.key)));
  });

  it('writes the roles and the taxonomy on a first run', async () => {
    const result = await seed({ url });

    const expectedSkills = SEED_SKILLS.reduce((n, s) => n + 1 + (s.children?.length ?? 0), 0);
    const expectedGrants = SEED_ROLES.reduce((n, r) => n + r.permissions.length, 0);
    expect(result).toEqual({
      // Zero: migration 0001 wrote the catalogue. The seed re-asserts it so that a permission
      // added after an installation exists still reaches it — a migration that has already run
      // never will.
      permissions: 0,
      roles: SEED_ROLES.length,
      rolePermissions: expectedGrants,
      skills: expectedSkills,
    });

    expect(await count('permissions')).toBe(SEED_PERMISSIONS.length);
    expect(await count('user_roles', 'org_id IS NULL AND is_system')).toBe(SEED_ROLES.length);
    expect(await count('skills', 'org_id IS NULL')).toBe(expectedSkills);
  });

  it('writes a permission the catalogue gains later, without a migration', async () => {
    // The reason the block stays. Deleting a row simulates an installation that predates it.
    await owner`DELETE FROM permissions WHERE key = 'report.export'`;
    const result = await seed({ url });
    expect(result.permissions).toBe(1);
    expect(await count('permissions')).toBe(SEED_PERMISSIONS.length);
  });

  it('writes nothing at all on a second run', async () => {
    const before = {
      permissions: await count('permissions'),
      roles: await count('user_roles'),
      grants: await count('user_role_permissions'),
      skills: await count('skills'),
    };

    expect(await seed({ url })).toEqual({
      permissions: 0,
      roles: 0,
      rolePermissions: 0,
      skills: 0,
    });

    expect({
      permissions: await count('permissions'),
      roles: await count('user_roles'),
      grants: await count('user_role_permissions'),
      skills: await count('skills'),
    }).toEqual(before);
  });

  it('grants every role exactly the permissions it declares, and no others', async () => {
    const rows = await owner<{ role: string; permission: string }[]>`
      SELECT r.key AS role, p.permission_key AS permission
        FROM user_roles r JOIN user_role_permissions p ON p.user_role_id = r.id
       WHERE r.org_id IS NULL`;

    const granted = new Map<string, string[]>();
    for (const row of rows)
      granted.set(row.role, [...(granted.get(row.role) ?? []), row.permission]);

    for (const role of SEED_ROLES) {
      expect([...(granted.get(role.key) ?? [])].sort(), role.key).toEqual(
        [...role.permissions].sort(),
      );
    }
  });

  it('grants only permissions that exist — the foreign key is the proof', () => {
    const declared = new Set(SEED_PERMISSIONS.map((p) => p.key));
    for (const role of SEED_ROLES) {
      for (const permission of role.permissions) {
        expect(declared.has(permission), `${role.key} → ${permission}`).toBe(true);
      }
    }
  });

  it('keeps the taxonomy two levels deep (ADR-009), with every child under its parent', async () => {
    const rows = await owner<{ key: string; parent: string | null }[]>`
      SELECT c.key, p.key AS parent
        FROM skills c LEFT JOIN skills p ON p.id = c.parent_id
       WHERE c.org_id IS NULL`;

    const parentOf = new Map(rows.map((r) => [r.key, r.parent]));
    for (const [key, parent] of parentOf) {
      if (parent === null) continue;
      // A child's parent is a root: a third level would mean the parent has a parent.
      expect(parentOf.get(parent) ?? null, `${key} → ${parent}`).toBeNull();
    }
    for (const parent of SEED_SKILLS) {
      for (const child of parent.children ?? []) {
        expect(parentOf.get(child.key), child.key).toBe(parent.key);
      }
    }
  });

  describe('a global key means one row (migration 0011)', () => {
    it('refuses a second global skill with the same key', async () => {
      await expect(
        owner`INSERT INTO skills (org_id, key, name) VALUES (NULL, 'python', 'Python again')`,
      ).rejects.toThrow(/skills_global_key_key/u);
    });

    it('refuses a second global system role with the same key', async () => {
      await expect(
        owner`INSERT INTO user_roles (org_id, key, name) VALUES (NULL, 'admin', 'Admin again')`,
      ).rejects.toThrow(/user_roles_global_key_key/u);
    });

    it('still lets each organisation hold its own skill with a global key', async () => {
      const org = required(
        (
          await owner<{ id: string }[]>`
          INSERT INTO organizations (name, slug) VALUES ('Seed Co', 'seed-co') RETURNING id`
        )[0],
        'org',
      );
      // Two tenants and the global row may all key 'python'; that is the point of the taxonomy.
      await owner`INSERT INTO skills (org_id, key, name) VALUES (${org.id}, 'python', 'Python (ours)')`;
      expect(await count('skills', `key = 'python'`)).toBe(2);

      await expect(
        owner`INSERT INTO skills (org_id, key, name) VALUES (${org.id}, 'python', 'Python (twice)')`,
      ).rejects.toThrow(/skills_org_id_key_key/u);
    });
  });
});
