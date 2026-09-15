/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * React bindings for {@link CountdownClock}.
 *
 * Everything worth testing lives in `countdown.ts`; this file exists only to attach a
 * store to the render loop and to drive the tick. Keeping it this thin is deliberate —
 * a hook that also does arithmetic is a hook that needs a DOM to test, and the ADR-006
 * invariant is far too important to be verified only through a renderer.
 *
 * The client clock is DISPLAY ONLY. See the header of `countdown.ts`.
 */

import { useEffect, useSyncExternalStore } from 'react';

import type { CountdownClock, CountdownSnapshot, ServerTimeSample } from './countdown';

/**
 * The default monotonic source.
 *
 * `performance.now()` counts from an arbitrary origin and is not settable from the page,
 * so a candidate who changes their machine's clock changes nothing here. `Date.now()`
 * would be settable, which is exactly the failure this module exists to prevent.
 */
export function browserMonotonic(): number {
  return performance.now();
}

/**
 * Take a server-time sample now.
 *
 * Call it at the moment an API response lands, passing that response's `server_time`.
 * The monotonic reading must be taken as close to arrival as possible — the gap between
 * arrival and this call is the estimate's error, and it is small only if the call is
 * immediate.
 */
export function sampleServerTime(
  serverTimeMs: number,
  monotonic: () => number = browserMonotonic,
): ServerTimeSample {
  return { serverTimeMs, receivedAtMs: monotonic() };
}

/** How often the displayed countdown recomputes. */
const DEFAULT_TICK_INTERVAL_MS = 250;

/**
 * Subscribe to a countdown and keep it ticking for as long as the component is mounted.
 *
 * Ticking four times a second rather than once keeps the displayed second from lagging
 * by up to a whole second after a reconciliation, while the snapshot identity check in
 * `CountdownClock` means three of those four ticks re-render nothing.
 *
 * Passing `null` — before the attempt has started, and therefore before the server has
 * issued a deadline — yields `null`. There is no placeholder countdown, because a
 * countdown the server has not authorised is a number this application must not invent.
 */
export function useCountdown(
  clock: CountdownClock | null,
  tickIntervalMs: number = DEFAULT_TICK_INTERVAL_MS,
): CountdownSnapshot | null {
  const snapshot = useSyncExternalStore<CountdownSnapshot | null>(
    clock === null ? subscribeToNothing : clock.subscribe,
    clock === null ? getNullSnapshot : clock.getSnapshot,
    clock === null ? getNullSnapshot : clock.getSnapshot,
  );

  useEffect(() => {
    if (clock === null) return undefined;
    const handle = setInterval(() => {
      clock.tick();
    }, tickIntervalMs);
    return () => {
      clearInterval(handle);
    };
  }, [clock, tickIntervalMs]);

  return snapshot;
}

function subscribeToNothing(): () => void {
  return () => {
    // No store to unsubscribe from.
  };
}

function getNullSnapshot(): null {
  return null;
}
