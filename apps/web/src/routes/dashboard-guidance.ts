/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What to do next, decided from data rather than left to the reader (`H-191`, docs/18 §1).
 *
 * ## Why this is a function and not a paragraph in a component
 *
 * A dashboard that shows four panels and lets you work out which one matters is a dashboard
 * that gets read once. The product's stated problem is that setting up hiring here is too
 * manual — *"we need a proper user flow, guided, less manual work"* — and the smallest honest
 * answer to that is a system that says, in one sentence, which of the things it can see is
 * the one blocking you.
 *
 * Separating the decision from the rendering is what makes it reviewable. The ordering below
 * is a product judgement, and a product judgement buried in JSX is a product judgement
 * nobody ever revisits. Here it is a table of rules with a test per rule.
 *
 * ## The ordering, and why it is this one
 *
 * 1. **No roles.** Nothing else can be judged. A bank with no role to measure against is a
 *    pile of questions, which is the state this console used to leave people in.
 * 2. **A role that cannot be assessed at all.** A required skill with nothing published in
 *    its band means no assessment can be composed — work is blocked, not merely weaker.
 * 3. **Questions waiting for review.** Somebody else's work is stopped until this is done,
 *    and it is the only item here with a person on the other end of it.
 * 4. **A role that is thin.** Composable, but two candidates will see largely the same
 *    paper, which makes the comparison between them weaker than it looks (docs/18 §3.2).
 *    Below review because it degrades a result rather than preventing one.
 * 5. **Everything is ready.** Said plainly. A screen that only ever warns is a screen people
 *    learn to skim, and then the warning that mattered is skimmed too.
 *
 * Nothing here scores, ranks or recommends a candidate. It reports the state of the bank
 * against the roles the organisation defined, which is bookkeeping — ADR-011 and invariant 4
 * are about the decision path, and the decision path starts after a candidate exists.
 */

import { type ConsolePath } from '../app/routes.js';
import { type CoverageVerdict, type JobRoleView } from '../api/roles.js';

/** A role, with the verdict for it once its coverage has arrived. */
export interface RoleReadiness {
  readonly role: JobRoleView;
  /** `undefined` while the coverage query is in flight, or when it failed. */
  readonly verdict: CoverageVerdict | undefined;
}

/** What the dashboard knows when it decides. */
export interface GuidanceInput {
  readonly roles: readonly RoleReadiness[];
  /** How many questions are sitting in review on the first page. */
  readonly reviewCount: number;
  /** Whether there are more than that page holds, so the count reads as "at least". */
  readonly reviewHasMore: boolean;
}

/** The one thing to do next, and the link that starts it. */
export interface Guidance {
  /** Which rule fired. Stable, so a test names a rule rather than matching prose. */
  readonly rule: 'no-roles' | 'blocked' | 'review' | 'thin' | 'ready';
  readonly tone: 'info' | 'warning' | 'danger' | 'success';
  /**
   * The eyebrow above the title, overriding the tone's default word.
   *
   * `danger` labels itself "Error", which is right for a request that failed and wrong for
   * every state on this screen: a role with an unfillable skill is not a malfunction, it is
   * the system correctly reporting the shape of the bank. Calling it an error teaches people
   * that the red box means something broke — and then the red box that does mean that is
   * read as more of the same.
   */
  readonly label: string;
  readonly title: string;
  readonly body: string;
  readonly action: { readonly label: string; readonly to: ConsolePath } | undefined;
}

/** "Backend Engineer", or "Backend Engineer and 2 others". */
function naming(roles: readonly RoleReadiness[]): string {
  const [first, ...rest] = roles;
  if (first === undefined) return '';
  if (rest.length === 0) return first.role.title;
  return `${first.role.title} and ${String(rest.length)} other${rest.length === 1 ? '' : 's'}`;
}

/** The number of questions in review, phrased so it never overstates what was counted. */
function reviewPhrase(count: number, hasMore: boolean): string {
  const noun = count === 1 ? 'question is' : 'questions are';
  return hasMore ? `More than ${String(count)} ${noun}` : `${String(count)} ${noun}`;
}

/**
 * Decides the single next step.
 *
 * Roles whose coverage has not arrived are simply not counted — they are neither blocked nor
 * ready, and guessing either way would make the sentence flicker as queries land. The caller
 * withholds the panel entirely while the first load is in flight; this function's job is to
 * be correct about whatever it has been given, which is also what makes it testable.
 */
export function guidanceFor(input: GuidanceInput): Guidance {
  const { roles, reviewCount, reviewHasMore } = input;

  if (roles.length === 0) {
    return {
      rule: 'no-roles',
      label: 'Start here',
      tone: 'info',
      title: 'Start by saying what you are hiring for',
      body:
        'A role is a set of skills, each with a weight and a difficulty band. It is what an ' +
        'assessment is composed from and what the question bank is measured against — so ' +
        'until one exists, there is nothing for the bank to be good or bad at.',
      action: { label: 'Go to roles', to: '/roles' },
    };
  }

  const blocked = roles.filter((entry) => entry.verdict !== undefined && !entry.verdict.ready);
  if (blocked.length > 0) {
    const skills = new Set<string>();
    for (const entry of blocked) {
      for (const skill of entry.verdict?.blocked ?? []) skills.add(skill.skill_name);
    }

    return {
      rule: 'blocked',
      label: 'Blocked',
      tone: 'danger',
      title: `${naming(blocked)} cannot be assessed yet`,
      body:
        `${skills.size === 1 ? 'A required skill has' : `${String(skills.size)} required skills have`}` +
        ' no published question inside the difficulty band the role asks for, so no assessment ' +
        `can be composed: ${[...skills].sort((a, b) => a.localeCompare(b)).join(', ')}.`,
      action: { label: 'Add questions', to: '/questions' },
    };
  }

  if (reviewCount > 0) {
    return {
      rule: 'review',
      label: 'Waiting on you',
      tone: 'info',
      title: `${reviewPhrase(reviewCount, reviewHasMore)} waiting for review`,
      body:
        'A question stays out of every assessment until it is published, so a review queue ' +
        'is the bank not growing. This is the only thing here with somebody else waiting on ' +
        'the other end of it.',
      action: { label: 'Review them', to: '/questions' },
    };
  }

  const thin = roles.filter((entry) => (entry.verdict?.thin.length ?? 0) > 0);
  if (thin.length > 0) {
    return {
      rule: 'thin',
      label: 'Worth fixing',
      tone: 'warning',
      title: `${naming(thin)} can be assessed, but thinly`,
      body:
        'There are enough questions to compose an assessment and not enough to give two ' +
        'candidates meaningfully different ones. They will see largely the same paper, which ' +
        'makes comparing them weaker than the scores make it look.',
      action: { label: 'Add questions', to: '/questions' },
    };
  }

  return {
    rule: 'ready',
    label: 'All clear',
    tone: 'success',
    title: 'Every role you hire for can be measured',
    body:
      'Each required skill has published questions inside its band, with enough of them to ' +
      'draw a different set per candidate. Composing an assessment from a role arrives with ' +
      'the assessment engine in P3.',
    action: undefined,
  };
}
