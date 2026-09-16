/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * "Exactly once", for both stores.
 *
 * The Valkey store is asserted on the *command it sends*, not on a mock's return value:
 * the whole security property is that the claim is one `SET … PX … NX`, and a refactor
 * to `GET` then `SET` would pass a behavioural test on a single-threaded fake while
 * being exactly the race docs/14 `T-013` names. The arguments are the assertion.
 */

import { fixedClock } from '@assaybank/auth';
import { describe, expect, it } from 'vitest';

import {
  SINGLE_USE_NAMESPACE,
  memorySingleUseStore,
  singleUseKey,
  valkeySingleUseStore,
  type SetIfAbsentClient,
} from './single-use.js';

const NOW = new Date('2026-10-12T09:00:00.000Z');

/** Records every command, and answers as Valkey would for a key that is or is not set. */
function fakeValkey(): SetIfAbsentClient & {
  readonly calls: unknown[][];
  readonly keys: Set<string>;
} {
  const calls: unknown[][] = [];
  const keys = new Set<string>();

  return {
    calls,
    keys,
    set(key: string, value: string, px: 'PX', ttlMs: number, nx: 'NX'): Promise<string | null> {
      calls.push([key, value, px, ttlMs, nx]);
      if (keys.has(key)) return Promise.resolve(null);
      keys.add(key);
      return Promise.resolve('OK');
    },
  };
}

describe('memorySingleUseStore', () => {
  it('claims a key once and refuses it afterwards', async () => {
    const store = memorySingleUseStore(fixedClock(NOW));

    await expect(store.claim('k', 1000)).resolves.toBe('claimed');
    await expect(store.claim('k', 1000)).resolves.toBe('replayed');
    await expect(store.claim('k', 1000)).resolves.toBe('replayed');
  });

  it('keeps two different keys independent', async () => {
    const store = memorySingleUseStore(fixedClock(NOW));

    await expect(store.claim('a', 1000)).resolves.toBe('claimed');
    await expect(store.claim('b', 1000)).resolves.toBe('claimed');
  });

  it('gives exactly one winner when claims race', async () => {
    const store = memorySingleUseStore(fixedClock(NOW));

    const outcomes = await Promise.all(
      Array.from({ length: 16 }, () => store.claim('contended', 1000)),
    );

    expect(outcomes.filter((outcome) => outcome === 'claimed')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === 'replayed')).toHaveLength(15);
  });

  it('forgets a claim once the credential could no longer have verified', async () => {
    // Driven by the injected clock rather than by a sleep: the entry's retention is a
    // property of the credential's life, and the test asserts the boundary.
    let instant = NOW;
    const store = memorySingleUseStore({ now: (): Date => instant });

    await expect(store.claim('k', 1000)).resolves.toBe('claimed');

    instant = new Date(NOW.getTime() + 999);
    await expect(store.claim('k', 1000)).resolves.toBe('replayed');

    instant = new Date(NOW.getTime() + 1000);
    await expect(store.claim('k', 1000)).resolves.toBe('claimed');
  });

  it('reports and can drop what it holds', async () => {
    const store = memorySingleUseStore(fixedClock(NOW));

    await store.claim('a', 1000);
    await store.claim('b', 1000);
    expect(store.size).toBe(2);

    store.clear();
    expect(store.size).toBe(0);
  });
});

describe('valkeySingleUseStore', () => {
  it('claims with a single SET … PX … NX, which is what makes it atomic', async () => {
    const client = fakeValkey();
    const store = valkeySingleUseStore(client);

    await expect(store.claim('hash', 65_000)).resolves.toBe('claimed');

    expect(client.calls).toEqual([
      [singleUseKey(SINGLE_USE_NAMESPACE, 'hash'), '1', 'PX', 65_000, 'NX'],
    ]);
  });

  it('reads a null reply as a replay, because NX only refuses when the key exists', async () => {
    const store = valkeySingleUseStore(fakeValkey());

    await expect(store.claim('hash', 1000)).resolves.toBe('claimed');
    await expect(store.claim('hash', 1000)).resolves.toBe('replayed');
  });

  it('namespaces its keys so they can be found and flushed', async () => {
    const client = fakeValkey();
    await valkeySingleUseStore(client, 'test:ns').claim('abc', 1000);

    expect([...client.keys]).toEqual(['test:ns:abc']);
  });

  it('never sends a non-positive expiry, which Valkey rejects outright', async () => {
    const client = fakeValkey();
    await valkeySingleUseStore(client).claim('hash', 0);

    expect(client.calls[0]?.[3]).toBe(1);
  });

  it('propagates a store failure rather than admitting the credential', async () => {
    // Fail closed. An unreachable replay store means single use cannot be guaranteed, and
    // admitting a second connection to a live interview is precisely T-013's failure.
    const store = valkeySingleUseStore({
      set: (): Promise<string | null> => Promise.reject(new Error('valkey is unreachable')),
    });

    await expect(store.claim('hash', 1000)).rejects.toThrow('valkey is unreachable');
  });
});
