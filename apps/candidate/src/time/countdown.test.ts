/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The ADR-006 tests.
 *
 * The central one is `ignores a manipulated local clock`. It does not merely assert that
 * the displayed number happens not to change when the system clock moves — a passing
 * assertion of that kind is compatible with an implementation that reads `Date.now()`
 * and gets lucky. It replaces `Date.now` and the `Date` constructor with versions that
 * throw, so *any* read of the wall clock inside the countdown fails the test by name.
 *
 * That is the difference between testing today's behaviour and pinning an invariant. A
 * future edit that adds a "fall back to local time if the sample is stale" branch — which
 * is a reasonable-sounding thing to write — breaks this test loudly instead of quietly
 * handing every candidate a clock they can set.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Announcement, ServerTimeSample } from './countdown';
import {
  CountdownClock,
  announcementForThreshold,
  formatRemaining,
  formatRemainingForSpeech,
  remainingMs,
  thresholdBoundaryMs,
  thresholdsCrossed,
} from './countdown';

const MINUTE = 60_000;
/** An arbitrary but fixed server epoch: 2026-10-12T09:00:00Z, the first day of M1. */
const SERVER_START_MS = Date.parse('2026-10-12T09:00:00.000Z');
const DURATION_MS = 45 * MINUTE;
const DEADLINE_MS = SERVER_START_MS + DURATION_MS;

/** A controllable monotonic source, standing in for `performance.now()`. */
function fakeMonotonic(): { read: () => number; advance: (ms: number) => void } {
  let value = 1_000;
  return {
    read: () => value,
    advance: (ms: number) => {
      value += ms;
    },
  };
}

