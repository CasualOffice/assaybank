/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The forwarder's three properties, none of which needs a database.
 *
 * What a real connection would add here is nothing: the question is whether a statement
 * reaches the transaction the current async context is in, and a stub transaction answers
 * that more precisely than a real one — it can be identified. `test/integration/` proves
 * the other half, that the transaction it reaches is genuinely scoped to an organisation.
 */

import { describe, expect, it } from 'vitest';

import type { DbTransaction } from '@assaybank/db';

import {
  TenantContextMissingError,
  currentTenantTransaction,
  inTenantContext,
  tenantScopedDb,
} from './tenant-db.js';

/**
 * A transaction-shaped object that records what was asked of it.
 *
 * Cast through `unknown` because `DbTransaction` is a large Drizzle type and the four
 * methods under test are the whole of what the forwarder touches — restating the rest
 * would be restating Drizzle.
 */
function stubTx(label: string): { tx: DbTransaction; calls: string[] } {
  const calls: string[] = [];
  const record =
    (method: string) =>
    (...args: unknown[]): string => {
      calls.push(`${method}(${args.length})`);
      return label;
    };

  const tx = {
    select: record('select'),
    insert: record('insert'),
    update: record('update'),
    delete: record('delete'),
  } as unknown as DbTransaction;

  return { tx, calls };
}

describe('currentTenantTransaction', () => {
  it('throws outside a tenant context rather than falling back to anything', () => {
    expect(() => currentTenantTransaction()).toThrow(TenantContextMissingError);

    // The message is for a developer reading a stack trace, so it names the fix.
    expect(() => currentTenantTransaction()).toThrow(/withOrg/);
  });

  it('returns the transaction the current context was entered with', async () => {
    const { tx } = stubTx('a');
    await inTenantContext(tx, () => {
      expect(currentTenantTransaction()).toBe(tx);
      return Promise.resolve();
    });
  });
});

describe('tenantScopedDb', () => {
  it('forwards every method Better Auth uses to the transaction in scope', async () => {
    const { tx, calls } = stubTx('a');
    const db = tenantScopedDb();

    await inTenantContext(tx, () => {
      db.select();
      db.insert({} as never);
      db.update({} as never);
      db.delete({} as never);
      return Promise.resolve();
    });

    expect(calls).toEqual(['select(0)', 'insert(1)', 'update(1)', 'delete(1)']);
  });

  it('throws rather than issuing a statement with no tenant context (ADR-010)', () => {
    // The "graceful" alternative would be a connection outside withOrg, where
    // app.current_org is unset and every policy denies — an empty result set that looks
    // exactly like a wrong password.
    const db = tenantScopedDb();
    expect(() => db.select()).toThrow(TenantContextMissingError);
  });

  it('keeps two interleaved contexts apart on one shared forwarder', async () => {
    // The case a naive implementation passes sequentially and fails under load: the
    // forwarder is a single shared object, so if it held a transaction rather than
    // resolving one, request B would issue its statements into request A's transaction.
    const a = stubTx('a');
    const b = stubTx('b');
    const db = tenantScopedDb();

    const release: (() => void)[] = [];
    const barrier = new Promise<void>((resolve) => release.push(resolve));

    const first = inTenantContext(a.tx, async () => {
      db.select();
      await barrier;
      db.insert({} as never);
    });

    const second = inTenantContext(b.tx, () => {
      db.select();
      db.insert({} as never);
      release[0]?.();
      return Promise.resolve();
    });

    await Promise.all([first, second]);

    expect(a.calls).toEqual(['select(0)', 'insert(1)']);
    expect(b.calls).toEqual(['select(0)', 'insert(1)']);
  });

  it('nests, so a rotation inside a login sees the inner transaction', async () => {
    const outer = stubTx('outer');
    const inner = stubTx('inner');
    const db = tenantScopedDb();

    await inTenantContext(outer.tx, async () => {
      db.select();
      await inTenantContext(inner.tx, () => {
        db.select();
        return Promise.resolve();
      });
      db.insert({} as never);
    });

    expect(outer.calls).toEqual(['select(0)', 'insert(1)']);
    expect(inner.calls).toEqual(['select(0)']);
  });
});
