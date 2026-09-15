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

import { readFileSync } from 'node:fs';

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

const journal = JSON.parse(read('meta/_journal.json')) as {
  entries: { idx: number; tag: string; when: number; breakpoints: boolean }[];
};

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

describe('migration 0001_initial', () => {
  it('creates every table in the Drizzle schema', () => {
    const missing = ALL_TABLES.filter(
      (table) => !new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`).test(initialSql),
    );
    expect(missing).toEqual([]);
  });

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

describe('migration 0002_rls', () => {
  it('enables row-level security on every table that is not explicitly exempt', () => {
    const missing = POLICIED_TABLES.filter(
      (table) => !rlsSql.includes(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`),
    );
    expect(missing).toEqual([]);
  });

  it('creates an org_isolation policy on every table that is not explicitly exempt', () => {
    const missing = POLICIED_TABLES.filter(
      (table) => !new RegExp(`CREATE POLICY org_isolation ON ${table}\\b`).test(rlsSql),
    );
    expect(missing).toEqual([]);
  });

  it('compares the tenant key against app.current_org on every directly keyed table', () => {
    for (const table of TENANT_TABLES) {
      const policy = rlsSql.slice(rlsSql.indexOf(`CREATE POLICY org_isolation ON ${table}\n`));
      const body = policy.slice(0, policy.indexOf('--> statement-breakpoint'));
      expect(body, `${table} must compare org_id to app_current_org()`).toContain(
        'org_id = public.app_current_org()',
      );
    }
  });

  it('lets the two nullable-org_id tables be read but never written as global rows', () => {
    // USING admits org_id IS NULL so a tenant can read the shared taxonomy; WITH CHECK
    // must not, or a tenant could edit every other tenant's rows.
    for (const table of GLOBAL_ROW_TABLES) {
      const start = rlsSql.indexOf(`CREATE POLICY org_isolation ON ${table}\n`);
      const body = rlsSql.slice(start, rlsSql.indexOf('--> statement-breakpoint', start));
      expect(body).toContain('USING (org_id IS NULL OR org_id = public.app_current_org())');
      expect(body).toContain('WITH CHECK (org_id = public.app_current_org())');
    }
  });

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

describe('the migration journal', () => {
  it('lists both migrations, in order, with strictly increasing timestamps', () => {
    const tags = journal.entries.map((entry) => entry.tag);
    expect(tags).toEqual(['0001_initial', '0002_rls']);

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
