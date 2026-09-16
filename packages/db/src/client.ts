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
 * **And the guarantee is checked, not assumed.** The statement that sets the org also
 * reports what the connection was already carrying, and {@link withOrg} refuses to run
 * when that is not empty (see {@link OrgContextLeakError}). Transaction-local scoping is
 * the mechanism; the check is what turns "this should be impossible" into "this is
 * observed on every checkout, in production, for free" — it rides along in the statement
 * that had to be sent anyway, so it costs no extra round trip.
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
import { OrgIdSchema, type OrgId } from '@assaybank/contracts';

import { writeAudit } from './audit.js';
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

/**
 * The organisation an elevated block names when it is acting for no single tenant — a
 * deadline sweep, a retention pass, a queue drain.
 *
 * The nil UUID, and it owns no rows by construction: migration `0003_platform_org`
 * carries a `CHECK` forbidding it as an `organizations.id`, so this is a structural
 * guarantee rather than a convention someone could break by seeding an organisation with
 * an unlucky identifier. `apps/api` already relies on the same property for its readiness
 * probe.
 *
 * Because no organisation has this id, `org_id = public.app_current_org()` is false for
 * every tenant: platform-level audit rows are invisible to all of them, which is the
 * correct visibility for a row that describes the platform rather than a customer. It is
 * also why `audit_log.org_id` stays `NOT NULL` — a nullable tenant key on an
 * isolation-critical table is a `NULL` one policy admits by accident.
 */
export const PLATFORM_ORG_ID: OrgId = OrgIdSchema.parse('00000000-0000-0000-0000-000000000000');

/**
 * Actions written by the background-job role carry a `job.` prefix, per the note on
 * `audit_log.actor_user_id` in the schema: the actor column is null for a job, so the
 * prefix is the only thing that distinguishes "nobody did this" from "a machine did
 * this" when reading history back.
 */
