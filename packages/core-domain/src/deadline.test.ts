/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';

import { computeDeadline, isPastDeadline, secondsRemaining, type Clock } from './deadline.js';

/**
 * A clock the test owns. Nothing here calls `Date.now()` or `vi.useFakeTimers()` —
 * `core-domain` cannot read a clock, so a deadline test needs no global time surgery
 * (ADR-006, CODE-GRAPH L2).
 */
const fixedClock = (iso: string): Clock => ({ now: () => new Date(iso) });

const STARTED_AT = new Date('2026-09-21T09:00:00.000Z');

describe('computeDeadline', () => {
  const cases = [
    { durationSeconds: 3600, extraTimePct: undefined, expected: '2026-09-21T10:00:00.000Z' },
    { durationSeconds: 3600, extraTimePct: 0, expected: '2026-09-21T10:00:00.000Z' },
    { durationSeconds: 3600, extraTimePct: 25, expected: '2026-09-21T10:15:00.000Z' },
    { durationSeconds: 3600, extraTimePct: 50, expected: '2026-09-21T10:30:00.000Z' },
    { durationSeconds: 3600, extraTimePct: 100, expected: '2026-09-21T11:00:00.000Z' },
    { durationSeconds: 90, extraTimePct: 33, expected: '2026-09-21T09:02:00.000Z' },
    { durationSeconds: 1, extraTimePct: 0, expected: '2026-09-21T09:00:01.000Z' },
  ] as const;

  it.each(cases)(
    'duration $durationSeconds s plus $extraTimePct% -> $expected',
    ({ durationSeconds, extraTimePct, expected }) => {
      const deadline =
        extraTimePct === undefined
          ? computeDeadline(STARTED_AT, durationSeconds)
          : computeDeadline(STARTED_AT, durationSeconds, extraTimePct);
      expect(deadline.toISOString()).toBe(expected);
    },
  );

  it('rounds a fractional accommodation up, never down', () => {
    // 90s + 33% = 119.7s. Rounding down would quietly remove most of a second.
    const deadline = computeDeadline(STARTED_AT, 90, 33);
    expect(deadline.getTime() - STARTED_AT.getTime()).toBe(120_000);
  });

  it('never shortens the window', () => {
    const base = computeDeadline(STARTED_AT, 1800);
    for (const pct of [0, 1, 25, 200]) {
      const extended = computeDeadline(STARTED_AT, 1800, pct);
      expect(extended.getTime()).toBeGreaterThanOrEqual(base.getTime());
    }
  });

  it('does not mutate the start date', () => {
    const startedAt = new Date(STARTED_AT.getTime());
    computeDeadline(startedAt, 3600, 25);
    expect(startedAt.toISOString()).toBe(STARTED_AT.toISOString());
  });

  it('is deterministic', () => {
    expect(computeDeadline(STARTED_AT, 3600, 25).getTime()).toBe(
      computeDeadline(STARTED_AT, 3600, 25).getTime(),
    );
  });

  it.each([
    { label: 'zero duration', duration: 0 },
    { label: 'negative duration', duration: -1 },
    { label: 'fractional duration', duration: 10.5 },
    { label: 'NaN duration', duration: Number.NaN },
    { label: 'infinite duration', duration: Number.POSITIVE_INFINITY },
    { label: 'duration beyond seven days', duration: 7 * 24 * 60 * 60 + 1 },
  ])('rejects a $label', ({ duration }) => {
    expect(() => computeDeadline(STARTED_AT, duration)).toThrow(RangeError);
  });

  it.each([
    { label: 'negative accommodation', pct: -1 },
    { label: 'NaN accommodation', pct: Number.NaN },
    { label: 'infinite accommodation', pct: Number.POSITIVE_INFINITY },
    { label: 'absurd accommodation', pct: 1001 },
  ])('rejects a $label', ({ pct }) => {
    expect(() => computeDeadline(STARTED_AT, 3600, pct)).toThrow(RangeError);
  });

  it('rejects an invalid start date rather than producing an invalid deadline', () => {
    expect(() => computeDeadline(new Date('not a date'), 3600)).toThrow(RangeError);
  });
});

describe('isPastDeadline', () => {
  const deadline = new Date('2026-09-21T10:00:00.000Z');

  it.each([
    { label: 'well before', at: '2026-09-21T09:59:00.000Z', past: false },
    { label: 'one millisecond before', at: '2026-09-21T09:59:59.999Z', past: false },
    { label: 'exactly on the deadline', at: '2026-09-21T10:00:00.000Z', past: false },
    { label: 'one millisecond after', at: '2026-09-21T10:00:00.001Z', past: true },
    { label: 'well after', at: '2026-09-21T11:00:00.000Z', past: true },
  ])('$label -> $past', ({ at, past }) => {
    expect(isPastDeadline(deadline, fixedClock(at))).toBe(past);
  });

  it('gives the boundary millisecond to the candidate', () => {
    expect(isPastDeadline(deadline, fixedClock('2026-09-21T10:00:00.000Z'))).toBe(false);
  });

  it('ignores anything the client might believe, because it only sees the injected clock', () => {
    // A client clock rolled back an hour changes nothing: it is not an argument here.
    const serverClock = fixedClock('2026-09-21T10:30:00.000Z');
    expect(isPastDeadline(deadline, serverClock)).toBe(true);
  });

  it('rejects an invalid deadline instead of silently never expiring', () => {
    expect(() => isPastDeadline(new Date('nope'), fixedClock('2026-09-21T10:00:00.000Z'))).toThrow(
      RangeError,
    );
  });

  it('rejects a clock that returns an invalid date', () => {
    const brokenClock: Clock = { now: () => new Date('nope') };
    expect(() => isPastDeadline(deadline, brokenClock)).toThrow(RangeError);
  });
});

describe('secondsRemaining', () => {
  const deadline = new Date('2026-09-21T10:00:00.000Z');

  it.each([
    { at: '2026-09-21T09:00:00.000Z', expected: 3600 },
    { at: '2026-09-21T09:59:00.000Z', expected: 60 },
    { at: '2026-09-21T09:59:59.001Z', expected: 1 },
    { at: '2026-09-21T10:00:00.000Z', expected: 0 },
    { at: '2026-09-21T10:00:00.001Z', expected: 0 },
    { at: '2026-09-21T23:00:00.000Z', expected: 0 },
  ])('at $at -> $expected s', ({ at, expected }) => {
    expect(secondsRemaining(deadline, fixedClock(at))).toBe(expected);
  });

  it('is never negative', () => {
    expect(secondsRemaining(deadline, fixedClock('2030-01-01T00:00:00.000Z'))).toBe(0);
  });

  it('rounds a part second up so the display never shows zero while time remains', () => {
    expect(secondsRemaining(deadline, fixedClock('2026-09-21T09:59:59.500Z'))).toBe(1);
  });

  it('agrees with isPastDeadline at the boundary', () => {
    const clock = fixedClock('2026-09-21T10:00:00.000Z');
    expect(secondsRemaining(deadline, clock)).toBe(0);
    expect(isPastDeadline(deadline, clock)).toBe(false);
  });
});
