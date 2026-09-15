/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  assertBusinessKey,
  createRedisIdempotencyStore,
  DEFAULT_IDEMPOTENCY_TTL_SECONDS,
  getIdempotencyStore,
  idempotent,
  IDEMPOTENCY_KEY_PREFIX,
  IdempotencyKeyError,
  MAX_IDEMPOTENCY_KEY_CHARS,
  MemoryIdempotencyStore,
  resetIdempotency,
  setIdempotencyStore,
  toJobId,
} from './idempotency.js';
import type { IdempotencyRedisClient, IdempotencyStore } from './idempotency.js';

beforeEach(() => {
  resetIdempotency();
});

afterEach(() => {
  resetIdempotency();
});

describe('idempotent', () => {
  it('runs the effect once and returns its result', async () => {
    const effect = vi.fn(() => Promise.resolve({ graded: true }));
    const result = await idempotent('grade:s1', effect);

    expect(result).toEqual({ graded: true });
    expect(effect).toHaveBeenCalledTimes(1);
  });

  it('returns the recorded result on a redelivery instead of running the effect again', async () => {
    const effect = vi.fn(() => Promise.resolve({ score: 7 }));

    const first = await idempotent('grade:s1', effect);
    const second = await idempotent('grade:s1', effect);

    expect(effect).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });

  it('keeps separate records per business key', async () => {
    const effect = vi.fn((id: string) => Promise.resolve({ id }));

    await idempotent('grade:s1', () => effect('s1'));
    await idempotent('grade:s2', () => effect('s2'));

    expect(effect).toHaveBeenCalledTimes(2);
  });

  it('does not record a failure, so the next delivery runs the effect again', async () => {
    // The guarantee that matters: a job never ends up remembered as "attempted" and
    // therefore skipped, which is how a submission goes ungraded with nothing in the
    // dead-letter queue to show for it.
    let attempts = 0;
    const flaky = (): Promise<string> => {
      attempts += 1;
      return attempts === 1 ? Promise.reject(new Error('transient')) : Promise.resolve('ok');
    };

    await expect(idempotent('grade:s1', flaky)).rejects.toThrow('transient');
    await expect(idempotent('grade:s1', flaky)).resolves.toBe('ok');
    expect(attempts).toBe(2);
  });

  it('shares one execution between concurrent callers with the same key', async () => {
    let started = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const effect = async (): Promise<string> => {
      started += 1;
      await gate;
      return 'done';
    };

    const a = idempotent('grade:s1', effect);
    const b = idempotent('grade:s1', effect);
    release?.();

    await expect(Promise.all([a, b])).resolves.toEqual(['done', 'done']);
    expect(started).toBe(1);
  });

  it('records a result of undefined as a record, not as an absence', async () => {
    const effect = vi.fn(() => Promise.resolve(undefined));

    await idempotent('sweep:tick', effect);
    await idempotent('sweep:tick', effect);

    expect(effect).toHaveBeenCalledTimes(1);
  });

  it('writes under a namespaced key so the keyspace stays inspectable', async () => {
    const store = new MemoryIdempotencyStore();
    await idempotent('grade:s1', () => Promise.resolve(1), { store });
    await expect(store.get(`${IDEMPOTENCY_KEY_PREFIX}grade:s1`)).resolves.toBe('{"v":1}');
  });

  it('honours the store and TTL it is given', async () => {
    const set = vi.fn(() => Promise.resolve());
    const store: IdempotencyStore = {
      get: () => Promise.resolve(null),
      set,
      delete: () => Promise.resolve(),
    };

    await idempotent('grade:s1', () => Promise.resolve('x'), { store, ttlSeconds: 60 });
    expect(set).toHaveBeenCalledWith(`${IDEMPOTENCY_KEY_PREFIX}grade:s1`, '{"v":"x"}', 60);
  });

  it('runs the effect again once the record has expired', async () => {
    let clock = 1_000;
    const store = new MemoryIdempotencyStore(() => clock);
    const effect = vi.fn(() => Promise.resolve('x'));

    await idempotent('grade:s1', effect, { store, ttlSeconds: 10 });
    clock += 11_000;
    await idempotent('grade:s1', effect, { store, ttlSeconds: 10 });

    expect(effect).toHaveBeenCalledTimes(2);
  });

  it('parses a recorded value back through the decoder rather than asserting it', async () => {
    const schema = z.object({ score: z.number() });
    const store = new MemoryIdempotencyStore();

    await idempotent('grade:s1', () => Promise.resolve({ score: 7 }), { store });
    const replayed = await idempotent('grade:s1', () => Promise.resolve({ score: 999 }), {
      store,
      decode: (value: unknown) => schema.parse(value),
    });

    expect(replayed).toEqual({ score: 7 });
  });

  it('re-runs rather than returning a record it cannot parse', async () => {
    const store = new MemoryIdempotencyStore();
    await store.set(`${IDEMPOTENCY_KEY_PREFIX}grade:s1`, 'not json at all', 60);

    const effect = vi.fn(() => Promise.resolve('fresh'));
    await expect(idempotent('grade:s1', effect, { store })).resolves.toBe('fresh');
    expect(effect).toHaveBeenCalledTimes(1);
  });

  it('defaults to the process-wide store', async () => {
    const store = new MemoryIdempotencyStore();
    setIdempotencyStore(store);
    expect(getIdempotencyStore()).toBe(store);

    await idempotent('grade:s1', () => Promise.resolve(1));
    expect(store.size).toBe(1);
  });

  it('defaults the TTL to a day, past the longest plausible redelivery window', () => {
    expect(DEFAULT_IDEMPOTENCY_TTL_SECONDS).toBe(86_400);
  });
});

