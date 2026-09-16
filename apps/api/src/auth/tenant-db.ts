/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * How Better Auth's database adapter gets a connection that is already scoped to a
 * tenant.
 *
 * Better Auth's Drizzle adapter is constructed once, at boot, with one database handle;
 * it then calls `db.select()`, `db.insert()`, `db.update()` and `db.delete()` whenever an
 * endpoint needs a row. ADR-010 requires every one of those statements to run inside a
 * transaction that has already set `app.current_org`, and `@assaybank/db` exports no raw
 * connection at all — `withOrg` and `withElevated` are the entire query surface, and the
 * pools are private on purpose.
 *
 * The two facts are reconciled here, in about thirty lines: the adapter is handed a
 * **forwarder**, not a connection. Each of the four methods looks up the transaction the
 * current async context is running in and calls the same method on it. A route therefore
 * writes
 *
 * ```ts
 * await withOrg(db, orgId, (tx) => inTenantContext(tx, () => auth.api.signInEmail(…)));
 * ```
 *
 * and every statement Better Auth issues inside that call — however deep, however many —
 * lands in that transaction, under that organisation's policies, and commits or rolls
 * back with it.
 *
 * **This is not an abstraction over Better Auth.** It abstracts nothing about
 * authentication; there is no interface a second identity library could implement here
 * and no strategy to select. It is an adapter over *our own* database handle, and it
 * exists because the library reasonably assumes a connection that is always usable while
 * this system reasonably insists that no connection ever is.
 *
 * **Why AsyncLocalStorage and not a parameter.** There is nowhere to put the parameter.
 * The call is `auth.api.signInEmail(...)`, five frames above the adapter, and the
 * signature in between belongs to a library. `AsyncLocalStorage` is the mechanism Node
 * provides for exactly this shape, and `packages/observability` already uses it to carry
 * the trace id for the same reason.
 *
 * **Why the failure is loud.** A statement issued with no transaction in context does not
 * fall back to anything; it throws {@link TenantContextMissingError}. A fallback would be
 * a connection outside `withOrg`, which is the one thing this file exists to make
 * impossible — and because `app.current_org` would be unset, the policies would deny
 * everything anyway, so the "graceful" version is an empty result set that looks like a
 * wrong password. Failing loudly turns a design error into a stack trace instead of into
 * a support ticket about intermittent login failures.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

import type { DbTransaction } from '@assaybank/db';

/**
 * The four query builders Better Auth's Drizzle adapter reaches for.
 *
 * Narrowed from `DbTransaction` with `Pick` rather than restated, so the forwarder cannot
 * drift from the transaction's real signatures, and so the forwarder is incapable of
 * exposing `execute`, `transaction` or anything else the adapter has no business calling.
 */
export type TenantQueryApi = Pick<DbTransaction, 'select' | 'insert' | 'update' | 'delete'>;

/**
 * The names of {@link TenantQueryApi}'s members, as values.
 *
 * `satisfies readonly (keyof TenantQueryApi)[]` is the whole point: adding a method to
 * the `Pick` above without adding it here — or the reverse — is a compile error, so the
 * forwarder cannot end up silently missing one of the four and passing the adapter an
 * object whose `delete` is `undefined`.
 */
const FORWARDED_METHODS = [
  'select',
  'insert',
  'update',
  'delete',
] as const satisfies readonly (keyof TenantQueryApi)[];

/**
 * Thrown when Better Auth issues a statement outside {@link inTenantContext}.
 *
 * Always a defect in this repository rather than anything a client did, so it is not an
 * `ApiError`: it reaches the global handler as an unrecognised throw and becomes the
 * fixed `internal` envelope, with the real cause in the log under the request's trace id.
 * A caller learns nothing, which is correct — there is nothing about our transaction
 * management that a caller should learn.
 */
export class TenantContextMissingError extends Error {
  override readonly name = 'TenantContextMissingError';

  constructor() {
    super(
      'Better Auth issued a database statement with no tenant transaction in scope. Every ' +
        'call into auth.api.* that can touch a row must be wrapped in ' +
        'withOrg(db, orgId, (tx) => inTenantContext(tx, …)), because ADR-010 requires ' +
        'app.current_org to be set inside the transaction the statement runs in. Refusing ' +
        'to run it unscoped.',
    );
  }
}

const TENANT_TRANSACTION = new AsyncLocalStorage<DbTransaction>();

/**
 * Runs `fn` with `tx` as the transaction every Better Auth statement will use.
 *
 * Nests safely: an inner call replaces the transaction only for its own subtree, which is
 * what makes a rotation inside a login — two `withOrg` blocks in one request — behave the
 * way it reads.
 */
export function inTenantContext<T>(tx: DbTransaction, fn: () => Promise<T>): Promise<T> {
  return TENANT_TRANSACTION.run(tx, fn);
}

/**
 * The transaction in scope, or a throw.
 *
 * Exported for the tests that assert the failure mode; route code should not need it.
 */
export function currentTenantTransaction(): DbTransaction {
  const tx = TENANT_TRANSACTION.getStore();
  if (tx === undefined) throw new TenantContextMissingError();
  return tx;
}

/**
 * The object handed to `drizzleAdapter(...)`.
 *
 * Created once and shared, because it holds no state: every call resolves the
 * transaction afresh from the async context, so two concurrent requests using this same
 * object reach two different transactions without knowing about each other. That is the
 * property ADR-010's "per checkout, never per connection" rule is really asking for.
 */
export function tenantScopedDb(): TenantQueryApi {
  const forwarder: Record<string, (...args: unknown[]) => unknown> = {};

  for (const name of FORWARDED_METHODS) {
    forwarder[name] = (...args: unknown[]): unknown => {
      // Drizzle's builders are overloaded several ways over their argument types, and a
      // forwarder cannot be written to preserve that without restating every overload.
      // The cast is confined to this one line, the method name comes from a `const`
      // tuple derived from the narrowed type above, and the arguments are passed through
      // untouched, so the only thing being asserted is "calling `tx.select` with
      // `select`'s arguments returns what `select` returns".
      const tx = currentTenantTransaction() as unknown as Record<
        string,
        (...a: unknown[]) => unknown
      >;
      return tx[name]?.(...args);
    };
  }

  return forwarder as unknown as TenantQueryApi;
}