const JOB_ACTION = /^job\.[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

/**
 * Thrown when a connection arrives at {@link withOrg} still carrying an
 * `app.current_org` from whatever used it last.
 *
 * This is the failure ADR-010 names — request B inheriting request A's organisation —
 * and it is thrown rather than corrected because a connection in that state is evidence
 * that something in this process set the variable outside a transaction. Silently
 * overwriting it would let the bug survive to the next release; failing the one request
 * that noticed makes it a bug report.
 *
 * It carries no organisation identifiers in its message. The message reaches logs and,
 * through a handler that was not paying attention, possibly a response body; naming the
 * tenant whose context leaked would make the exception itself the disclosure.
 */
export class OrgContextLeakError extends Error {
  override readonly name = 'OrgContextLeakError';

  constructor() {
    super(
      'A pooled connection arrived carrying app.current_org from a previous checkout. ' +
        'Tenant context must be transaction-local (ADR-010); something set it with a ' +
        'session-scoped SET, or outside a transaction. Refusing to run this query.',
    );
  }
}

/** One elevated block, as handed to {@link DbOptions.onElevation}. */
export interface ElevationRecord {
  /** Why the background job needed a role that policies cannot constrain. */
  readonly reason: string;
  /** The organisation acted for, or {@link PLATFORM_ORG_ID} when there is not one. */
  readonly orgId: OrgId;
  /** When the block was entered, from the injected clock. */
  readonly at: Date;
}

/**
 * What {@link withElevated} records. A bare string is shorthand for `{ reason }`.
 *
 * `reason` is the `audit_log.action`, so it is also the thing someone greps for at
 * 03:00. `job.grade` and `job.deadline_sweep` are useful; `elevated` is not.
 */
export interface Elevation {
  /** `job.`-prefixed action, written verbatim to `audit_log.action`. */
  readonly reason: string;
  /**
   * The organisation whose data is touched, when the job knows it.
   *
   * Supply it wherever it exists: an audit row attributed to the platform is a row the
   * affected organisation cannot see in its own history. Defaults to
   * {@link PLATFORM_ORG_ID} for genuinely cross-tenant work.
   */
  readonly orgId?: OrgId;
  /** `audit_log.entity_type`. Defaults to `system`. */
  readonly entityType?: string;
  /** `audit_log.entity_id`, when the block is about one row. */
  readonly entityId?: string;
}

/** Everything a caller may vary that is not configuration. */
export interface DbOptions {
  /**
   * Shows up in `pg_stat_activity` and in Postgres log lines, so a slow query can be
   * attributed to a service without correlating timestamps by hand.
   */
  readonly applicationName?: string;
  /**
   * Called on entry to every {@link withElevated} block, before the transaction opens.
   *
   * ADR-010 grants the job role `BYPASSRLS` and, in exchange, requires every use of that
   * role to be reconstructable afterwards. There are two records and they answer
   * different questions: the `audit_log` row written inside the transaction says what
   * *committed*, and this hook — which fires whether or not the block goes on to
   * succeed — says what was *attempted*. A job that elevated and then rolled back leaves
   * no audit row, and that is correct; it should still be in the log stream.
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
 * The first statement of every {@link withOrg} transaction: it installs the tenant key
 * and, in the same round trip, reports what the connection was already carrying.
 *
 * The `MATERIALIZED` is the whole trick and it is not cosmetic. A target list is
 * evaluated in no guaranteed order, so reading `current_setting` and calling
 * `set_config` as two items of one `SELECT` could read the value this statement is
 * itself writing. Forcing the CTE to be evaluated as its own node puts a fence between
 * them: the tuplestore is filled before the outer target list runs, so `inherited` is
 * unambiguously the value from *before* this transaction. Verified against
 * PostgreSQL 16, the version `docker-compose.yml` pins.
 *
 * `coalesce` folds the two shapes of "clean" into one. A placeholder GUC the session has
 * never touched reads as `NULL`; one whose transaction-local value has been discarded at
 * commit reads back as the empty string. Both mean nobody has claimed this connection.
 */
const SET_ORG = (orgId: OrgId): ReturnType<typeof sql> => sql`
  WITH inherited AS MATERIALIZED (
    SELECT coalesce(current_setting('app.current_org', true), '') AS value
  )
  SELECT inherited.value AS inherited,
         set_config('app.current_org', ${orgId}, true) AS applied
    FROM inherited
`;

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
 *
 * Interleaving is the case this is written for. Two concurrent calls take two
 * connections, and each one's setting lives and dies inside its own transaction, so
 * neither can observe the other's — which is exactly what a naive implementation that
 * sets the variable on the connection gets wrong, and gets wrong only under
 * concurrency. `tests/org-context.test.ts` interleaves them explicitly rather than
 * trusting the argument.
 *
 * @throws {OrgContextLeakError} if the connection arrived carrying someone else's org.
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
    const rows = await tx.execute<{ inherited: string; applied: string }>(SET_ORG(orgId));

    // Fail closed. A one-row CTE cannot return nothing, so this branch is unreachable —
    // but the alternative spelling, `rows[0]?.inherited ?? ''`, treats "I could not tell"
    // as "it was clean", and a tenancy check that fails open on a case nobody expected is
    // how the case nobody expected becomes the incident.
    const first = rows[0];
    if (first === undefined) {
      throw new Error(
        'The statement that establishes tenant context returned no row, so ' +
          'app.current_org cannot be assumed to be set. Refusing to run this query with ' +
          'row-level security in an unknown state.',
      );
    }
    if (first.inherited !== '') {
      throw new OrgContextLeakError();
    }
    return fn(tx);
  });
}

/** {@link Elevation} with every default resolved, ready to become an `audit_log` row. */
interface NormalisedElevation {
  readonly reason: string;
  readonly orgId: OrgId;
  readonly entityType: string;
  /** `null` rather than `undefined`: it is going into a nullable column. */
  readonly entityId: string | null;
}

