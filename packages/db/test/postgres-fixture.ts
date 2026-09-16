/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * One real PostgreSQL, migrated, with both application roles usable.
 *
 * Row-level security, `GRANT`, `BYPASSRLS` and policy predicates do not exist in a fake
 * (docs/17 §8), so every suite in `tests/` needs a container. Three suites needing the
 * same container is three copies of the same forty lines, and the copies drift — one
 * gets the new migration count, one does not, and the one that does not is the one that
 * keeps passing while proving less.
 *
 * Not a product seeder and not exported from the package. `test/` holds fixtures; the
 * build project (`tsconfig.build.json`) does not compile it and `dist/` never sees it.
 */

import { readFileSync } from 'node:fs';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { getContainerRuntimeClient } from 'testcontainers';
import postgres from 'postgres';

import { migrate } from '../src/migrate.js';

/**
 * Pinned to the version docker-compose.yml runs, so the policies are tested on the
 * engine they will actually run on. RLS plan behaviour and `num_nonnulls` semantics are
 * both version-sensitive enough that testing on a different major would prove less than
 * it appears to.
 */
export const POSTGRES_IMAGE = 'postgres:16-alpine';

export const OWNER_USER = 'hiring';
export const OWNER_PASSWORD = 'hiring';
export const DATABASE = 'hiring';

/**
 * Assigned by the fixture, not by the migration. 0002 creates the roles without a
 * password on purpose — a password in a migration is a secret in the repository.
 */
export const APP_PASSWORD = 'hiring_app_test';
export const JOB_PASSWORD = 'hiring_job_test';

/**
 * How many migration files exist, read from the journal rather than typed.
 *
 * A suite asserting `applied === 2` is a suite that fails the day someone adds the third
 * migration, for no reason connected to what it tests. Reading the journal keeps
 * "migrate applied everything, and applied nothing the second time" as the property under
 * test.
 */
export const MIGRATION_COUNT: number = (
  JSON.parse(
    readFileSync(new URL('../migrations/meta/_journal.json', import.meta.url), 'utf8'),
  ) as {
    entries: unknown[];
  }
).entries.length;

/**
 * Whether a container runtime answered, and what it said if it did not.
 *
 * Evaluated once at module load. Every suite that needs Postgres reads this and skips
 * with the reason printed rather than failing a build on a laptop with no daemon — and
 * runs for real the moment one is up.
 */
export const containerRuntime: { readonly available: boolean; readonly reason: string } =
  await (async () => {
    try {
      await getContainerRuntimeClient();
      return { available: true, reason: '' };
    } catch (error) {
      return { available: false, reason: error instanceof Error ? error.message : String(error) };
    }
  })();

/**
 * Says so, on stderr, when a suite is skipped.
 *
 * A suite that quietly does not run is worse than one that fails, because nobody
 * investigates a green tick. stderr because vitest does not fold it into a task's
 * captured output.
 */
export function announceSkip(file: string, alsoCoveredBy?: string): void {
  if (containerRuntime.available) return;
  process.stderr.write(
    `\n[${file}] SKIPPED: no container runtime is reachable, so this suite cannot run.\n` +
      `Start Docker (or Colima, or Podman) and re-run to execute it.\n` +
      `Reason reported by testcontainers: ${containerRuntime.reason}\n` +
      (alsoCoveredBy === undefined
        ? ''
        : `Partially covered without a daemon by ${alsoCoveredBy}.\n`) +
      '\n',
  );
}

/** Appends the skip reason to a suite name, where every reporter shows it. */
export function suiteName(name: string): string {
  return containerRuntime.available
    ? name
    : `${name} — SKIPPED, no container runtime: ${containerRuntime.reason}`;
}

export interface TestDatabase {
  readonly container: StartedPostgreSqlContainer;
  /** Owner DSN. Creates objects; exempt from its own policies (0002 uses no FORCE). */
  readonly ownerUrl: string;
  /** `hiring_app` — row-level security enforced. */
  readonly appUrl: string;
  /** `hiring_job` — BYPASSRLS, per ADR-010. */
  readonly jobUrl: string;
  /** A single owner connection, for seeding and for out-of-band assertions. */
  readonly owner: postgres.Sql;
  /** How many migrations this fixture applied. Equals {@link MIGRATION_COUNT}. */
  readonly applied: number;
  stop(): Promise<void>;
}

/**
 * Starts a container, runs every migration as the owner, and gives the two application
 * roles a password so a suite can connect as them exactly as an operator would.
 *
 * Seeding happens through the owner rather than through `withOrg`, deliberately: seeding
 * through the application role would be circular, because the thing under test would be
 * deciding what the fixture contains.
 */
export async function startTestDatabase(): Promise<TestDatabase> {
  const container = await new PostgreSqlContainer(POSTGRES_IMAGE)
    .withDatabase(DATABASE)
    .withUsername(OWNER_USER)
    .withPassword(OWNER_PASSWORD)
    .start();

  const host = container.getHost();
  const port = container.getPort();
  const ownerUrl = `postgres://${OWNER_USER}:${OWNER_PASSWORD}@${host}:${port}/${DATABASE}`;

  const { applied } = await migrate({ url: ownerUrl });

  const owner = postgres(ownerUrl, { max: 1 });
  await owner.unsafe(`ALTER ROLE hiring_app WITH PASSWORD '${APP_PASSWORD}'`);
  await owner.unsafe(`ALTER ROLE hiring_job WITH PASSWORD '${JOB_PASSWORD}'`);

  return {
    container,
    ownerUrl,
    appUrl: `postgres://hiring_app:${APP_PASSWORD}@${host}:${port}/${DATABASE}`,
    jobUrl: `postgres://hiring_job:${JOB_PASSWORD}@${host}:${port}/${DATABASE}`,
    owner,
    applied,
    stop: async () => {
      await owner.end();
      await container.stop();
    },
  };
}

/**
 * PostgreSQL's `insufficient_privilege` (SQLSTATE 42501). Stronger isolation than zero
 * rows, not weaker: the statement never reached a policy because the grant refused it
 * first. `audit_log` is deliberately in that position for UPDATE and DELETE.
 *
 * The cause chain is walked because Drizzle wraps a driver error in a
 * `DrizzleQueryError`, so the SQLSTATE is one level down from what the caller catches.
 */
export function isInsufficientPrivilege(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && typeof current === 'object' && current !== null; depth += 1) {
    if ('code' in current && current.code === '42501') {
      return true;
    }
    current = 'cause' in current ? current.cause : undefined;
  }
  return false;
}

/** Fails loudly rather than letting an undefined fixture turn into a vacuous pass. */
export function required<T>(value: T | undefined, name: string): T {
  if (value === undefined) {
    throw new Error(`fixture ${name} was not initialised; the suite cannot assert anything`);
  }
  return value;
}
