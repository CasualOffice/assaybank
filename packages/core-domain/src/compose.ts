/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Turning a role into an assessment's section rules (`H-179`, docs/18 §2.2).
 *
 * ## The judgement this removes
 *
 * Before this, "compose an assessment" meant a recruiter choosing, by hand: which skills to
 * test, how many questions each, at what difficulty, and whether the bank could supply them.
 * Four judgements, none of which a recruiter is placed to make, and all four already implied
 * by the role they are hiring for — a role is *defined* as a set of skills with a weight and
 * a difficulty band, which is the same information a `section_rules` row holds.
 *
 * So composition is a projection, not a wizard with defaults. The role says Python matters
 * twice as much as SQL and should be asked at difficulty 2–4; this turns that into "6 Python
 * questions at 2–4, 3 SQL questions at 2–4" and stops. Where the result is wrong, the fix is
 * to correct the role, which is durable, rather than to hand-adjust one assessment, which is
 * not.
 *
 * ## Proportional to weight, and honest about rounding
 *
 * Question counts are allocated by weight using the largest-remainder method. The obvious
 * alternative — round each share independently — produces a paper of 9 or 11 questions when
 * 10 were asked for, and a candidate comparing two sittings of "the same" assessment would be
 * right to ask why. Largest remainder always sums to exactly the target.
 *
 * Every required skill gets **at least one** question before proportionality is applied. A
 * role that declares a skill required and then tests it zero times is a role the assessment
 * does not actually measure, and with six required skills and eight questions naive
 * proportionality does exactly that to the two lightest.
 *
 * The consequence is a floor: an assessment for a role with six required skills cannot have
 * fewer than six questions, and asking for five is refused rather than quietly served. That
 * refusal is the honest answer — the alternative is a paper that does not cover the role.
 *
 * ## What it does not decide
 *
 * It does not draw. `resolveDraw` selects the actual questions per candidate at attempt
 * start, from the pool these rules describe (ADR-004), and two candidates therefore sit
 * different papers under the same rules. It does not check feasibility either: whether the
 * bank can supply six Python questions at 2–4 is a question about the bank, answered by the
 * coverage read model, and a pure function with no I/O cannot ask it. The caller pairs the
 * two — `assessmentPlan` in `packages/db` is where a rule meets its in-band count.
 */

import type { SkillId } from '@assaybank/contracts';

import type { QuestionKind, SectionRule } from './draw.js';
import { domainError, type DomainError } from './errors.js';
import { err, ok, type Result } from './result.js';

/** A role's skill, as `job_role_skills` holds it. */
export interface RoleSkill {
  readonly skillId: SkillId;
  readonly skillName: string;
  /** Relative share of the paper. A skill of weight 2 gets twice the questions of a 1. */
  readonly weight: number;
  /** The role's band, or `null` for "any difficulty", which means the full 1–5. */
  readonly minDifficulty: number | null;
  readonly maxDifficulty: number | null;
  readonly isRequired: boolean;
}

/** What to compose. */
export interface ComposeOptions {
  /** How many questions the paper should hold in total. */
  readonly questionCount: number;
  /**
   * Restrict every rule to these kinds, or empty for no restriction.
   *
   * A single list rather than one per skill: "this is a written-answer paper" is a property
   * of the assessment, and a per-skill kind mix is a thing to add when somebody asks for it
   * rather than a knob to ship unasked.
   */
  readonly kinds?: readonly QuestionKind[];
  /**
   * Days within which a question this candidate has already seen is excluded.
   *
   * Zero disables it. It belongs here rather than on the role because it is a property of
   * how you are running the hiring process — a second-round assessment wants it, a first
   * round has nothing to exclude.
   */
  readonly excludeSeenDays?: number;
}

/** One composed section, ready to be written as a row plus its rules. */
export interface ComposedSection {
  readonly name: string;
  readonly rules: readonly (SectionRule & { readonly skillName: string })[];
}

/** The composition, and the arithmetic behind it. */
export interface Composition {
  readonly sections: readonly ComposedSection[];
  /** Always equal to the requested `questionCount`. Asserted by a test. */
  readonly questionCount: number;
  /** Marks available, one per question, so a percentage is questions-correct. */
  readonly totalScore: number;
}

/** A question is worth one mark; a percentage is then simply questions correct. */
export const SCORE_PER_QUESTION = 1;

/**
 * Allocates `total` items across `weights` proportionally, summing to exactly `total`.
 *
 * Largest remainder: floor every share, then hand the leftover to whoever was rounded down
 * hardest. Ties break on the earlier index, so the allocation is a function of its inputs and
 * two calls with the same role produce the same paper shape.
 */
export function allocateByWeight(total: number, weights: readonly number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0) return weights.map(() => 0);

  const exact = weights.map((w) => (w / sum) * total);
  const floors = exact.map(Math.floor);
  let remaining = total - floors.reduce((a, b) => a + b, 0);

  const order = exact
    .map((value, index) => ({ index, remainder: value - Math.floor(value) }))
    .sort((a, b) => (b.remainder === a.remainder ? a.index - b.index : b.remainder - a.remainder));

  const out = [...floors];
  for (const { index } of order) {
    if (remaining <= 0) break;
    out[index] = (out[index] ?? 0) + 1;
    remaining -= 1;
  }
  return out;
}

/**
 * Composes section rules for a role.
 *
 * One section holding one rule per required skill. Optional skills are dropped: they do not
 * define the role, and including them would spend questions a required skill needed.
 */
export function composeFromRole(
  skills: readonly RoleSkill[],
  options: ComposeOptions,
): Result<Composition, DomainError> {
  const required = skills.filter((skill) => skill.isRequired);

  if (required.length === 0) {
    return err(
      domainError(
        'invalid_rule',
        'The role declares no required skill, so there is nothing to compose an assessment from.',
        { skillCount: skills.length },
      ),
    );
  }

  const { questionCount } = options;
  if (!Number.isInteger(questionCount) || questionCount <= 0) {
    return err(
      domainError('invalid_rule', 'questionCount must be a positive integer.', { questionCount }),
    );
  }

  if (questionCount < required.length) {
    return err(
      domainError(
        'invalid_rule',
        `This role has ${String(required.length)} required skills, so an assessment for it needs at least ${String(required.length)} questions.`,
        { questionCount, requiredSkillCount: required.length },
      ),
    );
  }

  if (required.some((skill) => skill.weight <= 0)) {
    return err(domainError('invalid_rule', 'A required skill must carry a weight above zero.', {}));
  }

  // One each first, then share out what is left. See the module note: proportionality alone
  // tests the lightest skills zero times.
  const spare = questionCount - required.length;
  const extra = allocateByWeight(
    spare,
    required.map((skill) => skill.weight),
  );

  const rules = required.map((skill, index) => ({
    skillName: skill.skillName,
    pickCount: 1 + (extra[index] ?? 0),
    skillIds: [skill.skillId] as readonly SkillId[],
    kinds: options.kinds ?? [],
    minDifficulty: skill.minDifficulty ?? 1,
    maxDifficulty: skill.maxDifficulty ?? 5,
    excludeSeenDays: options.excludeSeenDays ?? 0,
    scorePerQuestion: SCORE_PER_QUESTION,
  })) as readonly (SectionRule & { readonly skillName: string })[];

  return ok({
    sections: [{ name: 'Questions', rules }],
    questionCount: rules.reduce((total, rule) => total + rule.pickCount, 0),
    totalScore: questionCount * SCORE_PER_QUESTION,
  });
}
