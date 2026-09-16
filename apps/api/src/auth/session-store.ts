/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Where staff sessions live: Valkey, keyed by the session token.
 *
 * Better Auth calls this its `secondaryStorage`, which undersells it here — for this
 * deployment it is the *only* session storage, because `storeSessionInDatabase` is off.
 * The reason is tenancy rather than speed: a session row in Postgres would have to be read
 * before the organisation is known, in order to discover the organisation, and the only
 * ways to read it are a request-path role that bypasses row-level security or a
 * policy-free table. Valkey has no policies to bypass and the blob it stores already
 * carries the user's `orgId`, so resolving a cookie touches no tenant row at all.
 * `packages/db/src/schema/staff-identity.ts` has the full argument.
 *
 * **This interface is not an abstraction over Better Auth.** It is Better Auth's own
 * `SecondaryStorage` shape, restated here so this workspace can name it without exporting
 * the library's type through five signatures — and it is the one place a second
 * implementation genuinely exists, because the unit suite needs a store that is not a
 * network service (docs/17 §8). Two real implementations is the bar for an interface;
 * everything else in this directory has one.
 *
 * **Keys and values are opaque.** Better Auth chooses both: a session token, or
 * `active-sessions-<userId>`. Nothing here parses either, so nothing here can be wrong
 * about the format when the library changes it.
 *
 * **Expiry is the store's job, not a sweep's.** Every `set` carries a TTL, so an expired
 * session disappears without anything having to run. That is the property that makes
 * "sessions are not in Postgres" cheap: there is no retention policy to write and no
 * table that grows between sweeps.
 */

/**
 * The storage contract Better Auth expects.
 *
 * `get` returns `null` for a miss rather than `undefined`, which is what the library
 * checks for; returning the wrong absence would make every session look valid-but-empty.
 */
export interface SessionStore {
  get(key: string): Promise<string | null>;
  /** `ttl` is in seconds, and is absent for the handful of values that do not expire. */
  set(key: string, value: string, ttl?: number): Promise<void>;
  delete(key: string): Promise<void>;
  /**
   * Reads a value and removes it in one step.
   *
   * Better Auth uses it for single-use material — a one-time token is redeemed by the
   * first caller to read it, and two callers reading before either deletes is the double
   * redemption. The Valkey implementation therefore uses `GETDEL`, a single command, so
   * atomicity is the server's problem rather than a race between two round trips.
   */
  getAndDelete(key: string): Promise<string | null>;
  /**
   * Adds one to a counter and returns the new value.
   *
   * Better Auth's own rate limiter uses it. This API does not enable that limiter — the
   * limits of docs/03 §2 are enforced in `../rate-limit.ts`, and two limiters on one route
   * means two ceilings and one of them wrong — but the method has to exist for the
   * contract to be satisfied, and an implementation that works is better than one that
   * throws if the library ever reaches for it.
   */
  increment(key: string): Promise<number>;
}

/**
 * The minimum of `ioredis` this module uses.
 *
 * Structural, so `new Redis(url)` satisfies it without this file importing the client —
 * which keeps the unit suite free of a driver it never connects with, and keeps the
 * import graph honest about who actually opens a socket.
 */
export interface ValkeyClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
  set(key: string, value: string, mode: 'EX', seconds: number): Promise<unknown>;
  del(key: string): Promise<unknown>;
  getdel(key: string): Promise<string | null>;
  incr(key: string): Promise<number>;
}

/**
 * The prefix every key this store writes carries.
 *
 * Valkey is shared with the queues and the rate limiters (docs/02 §3), so an unprefixed
 * `del` on a token-shaped key would be one collision away from deleting a job. It also
 * makes `KEYS assaybank:staff-session:*` a usable incident tool.
 */
export const SESSION_KEY_PREFIX = 'assaybank:staff-session:';

/** Sessions in Valkey, for every tier that has one. */
export function valkeySessionStore(client: ValkeyClient): SessionStore {
  const namespaced = (key: string): string => `${SESSION_KEY_PREFIX}${key}`;

  return {
    get(key) {
      return client.get(namespaced(key));
    },
    async set(key, value, ttl) {
      // A TTL of zero or less would mean "expire immediately", which for a session Better
      // Auth has just decided is valid is a logout the user did not ask for. Writing it
      // without expiry and letting the session's own `expiresAt` decide is the safe
      // direction; the key is bounded either way because every session has one.
      if (ttl !== undefined && ttl > 0) {
        await client.set(namespaced(key), value, 'EX', Math.ceil(ttl));
      } else {
        await client.set(namespaced(key), value);
      }
    },
    async delete(key) {
      await client.del(namespaced(key));
    },
    getAndDelete(key) {
      // One command, so there is no window between the read and the delete for a second
      // caller to read the same single-use value.
      return client.getdel(namespaced(key));
    },
    increment(key) {
      return client.incr(namespaced(key));
    },
  };
}

/**
 * Sessions in a `Map`, for tests.
 *
 * Honours the TTL against an injected clock rather than a timer: `setTimeout` in a test
 * either makes the suite slow or makes it flaky, and ADR-006 makes time a parameter
 * everywhere it is observable. A test that wants to prove a session expired advances the
 * clock; nothing sleeps.
 */
export function memorySessionStore(now: () => Date = () => new Date()): SessionStore & {
  /** The live entries, for a test that wants to assert on what was stored. */
  readonly entries: ReadonlyMap<string, { value: string; expiresAt: number | undefined }>;
} {
  const map = new Map<string, { value: string; expiresAt: number | undefined }>();

  const live = (key: string): { value: string; expiresAt: number | undefined } | undefined => {
    const entry = map.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt !== undefined && entry.expiresAt <= now().getTime()) {
      map.delete(key);
      return undefined;
    }
    return entry;
  };

  return {
    entries: map,
    get(key) {
      return Promise.resolve(live(key)?.value ?? null);
    },
    set(key, value, ttl) {
      map.set(key, {
        value,
        expiresAt: ttl === undefined || ttl <= 0 ? undefined : now().getTime() + ttl * 1000,
      });
      return Promise.resolve();
    },
    delete(key) {
      map.delete(key);
      return Promise.resolve();
    },
    getAndDelete(key) {
      const value = live(key)?.value ?? null;
      map.delete(key);
      return Promise.resolve(value);
    },
    increment(key) {
      const next = Number.parseInt(live(key)?.value ?? '0', 10) + 1;
      map.set(key, { value: String(next), expiresAt: map.get(key)?.expiresAt });
      return Promise.resolve(next);
    },
  };
}
