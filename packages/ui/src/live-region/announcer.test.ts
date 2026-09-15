/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it, vi } from 'vitest';

import {
  AnnouncementQueue,
  ASSERTIVE_INTERVAL_MS,
  intervalFor,
  POLITE_INTERVAL_MS,
  ROUTE_INTERVAL_MS,
} from './announcer.js';

/** The invisible marker AnnouncementQueue alternates so a repeat is a real mutation. */
const ZWSP = '\u200B';

/**
 * A hand-rolled clock and scheduler, injected rather than patched globally.
 *
 * The budget is arithmetic over time, so testing it against the wall clock would make
 * the suite either slow or flaky. docs/17 §8: time is injected, never read.
 */
function harness(intervalMs: number) {
  let now = 0;
  const timers: { at: number; run: () => void }[] = [];
  const heard: string[] = [];

  const queue = new AnnouncementQueue({
    intervalMs,
    now: () => now,
    setTimer: (callback, delayMs) => {
      const timer = { at: now + delayMs, run: callback };
      timers.push(timer);
      return timer;
    },
    clearTimer: (handle) => {
      const index = timers.indexOf(handle as { at: number; run: () => void });
      if (index >= 0) {
        timers.splice(index, 1);
      }
    },
  });

  queue.subscribe((message) => heard.push(message));

  return {
    queue,
    heard,
    /** Advances the clock, firing anything due. */
    advance: (ms: number): void => {
      const target = now + ms;
      for (;;) {
        const due = timers
          .filter((timer) => timer.at <= target)
          .sort((a, b) => a.at - b.at)
          .at(0);
        if (due === undefined) {
          break;
        }
        timers.splice(timers.indexOf(due), 1);
        now = due.at;
        due.run();
      }
      now = target;
    },
  };
}

