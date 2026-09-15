/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The candidate countdown (ADR-006, docs/15 §3.3).
 *
 * ## THE CLIENT CLOCK IS DISPLAY ONLY
 *
 * `deadline_at` is computed once, server-side, at `POST /attempt/start`, from
 * `duration_seconds × (1 + extra_time_pct / 100)`, and is persisted. It is never
 * recomputed from client input, and the only adjustment permitted after start is a
 * recorded `breaks_allowed` accommodation applied by an audited server-side state
 * transition. Nothing in this file may move a deadline; `applyServerDeadline` exists so
 * a *server* response can, and it is the only door.
 *
 * Everything here therefore renders a number that the server already decided. If this
 * module and the server disagree, the server is right and this module is wrong — a
 * candidate whose machine clock is wrong, or who has set it deliberately, sees exactly
 * the same remaining time as everybody else, and an expiry the client renders is a
 * *hint* to submit, never the fact of expiry.
 *
 * ## How that is guaranteed rather than intended
 *
 * The wall clock is never read. Not once, not as a fallback, not in a "close enough"
 * branch. The inputs are:
 *
 *   - `serverTimeMs` — the `server_time` field the API stamps on every response.
 *   - `receivedAtMs` — a reading of a *monotonic* source taken when that response
 *     arrived. `performance.now()` in a browser; anything injectable in a test.
 *   - `monotonicNowMs` — the same monotonic source, read now.
 *
 * Elapsed time is `monotonicNowMs - receivedAtMs`, which is a duration measured by a
 * counter the user cannot set. Adding it to the last known server instant gives an
 * estimate of the server's clock that drifts only by the machine's oscillator, and the
 * drift is erased on the next heartbeat by {@link CountdownClock.reconcile}.
 *
 * `src/time/countdown.test.ts` installs a `Date.now` that throws, so a future edit that
 * reaches for the wall clock fails a test rather than shipping.
 *
 * This module is pure: no React, no I/O, no ambient time. It is a plain store so that
 * the interesting behaviour is testable without a DOM.
 */

/** Milliseconds in the units the thresholds are expressed in. */
const ONE_SECOND_MS = 1_000;
const ONE_MINUTE_MS = 60 * ONE_SECOND_MS;

/**
 * A reading of the server's clock, paired with the monotonic instant it arrived.
 *
 * The pairing is the whole point: a server timestamp on its own goes stale, and a
 * monotonic reading on its own has no epoch. Together they let the client estimate the
 * server's clock without ever consulting its own.
 */
export interface ServerTimeSample {
  /** The `server_time` field of an API response, as epoch milliseconds. */
  readonly serverTimeMs: number;
  /**
   * A monotonic reading (`performance.now()`, or an injected equivalent) taken as close
   * as possible to the moment that response was received. Not an epoch: only
   * differences between readings from the same source are meaningful.
   */
  readonly receivedAtMs: number;
}

/** The inputs of a single remaining-time computation. */
export interface RemainingInputs {
  /** The server-computed deadline, as epoch milliseconds. Never client-derived. */
  readonly deadlineAtMs: number;
  /** The most recent server-time sample. */
  readonly sample: ServerTimeSample;
  /** A monotonic reading taken now, from the same source as `sample.receivedAtMs`. */
  readonly monotonicNowMs: number;
}

/**
 * Milliseconds remaining before the server's deadline, clamped at zero.
 *
 * Pure, total, and free of any ambient clock. A negative result is clamped rather than
 * returned because "minus four minutes remaining" is not a thing to render, and because
 * a clamp keeps the threshold arithmetic below monotonic.
 */
export function remainingMs(inputs: RemainingInputs): number {
  const { deadlineAtMs, sample, monotonicNowMs } = inputs;
  const elapsedSinceSampleMs = monotonicNowMs - sample.receivedAtMs;
  const estimatedServerNowMs = sample.serverTimeMs + elapsedSinceSampleMs;
  const remaining = deadlineAtMs - estimatedServerNowMs;
  return remaining > 0 ? remaining : 0;
}

/**
 * The four moments the candidate is told about (docs/15 §5.2).
 *
 * Every other second of the countdown is deliberately silent: a region that announces
 * each tick renders a screen reader useless, which is why the timer element itself is
 * never `aria-live` (docs/15 §3.3).
 */
export type CountdownThreshold = 'half' | 'ten-minutes' | 'five-minutes' | 'one-minute';

/** The order thresholds are crossed in, most time remaining first. */
export const COUNTDOWN_THRESHOLDS: readonly CountdownThreshold[] = [
  'half',
  'ten-minutes',
  'five-minutes',
  'one-minute',
];

/** Where an announcement goes, per the region architecture in docs/15 §5.1. */
export type AnnouncementRegion = 'polite' | 'assertive';

/** A message bound for one of the two announcement regions. */
export interface Announcement {
  readonly region: AnnouncementRegion;
  readonly message: string;
}

