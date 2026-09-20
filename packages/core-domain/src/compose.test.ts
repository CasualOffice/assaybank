/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Composition arithmetic (`H-179`).
 *
 * This is a function whose output nobody checks by hand. A paper of eleven questions when ten
 * were asked for, or a required skill tested zero times, is invisible on the screen that
 * shows it and visible only to the candidate who sat it — so the properties are asserted
 * here rather than trusted to a reviewer counting.
 */

import { describe, expect, it } from 'vitest';

import { SkillIdSchema, type SkillId } from '@assaybank/contracts';

import { allocateByWeight, composeFromRole, SCORE_PER_QUESTION } from './compose.js';
import type { RoleSkill } from './compose.js';

let seq = 0;
function skillId(): SkillId {
  seq += 1;
  return SkillIdSchema.parse(`00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`);
}

function skill(over: Partial<RoleSkill> & { skillName: string }): RoleSkill {
  return {
    skillId: skillId(),
    weight: 1,
    minDifficulty: 2,
    maxDifficulty: 4,
    isRequired: true,
    ...over,
  };
}

/** The composition, or a thrown error naming why it refused. */
function compose(skills: readonly RoleSkill[], questionCount: number, extra = {}) {
  const result = composeFromRole(skills, { questionCount, ...extra });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

const rulesOf = (skills: readonly RoleSkill[], count: number) =>
  compose(skills, count).sections.flatMap((section) => section.rules);

describe('allocateByWeight', () => {
  it('sums to exactly the total, which rounding each share independently does not', () => {
    // Three equal weights over ten: 3.33 each. Rounded independently that is 3+3+3=9 or
    // 4+4+4=12, and a paper of nine questions when ten were asked for is a different
    // denominator for anybody comparing two sittings.
    expect(allocateByWeight(10, [1, 1, 1])).toEqual([4, 3, 3]);
    expect(allocateByWeight(10, [1, 1, 1]).reduce((a, b) => a + b)).toBe(10);
  });

  it('gives the leftover to whoever was rounded down hardest', () => {
    expect(allocateByWeight(10, [3, 1, 1])).toEqual([6, 2, 2]);
    expect(allocateByWeight(7, [5, 2])).toEqual([5, 2]);
  });

  it('breaks a tie on the earlier index, so the same role gives the same paper twice', () => {
    expect(allocateByWeight(4, [1, 1, 1])).toEqual([2, 1, 1]);
    expect(allocateByWeight(4, [1, 1, 1])).toEqual(allocateByWeight(4, [1, 1, 1]));
  });

  it('allocates nothing when there is nothing to allocate', () => {
    expect(allocateByWeight(0, [2, 1])).toEqual([0, 0]);
    expect(allocateByWeight(5, [])).toEqual([]);
    expect(allocateByWeight(5, [0, 0])).toEqual([0, 0]);
  });
});

describe('composing a paper from a role', () => {
  it('asks about every required skill, and about nothing else', () => {
    const rules = rulesOf(
      [
        skill({ skillName: 'Python' }),
        skill({ skillName: 'SQL' }),
        skill({ skillName: 'Nice to have', isRequired: false }),
      ],
      6,
    );

    expect(rules.map((rule) => rule.skillName)).toEqual(['Python', 'SQL']);
  });

  it('serves exactly the number of questions asked for', () => {
    for (const count of [2, 3, 7, 10, 13, 50]) {
      const composition = compose(
        [skill({ skillName: 'A', weight: 3 }), skill({ skillName: 'B' })],
        count,
      );
      const served = composition.sections
        .flatMap((s) => s.rules)
        .reduce((total, rule) => total + rule.pickCount, 0);

      expect(served, `asked for ${String(count)}`).toBe(count);
      expect(composition.questionCount).toBe(count);
    }
  });

  it('splits the paper in proportion to weight', () => {
    const rules = rulesOf(
      [skill({ skillName: 'Python', weight: 2 }), skill({ skillName: 'SQL' })],
      9,
    );

    // One each, then 7 shared 2:1 — so 1+4.67→5 and 1+2.33→2. Python gets twice the
    // questions the role says it is worth, near enough that a recruiter would agree.
    expect(rules.map((r) => [r.skillName, r.pickCount])).toEqual([
      ['Python', 6],
      ['SQL', 3],
    ]);
  });

  it('never tests a required skill zero times, whatever the weights say', () => {
    // The case proportionality alone gets wrong: with 8 questions over these weights, the
    // two lightest skills round to zero and the paper silently stops measuring two things
    // the role calls required.
    const rules = rulesOf(
      [
        skill({ skillName: 'Heavy', weight: 20 }),
        skill({ skillName: 'Light', weight: 1 }),
        skill({ skillName: 'Lighter', weight: 1 }),
      ],
      8,
    );

    expect(rules.every((rule) => rule.pickCount >= 1)).toBe(true);
    expect(rules.reduce((t, r) => t + r.pickCount, 0)).toBe(8);
  });

  it('refuses a paper too short to cover the role, rather than serving a partial one', () => {
    const result = composeFromRole(
      [skill({ skillName: 'A' }), skill({ skillName: 'B' }), skill({ skillName: 'C' })],
      { questionCount: 2 },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('at least 3 questions');
    }
  });

  it('carries each skill’s own difficulty band onto its rule', () => {
    // The band is the role's judgement about seniority, and it is per skill: a senior role
    // may want hard Python and any-difficulty SQL.
    const rules = rulesOf(
      [
        skill({ skillName: 'Python', minDifficulty: 4, maxDifficulty: 5 }),
        skill({ skillName: 'SQL', minDifficulty: null, maxDifficulty: null }),
      ],
      4,
    );

    expect(rules[0]).toMatchObject({ minDifficulty: 4, maxDifficulty: 5 });
    // `null` is "any difficulty" on the role and has to become the full range on the rule,
    // because `section_rules` has no null band — it has 1 and 5.
    expect(rules[1]).toMatchObject({ minDifficulty: 1, maxDifficulty: 5 });
  });

  it('scopes each rule to exactly its own skill', () => {
    const skills = [skill({ skillName: 'Python' }), skill({ skillName: 'SQL' })];
    const rules = rulesOf(skills, 4);

    expect(rules[0]?.skillIds).toEqual([skills[0]?.skillId]);
    expect(rules[1]?.skillIds).toEqual([skills[1]?.skillId]);
  });

  it('marks every question the same, so a percentage is questions correct', () => {
    const composition = compose(
      [skill({ skillName: 'A', weight: 5 }), skill({ skillName: 'B' })],
      10,
    );
    const rules = composition.sections.flatMap((s) => s.rules);

    // Weight decides how *many* questions a skill gets, never what one is worth. Weighting
    // the marks as well would compound the ratio and make a heavy skill count twice over.
    expect(rules.every((rule) => rule.scorePerQuestion === SCORE_PER_QUESTION)).toBe(true);
    expect(composition.totalScore).toBe(10 * SCORE_PER_QUESTION);
  });

  it('passes the kind restriction and the seen-recently window to every rule', () => {
    const composition = composeFromRole([skill({ skillName: 'A' })], {
      questionCount: 3,
      kinds: ['coding'],
      excludeSeenDays: 90,
    });

    expect(composition.ok).toBe(true);
    if (composition.ok) {
      const rule = composition.value.sections[0]?.rules[0];
      expect(rule).toMatchObject({ kinds: ['coding'], excludeSeenDays: 90 });
    }
  });

  it('refuses a role with no required skill at all', () => {
    const result = composeFromRole([skill({ skillName: 'Optional', isRequired: false })], {
      questionCount: 5,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('no required skill');
  });

  it.each([0, -1, 2.5, Number.NaN])('refuses a question count of %s', (questionCount) => {
    const result = composeFromRole([skill({ skillName: 'A' })], { questionCount });
    expect(result.ok).toBe(false);
  });

  it('refuses a weight of zero rather than dividing by it', () => {
    const result = composeFromRole(
      [skill({ skillName: 'A', weight: 0 }), skill({ skillName: 'B' })],
      { questionCount: 4 },
    );
    expect(result.ok).toBe(false);
  });

  it('is a function of its inputs: the same role composes the same paper', () => {
    const skills = [skill({ skillName: 'A', weight: 3 }), skill({ skillName: 'B', weight: 2 })];

    expect(compose(skills, 11)).toEqual(compose(skills, 11));
  });
});
