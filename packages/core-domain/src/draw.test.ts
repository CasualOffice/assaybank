/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { type QuestionVersionId, type SkillId } from '@assaybank/contracts';
import { describe, expect, it } from 'vitest';

import {
  QUESTION_KINDS,
  resolveDraw,
  type DrawCandidate,
  type QuestionKind,
  type SectionRule,
} from './draw.js';

const skill = (name: string): SkillId => name as SkillId;
const version = (name: string): QuestionVersionId => name as QuestionVersionId;

const PYTHON = skill('python');
const SQL = skill('sql');
const CONCURRENCY = skill('concurrency');

/**
 * A small linear congruential generator. Seeded, injected, reproducible — the point of
 * `rng: () => number` is that the test owns the sequence, and `Math.random()` never
 * appears in the package under test.
 */
function seededRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

const baseRule: SectionRule = {
  pickCount: 3,
  skillIds: [],
  kinds: [],
  minDifficulty: 1,
  maxDifficulty: 5,
  excludeSeenDays: 0,
  scorePerQuestion: 10,
};

const rule = (overrides: Partial<SectionRule>): SectionRule => ({ ...baseRule, ...overrides });

function candidate(
  id: string,
  overrides: Partial<Omit<DrawCandidate, 'questionVersionId'>> = {},
): DrawCandidate {
  const base = {
    questionVersionId: version(id),
    skillIds: [PYTHON],
    kind: 'coding' as QuestionKind,
    difficulty: 3,
  };
  return { ...base, ...overrides };
}

const pool = (...ids: string[]): DrawCandidate[] => ids.map((id) => candidate(id));

describe('resolveDraw — determinism (ADR-004)', () => {
  it('returns the same ordered set for the same seed', () => {
    const p = pool('q1', 'q2', 'q3', 'q4', 'q5', 'q6', 'q7', 'q8');

    const first = resolveDraw(rule({ pickCount: 4 }), p, seededRng(42));
    const second = resolveDraw(rule({ pickCount: 4 }), p, seededRng(42));

    expect(first.ok).toBe(true);
    expect(first).toStrictEqual(second);
  });

  it('returns a different set for a different seed', () => {
    const p = pool('q1', 'q2', 'q3', 'q4', 'q5', 'q6', 'q7', 'q8');

    const a = resolveDraw(rule({ pickCount: 4 }), p, seededRng(1));
    const b = resolveDraw(rule({ pickCount: 4 }), p, seededRng(9999));

    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(a.value.map((c) => c.questionVersionId)).not.toStrictEqual(
        b.value.map((c) => c.questionVersionId),
      );
    }
  });

  it('does not depend on the order the pool came back in', () => {
    const forwards = pool('q1', 'q2', 'q3', 'q4', 'q5', 'q6');
    const backwards = [...forwards].reverse();

    const a = resolveDraw(rule({ pickCount: 3 }), forwards, seededRng(7));
    const b = resolveDraw(rule({ pickCount: 3 }), backwards, seededRng(7));

    expect(a).toStrictEqual(b);
  });

  it('does not mutate the pool it was given', () => {
    const p = pool('q1', 'q2', 'q3', 'q4');
    const snapshot = p.map((c) => c.questionVersionId);

    resolveDraw(rule({ pickCount: 2 }), p, seededRng(3));

    expect(p.map((c) => c.questionVersionId)).toStrictEqual(snapshot);
  });
});