describe('assertBusinessKey', () => {
  it('accepts an ordinary key', () => {
    expect(assertBusinessKey('grade:4f8c3e1a-0000-4000-8000-000000000000')).toBe(
      'grade:4f8c3e1a-0000-4000-8000-000000000000',
    );
  });

  it('rejects an empty key', () => {
    expect(() => assertBusinessKey('')).toThrow(IdempotencyKeyError);
  });

  it('rejects whitespace, which is a key built by concatenating something unintended', () => {
    expect(() => assertBusinessKey('grade: s1')).toThrow(IdempotencyKeyError);
    expect(() => assertBusinessKey('grade:s1\n')).toThrow(IdempotencyKeyError);
  });

  it('rejects a key with a missing identifier, which would merge unrelated jobs', () => {
    // `grade:${attempt?.id}` with a missing attempt produces exactly this, and every job
    // with a missing id would then share one record.
    expect(() => assertBusinessKey('grade:undefined')).toThrow(IdempotencyKeyError);
    expect(() => assertBusinessKey('grade:null')).toThrow(IdempotencyKeyError);
  });

  it('does not reject a key that merely contains those letters', () => {
    expect(() => assertBusinessKey('import:nullable-columns')).not.toThrow();
  });

  it('rejects a key that is carrying content rather than an identity', () => {
    expect(() => assertBusinessKey('x'.repeat(MAX_IDEMPOTENCY_KEY_CHARS + 1))).toThrow(
      IdempotencyKeyError,
    );
  });

  it('refuses the key before the effect runs', async () => {
    const effect = vi.fn(() => Promise.resolve('x'));
    await expect(idempotent('', effect)).rejects.toThrow(IdempotencyKeyError);
    expect(effect).not.toHaveBeenCalled();
  });
});

describe('the Valkey-backed store', () => {
  it('sets with an expiry, so the keyspace cannot grow without bound', async () => {
    const calls: unknown[][] = [];
    const client: IdempotencyRedisClient = {
      get: () => Promise.resolve(null),
      set: (...args: unknown[]) => {
        calls.push(args);
        return Promise.resolve('OK');
      },
      del: () => Promise.resolve(1),
    };

    const store = createRedisIdempotencyStore(client);
    await store.set('k', 'v', 30);

    expect(calls[0]).toEqual(['k', 'v', 'EX', 30]);
  });

  it('never sets a zero or fractional expiry, which Valkey rejects', async () => {
    const calls: unknown[][] = [];
    const client: IdempotencyRedisClient = {
      get: () => Promise.resolve(null),
      set: (...args: unknown[]) => {
        calls.push(args);
        return Promise.resolve('OK');
      },
      del: () => Promise.resolve(1),
    };

    const store = createRedisIdempotencyStore(client);
    await store.set('k', 'v', 0.4);

    expect(calls[0]).toEqual(['k', 'v', 'EX', 1]);
  });

  it('reads through to the client', async () => {
    const client: IdempotencyRedisClient = {
      get: () => Promise.resolve('{"v":1}'),
      set: () => Promise.resolve('OK'),
      del: () => Promise.resolve(1),
    };
    await expect(createRedisIdempotencyStore(client).get('k')).resolves.toBe('{"v":1}');
  });
});

describe('toJobId', () => {
  it('removes the colon BullMQ rejects in a custom job id', () => {
    expect(toJobId('example.noop:2026-09-16T10:00:00.000Z')).not.toContain(':');
  });

  it('is deterministic, or a replay would enqueue a second copy instead of being refused', () => {
    const key = 'grade:0191f0c2-0000-7000-8000-000000000000';
    expect(toJobId(key)).toBe(toJobId(key));
  });

  it('is injective, or two unrelated jobs would collide and one would be silently dropped', () => {
    // The pair that a naive `replaceAll(':', '%3A')` collapses: escaping `%` first is
    // what keeps these distinct.
    expect(toJobId('a%3Ab')).not.toBe(toJobId('a:b'));
  });

  it('rejects an invalid business key rather than encoding it into something plausible', () => {
    expect(() => toJobId('')).toThrow(IdempotencyKeyError);
  });
});
