/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * "Accepted exactly once", as a check-and-set that no two requests can both win.
 *
 * A signature cannot notice that it has been seen before; only state can. docs/14
 * `T-013` says what that state has to be: *"single-use is the control, and it must be
 * enforced atomically in Valkey — a check-then-delete race under reconnection storms is
 * how single-use quietly becomes multi-use."* `H-148` adds the mechanism: *"ticket
 * redemption is a single atomic Valkey operation."*
 *
 * So the interface has exactly one method, and it is a claim rather than a lookup. There
 * is deliberately no `has()`: a caller holding `has()` writes `if (!has(k)) add(k)`,
 * which is the race the threat model names, and no amount of review reliably catches it
 * once the shape is available.
 *
 * **What is stored is a hash, never the credential.** Callers pass
 * `hashToken(credential, TOKEN_PEPPER)`, so a Valkey dump — or a heap dump of this
 * process — yields no usable credential. That matters most for the WebSocket ticket,
 * which travels in a URL and therefore lands in proxy logs and browser history.
 *
 * **Retention is bounded by the credential's own life.** An entry is kept only as long as
 * the credential could still have verified. Remembering it past that point adds nothing
 * but memory, and a set that grew forever would be a denial-of-service surface reachable
 * by anyone who can ask for a ticket.
 *
 * Two implementations, and they are not a strategy pattern: {@link valkeySingleUseStore}
 * is what runs, and {@link memorySingleUseStore} is the test double plus the honest
 * single-instance fallback. `apps/collab` holds a third, in-process copy for the
 * consuming side of the same ticket (`ticket-store.ts`); P5 moves it onto the same
 * Valkey keys this module writes, which is why the key derivation here is identical to
 * the one there.
 */

import type { Clock } from '@assaybank/auth';

/** What a claim decided. */
export type ClaimOutcome = 'claimed' | 'replayed';

/** The one-method store. See the module comment for why there is no `has`. */
export interface SingleUseStore {
  /**
   * Claims `key` for its one permitted use.
   *
   * Returns `claimed` for the first caller and `replayed` for every other caller within
   * `ttlMs`. Must be atomic: two concurrent claims of the same key produce exactly one
   * `claimed`.
   */
  claim(key: string, ttlMs: number): Promise<ClaimOutcome>;
}

/**
 * The subset of `ioredis` this module uses, spelled out structurally.
 *
 * `SET key value PX ttl NX` is one round trip and one atomic decision at the server:
 * the key is written only if it did not exist, and the reply says which happened. A
 * `GET` followed by a `SET` is the same operation with a window in the middle, and the
 * window is the vulnerability.
 *
 * Declared here rather than imported so that this file does not depend on the driver's
 * types, and so the test double is four lines.
 */
export interface SetIfAbsentClient {
  set(key: string, value: string, px: 'PX', ttlMs: number, nx: 'NX'): Promise<string | null>;
}

/** The key prefix every single-use claim is stored under. */
export const SINGLE_USE_NAMESPACE = 'assaybank:single-use';

/** Builds the stored key. A namespace makes the entries greppable and flushable. */
export function singleUseKey(namespace: string, key: string): string {
  return `${namespace}:${key}`;
}

/**
 * The real store: one `SET … PX … NX` per claim.
 *
 * The stored value is a constant, because the key is the whole record — what is being
 * asserted is "this credential has been seen", and a value would only be something else
 * to keep in sync.
 *
 * A Valkey outage makes `claim` reject rather than resolve. That is the right direction
 * for this particular check: an unavailable replay store means single use cannot be
 * guaranteed, and admitting a second connection to a live interview because the cache
 * was down is precisely the failure `T-013` describes. It is also why this is not the
 * rate limiter, which deliberately fails open — the limiter bounds damage, this one
 * enforces a security property.
 */
export function valkeySingleUseStore(
  client: SetIfAbsentClient,
  namespace: string = SINGLE_USE_NAMESPACE,
): SingleUseStore {
  return {
    async claim(key: string, ttlMs: number): Promise<ClaimOutcome> {
      const reply = await client.set(
        singleUseKey(namespace, key),
        '1',
        'PX',
        Math.max(1, Math.ceil(ttlMs)),
        'NX',
      );
      return reply === null ? 'replayed' : 'claimed';
    },
  };
}

/** A {@link SingleUseStore} that also reports what it is holding. For tests and gauges. */
export interface ObservableSingleUseStore extends SingleUseStore {
  /** How many claims are currently remembered. */
  readonly size: number;
  /** Drops everything. Shutdown, and test isolation. */
  clear(): void;
}

/** How often the in-memory store sweeps expired entries, in milliseconds. */
const SWEEP_INTERVAL_MS = 10_000;

/**
 * The in-process store.
 *
 * Correct for a single instance and honest about being no more than that: with two API
 * replicas behind a load balancer, a credential claimed on A can still be claimed on B.
 * Its other job is to make every test of the surrounding logic run without a container,
 * which is why expiry is driven by the injected {@link Clock} rather than by a timer —
 * a test moves the clock instead of sleeping, and an idle process holds no handle open.
 */
export function memorySingleUseStore(clock: Clock): ObservableSingleUseStore {
  /** key → the instant the entry may be forgotten. */
  const claimed = new Map<string, number>();
  let lastSweep = 0;

  function sweep(now: number): void {
    if (now - lastSweep < SWEEP_INTERVAL_MS) return;
    lastSweep = now;
    for (const [key, expiresAt] of claimed) {
      if (expiresAt <= now) claimed.delete(key);
    }
  }

  return {
    claim(key: string, ttlMs: number): Promise<ClaimOutcome> {
      const now = clock.now().getTime();
      sweep(now);

      const expiresAt = claimed.get(key);
      if (expiresAt !== undefined && expiresAt > now) {
        return Promise.resolve('replayed');
      }

      claimed.set(key, now + Math.max(1, Math.ceil(ttlMs)));
      return Promise.resolve('claimed');
    },
    get size(): number {
      return claimed.size;
    },
    clear(): void {
      claimed.clear();
      lastSweep = 0;
    },
  };
}
