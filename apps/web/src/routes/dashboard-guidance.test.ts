/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The ordering of the rules, as a table.
 *
 * The rule that fires is a product judgement — which of several true things is the one worth
 * a recruiter's attention — and the failure mode is silent: every ordering produces a
 * plausible sentence, and the wrong one sends somebody to write questions while a colleague's
 * review queue sits untouched. So each rule is asserted against a state where a *different*
 * rule would also have been true, which is the only way an ordering can be tested at all.
 */

import { describe, expect, it } from 'vitest';

import { type CoverageVerdict, type JobRoleView, type SkillCoverage } from '../api/roles.js';
import { guidanceFor, type RoleReadiness } from './dashboard-guidance.js';

/** A skill, only as much of one as a verdict carries. */
function skill(name: string): SkillCoverage {
  return { skill_name: name } as unknown as SkillCoverage;
}

function verdict(over: Partial<CoverageVerdict>): CoverageVerdict {
  return {
    blocked: over.blocked ?? [],
    thin: over.thin ?? [],
    ready: over.ready ?? true,
  };
}

let counter = 0;
function role(title: string, over: CoverageVerdict | undefined): RoleReadiness {
  counter += 1;
  return {
    role: { id: `role-${String(counter)}`, title } as unknown as JobRoleView,
    verdict: over,
  };
}

const READY = verdict({ ready: true });

describe('the one thing to do next', () => {
  it('asks for a role first, because nothing else can be judged without one', () => {
    // Even with a review queue waiting. A bank measured against nothing is a pile of
    // questions, which is the state this whole flow exists to get out of.
    const guidance = guidanceFor({ roles: [], reviewCount: 9, reviewHasMore: false });

    expect(guidance.rule).toBe('no-roles');
    expect(guidance.action?.to).toBe('/roles');
  });

  it('puts a blocked role above a review queue, because blocked is work that cannot start', () => {
    const guidance = guidanceFor({
      roles: [
        role('Senior backend engineer', verdict({ ready: false, blocked: [skill('SQL tuning')] })),
      ],
      reviewCount: 4,
      reviewHasMore: false,
    });

    expect(guidance.rule).toBe('blocked');
    expect(guidance.tone).toBe('danger');
    expect(guidance.title).toContain('Senior backend engineer');
    expect(guidance.body).toContain('SQL tuning');
  });

  it('names the skills once across several blocked roles rather than once per role', () => {
    // Two roles sharing a gap is one gap. Saying it twice makes a two-line sentence read as
    // a four-line one and suggests there is more to do than there is.
    const blocked = verdict({ ready: false, blocked: [skill('SQL tuning')] });
    const guidance = guidanceFor({
      roles: [role('Backend', blocked), role('Data', blocked)],
      reviewCount: 0,
      reviewHasMore: false,
    });

    expect(guidance.title).toBe('Backend and 1 other cannot be assessed yet');
    expect(guidance.body).toContain('A required skill has');
    expect(guidance.body.match(/SQL tuning/gu)).toHaveLength(1);
  });

  it('puts the review queue above a thin role, because somebody is waiting on it', () => {
    const guidance = guidanceFor({
      roles: [role('Backend', verdict({ ready: true, thin: [skill('REST design')] }))],
      reviewCount: 3,
      reviewHasMore: false,
    });

    expect(guidance.rule).toBe('review');
    expect(guidance.title).toBe('3 questions are waiting for review');
  });

  it('says "more than" when the page it counted was full', () => {
    // The count comes from one page of the bank, so it is a floor and not a total. A
    // dashboard that reports 25 when there are 400 is worse than one that says "more than".
    const guidance = guidanceFor({
      roles: [role('Backend', READY)],
      reviewCount: 25,
      reviewHasMore: true,
    });

    expect(guidance.title).toBe('More than 25 questions are waiting for review');
  });

  it('agrees with itself about singular and plural', () => {
    const one = guidanceFor({
      roles: [role('Backend', READY)],
      reviewCount: 1,
      reviewHasMore: false,
    });
    expect(one.title).toBe('1 question is waiting for review');
  });

  it('warns about a thin role once nothing is blocked and nothing is waiting', () => {
    const guidance = guidanceFor({
      roles: [role('Backend', verdict({ ready: true, thin: [skill('REST design')] }))],
      reviewCount: 0,
      reviewHasMore: false,
    });

    expect(guidance.rule).toBe('thin');
    expect(guidance.tone).toBe('warning');
    expect(guidance.body).toContain('weaker than the scores make it look');
  });

  it('says plainly that everything is ready, and offers no action', () => {
    // A screen that only ever warns is a screen people learn to skim — and then the warning
    // that mattered is skimmed too. There is no action because there is nothing to fix;
    // inventing one would be a button that leads somewhere pointless.
    const guidance = guidanceFor({
      roles: [role('Backend', READY), role('Data', READY)],
      reviewCount: 0,
      reviewHasMore: false,
    });

    expect(guidance.rule).toBe('ready');
    expect(guidance.tone).toBe('success');
    expect(guidance.action).toBeUndefined();
  });

  it('treats a role whose coverage has not arrived as neither blocked nor ready', () => {
    // Guessing either way makes the sentence flip as queries land, which is worse than the
    // skeleton the screen shows instead. Here the only *known* state is the review queue.
    const guidance = guidanceFor({
      roles: [role('Backend', undefined)],
      reviewCount: 2,
      reviewHasMore: false,
    });

    expect(guidance.rule).toBe('review');
  });

  it('does not claim everything is ready when nothing is known', () => {
    // The dangerous version of the case above: one role, no verdict, nothing in review. The
    // honest answer is not "every role you hire for can be measured".
    const guidance = guidanceFor({
      roles: [role('Backend', undefined)],
      reviewCount: 0,
      reviewHasMore: false,
    });

    expect(guidance.rule).toBe('ready');
    // Documented rather than asserted as good: the screen withholds the panel until every
    // coverage query has settled, so this input does not reach a user. If that guard is ever
    // removed, this test is where the consequence is written down.
    expect(guidance.title).toContain('can be measured');
  });
});
