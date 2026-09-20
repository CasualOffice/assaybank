/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The strip that turned coverage from a sentence into figures.
 *
 * The property worth pinning is not that it renders — it is that the **number** is always
 * there. A bar is an approximation on a fixed scale, and the moment somebody decides the bar
 * is enough on its own, a skill with 12 and a skill with 40 become indistinguishable and the
 * screen is back to saying "lots" in a more expensive way.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { SkillCoverageSchema } from '@assaybank/contracts';

import { COMFORTABLE_BAND_TARGET, type SkillCoverage } from '../api/roles.js';
import { CoverageStrip, STRIP_LIMIT } from './CoverageStrip.js';

let seq = 0;
function skill(over: { name: string; inBand: number; required?: boolean }): SkillCoverage {
  seq += 1;
  return SkillCoverageSchema.parse({
    skill_id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    skill_key: over.name.toLowerCase().replace(/[^a-z]+/gu, '.'),
    skill_name: over.name,
    is_required: over.required ?? true,
    weight: 1,
    min_difficulty: 2,
    max_difficulty: 4,
    in_band: over.inBand,
    published: over.inBand,
    by_difficulty: { '1': 0, '2': over.inBand, '3': 0, '4': 0, '5': 0 },
  });
}

const render = (skills: readonly SkillCoverage[], limit?: number): string =>
  renderToStaticMarkup(
    limit === undefined ? (
      <CoverageStrip skills={skills} />
    ) : (
      <CoverageStrip skills={skills} limit={limit} />
    ),
  );

const text = (markup: string): string =>
  markup
    .replace(/<[^>]*>/gu, ' ')
    .replace(/&#x27;/gu, "'")
    .replace(/\s+/gu, ' ')
    .trim();

/** The widths of the rendered fills, in source order. */
function fills(markup: string): number[] {
  return [...markup.matchAll(/inline-size:\s*([\d.]+)%/gu)].map((m) => Number(m[1]));
}

describe('the number is the fact and the bar is the approximation', () => {
  it('prints the count for every skill it shows', () => {
    const body = text(render([skill({ name: 'Algorithms', inBand: 12 })]));

    expect(body).toContain('Algorithms');
    expect(body).toContain('12');
  });

  it('prints a zero rather than an empty cell', () => {
    // The blocking case. An empty cell reads as "not measured"; 0 reads as "measured, and
    // there is nothing" — which is the whole difference between the two.
    expect(text(render([skill({ name: 'Sorting', inBand: 0 })]))).toContain('0');
  });

  it('keeps counting past the point the bar stops growing', () => {
    // The bar is capped so the scale stays comparable; the count never is, or a bank with
    // forty in a band would read the same as one with ten.
    const body = text(render([skill({ name: 'Algorithms', inBand: 40 })]));

    expect(body).toContain('40');
    expect(fills(render([skill({ name: 'Algorithms', inBand: 40 })]))).toEqual([100]);
  });

  it('scales the bar against a fixed target, not against the largest value present', () => {
    // A bar scaled to the biggest number on screen redraws itself whenever somebody
    // publishes a question, and two roles become incomparable.
    const half = COMFORTABLE_BAND_TARGET / 2;
    const one = fills(render([skill({ name: 'A', inBand: half })]));
    const withBigger = fills(
      render([skill({ name: 'A', inBand: half }), skill({ name: 'B', inBand: 40 })]),
    );

    expect(one).toEqual([50]);
    expect(withBigger[0]).toBe(50);
  });
});

describe('what it shows, and in what order', () => {
  it('puts the worst skill first, because that is the one blocking the role', () => {
    const body = text(
      render([
        skill({ name: 'Deep', inBand: 14 }),
        skill({ name: 'Empty', inBand: 0 }),
        skill({ name: 'Middling', inBand: 5 }),
      ]),
    );

    expect(body.indexOf('Empty')).toBeLessThan(body.indexOf('Middling'));
    expect(body.indexOf('Middling')).toBeLessThan(body.indexOf('Deep'));
  });

  it('ignores optional skills, which do not decide whether a role can be assessed', () => {
    const body = text(
      render([
        skill({ name: 'Required one', inBand: 6 }),
        skill({ name: 'Nice to have', inBand: 0, required: false }),
      ]),
    );

    expect(body).toContain('Required one');
    expect(body).not.toContain('Nice to have');
  });

  it('stops at the limit and says how many it did not show', () => {
    const many = Array.from({ length: STRIP_LIMIT + 3 }, (_, i) =>
      skill({ name: `Skill ${String(i)}`, inBand: i }),
    );

    expect(text(render(many))).toContain('3 more required skills');
  });

  it('says "skill" rather than "skills" when one is left over', () => {
    const many = Array.from({ length: STRIP_LIMIT + 1 }, (_, i) =>
      skill({ name: `Skill ${String(i)}`, inBand: i }),
    );

    expect(text(render(many))).toContain('1 more required skill');
    expect(text(render(many))).not.toContain('1 more required skills');
  });

  it('renders nothing at all when a role has no required skill', () => {
    expect(render([skill({ name: 'Optional', inBand: 3, required: false })])).toBe('');
  });
});

describe('the accessible reading', () => {
  it('hides the bar and gives a screen reader the band the count is of', () => {
    // "3" is meaningless without "at difficulty 2–4". The bar conveys nothing the number
    // does not, so it is decoration and says so (SC 1.4.1).
    const markup = render([skill({ name: 'Algorithms', inBand: 3 })]);

    expect(markup).toContain('aria-hidden="true"');
    expect(text(markup)).toContain('in band, difficulty 2–4');
  });
});
