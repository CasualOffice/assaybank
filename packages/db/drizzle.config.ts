/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * drizzle-kit configuration — a **drafting** tool, not the migration path.
 *
 * `pnpm db:generate` writes a proposed migration into `out/drizzle-drafts/`, which is
 * scratch space (`out/` is git-ignored). Nothing in `migrations/` is ever written by a
 * tool. That is deliberate:
 *
 * - `migrations/0001_initial.sql` is hand-authored, because it carries three things
 *   drizzle-kit cannot express — the `pgcrypto` / `pg_trgm` / `citext` extensions, the
 *   ADR-003 immutability trigger on `question_versions`, and the permission-catalogue
 *   seed. A generator that overwrote the file would silently drop all three.
 * - `migrations/0002_rls.sql` is policies, roles and grants, which are not in the
 *   TypeScript model at all.
 *
 * So the workflow is: change the schema, generate a draft, read it, and merge what it got
 * right into a hand-written migration. `src/schema/schema.test.ts` and
 * `src/rls-tables.test.ts` are what actually keep the model and the migrations in step.
 *
 * The credentials are deliberately absent, which makes drizzle-kit's push mode — a diff
 * applied straight to a live database with no reviewed artefact in between — impossible
 * to invoke by accident. docs/17 §4 rules it out.
 */

import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './out/drizzle-drafts',
  casing: 'snake_case',
  strict: true,
  verbose: true,
});
