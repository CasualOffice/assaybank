/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The audience predicate, proved in both directions.
 *
 * A compile-time assertion is worth exactly nothing until somebody has watched it reject
 * something. `Satisfied<IsCandidateSafe<CandidateQuestionView>>` in `questions.ts` would
 * compile just as happily if `HasAnswerKeyField` had a variance bug that made it answer
 * `false` for everything — and that bug is not hypothetical: the naive spelling of the
 * union case computes `keyof T` over the whole union, which is the *intersection* of the
 * members' keys, and therefore reports a union whose one dangerous member carries
 * `is_correct` as perfectly safe.
 *
 * So every case below that expects a rejection is written as `@ts-expect-error`, which
 * fails the build if the assertion it guards ever starts compiling. The positive cases
 * are plain declarations, which fail the build if they ever stop.
 *
 * The runtime half — {@link findAnswerKeyFields} — is tested with `expect`, because it is
 * the backstop for values that reached a serialiser as `unknown` and no type ever saw.
 */

import { describe, expect, it } from 'vitest';

import {
  ANSWER_KEY_FIELDS,
  findAnswerKeyFields,
  type IsCandidateSafe,
  type Satisfied,
} from './audience.js';

// --- the compile-time predicate ----------------------------------------------

/** A clean leaf: nothing here is answer-key material. */
type CleanOption = { id: string; ordinal: number; body_md: string };

/** The same option after somebody widened it. This is the failure being guarded. */
type LeakyOption = { id: string; ordinal: number; body_md: string; is_correct: boolean };

/** The camel spelling, which is what a forwarded Drizzle row would carry. */
type CamelLeak = { id: string; isCorrect: boolean };

/** A leak one level down, inside an array — how it actually reaches a payload. */
type LeakyNested = { id: string; options: CleanOption[]; cases: { expected_stdout: string }[] };

/** A leak inside an optional property, which a mapped type without `-?` would skip. */
type LeakyOptional = { id: string; spec?: { solution_code: Record<string, string> } };

/** A union whose members disagree. `keyof` over the union would miss the bad one. */
type MixedUnion = CleanOption | LeakyOption;

/** An object carrying only innocent primitives, arrays and a `Date`. */
type Wholesome = {
  id: string;
  when: Date;
  tags: readonly string[];
  nested: { count: number; labels: (string | null)[] };
  starter_code: Record<string, string>;
};

// Positive: each of these must remain candidate-safe.
type _cleanOption = Satisfied<IsCandidateSafe<CleanOption>>;
type _wholesome = Satisfied<IsCandidateSafe<Wholesome>>;
type _primitive = Satisfied<IsCandidateSafe<string>>;
type _nullable = Satisfied<IsCandidateSafe<string | null>>;
type _arrayOfClean = Satisfied<IsCandidateSafe<readonly CleanOption[]>>;
type _emptyObject = Satisfied<IsCandidateSafe<Record<never, never>>>;

// Negative: each of these must be refused. If one of them starts compiling, the
// `@ts-expect-error` above it becomes the failure, which is the alarm.

// @ts-expect-error — `is_correct` is an answer key.
type _leakyOption = Satisfied<IsCandidateSafe<LeakyOption>>;

// @ts-expect-error — the camelCase spelling of the same field is refused too.
type _camelLeak = Satisfied<IsCandidateSafe<CamelLeak>>;

// @ts-expect-error — a hidden test-case expectation nested inside an array.
type _leakyNested = Satisfied<IsCandidateSafe<LeakyNested>>;

// @ts-expect-error — a reference solution behind an optional property.
type _leakyOptional = Satisfied<IsCandidateSafe<LeakyOptional>>;

// @ts-expect-error — one bad member is enough to condemn the union.
type _mixedUnion = Satisfied<IsCandidateSafe<MixedUnion>>;

// @ts-expect-error — an array of leaky elements is a leak.
type _leakyArray = Satisfied<IsCandidateSafe<LeakyOption[]>>;

describe('the compile-time audience predicate', () => {
  it('is enforced by the type checker rather than by this assertion', () => {
    // The declarations above are the test; this case exists so the file reports a
    // result and so the aliases are referenced rather than flagged as unused.
    const proofs: readonly true[] = [
      true satisfies _cleanOption,
      true satisfies _wholesome,
      true satisfies _primitive,
      true satisfies _nullable,
      true satisfies _arrayOfClean,
      true satisfies _emptyObject,
    ];
    expect(proofs).toHaveLength(6);
  });
});

// --- the runtime backstop ----------------------------------------------------

describe('findAnswerKeyFields', () => {
  it('reports nothing for a payload that names none of them', () => {
    expect(
      findAnswerKeyFields({
        question_version_id: 'fdd3f0d2-3e4f-4a1b-9c6d-2f7a8b9c0d1e',
        prompt_md: 'Reverse a linked list.',
        coding: { allowed_languages: ['python'], sample_case_count: 3, hidden_case_count: 12 },
      }),
    ).toEqual([]);
  });

  it('reports the dotted path of every answer-key field, however deeply nested', () => {
    const leaked = {
      options: [
        { id: 'a', body_md: 'yes', is_correct: true },
        { id: 'b', body_md: 'no', is_correct: false },
      ],
      coding: { solution_code: { python: 'return xs[::-1]' } },
      cases: [{ stdin: '1 2 3', expected_stdout: '3 2 1' }],
    };

    expect(findAnswerKeyFields(leaked)).toEqual([
      '$.options[0].is_correct',
      '$.options[1].is_correct',
      '$.coding.solution_code',
      '$.cases[0].expected_stdout',
    ]);
  });

  it('walks a top-level array as readily as a top-level object', () => {
    expect(findAnswerKeyFields([{ is_correct: true }])).toEqual(['$[0].is_correct']);
  });

  it('is unbothered by primitives, null and undefined', () => {
    expect(findAnswerKeyFields(null)).toEqual([]);
    expect(findAnswerKeyFields(undefined)).toEqual([]);
    expect(findAnswerKeyFields('is_correct')).toEqual([]);
    expect(findAnswerKeyFields(42)).toEqual([]);
  });

  it('keeps the name list frozen and non-empty, so it can only grow deliberately', () => {
    expect(ANSWER_KEY_FIELDS.length).toBeGreaterThan(0);
    expect(Object.isFrozen(ANSWER_KEY_FIELDS)).toBe(true);
  });

  it('covers both spellings of every field, so a forwarded row leaks nothing either', () => {
    // A Drizzle row carries camelCase; a wire payload carries snake_case. A deny-list
    // that knew only one of them would pass a payload that was never serialised at all.
    const snake = ANSWER_KEY_FIELDS.filter((name) => name.includes('_'));
    for (const name of snake) {
      const camel = name.replace(/_([a-z])/gu, (_match, letter: string) => letter.toUpperCase());
      expect(ANSWER_KEY_FIELDS).toContain(camel);
    }
    expect(snake.length).toBeGreaterThan(0);
  });
});
