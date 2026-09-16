/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';

import { SESSION_KEY_PREFIX, memorySessionStore, valkeySessionStore } from './session-store.js';
import type { ValkeyClient } from './session-store.js';

/** A Valkey stand-in that records the commands it was given, verbatim. */
function fakeValkey(): ValkeyClient & { readonly commands: string[] } {
  const data = new Map<string, string>();
  const commands: string[] = [];

  const client: ValkeyClient & { readonly commands: string[] } = {
    commands,
    get(key: string): Promise<string | null> {
      commands.push(`GET ${key}`);
      return Promise.resolve(data.get(key) ?? null);
    },
    set(key: string, value: string, mode?: 'EX', seconds?: number): Promise<unknown> {
      commands.push(seconds === undefined ? `SET ${key}` : `SET ${key} ${mode ?? ''} ${seconds}`);
      data.set(key, value);
      return Promise.resolve('OK');
    },
    del(key: string): Promise<unknown> {
      commands.push(`DEL ${key}`);
      return Promise.resolve(data.delete(key) ? 1 : 0);
    },
    getdel(key: string): Promise<string | null> {
      commands.push(`GETDEL ${key}`);
      const value = data.get(key) ?? null;
      data.delete(key);
      return Promise.resolve(value);
    },
    incr(key: string): Promise<number> {
      commands.push(`INCR ${key}`);
      const next = Number.parseInt(data.get(key) ?? '0', 10) + 1;
      data.set(key, String(next));
      return Promise.resolve(next);
    },
  };

  return client;
}

describe('valkeySessionStore', () => {
  it('namespaces every key, so a session cannot collide with a queue or a rate limiter', async () => {
    const client = fakeValkey();
    const store = valkeySessionStore(client);

    await store.set('token', '{}', 60);
    await store.get('token');
    await store.delete('token');

    expect(client.commands).toEqual([
      `SET ${SESSION_KEY_PREFIX}token EX 60`,
      `GET ${SESSION_KEY_PREFIX}token`,
      `DEL ${SESSION_KEY_PREFIX}token`,
    ]);
  });

  it('sets an expiry from the TTL, rounding up rather than down', async () => {
    // Rounding down would expire a session a fraction of a second before Better Auth
    // thinks it should, which is a logout nobody asked for and nobody can reproduce.
    const client = fakeValkey();
    await valkeySessionStore(client).set('token', '{}', 59.2);
    expect(client.commands).toEqual([`SET ${SESSION_KEY_PREFIX}token EX 60`]);
  });

  it('writes without an expiry rather than with a non-positive one', async () => {
    const client = fakeValkey();
    const store = valkeySessionStore(client);

    await store.set('a', '{}');
    await store.set('b', '{}', 0);
    await store.set('c', '{}', -5);

    expect(client.commands).toEqual([
      `SET ${SESSION_KEY_PREFIX}a`,
      `SET ${SESSION_KEY_PREFIX}b`,
      `SET ${SESSION_KEY_PREFIX}c`,
    ]);
  });

  it('answers null for a miss, not undefined', async () => {
    // Better Auth checks for null; the wrong absence makes every session look
    // valid-but-empty.
    await expect(valkeySessionStore(fakeValkey()).get('nothing')).resolves.toBeNull();
  });

  it('uses one command for a single-use read, so two callers cannot both win', async () => {
    const client = fakeValkey();
    const store = valkeySessionStore(client);
    await store.set('once', 'value');

    await expect(store.getAndDelete('once')).resolves.toBe('value');
    await expect(store.getAndDelete('once')).resolves.toBeNull();
    expect(client.commands).toContain(`GETDEL ${SESSION_KEY_PREFIX}once`);
    expect(client.commands.filter((c) => c.startsWith('GET '))).toEqual([]);
  });
});

describe('memorySessionStore', () => {
  it('round-trips a value', async () => {
    const store = memorySessionStore();
    await store.set('k', 'v');
    await expect(store.get('k')).resolves.toBe('v');
    await store.delete('k');
    await expect(store.get('k')).resolves.toBeNull();
  });

  it('expires against the injected clock, not against a timer (ADR-006)', async () => {
    let instant = new Date('2026-10-13T08:00:00.000Z');
    const store = memorySessionStore(() => instant);

    await store.set('k', 'v', 60);
    await expect(store.get('k')).resolves.toBe('v');

    instant = new Date('2026-10-13T08:00:59.000Z');
    await expect(store.get('k')).resolves.toBe('v');

    instant = new Date('2026-10-13T08:01:00.000Z');
    await expect(store.get('k')).resolves.toBeNull();
  });

  it('keeps a value with no TTL indefinitely', async () => {
    let instant = new Date('2026-10-13T08:00:00.000Z');
    const store = memorySessionStore(() => instant);

    await store.set('k', 'v');
    instant = new Date('2030-01-01T00:00:00.000Z');
    await expect(store.get('k')).resolves.toBe('v');
  });

  it('reads and removes in one call', async () => {
    const store = memorySessionStore();
    await store.set('k', 'v');
    await expect(store.getAndDelete('k')).resolves.toBe('v');
    await expect(store.getAndDelete('k')).resolves.toBeNull();
  });

  it('counts up from absent', async () => {
    const store = memorySessionStore();
    await expect(store.increment('n')).resolves.toBe(1);
    await expect(store.increment('n')).resolves.toBe(2);
  });
});
