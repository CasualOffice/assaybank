/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * "No table was missed", asserted without a database.
 *
 * `tests/rls.test.ts` proves the policies actually isolate, but it needs Docker and is
 * therefore skippable — and a property this important should not be provable only on
 * machines that happen to have a daemon running. So the same completeness claim is made
 * twice, by different means: this file reads the migration SQL as text and checks that
 * every table derived from the Drizzle schema is accounted for in it.
 *
 * It catches the realistic failure directly. Someone adds a table in P2, writes the
 * Drizzle definition, writes the `CREATE TABLE` in a migration, and forgets the policy.
 * `TENANT_TABLES` grows, the policy text does not, and this test fails on their branch
 * with the table's name in the message.
 */

import { readdirSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  ALL_TABLES,
  DERIVED_TENANT_TABLES,
  GLOBAL_ROW_TABLES,
  RLS_EXEMPT_TABLES,
  TENANT_ROOT_TABLE,
  TENANT_TABLES,
} from './rls-tables.js';

const read = (name: string): string =>
  readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8');

const initialSql = read('0001_initial.sql');
const rlsSql = read('0002_rls.sql');
const platformSql = read('0003_platform_org.sql');

const journal = JSON.parse(read('meta/_journal.json')) as {
  entries: { idx: number; tag: string; when: number; breakpoints: boolean }[];
};

/**
 * Every migration, concatenated in journal order.
 *
 * The completeness claims below — every table created, every table policied — are about
 * the schema as it stands, not about one file. A table introduced in 0006 is as much a
 * leak as one introduced in 0001 if it has no policy, and reading only `0001_initial.sql`
 * would have quietly stopped checking the tables that arrive later, which is exactly the
 * failure this suite exists to catch. Reading the journal rather than the directory keeps
 * the input to the check identical to the input the migrator uses.
 */
const migrationsSql = journal.entries.map((entry) => read(`${entry.tag}.sql`)).join('\n');

/** The tags on disk, sorted, so the journal can be checked against reality. */
const migrationTags: readonly string[] = readdirSync(new URL('../migrations/', import.meta.url))
  .filter((name) => name.endsWith('.sql'))
  .map((name) => name.replace(/\.sql$/, ''))
  .sort((a, b) => a.localeCompare(b));

/** Every table that must carry a policy: the root, the tenant-keyed, and the children. */
const POLICIED_TABLES: readonly string[] = [
  TENANT_ROOT_TABLE,
  ...TENANT_TABLES,
  ...DERIVED_TENANT_TABLES,
];

describe('TENANT_TABLES', () => {
  it('is not empty', () => {
    // A bug that made the derivation return nothing would make the generated isolation
    // suite vacuously pass, which is the one way this whole mechanism can fail silently.
    expect(TENANT_TABLES.length).toBeGreaterThan(0);
  });

  it('is derived, not hand-typed: it contains the tables that carry org_id and no others', () => {
    expect(TENANT_TABLES).toContain('attempts');
    expect(TENANT_TABLES).toContain('questions');
    expect(TENANT_TABLES).toContain('audit_log');
    // Keyed on `id`; covered separately.
    expect(TENANT_TABLES).not.toContain(TENANT_ROOT_TABLE);
    // Child tables reach their org through a parent and have no org_id of their own.
    expect(TENANT_TABLES).not.toContain('mcq_options');
    expect(TENANT_TABLES).not.toContain('answers');
  });

  it('partitions every table in the schema exactly once', () => {
    const exempt = Object.keys(RLS_EXEMPT_TABLES);
    const partitioned = [TENANT_ROOT_TABLE, ...TENANT_TABLES, ...DERIVED_TENANT_TABLES, ...exempt];

    expect(new Set(partitioned).size).toBe(partitioned.length);
    expect([...partitioned].sort((a, b) => a.localeCompare(b))).toEqual([...ALL_TABLES]);
  });

  it('names only tables that exist, for the nullable-org_id group', () => {
    for (const table of GLOBAL_ROW_TABLES) {
      expect(TENANT_TABLES).toContain(table);
    }
  });
});

