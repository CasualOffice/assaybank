/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';

import { shuffleOptions } from './shuffle.js';

function seededRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

const OPTIONS = ['a', 'b', 'c', 'd', 'e'];

describe('shuffleOptions', () => {
  it('is deterministic for a given generator sequence', () => {
    expect(shuffleOptions(OPTIONS, seededRng(17))).toStrictEqual(
      shuffleOptions(OPTIONS, seededRng(17)),
    );
  });

  it('does not mutate its input', () => {
    const input = [...OPTIONS];
    shuffleOptions(input, seededRng(1));
    expect(input).toStrictEqual(OPTIONS);
  });

  it('returns a new array', () => {
    const input = [...OPTIONS];
    expect(shuffleOptions(input, seededRng(1))).not.toBe(input);
  });

  it('is a permutation — every option survives exactly once', () => {
    for (let seed = 0; seed < 50; seed += 1) {
      const shuffled = shuffleOptions(OPTIONS, seededRng(seed));
      expect(shuffled).toHaveLength(OPTIONS.length);
      expect([...shuffled].sort()).toStrictEqual([...OPTIONS].sort());
    }
  });

  it('handles the empty and single-element cases', () => {
    expect(shuffleOptions([], seededRng(1))).toStrictEqual([]);
    expect(shuffleOptions(['only'], seededRng(1))).toStrictEqual(['only']);
  });

  it('preserves elements that are themselves undefined', () => {
    const sparse: (string | undefined)[] = ['a', undefined, 'c'];
    const shuffled = shuffleOptions(sparse, seededRng(3));
    expect(shuffled).toHaveLength(3);
    expect(shuffled.filter((v) => v === undefined)).toHaveLength(1);
  });

  it('actually reorders across seeds rather than returning the input', () => {
    const orders = new Set<string>();
    for (let seed = 0; seed < 50; seed += 1) {
      orders.add(shuffleOptions(OPTIONS, seededRng(seed)).join(''));
    }
    expect(orders.size).toBeGreaterThan(1);
  });

  it('survives a generator that always returns 1', () => {
    expect([...shuffleOptions(OPTIONS, () => 1)].sort()).toStrictEqual([...OPTIONS].sort());
  });

  it('survives a generator that always returns 0', () => {
    expect(shuffleOptions(OPTIONS, () => 0)).toStrictEqual(OPTIONS);
  });

  it('survives a generator returning NaN or a negative number', () => {
    expect([...shuffleOptions(OPTIONS, () => Number.NaN)].sort()).toStrictEqual(
      [...OPTIONS].sort(),
    );
    expect([...shuffleOptions(OPTIONS, () => -1)].sort()).toStrictEqual([...OPTIONS].sort());
  });

  it('reaches every permutation over a long draw sequence', () => {
    // Not a statistical proof — a smoke check that the generator drives the whole
    // range rather than parking one element in one slot. One generator, drawn from
    // repeatedly: seeding a linear congruential generator with 0, 1, 2 … produces
    // correlated first draws, which would test the test rather than the shuffle.
    const rng = seededRng(20_260_921);
    const permutations = new Set<string>();
    const firstPositions = new Set<string>();
    for (let round = 0; round < 2000; round += 1) {
      const shuffled = shuffleOptions(OPTIONS, rng);
      permutations.add(shuffled.join(''));
      const head = shuffled[0];
      if (head !== undefined) {
        firstPositions.add(head);
      }
    }
    expect(firstPositions.size).toBe(OPTIONS.length);
    // 5! = 120 permutations of a five-option question.
    expect(permutations.size).toBe(120);
  });
});
