/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it, vi } from 'vitest';

import type { TimerHandle } from './announcer';
import { ANNOUNCEMENT_BUDGET_MS, Announcer } from './announcer';

/** A scheduler under test control: nothing here waits on a real timer. */
function harness(): {
  announcer: Announcer;
  advance: (ms: number) => void;
} {
  let now = 0;
  const queue = new Map<number, { at: number; run: () => void }>();
  let nextId = 1;

  const announcer = new Announcer({
    now: () => now,
    schedule: (callback, delayMs) => {
      const id = nextId;
      nextId += 1;
      queue.set(id, { at: now + delayMs, run: callback });
      return id as unknown as TimerHandle;
    },
    cancel: (handle) => {
      queue.delete(handle as unknown as number);
    },
  });

  const advance = (ms: number): void => {
    const target = now + ms;
    for (const [id, entry] of [...queue].sort((a, b) => a[1].at - b[1].at)) {
      if (entry.at > target) continue;
      queue.delete(id);
      now = entry.at;
      entry.run();
    }
    now = target;
  };

  return { announcer, advance };
}

describe('Announcer', () => {
  it('publishes the first message in a channel immediately', () => {
    const { announcer } = harness();
    announcer.announce('polite', 'Your answer is saved.');
    expect(announcer.getSnapshot().polite).toBe('Your answer is saved.');
  });

  it('holds a second message back until the channel budget allows it', () => {
    const { announcer, advance } = harness();

    announcer.announce('polite', 'first');
    announcer.announce('polite', 'second');

    expect(announcer.getSnapshot().polite).toBe('first');
    advance(ANNOUNCEMENT_BUDGET_MS.polite);
    expect(announcer.getSnapshot().polite).toBe('second');
  });

  it('drops superseded messages rather than queueing them', () => {
    const { announcer, advance } = harness();

    announcer.announce('polite', 'Running your code.');
    announcer.announce('polite', 'Still grading.');
    announcer.announce('polite', 'Run complete. 3 of 4 sample tests passed.');

    advance(ANNOUNCEMENT_BUDGET_MS.polite);

    // By the time a three-messages-ago update would be read out it is no longer true,
    // and a screen-reader user hearing stale state is worse off than one hearing nothing.
    expect(announcer.getSnapshot().polite).toBe('Run complete. 3 of 4 sample tests passed.');
  });

  it('gives the assertive channel a much longer budget', () => {
    const { announcer, advance } = harness();

    announcer.announce('assertive', '1 minute remaining.');
    announcer.announce('assertive', 'Code execution is temporarily unavailable.');

    expect(announcer.getSnapshot().assertive).toBe('1 minute remaining.');
    advance(ANNOUNCEMENT_BUDGET_MS.polite);
    // Interruption is a cost. Something that interrupts every ten seconds is a siren.
    expect(announcer.getSnapshot().assertive).toBe('1 minute remaining.');

    advance(ANNOUNCEMENT_BUDGET_MS.assertive);
    expect(announcer.getSnapshot().assertive).toBe('Code execution is temporarily unavailable.');
  });

  it('keeps the two channels independent', () => {
    const { announcer } = harness();

    announcer.announce('polite', 'Submitted for grading.');
    announcer.announce('assertive', 'Assessment submitted.');

    expect(announcer.getSnapshot()).toEqual({
      polite: 'Submitted for grading.',
      assertive: 'Assessment submitted.',
    });
  });

  it('notifies subscribers when a region changes', () => {
    const { announcer } = harness();
    const listener = vi.fn();
    announcer.subscribe(listener);

    announcer.announce('polite', 'Your answer is saved.');
    expect(listener).toHaveBeenCalledTimes(1);

    // A live region whose text is replaced with an identical string is frequently not
    // re-announced, so a repeat is a no-op rather than a silent surprise.
    announcer.announce('polite', 'Your answer is saved.');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('cancels pending work on dispose', () => {
    const { announcer, advance } = harness();

    announcer.announce('polite', 'first');
    announcer.announce('polite', 'second');
    announcer.dispose();
    advance(ANNOUNCEMENT_BUDGET_MS.polite * 2);

    expect(announcer.getSnapshot().polite).toBe('first');
  });
});