describe('the migrations, taken together', () => {
  it('creates every table in the Drizzle schema', () => {
    // Across all migrations, not only 0001: staff_accounts and staff_verifications
    // arrive in 0006 and are as much a tenant table as anything in the first file.
    const missing = ALL_TABLES.filter(
      (table) => !new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`).test(migrationsSql),
    );
    expect(missing).toEqual([]);
  });

  it('enables row-level security on every table that is not explicitly exempt', () => {
    const missing = POLICIED_TABLES.filter(
      (table) => !migrationsSql.includes(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`),
    );
    expect(missing).toEqual([]);
  });

  // Checked across the migrations as written, not as finally applied: 0008 later replaces the
  // org_isolation policy on the nullable-org_id tables with per-command policies (see below).
  it('creates an org_isolation policy on every table that is not explicitly exempt', () => {
    const missing = POLICIED_TABLES.filter(
      (table) => !new RegExp(`CREATE POLICY org_isolation ON ${table}\\b`).test(migrationsSql),
    );
    expect(missing).toEqual([]);
  });

  it('compares the tenant key against app.current_org on every directly keyed table', () => {
    for (const table of TENANT_TABLES) {
      const start = migrationsSql.indexOf(`CREATE POLICY org_isolation ON ${table}\n`);
      const body = migrationsSql.slice(
        start,
        migrationsSql.indexOf('--> statement-breakpoint', start),
      );
      expect(body, `${table} must compare org_id to app_current_org()`).toContain(
        'org_id = public.app_current_org()',
      );
    }
  });
});

describe('migration 0001_initial', () => {
  it('creates the three extensions the schema depends on', () => {
    for (const extension of ['pgcrypto', 'pg_trgm', 'citext']) {
      expect(initialSql).toContain(`CREATE EXTENSION IF NOT EXISTS ${extension};`);
    }
  });

  it('uses timestamptz and never a naive timestamp', () => {
    // `timestamp` with no time zone in a column definition would be a deadline that moves
    // when the server's timezone does (docs/17 §4, ADR-006).
    expect(initialSql).not.toMatch(/\btimestamp\b(?!tz)/);
  });

  it('enforces ADR-003 with a trigger, not only with application code', () => {
    expect(initialSql).toContain('CREATE TRIGGER question_versions_immutable');
    expect(initialSql).toContain('BEFORE UPDATE ON question_versions');
  });
});

describe('migration 0008_global_rows_read_only', () => {
  // 0002's single policy per nullable-org_id table admitted global rows to DELETE and to an
  // UPDATE that rewrote org_id — a shape this file used to assert as correct. 0008 replaces it.
  // The behaviour is proven against a real database in tests/rls.test.ts; this checks the text.
  const globalSql = read('0008_global_rows_read_only.sql');

  const policy = (name: string, table: string): string => {
    const start = globalSql.indexOf(`CREATE POLICY ${name} ON ${table} `);
    expect(start, `${name} on ${table}`).toBeGreaterThan(-1);
    return globalSql.slice(start, globalSql.indexOf('--> statement-breakpoint', start));
  };

  it('drops the policy that admitted global rows to every command', () => {
    for (const table of GLOBAL_ROW_TABLES) {
      expect(globalSql).toContain(`DROP POLICY IF EXISTS org_isolation ON ${table};`);
    }
  });

  it('admits global rows to SELECT and to nothing else', () => {
    for (const table of GLOBAL_ROW_TABLES) {
      expect(policy('org_read', table)).toContain(
        'FOR SELECT\n    USING (org_id IS NULL OR org_id = public.app_current_org())',
      );
      for (const write of ['org_insert', 'org_update', 'org_delete']) {
        const body = policy(write, table);
        expect(body, `${write} on ${table}`).not.toContain('IS NULL');
        expect(body).toContain('org_id = public.app_current_org()');
      }
    }
  });
});

