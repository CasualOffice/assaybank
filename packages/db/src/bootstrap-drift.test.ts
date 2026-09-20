/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The local stack's bootstrap and the migrations must not drift apart (`H-192`, docs/14 T-043).
 *
 * ## The two halves, and why they can disagree
 *
 * `infra/postgres/init/` builds a developer's database at container start, from the
 * documented DDL. `packages/db/migrations/` is the authoritative schema and runs over the
 * top of it — `make up && make migrate` is the documented path, and it is the only one that
 * produces what CI tests against. The overlap is deliberate and both sides are meant to be
 * guarded so that whichever runs first wins.
 *
 * Nothing in CI runs container init. The integration suites use testcontainers and apply
 * migrations to an empty database, so the *second* half is exercised constantly and the
 * first half is exercised only on a developer's laptop — which is precisely where a failure
 * is discovered by the person least able to explain it, and where it was discovered:
 * `make up && make migrate` had been broken on a clean machine, in three separate ways, and
 * every test was green the whole time.
 *
 * These are static checks. They read the files, they need no database, and they run in the
 * unit suite — which is the point, because the thing they guard is the path CI does not
 * take.
 *
 * ## What each check would have caught
 *
 * **The missing policy.** Migration 0010 added `bank_jobs` with row-level security, and
 * `03-rls.sql` was not updated. Container init then built a database where one organisation
 * could read another's import and export jobs, and migration 0002's completeness check —
 * which was right — refused to apply over it.
 *
 * **The unguarded statement.** Migration 0012's `ADD COLUMN assertion_code` had no `IF NOT
 * EXISTS`, and 0013's `DROP CONSTRAINT` no `IF EXISTS`, so both failed against a database
 * the bootstrap had already given that shape. `migrate.ts` states the contract — *"every
 * statement in `migrations/` is additionally written `IF NOT EXISTS` or guarded so the files
 * can be replayed by hand"* — and nothing enforced it.
 *
 * ## What they do not catch
 *
 * The partitions of `session_events` and `proctor_events`. They are created by
 * `04-partitions.sql` and do not appear in the Drizzle schema, so no list here knows their
 * names. A partition does not inherit its parent's row-level security, which made each one a
 * way round the parent's policy for anyone who could write `session_events_y2026m09`; the
 * fix is in `ensure_event_partition()`, and the thing that catches a regression is migration
 * 0002's completeness check at `make migrate` — Postgres counts a partition as a table in
 * `public`, so the check sees them even though this file cannot.
 */

import { readFile, readdir } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

import { RLS_EXEMPT_TABLES } from './rls-tables.js';

const REPO_ROOT = new URL('../../../', import.meta.url);
const MIGRATIONS = new URL('packages/db/migrations/', REPO_ROOT);
const INIT_RLS = new URL('infra/postgres/init/03-rls.sql', REPO_ROOT);
/** What `02-schema.sql` loads into the container. The bootstrap's actual table list. */
const BOOTSTRAP_DDL = new URL('docs/hiring_platform_schema.sql', REPO_ROOT);

async function readText(url: URL): Promise<string> {
  return readFile(url, 'utf8');
}

/**
 * The tables the bootstrap creates, read from the DDL it loads.
 *
 * Not `ALL_TABLES` from the Drizzle schema. The two lists are deliberately different: the
 * bootstrap only ever knew the tables the documented DDL declares, and a table a migration
 * added later without the documentation catching up simply is not created at container
 * start — `staff_accounts` and `staff_verifications` (migration 0006) are in that position
 * today. Asserting against the Drizzle schema would therefore fail for tables the bootstrap
 * is not responsible for, and pass over exactly the ones it is.
 */
async function bootstrapTables(): Promise<readonly string[]> {
  const ddl = await readText(BOOTSTRAP_DDL);
  return [...ddl.matchAll(/^CREATE TABLE (?:IF NOT EXISTS )?(?<name>\w+)/gmu)]
    .map((match) => match.groups?.['name'] ?? '')
    .filter((name) => name !== '')
    .sort((a, b) => a.localeCompare(b));
}

async function migrationFiles(): Promise<readonly { name: string; sql: string }[]> {
  const names = (await readdir(MIGRATIONS)).filter((name) => name.endsWith('.sql')).sort();
  return Promise.all(
    names.map(async (name) => ({ name, sql: await readText(new URL(name, MIGRATIONS)) })),
  );
}

describe('the container bootstrap covers every table the schema declares', () => {
  it('enables row-level security on each of them in 03-rls.sql', async () => {
    const sql = await readText(INIT_RLS);
    const exempt = new Set(Object.keys(RLS_EXEMPT_TABLES));

    const missing = (await bootstrapTables()).filter(
      (table) =>
        !exempt.has(table) &&
        // Word-bounded, so `user_roles` is not satisfied by `user_role_permissions`.
        !new RegExp(`ALTER TABLE ${table}\\s+ENABLE ROW LEVEL SECURITY`, 'u').test(sql),
    );

    expect(missing, 'tables the bootstrap would create without a policy').toEqual([]);
  });

  it('gives each of them a policy, not merely the ENABLE', async () => {
    // `ENABLE` with no policy denies everything, which is safe and is not what these tables
    // want: a tenant must be able to read its own rows. The pairing is what makes the
    // bootstrap usable rather than merely locked.
    const sql = await readText(INIT_RLS);
    const exempt = new Set(Object.keys(RLS_EXEMPT_TABLES));

    const missing = (await bootstrapTables()).filter(
      (table) =>
        !exempt.has(table) && !new RegExp(`CREATE POLICY \\w+ ON ${table}\\b`, 'u').test(sql),
    );

    expect(missing, 'tables enabled for RLS with no policy to read their own rows').toEqual([]);
  });

  it('exempts a table only where the registry says so, with a reason', async () => {
    // The bootstrap's own completeness check hard-codes its exemption list. The two must
    // agree, or a table exempted in one place fails the check in the other.
    const sql = await readText(INIT_RLS);

    for (const [table, reason] of Object.entries(RLS_EXEMPT_TABLES)) {
      expect(sql, `${table} should be named in the bootstrap's exemption list`).toContain(
        `'${table}'`,
      );
      expect(reason.length, `${table} needs a reason, not just an entry`).toBeGreaterThan(20);
    }
  });
});