/** Normalises the two accepted shapes and rejects a reason that would not be findable. */
function normaliseElevation(elevation: string | Elevation): NormalisedElevation {
  const input: Elevation = typeof elevation === 'string' ? { reason: elevation } : elevation;
  const reason = input.reason.trim();

  if (reason === '') {
    throw new Error(
      'withElevated() requires a reason. The job role bypasses row-level security ' +
        '(ADR-010); an elevation nobody recorded is an elevation nobody can explain.',
    );
  }
  if (!JOB_ACTION.test(reason)) {
    throw new Error(
      `withElevated() reason ${JSON.stringify(reason)} is not a job action. It is written ` +
        'verbatim to audit_log.action, where the `job.` prefix is what marks a row whose ' +
        'actor_user_id is null as a machine rather than as an unattributed human. Use ' +
        'job.<verb>, for example job.grade or job.deadline_sweep.',
    );
  }

  return {
    reason,
    orgId: input.orgId ?? PLATFORM_ORG_ID,
    entityType: input.entityType ?? 'system',
    entityId: input.entityId ?? null,
  };
}

/**
 * Runs `fn` as the elevated background-job role, in a transaction, with the reason
 * recorded in `audit_log` by the same transaction.
 *
 * ADR-010 grants this role `BYPASSRLS` because a grading job has no authenticated session
 * behind it and therefore no organisation to put in `app.current_org` — there is no
 * policy that could admit it. What the role owes in return is an audit trail, so:
 *
 * - `reason` is required, must be a `job.`-prefixed action, and is written to
 *   `app.elevation_reason` for the life of the transaction, where `pg_stat_activity` and
 *   any future trigger can see it.
 * - An `audit_log` row is inserted **before `fn` runs and inside `fn`'s transaction**.
 *   Inside, because docs/17 §4 and the P1 plan both want the record to describe what
 *   committed: if `fn` throws, the work and its audit row roll back together and history
 *   does not claim an access that never happened. Before, so the recorded instant is
 *   when the elevation was taken rather than when it finished.
 * - {@link DbOptions.onElevation} is called on entry, outside the transaction, so an
 *   elevation that rolls back still leaves a trace in the log stream.
 *
 * The consequence worth knowing: **an elevated block is always a write transaction**,
 * even when `fn` only reads. That rules out pointing the job role at a read replica, and
 * it is the price of the trail. It is also why `withElevated` is not the convenient
 * default — see below.
 *
 * This is not a general-purpose escape from tenancy. If a job knows which organisation it
 * is acting for — and most do, from the attempt row they just loaded — use
 * {@link withOrg} instead and keep the policies in play.
 */
export async function withElevated<T>(
  db: Database,
  elevation: string | Elevation,
  fn: (tx: DbTransaction) => Promise<T>,
): Promise<T> {
  const { reason, orgId, entityType, entityId } = normaliseElevation(elevation);
  const { jobDb, onElevation, now } = poolsFor(db);

  const at = now();
  onElevation?.({ reason, orgId, at });

  return jobDb.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.elevation_reason', ${reason}, true)`);

    // Through the one writer (`./audit.ts`) rather than through an INSERT of its own.
    // Two INSERTs into one append-only table are two places for the column list to
    // drift, and the elevation row is the one row that must never be the one that got
    // it wrong. The writer also applies the rules this row has always had to satisfy —
    // a `job.` action, a null actor, a non-empty reason — instead of restating them.
    //
    // `after` rather than `before`: nothing changed state yet, and the column that
    // describes the resulting situation is the one a reader expects to hold context.
    // The payload names the role explicitly so a row is self-describing when read back
    // years later, by which time "hiring_job" may not be the only elevated principal.
    // The writer merges `reason` in alongside, which is where 0004's CHECK looks for it.
    await writeAudit(tx, {
      orgId,
      actor: { kind: 'job' },
      action: reason,
      entityType,
      entityId,
      after: { role: 'hiring_job', bypassed_rls: true },
      reason,
      at,
    });

    return fn(tx);
  });
}
