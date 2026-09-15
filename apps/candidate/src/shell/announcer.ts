/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The coalescing announcement queue behind the live regions (docs/15 §5.1).
 *
 * ## The failure this prevents
 *
 * Four things in the runner change without the candidate acting — autosave state, time
 * remaining, execution results arriving from the queue, and queue position. Every one is
 * an SC 4.1.3 status message, and every one, implemented as its own `aria-live`
 * attribute sprinkled where it seemed useful, is a way to make the application unusable
 * with a screen reader by talking constantly. Ad-hoc live regions are how an application
 * ends up announcing four things simultaneously, of which a screen reader reads one at
 * random.
 *
 * So there is one queue, with a budget per region:
 *
 *   - polite: one message per 2 seconds; a superseded message is dropped, not queued.
 *   - assertive: one per 10 seconds. Interruption is a cost. Something that interrupts
 *     every ten seconds is a siren, not a warning.
 *
 * Dropping rather than queueing is the right trade for status: by the time a
 * three-messages-ago update is read out it is no longer true, and a screen-reader user
 * hearing stale state is worse off than one hearing nothing.
 *
 * ## Injected time
 *
 * `now` and `schedule` are parameters. The budgets are the behaviour worth testing, and a
 * rate limiter that reads an ambient clock is a rate limiter tested with real sleeps.
 */

/** The two announcement channels. `route` is separate and unbudgeted; see below. */
export type AnnouncerChannel = 'polite' | 'assertive';

/** What the live regions currently render. */
export interface AnnouncerSnapshot {
  readonly polite: string;
  readonly assertive: string;
}

/** A timer handle, abstracted so tests can inject their own scheduler. */
export type TimerHandle = ReturnType<typeof setTimeout>;

/** Construction parameters for {@link Announcer}. */
export interface AnnouncerOptions {
  /** A monotonic millisecond reading. */
  readonly now: () => number;
  readonly schedule: (callback: () => void, delayMs: number) => TimerHandle;
  readonly cancel: (handle: TimerHandle) => void;
}

/** Minimum gap between announcements, per channel, in milliseconds. */
export const ANNOUNCEMENT_BUDGET_MS: Readonly<Record<AnnouncerChannel, number>> = {
  polite: 2_000,
  assertive: 10_000,
};

const EMPTY: AnnouncerSnapshot = { polite: '', assertive: '' };

/**
 * A rate-limited, coalescing publisher for the two live regions.
 *
 * The regions themselves are mounted once and never removed — see `LiveRegions`. This
 * class only decides what their text content is at any moment.
 */
export class Announcer {
  readonly #options: AnnouncerOptions;
  readonly #listeners = new Set<() => void>();
  readonly #lastEmittedAt: Record<AnnouncerChannel, number> = {
    polite: Number.NEGATIVE_INFINITY,
    assertive: Number.NEGATIVE_INFINITY,
  };
  readonly #pending: Record<AnnouncerChannel, string | null> = { polite: null, assertive: null };
  readonly #timers: Record<AnnouncerChannel, TimerHandle | null> = {
    polite: null,
    assertive: null,
  };

  #snapshot: AnnouncerSnapshot = EMPTY;

  constructor(options: AnnouncerOptions) {
    this.#options = options;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  getSnapshot = (): AnnouncerSnapshot => this.#snapshot;

  /**
   * Offer a message to a channel.
   *
   * If the channel's budget allows it the message is published immediately. Otherwise it
   * replaces whatever was already waiting — the newest state is the only state worth
   * reading — and is published when the budget next permits.
   */
  announce(channel: AnnouncerChannel, message: string): void {
    const elapsed = this.#options.now() - this.#lastEmittedAt[channel];
    const budget = ANNOUNCEMENT_BUDGET_MS[channel];

    if (elapsed >= budget) {
      this.#emit(channel, message);
      return;
    }

    this.#pending[channel] = message;
    if (this.#timers[channel] !== null) return;
    this.#timers[channel] = this.#options.schedule(() => {
      this.#timers[channel] = null;
      const queued = this.#pending[channel];
      this.#pending[channel] = null;
      if (queued !== null) this.#emit(channel, queued);
    }, budget - elapsed);
  }

  /** Cancel pending work. Call from the shell's unmount cleanup. */
  dispose(): void {
    for (const channel of ['polite', 'assertive'] as const) {
      const handle = this.#timers[channel];
      if (handle !== null) this.#options.cancel(handle);
      this.#timers[channel] = null;
      this.#pending[channel] = null;
    }
  }

  #emit(channel: AnnouncerChannel, message: string): void {
    this.#lastEmittedAt[channel] = this.#options.now();
    // A live region whose text is replaced with an identical string is frequently not
    // re-announced, so a repeat of the same message is a no-op rather than a silent
    // surprise. Callers that need a repeat (there are none today) would vary the text.
    if (this.#snapshot[channel] === message) return;
    this.#snapshot =
      channel === 'polite'
        ? { polite: message, assertive: this.#snapshot.assertive }
        : { polite: this.#snapshot.polite, assertive: message };
    for (const listener of this.#listeners) listener();
  }
}

/** An {@link Announcer} wired to the browser's timers. */
export function createBrowserAnnouncer(): Announcer {
  return new Announcer({
    now: () => performance.now(),
    schedule: (callback, delayMs) => setTimeout(callback, delayMs),
    cancel: (handle) => {
      clearTimeout(handle);
    },
  });
}
