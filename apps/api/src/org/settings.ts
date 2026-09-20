/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Reading and changing one organisation's settings row, inside a transaction somebody
 * else opened.
 *
 * Both functions take a {@link DbTransaction} and neither takes a `Database`. That is
 * the same signature-level guarantee `@assaybank/db`'s audit writer makes, for the same
 * reason: the only way to obtain a transaction is from inside `withOrg`, so a settings
 * read cannot happen outside an organisation's context and a settings write cannot
 * happen outside the transaction that records it. There is deliberately no convenience
 * overload that takes the pool.
 *
 * The shaping of the document — what a stored blob means, what a partial change does to
 * it — is pure and lives with the schema in `@assaybank/contracts`. What is left here is
 * the part that genuinely needs a database: which row, under which lock, and what to do
 * when the policy admits none.
 *
 * ## Three defences, in this order
 *
 * 1. **Row-level security.** `withOrg` sets `app.current_org` transaction-locally and the
 *    `organizations` policy is `id = app_current_org()` (migration 0002, A.1). One row is
 *    visible and it is this tenant's; an `UPDATE` aimed at another organisation's id
 *    finds nothing to change, because from inside this transaction there is nothing there.
 * 2. **The predicate.** The statements below still say `WHERE id = :orgId`. It is not the
 *    guarantee and does not pretend to be — it states which row is meant, so a reader can
 *    see the intent, and it keeps the plan an index lookup. CLAUDE.md rule 8 forbids the
 *    filter *as the only defence*, which is not the same as forbidding the filter.
 * 3. **The projection.** `projectOrgSettings` builds the response from named fields, so
 *    the schemaless column cannot serve a key nobody remembers writing.
 *
 * ## Why the read takes a row lock on the write path
 *
 * A `PATCH` is a read-modify-write over a document: the new value is the stored one
 * merged with the caller's partial. Two administrators changing different fields at the
 * same instant would otherwise both read the old document, and the second write would
 * discard the first change — a lost update that nothing in either response, either audit
 * row or the log would reveal, because both requests succeeded and both records are
 * internally consistent. `SELECT … FOR UPDATE` serialises the pair, at the cost of one
 * clause on an endpoint nobody calls in a loop.
 */

import { eq } from 'drizzle-orm';

import {
  ApiError,
  OrgIdSchema,
  OrgSettingsSchema,
  projectOrgSettings,
  type OrgId,
  type OrgSettings,
} from '@assaybank/contracts';
import { organizations, type DbTransaction } from '@assaybank/db';

/** The organisation row this endpoint works with, as it exists in the database. */
export interface StoredOrg {
  readonly id: OrgId;
  readonly name: string;
  readonly slug: string;
  /**
   * The `settings` column exactly as stored, unparsed.
   *
   * Carried alongside the projection because a `PATCH` has to write back the keys this
   * build does not know about rather than dropping them. A future feature storing its own
   * key in this column — or an older release that stored one — must survive an
   * administrator changing a logo, and the only way to be sure of that is to carry the
   * original document through the merge.
   */
  readonly stored: Record<string, unknown>;
  /** The stored document as this build understands it. */
  readonly settings: OrgSettings;
}

/** True for a plain JSON object. `jsonb` can hold a scalar or an array just as happily. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** How a row is read: plainly, or with the lock a read-modify-write needs. */
export interface ReadOrgOptions {
  /** `true` on the `PATCH` path. See the module comment. */
  readonly forUpdate?: boolean | undefined;
}

/**
 * The organisation this transaction is scoped to, or `undefined`.
 *
 * `undefined` rather than a thrown error, because the caller decides what absence means —
 * and on this endpoint it means `not_found`, never `forbidden` (ADR-010, docs/14 `H-154`).
 * Absence is genuinely reachable rather than theoretical: a staff session lives in Valkey
 * for eight hours, and an organisation erased under docs/11 §6 takes its rows with it, so
 * a cookie can outlive the tenant it names.
 */
export async function readOrg(
  tx: DbTransaction,
  orgId: OrgId,
  options: ReadOrgOptions = {},
): Promise<StoredOrg | undefined> {
  const query = tx
    .select({
      id: organizations.id,
      name: organizations.name,
      slug: organizations.slug,
      settings: organizations.settings,
    })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);

  const [row] = await (options.forUpdate === true ? query.for('update') : query);
  if (row === undefined) return undefined;

  const stored = isRecord(row.settings) ? row.settings : {};

  return {
    // Parsed rather than cast. The value came out of the database, which is an input like
    // any other (docs/17 §1), and it is the id the *policy* admitted rather than the one
    // the principal claimed — if those two could ever differ, the response should say
    // what the database said.
    id: OrgIdSchema.parse(row.id),
    name: row.name,
    slug: row.slug,
    stored,
    settings: projectOrgSettings(stored),
  };
}

/**
 * Writes a settings document back, preserving whatever else the column held.
 *
 * The two known sections are replaced and every other top-level key in the stored
 * document is carried across untouched. Dropping them would make this endpoint a
 * destructive write for data it has never heard of, which is the opposite of what
 * expand-contract asks for (docs/17 §4): a release that adds a key to this column must
 * survive an administrator changing a logo while a older replica is still serving.
 *
 * A row count other than one aborts the transaction. It cannot happen after a successful
 * `readOrg` under `FOR UPDATE` in the same transaction, and it is checked anyway: a
 * silent no-op `UPDATE` that still wrote its audit row would put a change into a
 * seven-year record that the database never made.
 */
export async function writeOrgSettings(
  tx: DbTransaction,
  org: StoredOrg,
  next: OrgSettings,
): Promise<void> {
  const document = {
    ...org.stored,
    branding: next.branding,
    proctoring_defaults: next.proctoring_defaults,
  };

  const changed = await tx
    .update(organizations)
    .set({ settings: document })
    .where(eq(organizations.id, org.id))
    .returning({ id: organizations.id });

  if (changed.length !== 1) throw ApiError.internal();
}

/**
 * Re-parses a merged document, as the last check before it is written and served.
 *
 * Cheap, and it closes the one gap the projection cannot: `mergeOrgSettings` composes two
 * already-valid objects, so nothing forces the *result* through a schema. Throwing here
 * happens inside the transaction, so a document this build could not serve is never a
 * document this build stored.
 */
export function assertServable(settings: OrgSettings): OrgSettings {
  const parsed = OrgSettingsSchema.safeParse(settings);
  if (!parsed.success) throw ApiError.internal({ cause: parsed.error });
  return parsed.data;
}