describe('AnnouncementQueue', () => {
  it('emits the first message immediately', () => {
    const { queue, heard } = harness(POLITE_INTERVAL_MS);

    queue.push('Your answer is saved.');

    expect(heard).toEqual(['Your answer is saved.']);
  });

  it('holds a second message until the budget allows it', () => {
    const { queue, heard, advance } = harness(POLITE_INTERVAL_MS);

    queue.push('Running your code.');
    queue.push('Run complete.');

    expect(heard).toEqual(['Running your code.']);
    expect(queue.hasPending).toBe(true);

    advance(POLITE_INTERVAL_MS);
    expect(heard).toEqual(['Running your code.', 'Run complete.']);
    expect(queue.hasPending).toBe(false);
  });

  it('drops a superseded message rather than queueing it', () => {
    const { queue, heard, advance } = harness(POLITE_INTERVAL_MS);

    queue.push('Saving.');
    queue.push('Saved at 10:01.');
    queue.push('Saved at 10:02.');
    queue.push('Saved at 10:03.');

    advance(POLITE_INTERVAL_MS * 5);

    // The user needs the current state, not a recording of the last four. Announcing
    // every intermediate state is how a screen reader becomes unusable during an
    // assessment where autosave fires every five seconds (FR-9, docs/15 §5.2).
    expect(heard).toEqual(['Saving.', 'Saved at 10:03.']);
  });

  it('emits again immediately once the interval has passed on its own', () => {
    const { queue, heard, advance } = harness(POLITE_INTERVAL_MS);

    queue.push('10 minutes remaining.');
    advance(POLITE_INTERVAL_MS);
    queue.push('5 minutes remaining.');

    expect(heard).toEqual(['10 minutes remaining.', '5 minutes remaining.']);
  });

  it('makes a repeated message a real DOM change so it is announced again', () => {
    const { queue, heard, advance } = harness(POLITE_INTERVAL_MS);

    queue.push('Your answer could not be saved. Retrying.');
    advance(POLITE_INTERVAL_MS);
    queue.push('Your answer could not be saved. Retrying.');

    expect(heard).toHaveLength(2);
    expect(heard[0]).toBe('Your answer could not be saved. Retrying.');
    // A live region that receives the identical string does not announce it: nothing in
    // the DOM changed. The zero-width space is invisible and inaudible, and it is a
    // mutation.
    expect(heard[1]).toBe(`Your answer could not be saved. Retrying.${ZWSP}`);
    expect(heard[1]?.replace(ZWSP, '')).toBe(heard[0]);
  });

  it('alternates rather than accumulating the marker', () => {
    const { queue, heard, advance } = harness(POLITE_INTERVAL_MS);

    for (let index = 0; index < 4; index += 1) {
      queue.push('Still grading.');
      advance(POLITE_INTERVAL_MS);
    }

    expect(heard).toEqual([
      'Still grading.',
      `Still grading.${ZWSP}`,
      'Still grading.',
      `Still grading.${ZWSP}`,
    ]);
  });

  it('ignores an empty or whitespace-only message', () => {
    const { queue, heard } = harness(POLITE_INTERVAL_MS);

    queue.push('');
    queue.push('   ');
    queue.push('\n\t');

    // Clearing the region without saying anything is a bug at the call site, not an
    // announcement.
    expect(heard).toEqual([]);
  });

  it('trims the message it emits', () => {
    const { queue, heard } = harness(POLITE_INTERVAL_MS);

    queue.push('  Submitted for grading.  ');

    expect(heard).toEqual(['Submitted for grading.']);
  });

  it('clear() drops what was pending without emitting it', () => {
    const { queue, heard, advance } = harness(POLITE_INTERVAL_MS);

    queue.push('Running your code.');
    queue.push('Run complete.');
    queue.clear();
    advance(POLITE_INTERVAL_MS * 3);

    expect(heard).toEqual(['Running your code.']);
  });

  it('dispose() stops delivering to listeners', () => {
    const { queue, heard, advance } = harness(POLITE_INTERVAL_MS);

    queue.push('First.');
    queue.dispose();
    advance(POLITE_INTERVAL_MS * 3);
    queue.push('Second.');

    expect(heard).toEqual(['First.']);
  });

  it('unsubscribing stops that listener only', () => {
    const { queue, heard, advance } = harness(POLITE_INTERVAL_MS);
    const other = vi.fn();
    const off = queue.subscribe(other);

    queue.push('First.');
    off();
    advance(POLITE_INTERVAL_MS);
    queue.push('Second.');

    expect(other).toHaveBeenCalledOnce();
    expect(heard).toEqual(['First.', 'Second.']);
  });

  it('gives the assertive region a far longer gap, because interruption is a cost', () => {
    const { queue, heard, advance } = harness(ASSERTIVE_INTERVAL_MS);

    queue.push('Connection lost.');
    queue.push('1 minute remaining.');

    advance(POLITE_INTERVAL_MS);
    expect(heard).toEqual(['Connection lost.']);

    advance(ASSERTIVE_INTERVAL_MS);
    expect(heard).toEqual(['Connection lost.', '1 minute remaining.']);
  });

  it('does not budget the route announcer, which speaks once per navigation', () => {
    const { queue, heard } = harness(ROUTE_INTERVAL_MS);

    queue.push('Questions. Staff console.');
    queue.push('Assessments. Staff console.');

    expect(heard).toEqual(['Questions. Staff console.', 'Assessments. Staff console.']);
  });
});

describe('intervalFor', () => {
  it('maps politeness to the budget in docs/15 §5.1', () => {
    expect(intervalFor('polite')).toBe(POLITE_INTERVAL_MS);
    expect(intervalFor('assertive')).toBe(ASSERTIVE_INTERVAL_MS);
  });

  it('keeps the documented values, which are a decision and not a tuning knob', () => {
    expect(POLITE_INTERVAL_MS).toBe(2_000);
    expect(ASSERTIVE_INTERVAL_MS).toBe(10_000);
    expect(ROUTE_INTERVAL_MS).toBe(0);
  });
});
