/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Idempotency by business key.
 *
 * docs/17 §6: "Grading is idempotent by submission id. A replayed job produces an
 * identical result, because at-least-once delivery means replay is normal, not
 * exceptional." ADR-008 makes the same commitment, and RB-01 and RB-02 both rely on it:
 * the runbook's instruction to restart the worker tier mid-window, and its instruction to
 * retry the whole dead-letter queue, are only safe advice if a re-delivered job cannot do
 * its work twice.
 *
 * There are two layers, and both are needed.
 *
 * The first is the job id. Every queue in `queues.ts` declares the business key its job
 * id is set to — `submission_id`, `delivery_id`, `job_key:scheduled_for` — and BullMQ
 * refuses to enqueue a second job with an id that already exists. That stops a duplicate
 * *enqueue*.
 *
 * The second is this module. It stops a duplicate *execution*: a job that ran, wrote its
 * effect, and was then redelivered because the worker died before acknowledging it. The
 * completed result is recorded under the business key, and a later run with the same key
 * returns the record instead of running the effect again.
 *
 * What it deliberately does not do: a failure records nothing and deletes nothing, so the
 * next delivery re-runs. There is no state in which a job is remembered as "attempted"
 * and therefore skipped, because that state is how a submission ends up ungraded with
 * nothing in the dead-letter queue to show for it.
 */

import { z } from 'zod';

import { idempotentReplay, UNKNOWN_LABEL } from './metrics.js';
import type { QueueName } from './queue-names.js';

/** Namespace for every key this module writes, so the keyspace stays inspectable. */
export const IDEMPOTENCY_KEY_PREFIX = 'assaybank:idem:';

/**
 * How long a completed result is remembered, in seconds.
 *
 * Twenty-four hours: comfortably longer than the webhook retry window (docs/09 §5.2),
 * which is the longest interval over which a redelivery of the same business key is
 * plausible, and short enough that the keyspace does not grow without bound.
 */
export const DEFAULT_IDEMPOTENCY_TTL_SECONDS = 86_400;

/** Keys longer than this are a bug in the caller, not a long key. */
export const MAX_IDEMPOTENCY_KEY_CHARS = 512;

/** Thrown when a business key is missing or malformed. Always a programming error. */
export class IdempotencyKeyError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'IdempotencyKeyError';
  }
}

/**
 * Where completed results are recorded.
 *
 * Deliberately three methods over strings: it is satisfied by Valkey in a deployed tier
 * and by a map in a test, and nothing in this module needs a Redis client type.
 */
export interface IdempotencyStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  delete(key: string): Promise<void>;
}

/**
 * An in-process store. The default, and correct for a single-replica development stack
 * and for tests; a deployed tier installs the Valkey-backed store at boot, because a
 * result remembered in one replica's heap is not remembered by the replica that picks up
 * the redelivery.
 */
export class MemoryIdempotencyStore implements IdempotencyStore {
  private readonly entries = new Map<string, { value: string; expiresAtMs: number }>();

  /** `now` is injected: an expiry that reads the wall clock cannot be tested (docs/17 §8). */
  public constructor(private readonly now: () => number = Date.now) {}

  public get(key: string): Promise<string | null> {
    const entry = this.entries.get(key);
    if (entry === undefined) return Promise.resolve(null);
    if (entry.expiresAtMs <= this.now()) {
      this.entries.delete(key);
      return Promise.resolve(null);
    }
    return Promise.resolve(entry.value);
  }

  public set(key: string, value: string, ttlSeconds: number): Promise<void> {
    this.entries.set(key, { value, expiresAtMs: this.now() + ttlSeconds * 1000 });
    return Promise.resolve();
  }

  public delete(key: string): Promise<void> {
    this.entries.delete(key);
    return Promise.resolve();
  }

  /** Number of live entries. For tests and for the development `/metrics` page. */
  public get size(): number {
    return this.entries.size;
  }

  public clear(): void {
    this.entries.clear();
  }
}

/**
 * The slice of a Redis client this module needs, described structurally so that
 * `ioredis` satisfies it without this file importing a client library.
 */
export interface IdempotencyRedisClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, secondsToken: 'EX', seconds: number): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

/** A store backed by Valkey, shared by every worker replica. */
export function createRedisIdempotencyStore(client: IdempotencyRedisClient): IdempotencyStore {
  return {
    get(key: string): Promise<string | null> {
      return client.get(key);
    },
    async set(key: string, value: string, ttlSeconds: number): Promise<void> {
      await client.set(key, value, 'EX', Math.max(1, Math.floor(ttlSeconds)));
    },
    async delete(key: string): Promise<void> {
      await client.del(key);
    },
  };
}

let ambientStore: IdempotencyStore = new MemoryIdempotencyStore();

/** Installs the process-wide store. Called once, at boot, before any worker starts. */
export function setIdempotencyStore(store: IdempotencyStore): void {
  ambientStore = store;
}

/** The process-wide store. */
export function getIdempotencyStore(): IdempotencyStore {
  return ambientStore;
}

/**
 * Restores the default in-memory store and clears any in-flight bookkeeping. Tests call
 * this between cases; nothing else should.
 */
export function resetIdempotency(): void {
  ambientStore = new MemoryIdempotencyStore();
  inFlight.clear();
}

/** The recorded result, wrapped so that a function returning `undefined` is still a record. */
const RecordSchema = z.object({ v: z.unknown().optional() });

