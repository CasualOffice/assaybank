/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * ADR-006 — the server owns the clock.
 *
 * Nothing in this module reads a clock. `Clock` is an interface the caller satisfies,
 * which is what makes a deadline test possible without freezing global time and what
 * keeps `core-domain` pure (CODE-GRAPH L2). There is deliberately **no** exported
 * `systemClock` here: the composition root builds `{ now: () => new Date() }` and hands
 * it in, so the one place that touches real time is an app, not the domain.
 *
 * A client-supplied timestamp never reaches any of these functions. The countdown in
 * the browser is display only and is reconciled from `server_time` on every heartbeat.
 */

/** The injected clock. One method, so a test fake is one line. */
export type Clock = { now(): Date };

/** Seven days. A longer attempt is a data-entry error, not an accommodation. */
const MAX_DURATION_SECONDS = 7 * 24 * 60 * 60;

/** 1000% extra time. Far beyond any real accommodation, but finite. */
const MAX_EXTRA_TIME_PCT = 1000;

function assertValidDate(value: Date, label: string): void {
  if (Number.isNaN(value.getTime())) {
    throw new RangeError(`${label} must be a valid Date, received an invalid Date.`);
  }
}

/**
 * The server-computed deadline: `startedAt` plus the duration, extended by any recorded
 * accommodation.
 *
 * `extraTimePct` is a percentage (25 means 25% more time) and may not be negative — an
 * accommodation extends a deadline and can never shorten one. The total is rounded up
 * to a whole second so rounding always favours the candidate.
 *
 * Invalid inputs throw rather than returning a `Result`: a non-positive duration is a
 * malformed assessment that the zod parse at the edge should already have rejected, and
 * silently producing a deadline in the past would score someone zero.
 */
export function computeDeadline(startedAt: Date, durationSeconds: number, extraTimePct = 0): Date {
  assertValidDate(startedAt, 'startedAt');

  if (!Number.isInteger(durationSeconds) || durationSeconds <= 0) {
    throw new RangeError(
      `durationSeconds must be a positive integer, received ${String(durationSeconds)}.`,
    );
  }
  if (durationSeconds > MAX_DURATION_SECONDS) {
    throw new RangeError(
      `durationSeconds must not exceed ${String(MAX_DURATION_SECONDS)}, received ${String(durationSeconds)}.`,
    );
  }
  if (!Number.isFinite(extraTimePct) || extraTimePct < 0) {
    throw new RangeError(
      `extraTimePct must be a finite percentage of zero or more, received ${String(extraTimePct)}.`,
    );
  }
  if (extraTimePct > MAX_EXTRA_TIME_PCT) {
    throw new RangeError(
      `extraTimePct must not exceed ${String(MAX_EXTRA_TIME_PCT)}, received ${String(extraTimePct)}.`,
    );
  }

  const totalSeconds = Math.ceil((durationSeconds * (100 + extraTimePct)) / 100);
  return new Date(startedAt.getTime() + totalSeconds * 1000);
}

/**
 * Whether the deadline has passed, according to the injected clock.
 *
 * Strictly greater than: an action landing on the exact millisecond of the deadline is
 * still inside the window. The boundary is given to the candidate.
 */
export function isPastDeadline(deadlineAt: Date, clock: Clock): boolean {
  assertValidDate(deadlineAt, 'deadlineAt');
  const now = clock.now();
  assertValidDate(now, 'clock.now()');
  return now.getTime() > deadlineAt.getTime();
}

/**
 * Whole seconds left, never negative, rounded up so a partial second still displays as
 * a second. Used for the `server_time`-anchored countdown the client renders; it is not
 * itself an authorisation decision — `isPastDeadline` is.
 */
export function secondsRemaining(deadlineAt: Date, clock: Clock): number {
  assertValidDate(deadlineAt, 'deadlineAt');
  const now = clock.now();
  assertValidDate(now, 'clock.now()');
  return Math.max(0, Math.ceil((deadlineAt.getTime() - now.getTime()) / 1000));
}
