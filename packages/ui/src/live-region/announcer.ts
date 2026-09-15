/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The coalescing announcement queue behind the live regions.
 *
 * docs/15 §5.1 gives each region an announcement budget — one polite message per two
 * seconds, one assertive per ten — and says the queue "coalesces and drops superseded
 * messages". This is that queue. It is deliberately a plain class rather than a hook, so
 * that the budget arithmetic is testable without a renderer and so both applications get
 * the same behaviour rather than each re-deriving it.
 *
 * The rule the budget encodes: **interruption is a cost.** Autosave fires within five
 * seconds of the last change (FR-9), so a candidate writing continuously would otherwise
 * hear the application talk over whatever they were reading for the whole assessment.
 * Superseded messages are dropped rather than queued, because the user needs the current
 * state and not a recording of the last four.
 *
 * Time is injected (docs/17 §8). A queue that reads the wall clock is a queue whose tests
 * are either slow or flaky, and P3's timer work needs this to be neither.
 */

/** ARIA politeness of a region. */
export type Politeness = 'polite' | 'assertive';

/** Minimum gap between polite announcements (docs/15 §5.1). */
export const POLITE_INTERVAL_MS = 2_000;

/**
 * Minimum gap between assertive announcements. Something that interrupts every ten
 * seconds is a siren, and a candidate under time pressure is already carrying enough.
 */
export const ASSERTIVE_INTERVAL_MS = 10_000;

/**
 * A route change is announced once per navigation and is not budgeted: navigations are
 * user-initiated and a user who just navigated is waiting to be told where they are
 * (docs/15 §9.1).
 */
export const ROUTE_INTERVAL_MS = 0;

/**
 * A live region that repeats the identical string does not announce it again — the DOM
 * did not change, so there was nothing for the screen reader to notice. Alternating a
 * zero-width space makes the second "1 minute remaining" a real mutation while leaving
 * the spoken text unchanged.
 */
const ZERO_WIDTH_SPACE = '\u200B';

/** Called with the text a region should now contain. */
export type AnnouncementListener = (message: string) => void;

/** Construction options for {@link AnnouncementQueue}. */
export interface AnnouncementQueueOptions {
  /** Minimum gap between emissions, in milliseconds. `0` emits every push immediately. */
  readonly intervalMs: number;
  /** Monotonic-enough clock. Injected so the budget is testable (docs/17 §8). */
  readonly now?: () => number;
  /** Timer scheduler. Injected for the same reason. */
  readonly setTimer?: (callback: () => void, delayMs: number) => unknown;
  /** Timer canceller, paired with `setTimer`. */
  readonly clearTimer?: (handle: unknown) => void;
}

/**
 * A single live region's message queue.
 *
 * At most one message is ever pending. Pushing while one is pending replaces it: the
 * newer message is by definition the current state, and the older one describes a state
 * that has already gone.
 */
export class AnnouncementQueue {
  readonly #intervalMs: number;
  readonly #now: () => number;
  readonly #setTimer: (callback: () => void, delayMs: number) => unknown;
  readonly #clearTimer: (handle: unknown) => void;

  #listeners = new Set<AnnouncementListener>();
  #pending: string | undefined = undefined;
  #timer: unknown = undefined;
  #lastEmittedAt = Number.NEGATIVE_INFINITY;
  #lastEmitted: string | undefined = undefined;

  constructor(options: AnnouncementQueueOptions) {
    this.#intervalMs = options.intervalMs;
    this.#now = options.now ?? (() => Date.now());
    this.#setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.#clearTimer =
      options.clearTimer ??
      ((handle) => {
        clearTimeout(handle as ReturnType<typeof setTimeout>);
      });
  }

  /** Subscribes to emissions. Returns the unsubscribe function. */
  subscribe(listener: AnnouncementListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** True while a message is waiting for the budget to allow it through. */
  get hasPending(): boolean {
    return this.#pending !== undefined;
  }

  /**
   * Offers a message to the region.
   *
   * Emitted straight away when the budget allows, otherwise held as *the* pending
   * message until it does. An empty or whitespace-only message is ignored: it would
   * clear the region without saying anything, which is a bug at every call site that
   * could produce one.
   */
  push(message: string): void {
    const trimmed = message.trim();
    if (trimmed.length === 0) {
      return;
    }

    const elapsed = this.#now() - this.#lastEmittedAt;
    if (elapsed >= this.#intervalMs) {
      this.#emit(trimmed);
      return;
    }

    this.#pending = trimmed;
    if (this.#timer === undefined) {
      this.#timer = this.#setTimer(() => {
        this.#timer = undefined;
        const pending = this.#pending;
        this.#pending = undefined;
        if (pending !== undefined) {
          this.#emit(pending);
        }
      }, this.#intervalMs - elapsed);
    }
  }

  /** Drops anything pending without emitting it. */
  clear(): void {
    this.#pending = undefined;
    if (this.#timer !== undefined) {
      this.#clearTimer(this.#timer);
      this.#timer = undefined;
    }
  }

  /** Drops anything pending and forgets every listener. */
  dispose(): void {
    this.clear();
    this.#listeners = new Set<AnnouncementListener>();
  }

  #emit(message: string): void {
    const text = message === this.#lastEmitted ? `${message}${ZERO_WIDTH_SPACE}` : message;
    this.#lastEmitted = text;
    this.#lastEmittedAt = this.#now();
    for (const listener of this.#listeners) {
      listener(text);
    }
  }
}

/** The minimum gap for a given politeness. */
export function intervalFor(politeness: Politeness): number {
  return politeness === 'assertive' ? ASSERTIVE_INTERVAL_MS : POLITE_INTERVAL_MS;
}