describe('migration 0002_rls', () => {
  it('gives no policy to a table that is exempt, and names its reason', () => {
    for (const table of Object.keys(RLS_EXEMPT_TABLES)) {
      expect(new RegExp(`CREATE POLICY org_isolation ON ${table}\\b`).test(rlsSql)).toBe(false);
      expect(RLS_EXEMPT_TABLES[table]).toBeTruthy();
      // The exemption exists in the completeness check too, or the migration fails itself.
      expect(rlsSql).toContain(`c.relname NOT IN ('${table}')`);
    }
  });

  it('keeps audit_log append-only for both application roles', () => {
    expect(rlsSql).toContain('REVOKE UPDATE, DELETE ON audit_log FROM hiring_app, hiring_job;');
  });

  it('creates the app role without BYPASSRLS and the job role with it (ADR-010)', () => {
    expect(rlsSql).toContain("CREATE ROLE hiring_app LOGIN '");
    expect(rlsSql).toContain('NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS');
    expect(rlsSql).toContain("CREATE ROLE hiring_job LOGIN '");
    expect(rlsSql).toContain('NOSUPERUSER NOCREATEDB NOCREATEROLE BYPASSRLS');
  });

  it('sets no password: a password in a migration is a secret in the repository', () => {
    // docs/17 §7. The roles are created without one; the operator assigns it.
    expect(rlsSql).not.toMatch(/\bPASSWORD\b/);
  });

  it('fails itself if a future migration adds a table with no policy', () => {
    expect(rlsSql).toContain('RLS completeness check failed');
    expect(rlsSql).toContain('NOT c.relrowsecurity');
  });
});

describe('migration 0003_platform_org', () => {
  it('reserves the nil UUID so no organisation can hold it', () => {
    // apps/api runs its readiness probe as the nil organisation and packages/db files
    // platform-scoped elevation audit rows against it, both on the strength of it owning
    // no rows. A convention protecting an isolation boundary is not a protection.
    expect(platformSql).toContain('ADD CONSTRAINT organizations_id_not_platform');
    expect(platformSql).toContain("CHECK (id <> '00000000-0000-0000-0000-000000000000'::uuid)");
  });

  it('adds the constraint NOT VALID and validates it separately (docs/17 §4)', () => {
    // Expand-contract. On a populated table the split is what keeps it readable and
    // writable while the scan runs; doing it the cheap way here teaches the wrong habit
    // for the migration where it matters.
    expect(platformSql).toContain('NOT VALID');
    expect(platformSql).toContain('VALIDATE CONSTRAINT organizations_id_not_platform');
    expect(platformSql.indexOf('NOT VALID')).toBeLessThan(
      platformSql.indexOf('VALIDATE CONSTRAINT'),
    );
  });

  it('is guarded, so a replay applies nothing', () => {
    expect(platformSql).toContain('FROM pg_constraint');
    expect(platformSql).toContain('NOT convalidated');
  });

  it('adds no table, so it cannot have missed a policy', () => {
    expect(platformSql).not.toMatch(/CREATE TABLE/i);
  });
});

describe('the migration journal', () => {
  it('lists every migration, in order, with strictly increasing timestamps', () => {
    // Derived from the directory rather than written out: a hard-coded list turns every
    // new migration into an unrelated test edit, and the property worth asserting is
    // "the journal and the folder agree", not "there are exactly three files".
    const tags = journal.entries.map((entry) => entry.tag);
    expect(tags).toEqual(migrationTags);

    for (let i = 1; i < journal.entries.length; i += 1) {
      const previous = journal.entries[i - 1];
      const current = journal.entries[i];
      expect(previous).toBeDefined();
      expect(current).toBeDefined();
      // The migrator compares folderMillis against the last applied migration, so a
      // non-increasing `when` silently skips a file.
      expect(current?.when).toBeGreaterThan(previous?.when ?? Number.POSITIVE_INFINITY);
      expect(current?.idx).toBe(i);
    }
  });

  it('points at files that exist', () => {
    for (const entry of journal.entries) {
      expect(() => read(`${entry.tag}.sql`)).not.toThrow();
    }
  });
});
