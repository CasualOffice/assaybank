/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The programmatic migration runner.
 *
 * Migrations run as the **owner**, not as either application role: they create tables,
 * and neither `hiring_app` nor `hiring_job` may create objects in `public` (0002). So
 * this takes its own DSN rather than a {@link import('./client.js').Database}, and opens
 * a single connection it closes on the way out — a migration is not a workload that
 * wants a pool.
 *
 * **Forward-only.** There are no down migrations, per docs/17 §4: a down migration is
 * either trivially unnecessary or a data-loss event pretending to be a rollback. Roll
 * forward.
 *
 * **Idempotent.** Drizzle records each applied file's hash in
 * `drizzle.__drizzle_migrations` and skips what it has already run, and every statement
 * in `migrations/` is additionally written `IF NOT EXISTS` or guarded so the files can be
 * replayed by hand. `make migrate` twice: the second run reports `applied: 0`.
 *
 * **Not during an open exam window.** docs/13 makes that an operational rule, and it is
 * the reason the expand-contract discipline starts at 0001 rather than at the first
 * migration that happens to need it.
 */

import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate as drizzleMigrate } from 'drizzle-orm/postgres-js/migrator';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';

/**
 * The migrations directory, resolved relative to this module.
 *
 * `src/migrate.ts` and `dist/migrate.js` are both one level below the package root, so
 * the same expression is correct whether the caller imported the source (vitest,
 * `pnpm typecheck`) or the build (`apps/*` at runtime).
 */
export const MIGRATIONS_DIR = new URL('../migrations/', import.meta.url).pathname;

/** The schema and table Drizzle records applied migrations in. */
const MIGRATIONS_SCHEMA = 'drizzle';
const MIGRATIONS_TABLE = '__drizzle_migrations';

export interface MigrateOptions {
  /** Owner DSN. Not `DATABASE_URL`: that is the application role, which cannot create. */
  readonly url: string;
  /** Defaults to {@link MIGRATIONS_DIR}. Overridden only by tests. */
  readonly migrationsFolder?: string;
}

export interface MigrateResult {
  /** How many migration files this run applied. Zero on a re-run. */
  readonly applied: number;
  /** Total recorded in `drizzle.__drizzle_migrations` afterwards. */
  readonly total: number;
}

async function countApplied(client: postgres.Sql): Promise<number> {
  const rows = await client<{ present: boolean }[]>`
    SELECT to_regclass(${`${MIGRATIONS_SCHEMA}.${MIGRATIONS_TABLE}`}) IS NOT NULL AS present
  `;
  if (rows[0]?.present !== true) {
    return 0;
  }
  const db = drizzle(client);
  const result = await db.execute<{ n: string }>(
    sql`SELECT count(*)::text AS n FROM ${sql.identifier(MIGRATIONS_SCHEMA)}.${sql.identifier(
      MIGRATIONS_TABLE,
    )}`,
  );
  const first: { n: string } | undefined = result[0];
  return first === undefined ? 0 : Number.parseInt(first.n, 10);
}

/**
 * Applies every migration the database has not seen, and reports how many that was.
 *
 * The count is read before and after rather than inferred, so "the second run is a no-op"
 * is an assertion a test can make rather than a claim in a comment.
 */
export async function migrate(options: MigrateOptions): Promise<MigrateResult> {
  const folder = options.migrationsFolder ?? MIGRATIONS_DIR;

  // max: 1 — a migration is one sequential unit of work, and a pool would only let a
  // second statement start on a connection that has not seen the first.
  const client = postgres(options.url, { max: 1 });
  try {
    const before = await countApplied(client);
    await drizzleMigrate(drizzle(client), {
      migrationsFolder: folder,
      migrationsSchema: MIGRATIONS_SCHEMA,
      migrationsTable: MIGRATIONS_TABLE,
    });
    const after = await countApplied(client);
    return { applied: after - before, total: after };
  } finally {
    await client.end();
  }
}
