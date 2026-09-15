/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { type Clock, hashToken } from '@assaybank/auth';
import { describe, expect, it } from 'vitest';

import { REPLAY_RETENTION_MS, TicketStore } from './ticket-store.js';

/** A clock a test moves by hand. Expiry is an assertion here, never a sleep (ADR-006). */
function movableClock(startMs: number): Clock & { advance(ms: number): void } {
  let current = startMs;
  return {
    now: (): Date => new Date(current),
    advance: (ms: number): void => {
      current += ms;
    },
  };
}

const PEPPER = 'test-pepper';

describe('TicketStore', () => {
  it('claims a ticket once and refuses every later presentation', () => {
    const store = new TicketStore({ pepper: PEPPER, clock: movableClock(1_000) });

    expect(store.claim('abwt1.aaa.bbb')).toBe('claimed');
    expect(store.claim('abwt1.aaa.bbb')).toBe('replayed');
    expect(store.claim('abwt1.aaa.bbb')).toBe('replayed');
  });

  it('treats two different tickets independently', () => {
    const store = new TicketStore({ pepper: PEPPER, clock: movableClock(1_000) });

    expect(store.claim('abwt1.one.sig')).toBe('claimed');
    expect(store.claim('abwt1.two.sig')).toBe('claimed');
    expect(store.size).toBe(2);
  });

  it('stores a peppered hash rather than the ticket', () => {
    // The ticket travels in a URL, so it lands in proxy logs and browser history. What
    // this process keeps must not be a usable credential on its own.
    const store = new TicketStore({ pepper: PEPPER, clock: movableClock(1_000) });
    const ticket = 'abwt1.payload.signature';
    store.claim(ticket);

    expect(store.keys).not.toContain(ticket);
    expect(store.keys).toEqual([hashToken(ticket, PEPPER)]);
  });

  it('forgets a redemption once the ticket could no longer have verified', () => {
    // Remembering longer adds nothing — the signature has expired on its own — and a set
    // that only grows is a denial-of-service surface anyone able to ask for a ticket can
    // reach.
    const clock = movableClock(1_000);
    const store = new TicketStore({ pepper: PEPPER, clock });

    expect(store.claim('abwt1.aaa.bbb')).toBe('claimed');

    clock.advance(REPLAY_RETENTION_MS + 1);

    expect(store.claim('abwt1.aaa.bbb')).toBe('claimed');
    expect(store.size).toBe(1);
  });

  it('still refuses a replay one millisecond before the retention window closes', () => {
    const clock = movableClock(1_000);
    const store = new TicketStore({ pepper: PEPPER, clock });

    store.claim('abwt1.aaa.bbb');
    clock.advance(REPLAY_RETENTION_MS - 1);

    expect(store.claim('abwt1.aaa.bbb')).toBe('replayed');
  });

  it('honours a retention override', () => {
    const clock = movableClock(0);
    const store = new TicketStore({ pepper: PEPPER, clock, retentionMs: 50 });

    store.claim('abwt1.aaa.bbb');
    clock.advance(51);

    expect(store.claim('abwt1.aaa.bbb')).toBe('claimed');
  });

  it('drops everything on clear', () => {
    const store = new TicketStore({ pepper: PEPPER, clock: movableClock(1_000) });
    store.claim('abwt1.aaa.bbb');
    store.clear();

    expect(store.size).toBe(0);
    expect(store.claim('abwt1.aaa.bbb')).toBe('claimed');
  });
});
