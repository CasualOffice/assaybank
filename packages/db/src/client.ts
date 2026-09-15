/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The connection handle, and the only two ways to run a query through it.
 *
 * ADR-010 makes tenant isolation a property of the database rather than of every
 * developer remembering a `WHERE` clause. That only holds if `app.current_org` is set
 * before any tenant row is read, which is why this module exports no raw connection:
 * {@link withOrg} and {@link withElevated} are the entire surface, and both open a
 * transaction and set their setting inside it before calling you.
 *
 * **Why transaction-local rather than a checkout hook.** ADR-010 describes setting the
 * variable "per checkout". postgres.js has no checkout hook, and a per-connection
 * `SET` would be worse than none: a pooled connection serves many organisations over its
 * life, so a setting that outlives the query that set it is a setting the *next* request
 * inherits. `set_config(..., true)` is scoped to the transaction and is discarded on
 * commit or rollback, which makes the leak structurally impossible rather than merely
 * unlikely. It is the same guarantee ADR-010 asks for, obtained more cheaply.
 *
 * **Why the pools are private.** A `Database` carries two postgres.js clients — one for
 * the RLS-enforced application role, one for the elevated background-job role — in a
 * module-level `WeakMap` rather than as properties. An exported property is an exported
 * capability: anything holding the handle could run an unscoped query and no reviewer
 * would notice the missing `withOrg`. There is deliberately no escape hatch here.
 */

import { sql } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import type { DatabaseConfig } from '@assaybank/config';
import type { OrgId } from '@assaybank/contracts';

import { schema, type Schema } from './schema/index.js';

/**
 * What the client needs from configuration: `DATABASE_URL`, `DATABASE_JOB_URL` and
 * `DATABASE_POOL_MAX`.
 *
 * Narrowed from `@assaybank/config`'s `DatabaseConfig` rather than redeclared, so
 * `createDb(config.database)` is the whole call and a variable renamed in the config
 * schema is a type error here rather than a runtime surprise. The `Pick` is the point:
 * this package has no business seeing `postgresPassword`, and a type it cannot name is a
 * type it cannot log.
 *
 * Type-only, so importing this package does not pull in the environment parser — a
 * migration script or a test can construct a `DbConfig` literal without a `.env`.
 */
export type DbConfig = Pick<DatabaseConfig, 'url' | 'jobUrl' | 'poolMax'>;

/** One elevated block, as handed to {@link DbOptions.onElevation}. */
export interface ElevationRecord {
  /** Why the background job needed a role that policies cannot constrain. */
  readonly reason: string;
  /** When the block was entered, from the injected clock. */
  readonly at: Date;
}

/** Everything a caller may vary that is not configuration. */
export interface DbOptions {
  /**
   * Shows up in `pg_stat_activity` and in Postgres log lines, so a slow query can be
   * attributed to a service without correlating timestamps by hand.
   */
  readonly applicationName?: string;
  /**
   * Called on entry to every {@link withElevated} block.
   *
   * ADR-010 grants the job role `BYPASSRLS` and, in exchange, requires every write made
   * as that role to be reconstructable afterwards. This hook is where the API or the
   * worker attaches its logger and its audit writer. It is intentionally not optional in
   * spirit: an elevation nobody recorded is the one nobody can explain.
   */
  readonly onElevation?: (record: ElevationRecord) => void;
  /**
   * The clock. Injected because docs/17 §8 makes time a parameter everywhere it is
   * observable, and because a test that cannot control it cannot assert on it.
   */
  readonly now?: () => Date;
}

/**
 * A handle on the two pools. Opaque on purpose — see the module comment. Close it on
 * shutdown; `apps/*` do that from their graceful-shutdown path.
 */
export interface Database {
  /** Ends both pools, draining in-flight queries first. Safe to call more than once. */
  close(): Promise<void>;
}

/** The transaction handed to a {@link withOrg} or {@link withElevated} callback. */
export type DbTransaction = Parameters<Parameters<PostgresJsDatabase<Schema>['transaction']>[0]>[0];

interface Pools {
  readonly appSql: postgres.Sql;
  readonly appDb: PostgresJsDatabase<Schema>;
  readonly jobSql: postgres.Sql;
  readonly jobDb: PostgresJsDatabase<Schema>;
  readonly onElevation: ((record: ElevationRecord) => void) | undefined;
  readonly now: () => Date;
}