/**
 * The remaining-time value, in milliseconds, at which each threshold fires.
 *
 * `half` depends on the attempt's total duration; the rest are absolute. Returning a
 * number rather than a predicate keeps {@link thresholdsCrossed} a comparison of two
 * numbers, which is the only shape that behaves correctly when a tick skips over a
 * threshold entirely — a backgrounded tab, a slow frame, a long garbage collection.
 */
export function thresholdBoundaryMs(threshold: CountdownThreshold, totalMs: number): number {
  switch (threshold) {
    case 'half':
      return totalMs / 2;
    case 'ten-minutes':
      return 10 * ONE_MINUTE_MS;
    case 'five-minutes':
      return 5 * ONE_MINUTE_MS;
    case 'one-minute':
      return ONE_MINUTE_MS;
  }
}

/**
 * Which thresholds lie strictly between two successive remaining-time readings.
 *
 * A tick that jumps from 11 minutes to 4 minutes — entirely normal when the tab was
 * backgrounded — has crossed both the ten-minute and the five-minute boundary, and the
 * candidate is owed both. Comparing against boundaries rather than testing for equality
 * with a rounded minute is what makes that true.
 */
export function thresholdsCrossed(
  previousRemainingMs: number,
  currentRemainingMs: number,
  totalMs: number,
): readonly CountdownThreshold[] {
  if (currentRemainingMs >= previousRemainingMs) {
    // Time did not advance. A reconciliation may legitimately move the estimate
    // backwards (the local oscillator ran fast); re-announcing on the way back up would
    // announce the same threshold twice.
    return [];
  }
  return COUNTDOWN_THRESHOLDS.filter((threshold) => {
    const boundary = thresholdBoundaryMs(threshold, totalMs);
    return previousRemainingMs > boundary && currentRemainingMs <= boundary;
  });
}

/**
 * The wording and the region for a threshold, taken from the table in docs/15 §5.2.
 *
 * Only the one-minute warning is assertive. Interruption is a cost, and something that
 * interrupts four times in an hour is a warning; something that interrupts every ten
 * seconds is a siren.
 */
export function announcementForThreshold(
  threshold: CountdownThreshold,
  currentRemainingMs: number,
): Announcement {
  switch (threshold) {
    case 'half':
      return {
        region: 'polite',
        message: `Half your time remains: ${formatRemainingForSpeech(currentRemainingMs)}.`,
      };
    case 'ten-minutes':
      return { region: 'polite', message: '10 minutes remaining.' };
    case 'five-minutes':
      return { region: 'polite', message: '5 minutes remaining.' };
    case 'one-minute':
      return {
        region: 'assertive',
        message: '1 minute remaining. Your answers are saved automatically.',
      };
  }
}

/** What the timer region renders. Identity is stable while the displayed second is. */
export interface CountdownSnapshot {
  /** Milliseconds remaining, clamped at zero. */
  readonly remainingMs: number;
  /** Whole seconds remaining, rounded up so "0:01" is never shown for 1 ms. */
  readonly remainingSeconds: number;
  /** True once the client's estimate reaches zero. The server decides the real thing. */
  readonly expired: boolean;
  /** The server-computed deadline currently in force, as epoch milliseconds. */
  readonly deadlineAtMs: number;
  /** The attempt's full duration, used for the 50% threshold. */
  readonly totalMs: number;
}

/** Construction parameters for a {@link CountdownClock}. */
export interface CountdownClockOptions {
  /** The server-computed `deadline_at`, as epoch milliseconds. */
  readonly deadlineAtMs: number;
  /** The server-recorded `started_at`, as epoch milliseconds. Sets the 50% boundary. */
  readonly startedAtMs: number;
  /** The first server-time sample, normally from the `POST /attempt/start` response. */
  readonly sample: ServerTimeSample;
  /** The monotonic source. `() => performance.now()` in a browser. */
  readonly monotonic: () => number;
  /** Called once per threshold crossing, in crossing order. */
  readonly onAnnounce?: ((announcement: Announcement) => void) | undefined;
}

/**
 * A subscribable countdown that never reads the local wall clock.
 *
 * Deliberately a plain class rather than a hook: every rule worth testing — monotonic
 * derivation, heartbeat reconciliation, threshold coalescing, snapshot stability — is
 * testable here without a DOM, and `useCountdown` is then a thin
 * `useSyncExternalStore` wrapper with nothing of its own to get wrong.
 */
export class CountdownClock {
  readonly #monotonic: () => number;
  readonly #onAnnounce: ((announcement: Announcement) => void) | undefined;
  readonly #listeners = new Set<() => void>();
  readonly #totalMs: number;

  #deadlineAtMs: number;
  #sample: ServerTimeSample;
  #snapshot: CountdownSnapshot;