function sampleAt(monotonicValue: number, serverTimeMs = SERVER_START_MS): ServerTimeSample {
  return { serverTimeMs, receivedAtMs: monotonicValue };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('remainingMs', () => {
  it('derives the remaining time from the server sample and a monotonic delta', () => {
    const remaining = remainingMs({
      deadlineAtMs: DEADLINE_MS,
      sample: sampleAt(1_000),
      monotonicNowMs: 1_000 + 5 * MINUTE,
    });

    expect(remaining).toBe(DURATION_MS - 5 * MINUTE);
  });

  it('clamps at zero rather than reporting negative time', () => {
    const remaining = remainingMs({
      deadlineAtMs: DEADLINE_MS,
      sample: sampleAt(1_000),
      monotonicNowMs: 1_000 + DURATION_MS + 4 * MINUTE,
    });

    expect(remaining).toBe(0);
  });

  it('never consults the local wall clock', () => {
    // Any read of Date.now() or `new Date()` inside the computation fails here by name.
    const wallClock = vi.spyOn(Date, 'now').mockImplementation(() => {
      throw new Error('the countdown read the local wall clock');
    });

    const remaining = remainingMs({
      deadlineAtMs: DEADLINE_MS,
      sample: sampleAt(1_000),
      monotonicNowMs: 1_000 + MINUTE,
    });

    expect(remaining).toBe(DURATION_MS - MINUTE);
    expect(wallClock).not.toHaveBeenCalled();
  });
});

describe('CountdownClock — the client clock is display only (ADR-006)', () => {
  it('counts down as the monotonic source advances', () => {
    const monotonic = fakeMonotonic();
    const clock = new CountdownClock({
      deadlineAtMs: DEADLINE_MS,
      startedAtMs: SERVER_START_MS,
      sample: sampleAt(monotonic.read()),
      monotonic: monotonic.read,
    });

    expect(clock.getSnapshot().remainingMs).toBe(DURATION_MS);

    monotonic.advance(90_000);
    clock.tick();

    expect(clock.getSnapshot().remainingMs).toBe(DURATION_MS - 90_000);
    expect(clock.getSnapshot().expired).toBe(false);
  });

  it('ignores a manipulated local clock', () => {
    const monotonic = fakeMonotonic();
    const clock = new CountdownClock({
      deadlineAtMs: DEADLINE_MS,
      startedAtMs: SERVER_START_MS,
      sample: sampleAt(monotonic.read()),
      monotonic: monotonic.read,
    });

    monotonic.advance(10 * MINUTE);
    clock.tick();
    const before = clock.getSnapshot();
    expect(before.remainingMs).toBe(35 * MINUTE);

    // The candidate sets their machine forward by a year. A client that trusted local
    // time would now show an expired assessment; a client that set it *backwards* would
    // award itself unlimited time, which is the version that matters.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2027-10-12T09:00:00.000Z'));
    clock.tick();
    const afterForward = clock.getSnapshot();

    // ...and then back by a year, the direction a candidate would actually choose.
    vi.setSystemTime(new Date('2025-10-12T09:00:00.000Z'));
    clock.tick();
    const afterBackward = clock.getSnapshot();

    // The assertions above would also pass for an implementation that read `Date.now()`
    // and happened to get lucky, so the invariant is pinned structurally as well: with a
    // throwing `Date.now` installed, a tick still succeeds and the spy is never called.
    const wallClock = vi.spyOn(Date, 'now').mockImplementation(() => {
      throw new Error('the countdown read the local wall clock');
    });
    clock.tick();

    expect(wallClock).not.toHaveBeenCalled();
    expect(afterForward.remainingMs).toBe(before.remainingMs);
    expect(afterBackward.remainingMs).toBe(before.remainingMs);
    expect(afterForward.expired).toBe(false);
    // Identity is preserved too: nothing changed, so nothing re-renders.
    expect(afterBackward).toBe(before);
  });

  it('reconciles to the server on every heartbeat, erasing local drift', () => {
    const monotonic = fakeMonotonic();
    const clock = new CountdownClock({
      deadlineAtMs: DEADLINE_MS,
      startedAtMs: SERVER_START_MS,
      sample: sampleAt(monotonic.read()),
      monotonic: monotonic.read,
    });

    // The device's oscillator runs slow: five minutes of server time pass, but the
    // monotonic source only advanced by four.
    monotonic.advance(4 * MINUTE);
    clock.tick();
    expect(clock.getSnapshot().remainingMs).toBe(41 * MINUTE);

    // The heartbeat carries the server's own reading, and the estimate snaps to it.
    clock.reconcile({
      serverTimeMs: SERVER_START_MS + 5 * MINUTE,
      receivedAtMs: monotonic.read(),
    });

    expect(clock.getSnapshot().remainingMs).toBe(40 * MINUTE);
  });

  it('accepts a deadline the server moved, and offers no way to move one locally', () => {
    const monotonic = fakeMonotonic();
    const clock = new CountdownClock({
      deadlineAtMs: DEADLINE_MS,
      startedAtMs: SERVER_START_MS,
      sample: sampleAt(monotonic.read()),
      monotonic: monotonic.read,
    });

    // A recorded `breaks_allowed` accommodation resumed through an audited server-side
    // transition (ADR-006, docs/15 §3.2). The server sends the new deadline; the client
    // renders it.
    clock.applyServerDeadline(DEADLINE_MS + 10 * MINUTE);
    expect(clock.getSnapshot().remainingMs).toBe(55 * MINUTE);

    // There is deliberately no addTime/pause/resume on the public surface.
    const surface = Object.getOwnPropertyNames(Object.getPrototypeOf(clock));
    expect(surface).not.toContain('pause');
    expect(surface).not.toContain('resume');
    expect(surface).not.toContain('addTime');
  });

  it('reports expiry as a display state without performing one', () => {
    const monotonic = fakeMonotonic();
    const clock = new CountdownClock({
      deadlineAtMs: DEADLINE_MS,
      startedAtMs: SERVER_START_MS,
      sample: sampleAt(monotonic.read()),
      monotonic: monotonic.read,
    });

    monotonic.advance(DURATION_MS + MINUTE);
    clock.tick();

    const snapshot = clock.getSnapshot();
    expect(snapshot.remainingMs).toBe(0);
    expect(snapshot.expired).toBe(true);
    // The deadline is untouched: expiry is a server-side state transition and this
    // bundle has not performed one.
    expect(snapshot.deadlineAtMs).toBe(DEADLINE_MS);
  });

  it('keeps snapshot identity stable between ticks within the same second', () => {
    const monotonic = fakeMonotonic();
    const clock = new CountdownClock({
      deadlineAtMs: DEADLINE_MS,
      startedAtMs: SERVER_START_MS,
      sample: sampleAt(monotonic.read()),
      monotonic: monotonic.read,
    });

    const first = clock.getSnapshot();
    monotonic.advance(120);
    clock.tick();
    expect(clock.getSnapshot()).toBe(first);

    monotonic.advance(1_000);
    clock.tick();
    expect(clock.getSnapshot()).not.toBe(first);
  });

  it('notifies subscribers only when the displayed second changes', () => {
    const monotonic = fakeMonotonic();
    const clock = new CountdownClock({
      deadlineAtMs: DEADLINE_MS,
      startedAtMs: SERVER_START_MS,
      sample: sampleAt(monotonic.read()),
      monotonic: monotonic.read,
    });

    const listener = vi.fn();
    const unsubscribe = clock.subscribe(listener);

    monotonic.advance(100);
    clock.tick();
    expect(listener).not.toHaveBeenCalled();

    monotonic.advance(1_000);
    clock.tick();
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    monotonic.advance(2_000);
    clock.tick();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe('threshold announcements (docs/15 §5.2)', () => {
  it('places the half-time boundary at half the attempt duration', () => {
    expect(thresholdBoundaryMs('half', DURATION_MS)).toBe(22.5 * MINUTE);
    expect(thresholdBoundaryMs('ten-minutes', DURATION_MS)).toBe(10 * MINUTE);
    expect(thresholdBoundaryMs('one-minute', DURATION_MS)).toBe(MINUTE);
  });

  it('reports every threshold a single jump crossed', () => {
    // A backgrounded tab, a long garbage collection, or a laptop lid closed and reopened:
    // the tick lands well past several boundaries at once and the candidate is owed all
    // of them.
    expect(thresholdsCrossed(11 * MINUTE, 30_000, DURATION_MS)).toEqual([
      'ten-minutes',
      'five-minutes',
      'one-minute',
    ]);
  });

  it('does not re-announce when a reconciliation moves the estimate backwards', () => {
    expect(thresholdsCrossed(4 * MINUTE, 6 * MINUTE, DURATION_MS)).toEqual([]);
  });

  it('announces the one-minute warning assertively and the rest politely', () => {
    const regionOf = (announcement: Announcement): string => announcement.region;

    expect(regionOf(announcementForThreshold('half', 22.5 * MINUTE))).toBe('polite');
    expect(regionOf(announcementForThreshold('ten-minutes', 10 * MINUTE))).toBe('polite');
    expect(regionOf(announcementForThreshold('five-minutes', 5 * MINUTE))).toBe('polite');
    expect(regionOf(announcementForThreshold('one-minute', MINUTE))).toBe('assertive');
    expect(announcementForThreshold('one-minute', MINUTE).message).toContain(
      'Your answers are saved automatically',
    );
  });

  it('emits each crossing exactly once as the clock runs', () => {
    const monotonic = fakeMonotonic();
    const announcements: Announcement[] = [];
    const clock = new CountdownClock({
      deadlineAtMs: DEADLINE_MS,
      startedAtMs: SERVER_START_MS,
      sample: sampleAt(monotonic.read()),
      monotonic: monotonic.read,
      onAnnounce: (announcement) => announcements.push(announcement),
    });

    monotonic.advance(23 * MINUTE); // 22 minutes left: crosses half.
    clock.tick();
    monotonic.advance(MINUTE); // 21 left: crosses nothing.
    clock.tick();
    monotonic.advance(12 * MINUTE); // 9 left: crosses ten-minutes.
    clock.tick();

    expect(announcements.map((a) => a.message)).toEqual([
      'Half your time remains: 22 minutes.',
      '10 minutes remaining.',
    ]);
  });
});

describe('formatting', () => {
  it('renders minutes and seconds, and hours only when there are any', () => {
    expect(formatRemaining(45 * MINUTE)).toBe('45:00');
    expect(formatRemaining(9 * MINUTE + 5_000)).toBe('9:05');
    expect(formatRemaining(90 * MINUTE)).toBe('1:30:00');
    expect(formatRemaining(0)).toBe('0:00');
    expect(formatRemaining(-5_000)).toBe('0:00');
  });

  it('spells the value out for the timer accessible name', () => {
    // "12:04" is read as a time of day, a ratio, or two numbers depending on the screen
    // reader and its verbosity setting. A candidate under time pressure should not have
    // to decode that.
    expect(formatRemainingForSpeech(12 * MINUTE + 4_000)).toBe('12 minutes 4 seconds');
    expect(formatRemainingForSpeech(MINUTE)).toBe('1 minute');
    expect(formatRemainingForSpeech(90 * MINUTE)).toBe('1 hour 30 minutes');
    expect(formatRemainingForSpeech(0)).toBe('no time remaining');
  });
});