/**
 * Handle to pools. A `WeakMap` rather than a property so the connections cannot be
 * reached from the handle, and so a closed handle is collectable.
 */
const POOLS = new WeakMap<Database, Pools>();

function poolsFor(db: Database): Pools {
  const pools = POOLS.get(db);
  if (!pools) {
    throw new Error(
      'This Database handle was not produced by createDb(), or has already been garbage ' +
        'collected. Pass the handle createDb() returned.',
    );
  }
  return pools;
}

/**
 * Opens both pools. Neither connects until its first query, so calling this at module
 * load does not make the process depend on the database being reachable — `/readyz`
 * checks that, `/healthz` deliberately does not.
 */
export function createDb(cfg: DbConfig, options: DbOptions = {}): Database {
  const connection =
    options.applicationName === undefined
      ? {}
      : { connection: { application_name: options.applicationName } };

  const appSql = postgres(cfg.url, { max: cfg.poolMax, ...connection });
  const jobSql = postgres(cfg.jobUrl, { max: cfg.poolMax, ...connection });

  const handle: Database = {
    close: async () => {
      await Promise.all([appSql.end(), jobSql.end()]);
    },
  };

  POOLS.set(handle, {
    appSql,
    appDb: drizzle(appSql, { schema }),
    jobSql,
    jobDb: drizzle(jobSql, { schema }),
    onElevation: options.onElevation,
    now: options.now ?? (() => new Date()),
  });

  return handle;
}

/**
 * Runs `fn` in a transaction scoped to one organisation, as the RLS-enforced role.
 *
 * `app.current_org` is set by the first statement of the same transaction `fn` runs in —
 * not on the connection, not in a preceding transaction. That is the whole guarantee: a
 * query inside `fn` cannot execute before the setting exists, and the setting cannot
 * survive past the commit into whatever borrows the connection next.
 *
 * A forgotten `WHERE org_id = ?` inside `fn` therefore returns zero rows rather than
 * another tenant's data (ADR-010).
 */
export async function withOrg<T>(
  db: Database,
  orgId: OrgId,
  fn: (tx: DbTransaction) => Promise<T>,
): Promise<T> {
  const { appDb } = poolsFor(db);

  return appDb.transaction(async (tx) => {
    // Parameterised, not interpolated: orgId is parsed at the edge into a branded UUID,
    // and it is still passed as a parameter (docs/17 §7 — no string interpolation into
    // SQL, ever, including when the value is already known to be a UUID).
    await tx.execute(sql`SELECT set_config('app.current_org', ${orgId}, true)`);
    return fn(tx);
  });
}

/**
 * Runs `fn` as the elevated background-job role, in a transaction, with the reason
 * recorded.
 *
 * ADR-010 grants this role `BYPASSRLS` because a grading job has no authenticated session
 * behind it and therefore no organisation to put in `app.current_org` — there is no
 * policy that could admit it. What the role owes in return is an audit trail, so:
 *
 * - `reason` is required and must be non-empty. It is written to
 *   `app.elevation_reason` for the life of the transaction, where `pg_stat_activity` and
 *   any future trigger can see it.
 * - {@link DbOptions.onElevation} is called on entry, which is where the caller attaches
 *   its logger and its `job.*` audit row.
 *
 * This is not a general-purpose escape from tenancy. If a job knows which organisation it
 * is acting for — and most do, from the attempt row they just loaded — use
 * {@link withOrg} instead and keep the policies in play.
 */
export async function withElevated<T>(
  db: Database,
  reason: string,
  fn: (tx: DbTransaction) => Promise<T>,
): Promise<T> {
  if (reason.trim() === '') {
    throw new Error(
      'withElevated() requires a reason. The job role bypasses row-level security ' +
        '(ADR-010); an elevation nobody recorded is an elevation nobody can explain.',
    );
  }

  const { jobDb, onElevation, now } = poolsFor(db);
  onElevation?.({ reason, at: now() });

  return jobDb.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.elevation_reason', ${reason}, true)`);
    return fn(tx);
  });
}