describe('every migration can be replayed against a database that already has the shape', () => {
  it('guards every ADD COLUMN with IF NOT EXISTS', async () => {
    const offenders: string[] = [];

    for (const { name, sql } of await migrationFiles()) {
      for (const match of sql.matchAll(/ADD COLUMN(?<guard>\s+IF NOT EXISTS)?\s+(?<col>\w+)/giu)) {
        if (match.groups?.['guard'] === undefined) {
          offenders.push(`${name}: ADD COLUMN ${match.groups?.['col'] ?? '?'}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('guards every DROP CONSTRAINT with IF EXISTS', async () => {
    const offenders: string[] = [];

    for (const { name, sql } of await migrationFiles()) {
      for (const match of sql.matchAll(/DROP CONSTRAINT(?<guard>\s+IF EXISTS)?\s+(?<con>\w+)/giu)) {
        if (match.groups?.['guard'] === undefined) {
          offenders.push(`${name}: DROP CONSTRAINT ${match.groups?.['con'] ?? '?'}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('guards every ADD CONSTRAINT, by a drop before it or a pg_constraint check around it', async () => {
    // `ADD CONSTRAINT` has no `IF NOT EXISTS` in PostgreSQL, so it needs a guard of its own.
    // Two are in use here and both are fine: `DROP CONSTRAINT IF EXISTS` immediately before,
    // and a `DO` block that looks the name up in `pg_constraint` first — which is what
    // 0001's three circular foreign keys do, because they cannot be dropped and re-added on
    // a live table as cheaply as a CHECK can.
    const offenders: string[] = [];

    for (const { name, sql } of await migrationFiles()) {
      for (const match of sql.matchAll(/ADD CONSTRAINT\s+(?<con>\w+)/giu)) {
        const constraint = match.groups?.['con'];
        if (constraint === undefined) continue;

        const dropped = new RegExp(`DROP CONSTRAINT IF EXISTS ${constraint}\\b`, 'iu').test(sql);
        const checked = new RegExp(`pg_constraint[^;]*conname = '${constraint}'`, 'iu').test(sql);

        if (!dropped && !checked) {
          offenders.push(`${name}: ADD CONSTRAINT ${constraint} with no guard`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