describe('resolveDraw — selection', () => {
  it('returns exactly pickCount questions', () => {
    const result = resolveDraw(rule({ pickCount: 3 }), pool('a', 'b', 'c', 'd', 'e'), seededRng(5));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(3);
    }
  });

  it('never serves the same version twice', () => {
    const result = resolveDraw(rule({ pickCount: 5 }), pool('a', 'b', 'c', 'd', 'e'), seededRng(5));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(new Set(result.value.map((c) => c.questionVersionId)).size).toBe(5);
    }
  });

  it('deduplicates a pool that contains the same version twice', () => {
    const duplicated = [candidate('a'), candidate('a'), candidate('b'), candidate('c')];

    const drawn = resolveDraw(rule({ pickCount: 3 }), duplicated, seededRng(5));
    expect(drawn.ok).toBe(true);
    if (drawn.ok) {
      expect(new Set(drawn.value.map((c) => c.questionVersionId)).size).toBe(3);
    }

    // Four rows, three distinct versions: asking for four is infeasible, not a
    // licence to serve the same question twice.
    const overdrawn = resolveDraw(rule({ pickCount: 4 }), duplicated, seededRng(5));
    expect(overdrawn.ok).toBe(false);
    if (!overdrawn.ok) {
      expect(overdrawn.error.code).toBe('draw_infeasible');
      expect(overdrawn.error.details).toMatchObject({
        eligibleCount: 3,
        pickCount: 4,
        poolSize: 4,
      });
    }
  });

  it('filters by difficulty range, inclusive at both ends', () => {
    const p = [
      candidate('d1', { difficulty: 1 }),
      candidate('d2', { difficulty: 2 }),
      candidate('d3', { difficulty: 3 }),
      candidate('d4', { difficulty: 4 }),
      candidate('d5', { difficulty: 5 }),
    ];
    const result = resolveDraw(
      rule({ pickCount: 2, minDifficulty: 2, maxDifficulty: 3 }),
      p,
      seededRng(11),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.map((c) => c.questionVersionId).sort()).toStrictEqual([
        version('d2'),
        version('d3'),
      ]);
    }
  });

  it('filters by kind when kinds is non-empty', () => {
    const p = [
      candidate('k1', { kind: 'coding' }),
      candidate('k2', { kind: 'mcq_single' }),
      candidate('k3', { kind: 'sql' }),
    ];
    const result = resolveDraw(rule({ pickCount: 1, kinds: ['mcq_single'] }), p, seededRng(2));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.map((c) => c.questionVersionId)).toStrictEqual([version('k2')]);
    }
  });

  it('treats an empty kinds list as no kind filter', () => {
    const p = QUESTION_KINDS.map((kind, i) => candidate(`k${String(i)}`, { kind }));
    const result = resolveDraw(rule({ pickCount: QUESTION_KINDS.length }), p, seededRng(2));
    expect(result.ok).toBe(true);
  });

  it('matches a candidate carrying any one of the rule skills', () => {
    const p = [
      candidate('s1', { skillIds: [PYTHON] }),
      candidate('s2', { skillIds: [SQL] }),
      candidate('s3', { skillIds: [CONCURRENCY, PYTHON] }),
    ];
    const result = resolveDraw(rule({ pickCount: 2, skillIds: [PYTHON] }), p, seededRng(4));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.map((c) => c.questionVersionId).sort()).toStrictEqual([
        version('s1'),
        version('s3'),
      ]);
    }
  });

  it('treats an empty skillIds list as no skill filter', () => {
    const p = [candidate('s1', { skillIds: [SQL] }), candidate('s2', { skillIds: [] })];
    const result = resolveDraw(rule({ pickCount: 2, skillIds: [] }), p, seededRng(4));
    expect(result.ok).toBe(true);
  });

  it('excludes versions this candidate saw inside the exclusion window', () => {
    const p = [
      candidate('seen-recently', { lastSeenDaysAgo: 10 }),
      candidate('seen-long-ago', { lastSeenDaysAgo: 400 }),
      candidate('never-seen'),
    ];
    const result = resolveDraw(rule({ pickCount: 2, excludeSeenDays: 90 }), p, seededRng(6));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.map((c) => c.questionVersionId).sort()).toStrictEqual([
        version('never-seen'),
        version('seen-long-ago'),
      ]);
    }
  });

  it('treats the exclusion window as inclusive of its own boundary day', () => {
    const p = [candidate('boundary', { lastSeenDaysAgo: 90 })];
    const result = resolveDraw(rule({ pickCount: 1, excludeSeenDays: 90 }), p, seededRng(6));
    expect(result.ok).toBe(true);
  });

  it('applies no exclusion when excludeSeenDays is zero', () => {
    const p = [candidate('a', { lastSeenDaysAgo: 0 }), candidate('b', { lastSeenDaysAgo: 1 })];
    const result = resolveDraw(rule({ pickCount: 2, excludeSeenDays: 0 }), p, seededRng(6));
    expect(result.ok).toBe(true);
  });
});

describe('resolveDraw — infeasibility is detectable before a candidate sees it', () => {
  it('errors rather than short-drawing when the pool is too small', () => {
    const result = resolveDraw(rule({ pickCount: 5 }), pool('a', 'b'), seededRng(1));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('draw_infeasible');
      expect(result.error.details).toMatchObject({ pickCount: 5, eligibleCount: 2 });
    }
  });

  it('errors when the filters exclude everything', () => {
    const result = resolveDraw(
      rule({ pickCount: 1, kinds: ['system_design'] }),
      pool('a', 'b', 'c'),
      seededRng(1),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('draw_infeasible');
    }
  });

  it('errors on an empty pool', () => {
    const result = resolveDraw(rule({ pickCount: 1 }), [], seededRng(1));
    expect(result.ok).toBe(false);
  });

  it('never throws', () => {
    expect(() => resolveDraw(rule({ pickCount: 99 }), pool('a'), seededRng(1))).not.toThrow();
  });

  it('carries no question content in the error details', () => {
    const result = resolveDraw(rule({ pickCount: 5 }), pool('a', 'b'), seededRng(1));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(JSON.stringify(result.error)).not.toContain('"a"');
    }
  });
});

describe('resolveDraw — malformed rules', () => {
  it.each([
    { label: 'zero pickCount', overrides: { pickCount: 0 } },
    { label: 'negative pickCount', overrides: { pickCount: -1 } },
    { label: 'fractional pickCount', overrides: { pickCount: 2.5 } },
    { label: 'inverted difficulty range', overrides: { minDifficulty: 4, maxDifficulty: 2 } },
    { label: 'difficulty below 1', overrides: { minDifficulty: 0 } },
    { label: 'difficulty above 5', overrides: { maxDifficulty: 6 } },
    { label: 'negative excludeSeenDays', overrides: { excludeSeenDays: -1 } },
    { label: 'negative scorePerQuestion', overrides: { scorePerQuestion: -1 } },
    { label: 'NaN scorePerQuestion', overrides: { scorePerQuestion: Number.NaN } },
  ])('rejects a rule with a $label', ({ overrides }) => {
    const result = resolveDraw(rule(overrides), pool('a', 'b', 'c'), seededRng(1));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invalid_rule');
    }
  });
});

describe('resolveDraw — hostile generators', () => {
  it('survives a generator that always returns 1', () => {
    const result = resolveDraw(rule({ pickCount: 3 }), pool('a', 'b', 'c', 'd'), () => 1);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(3);
      expect(new Set(result.value.map((c) => c.questionVersionId)).size).toBe(3);
    }
  });

  it('survives a generator that returns NaN', () => {
    const result = resolveDraw(rule({ pickCount: 2 }), pool('a', 'b', 'c'), () => Number.NaN);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(2);
    }
  });

  it('survives a generator that returns a negative number', () => {
    const result = resolveDraw(rule({ pickCount: 2 }), pool('a', 'b', 'c'), () => -5);
    expect(result.ok).toBe(true);
  });
});
