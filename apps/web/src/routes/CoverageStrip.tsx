/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A role's coverage, per required skill, as numbers.
 *
 * ## Why this exists
 *
 * The dashboard described coverage in sentences — *"thin on Dynamic programming"* — and a
 * sentence cannot answer the question a recruiter actually has, which is **how thin**. Three
 * questions and nine questions produce the same sentence and are entirely different
 * situations: one is a morning's authoring, the other is a quarter's. A product whose whole
 * subject is what the bank can measure was showing no figures at all.
 *
 * So each required skill gets its count and a bar against a fixed scale. The bar is there to
 * make the comparison between skills pre-attentive — which is the one thing a column of
 * numbers is bad at — and the number is there because the bar is an approximation and the
 * count is the fact.
 *
 * ## The scale is fixed, and capped
 *
 * `COMFORTABLE_BAND_TARGET` is a full bar. A bar scaled to the largest value on screen would
 * redraw itself every time somebody published a question, and two roles would be
 * incomparable; a bar that grew without limit would squash everything else into the first
 * pixel. The count is never capped, so a skill with forty reads as full and says forty.
 *
 * ## Colour repeats the number, it does not carry it
 *
 * Tone comes from the same thresholds the verdict uses, so the bar and the badge above it can
 * never disagree. A screen reader gets the count and the band from the text; the bar itself is
 * `aria-hidden`, because a decorative length conveys nothing that the number beside it does
 * not already say (SC 1.4.1).
 */

import { type ReactNode } from 'react';

import { bandFill, bandLabel, bandTone, type SkillCoverage } from '../api/roles.js';

/** How many skills a strip shows before it stops and counts the rest. */
export const STRIP_LIMIT = 4;

/** Props for {@link CoverageStrip}. */
export interface CoverageStripProps {
  /** Every skill of the role. Optional ones are dropped here, not by the caller. */
  skills: readonly SkillCoverage[];
  /** How many rows to show. Defaults to {@link STRIP_LIMIT}. */
  limit?: number;
}

export function CoverageStrip({ skills, limit = STRIP_LIMIT }: CoverageStripProps): ReactNode {
  // Required only, and worst first. A strip that led with the healthy skills would bury the
  // one that is blocking the role under the ones that are fine.
  const required = [...skills]
    .filter((skill) => skill.is_required)
    .sort((a, b) => a.in_band - b.in_band);

  if (required.length === 0) return null;

  const shown = required.slice(0, limit);
  const rest = required.length - shown.length;

  return (
    <div className="ab-strip">
      {shown.map((skill) => (
        <div className="ab-strip__row" key={skill.skill_id}>
          <span className="ab-strip__name" title={`${skill.skill_name} · ${bandLabel(skill)}`}>
            {skill.skill_name}
          </span>
          <span
            className={`ab-strip__track ab-strip__track--${bandTone(skill)}`}
            aria-hidden="true"
          >
            <span
              className="ab-strip__fill"
              style={{ inlineSize: `${String(bandFill(skill) * 100)}%` }}
            />
          </span>
          <span className="ab-strip__count">
            {skill.in_band}
            {/* The band is what the count is *of*, and without it the number is unreadable:
                "3" means nothing until you know it is 3 at difficulty 2–4. */}
            <span className="ab-visually-hidden"> in band, {bandLabel(skill)}</span>
          </span>
        </div>
      ))}

      {rest > 0 ? (
        <p className="ab-strip__rest">
          {rest} more required skill{rest === 1 ? '' : 's'}
        </p>
      ) : null}
    </div>
  );
}
