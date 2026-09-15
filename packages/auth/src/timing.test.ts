/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The timing-safety proof, in its own file because it replaces `node:crypto`.
 *
 * A statistical timing test — hash a million tokens and compare medians — is the obvious
 * way to write this and the wrong one: it is slow, it is flaky on a loaded CI runner, and
 * a suite people have learned to re-run is a suite that no longer gates anything
 * (docs/17 §8). So this asserts the property structurally instead.
 *
 * The claim being proved is: **the comparison does not stop at the first differing byte.**
 * That is true if and only if every byte of both operands is handed to
 * `crypto.timingSafeEqual`, which is constant-time by construction. `timingSafeEqual` is
 * therefore wrapped in a spy that records the operand lengths, and each case asserts that
 * a difference in the first byte does exactly as much work as a difference in the last
 * one. An implementation that short-circuited would either not call it at all, or call it
 * with a truncated prefix, and both are visible here.
 */

import { timingSafeEqual } from 'node:crypto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { constantTimeEquals } from './crypto.js';
import { hashToken, verifyToken } from './token.js';

/** The shape of `node:crypto` this file cares about: the comparison, plus the rest. */
type CryptoModule = Record<string, unknown> & { timingSafeEqual: typeof timingSafeEqual };

vi.mock('node:crypto', async (importOriginal) => {
  const actual: CryptoModule = await importOriginal();

  // Everything else is the real module: only the comparison is observed, never replaced.
  return { ...actual, timingSafeEqual: vi.fn(actual.timingSafeEqual) };
});

const spy = vi.mocked(timingSafeEqual);

/** The operand lengths of every comparison made since the spy was cleared. */
function comparisons(): Array<[number, number]> {
  return spy.mock.calls.map(([left, right]) => [left.byteLength, right.byteLength]);
}

const PEPPER = 'pepper-for-the-timing-proof';
const PLAINTEXT = 'ZmFrZS10b2tlbi1wbGFpbnRleHQtZm9yLXRoZS10ZXN0cw';

/** Replaces the character at `index`, so exactly one byte of the digest differs. */
function corruptAt(value: string, index: number): string {
  const original = value.charAt(index);
  const replacement = original === 'a' ? 'b' : 'a';
  return `${value.slice(0, index)}${replacement}${value.slice(index + 1)}`;
}

describe('constantTimeEquals', () => {
  beforeEach(() => {
    spy.mockClear();
  });

  it('hands both whole operands to timingSafeEqual rather than comparing byte by byte', () => {
    expect(constantTimeEquals('abcdef', 'abcdef')).toBe(true);
    expect(comparisons()).toEqual([[6, 6]]);
  });

  it('does the same amount of work whether the first or the last byte differs', () => {
    expect(constantTimeEquals('Xbcdef', 'abcdef')).toBe(false);
    const firstByteDiffers = comparisons();

    spy.mockClear();
    expect(constantTimeEquals('abcdeX', 'abcdef')).toBe(false);
    const lastByteDiffers = comparisons();

    // Identical call shapes: one comparison, six bytes against six bytes, in both cases.
    // Where the difference sits changes nothing about what was compared.
    expect(firstByteDiffers).toEqual([[6, 6]]);
    expect(lastByteDiffers).toEqual(firstByteDiffers);
  });

  it('still compares in constant time when the lengths differ, instead of returning early', () => {
    expect(constantTimeEquals('ab', 'abcdef')).toBe(false);

    // The work done depends on the expected value, never on what the caller presented.
    expect(comparisons()).toEqual([[6, 6]]);
  });

  it('is not fooled by a prefix, which is what an early return would accept', () => {
    expect(constantTimeEquals('abcdef', 'abc')).toBe(false);
    expect(constantTimeEquals('abc', 'abcdef')).toBe(false);
  });
});

describe('verifyToken', () => {
  beforeEach(() => {
    spy.mockClear();
  });

  it('compares the whole digest even when it fails on the very first character', () => {
    const hash = hashToken(PLAINTEXT, PEPPER);
    const wrongFromTheStart = corruptAt(hash, 0);

    expect(verifyToken(PLAINTEXT, wrongFromTheStart, PEPPER)).toBe(false);
    const fromTheStart = comparisons();

    spy.mockClear();
    expect(verifyToken(PLAINTEXT, corruptAt(hash, hash.length - 1), PEPPER)).toBe(false);
    const fromTheEnd = comparisons();

    expect(fromTheStart).toEqual([[hash.length, hash.length]]);
    expect(fromTheEnd).toEqual(fromTheStart);
  });

  it('goes through timingSafeEqual on the success path too', () => {
    const hash = hashToken(PLAINTEXT, PEPPER);

    expect(verifyToken(PLAINTEXT, hash, PEPPER)).toBe(true);
    expect(comparisons()).toEqual([[hash.length, hash.length]]);
  });
});