/** Options for {@link idempotent}. */
export interface IdempotentOptions<T> {
  /** Defaults to the process-wide store. */
  readonly store?: IdempotencyStore | undefined;
  readonly ttlSeconds?: number | undefined;
  /** Labels the replay counter. Omitted outside a job. */
  readonly queue?: QueueName | undefined;
  /**
   * Turns a recorded value back into `T`.
   *
   * A record read back out of Valkey is `unknown` — it was written by some earlier
   * release of this process and JSON has lost every type it ever had. Supplying a decoder
   * (a zod `parse`, usually) makes the replay path as well-typed as the first run.
   * Without one the recorded value is returned as `T` on the caller's word, which is
   * adequate for a result the caller only logs and wrong for one it branches on.
   */
  readonly decode?: ((value: unknown) => T) | undefined;
}

/**
 * In-process single-flight. Two concurrent calls with the same key inside one worker —
 * the ordinary case when concurrency is greater than one and a producer enqueued twice —
 * share one execution rather than racing to the store.
 */
const inFlight = new Map<string, Promise<unknown>>();

/**
 * Runs `fn` at most once per business key.
 *
 * ```ts
 * const result = await idempotent(`grade:${submissionId}`, () => gradeSubmission(...));
 * ```
 *
 * Returns the recorded result when the key has already completed, and runs `fn` and
 * records its result otherwise. A throw propagates and records nothing, so the next
 * delivery of the same job runs the effect again — at-least-once, which is the guarantee
 * the queue provides and the only one worth building on.
 */
export async function idempotent<T>(
  key: string,
  fn: () => Promise<T>,
  options: IdempotentOptions<T> = {},
): Promise<T> {
  const storageKey = IDEMPOTENCY_KEY_PREFIX + assertBusinessKey(key);
  const store = options.store ?? getIdempotencyStore();
  const ttlSeconds = options.ttlSeconds ?? DEFAULT_IDEMPOTENCY_TTL_SECONDS;
  const queueLabel: string = options.queue ?? UNKNOWN_LABEL;

  const pending = inFlight.get(storageKey);
  if (pending !== undefined) {
    idempotentReplay.inc({ queue: queueLabel, outcome: 'replayed' });
    // The in-flight promise already resolves to this call's own result — it is the same
    // key, and one key used with two different result types is a caller bug — so the
    // decoder, which exists for values that made a round trip through JSON, is not run.
    const shared: unknown = await pending;
    return decodeRecorded(shared, undefined);
  }

  const run = (async (): Promise<T> => {
    const recorded = await store.get(storageKey);
    const revived = recorded === null ? undefined : reviveRecord(recorded);

    if (revived !== undefined) {
      idempotentReplay.inc({ queue: queueLabel, outcome: 'replayed' });
      return decodeRecorded(revived.value, options.decode);
    }

    const result = await fn();
    await store.set(storageKey, JSON.stringify({ v: result }), ttlSeconds);
    idempotentReplay.inc({ queue: queueLabel, outcome: 'executed' });
    return result;
  })();

  inFlight.set(storageKey, run);
  try {
    return await run;
  } finally {
    inFlight.delete(storageKey);
  }
}

/**
 * Validates a business key.
 *
 * An empty or whitespace-bearing key is rejected rather than normalised: a key built from
 * an `undefined` id stringifies to something plausible, and silently accepting it would
 * make every job with a missing id share one idempotency record.
 */
export function assertBusinessKey(key: string): string {
  if (typeof key !== 'string' || key.length === 0) {
    throw new IdempotencyKeyError('an idempotency key must be a non-empty string');
  }
  if (key.length > MAX_IDEMPOTENCY_KEY_CHARS) {
    throw new IdempotencyKeyError(
      `an idempotency key must be at most ${String(MAX_IDEMPOTENCY_KEY_CHARS)} characters; ` +
        `this one is ${String(key.length)}. A key that long is carrying content, not an identity.`,
    );
  }
  if (/\s/u.test(key)) {
    throw new IdempotencyKeyError(
      `an idempotency key must not contain whitespace: ${JSON.stringify(key)}`,
    );
  }
  if (key.split(':').some((segment) => segment === 'undefined' || segment === 'null')) {
    throw new IdempotencyKeyError(
      `the idempotency key ${JSON.stringify(key)} has a segment that is "undefined" or "null", ` +
        'which means an identifier was missing when it was built. Every job with that missing ' +
        'identifier would share one record.',
    );
  }
  return key;
}

/**
 * Parses a stored record. A record that cannot be parsed is treated as absent, so the
 * effect runs again: the function is idempotent by construction, and re-running it is
 * strictly safer than returning a value whose shape nothing has checked.
 */
function reviveRecord(raw: string): { value: unknown } | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }

  const result = RecordSchema.safeParse(parsed);
  if (!result.success) return undefined;
  return { value: result.data.v };
}

/**
 * Hands a recorded value back to the caller.
 *
 * The one place in this module where `unknown` becomes `T` without a runtime check, and
 * it is confined here on purpose. A caller that branches on the result passes `decode`
 * and gets a real parse; a caller that only logs it accepts the assertion.
 */
function decodeRecorded<T>(value: unknown, decode: ((value: unknown) => T) | undefined): T {
  return decode === undefined ? (value as T) : decode(value);
}