  constructor(options: CountdownClockOptions) {
    this.#monotonic = options.monotonic;
    this.#onAnnounce = options.onAnnounce;
    this.#deadlineAtMs = options.deadlineAtMs;
    this.#sample = options.sample;
    const total = options.deadlineAtMs - options.startedAtMs;
    this.#totalMs = total > 0 ? total : 0;
    this.#snapshot = this.#computeSnapshot();
  }

  /** Register a change listener. Returns the unsubscribe function. */
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  /**
   * The current value. Referentially stable between ticks that do not change the
   * displayed second, which is what keeps `useSyncExternalStore` from re-rendering the
   * shell sixty times a second.
   */
  getSnapshot = (): CountdownSnapshot => this.#snapshot;

  /**
   * Recompute from the monotonic source. Called on an interval by the hook, and
   * directly by tests.
   */
  tick(): void {
    this.#update();
  }

  /**
   * Fold in a fresh `server_time`, which every API response and every heartbeat carries.
   *
   * This is the correction that makes the monotonic estimate safe to run between
   * heartbeats: whatever the local oscillator did in the interval, the next sample
   * replaces the estimate with the server's own reading. Drift cannot accumulate across
   * an hour-long attempt.
   */
  reconcile(sample: ServerTimeSample): void {
    this.#sample = sample;
    this.#update();
  }

  /**
   * Accept a deadline the *server* has moved.
   *
   * The only legitimate caller is a response carrying a new `deadline_at` — a recorded
   * `breaks_allowed` accommodation resumed through an audited server-side transition
   * (ADR-006, docs/15 §3.2). There is deliberately no method that adds time, subtracts
   * time, pauses or resumes: a client that can do arithmetic on a deadline is a client
   * whose arithmetic an auditor has to trust.
   */
  applyServerDeadline(deadlineAtMs: number): void {
    this.#deadlineAtMs = deadlineAtMs;
    this.#update();
  }

  #update(): void {
    const previous = this.#snapshot;
    const next = this.#computeSnapshot();

    if (this.#onAnnounce !== undefined) {
      for (const threshold of thresholdsCrossed(
        previous.remainingMs,
        next.remainingMs,
        this.#totalMs,
      )) {
        this.#onAnnounce(announcementForThreshold(threshold, next.remainingMs));
      }
    }

    const unchanged =
      next.remainingSeconds === previous.remainingSeconds &&
      next.deadlineAtMs === previous.deadlineAtMs &&
      next.expired === previous.expired;
    if (unchanged) {
      // Keep the previous object so subscribers see a stable identity. The sub-second
      // remainder is not rendered, so it is not a change.
      return;
    }

    this.#snapshot = next;
    for (const listener of this.#listeners) listener();
  }

  #computeSnapshot(): CountdownSnapshot {
    const remaining = remainingMs({
      deadlineAtMs: this.#deadlineAtMs,
      sample: this.#sample,
      monotonicNowMs: this.#monotonic(),
    });
    return {
      remainingMs: remaining,
      remainingSeconds: Math.ceil(remaining / ONE_SECOND_MS),
      expired: remaining <= 0,
      deadlineAtMs: this.#deadlineAtMs,
      totalMs: this.#totalMs,
    };
  }
}

/**
 * The visible countdown, as `H:MM:SS` or `M:SS`.
 *
 * Digits only, no colour and no icon carried here: SC 1.4.1 forbids conveying the
 * warning by colour alone, so the warning state is text plus an icon plus this number,
 * assembled by the component.
 */
export function formatRemaining(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / ONE_SECOND_MS));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (value: number): string => String(value).padStart(2, '0');
  return hours > 0
    ? `${String(hours)}:${pad(minutes)}:${pad(seconds)}`
    : `${String(minutes)}:${pad(seconds)}`;
}

/**
 * The same value as words, for the accessible name of the timer.
 *
 * "12:04" is read by screen readers as a time of day, a ratio, or two numbers, depending
 * on the reader and its verbosity setting. A candidate under time pressure should not
 * have to decode that, so the accessible name spells it out and the visible text stays
 * compact.
 */
export function formatRemainingForSpeech(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / ONE_SECOND_MS));
  if (totalSeconds === 0) return 'no time remaining';

  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;

  const parts: string[] = [];
  if (hours > 0) parts.push(`${String(hours)} ${hours === 1 ? 'hour' : 'hours'}`);
  if (minutes > 0) parts.push(`${String(minutes)} ${minutes === 1 ? 'minute' : 'minutes'}`);
  // Seconds are dropped once there is more than an hour left: "1 hour 3 minutes 12
  // seconds" is noise, and the number is available on demand at any moment anyway.
  if (seconds > 0 && hours === 0)
    parts.push(`${String(seconds)} ${seconds === 1 ? 'second' : 'seconds'}`);

  return parts.length > 0 ? parts.join(' ') : 'less than a minute';
}
