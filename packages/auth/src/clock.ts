/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The injected clock (ADR-006, docs/17 §8).
 *
 * ADR-006 makes time a correctness boundary rather than a detail: `deadline_at` is
 * computed by the server and the client's countdown is display only. Everything in this
 * package that has an opinion about *now* — token expiry, ticket age — takes a `Clock`
 * and never calls `Date.now()` itself, so an expiry test is a deterministic assertion
 * about an injected instant rather than a sleep.
 *
 * `systemClock` is the one place in this package that reads the wall clock, and the
 * composition root passes it in.
 */

/** A source of the current instant. One method, so a test double is one line. */
export interface Clock {
  /** The current instant, in UTC. */
  now(): Date;
}

/** The real clock. Passed in by a composition root; never reached for implicitly. */
export const systemClock: Clock = Object.freeze({
  now: (): Date => new Date(),
});

/**
 * A clock frozen at `instant`. Exported because every consumer of this package needs one
 * to test its own expiry handling, and a second hand-rolled copy in each workspace would
 * drift from this interface.
 */
export function fixedClock(instant: Date): Clock {
  const frozen = new Date(instant.getTime());
  return Object.freeze({
    now: (): Date => new Date(frozen.getTime()),
  });
}
