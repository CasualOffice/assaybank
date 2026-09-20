/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Link } from '@tanstack/react-router';
import { type ReactNode } from 'react';

import { type ConsolePath } from './routes.js';

/**
 * One step in the trail. The last has no `to` — it is where you are.
 */
export interface Crumb {
  readonly label: string;
  readonly to?: ConsolePath;
}

/** Props for {@link PageBar}. */
export interface PageBarProps {
  /** The trail, outermost first. The last entry is the current page. */
  crumbs: readonly Crumb[];
  /** The page's actions. They stay reachable while the page scrolls. */
  children?: ReactNode;
}

/**
 * The bar at the top of the work area: where you are, and what you can do here.
 *
 * ## Why it is sticky and the page title is not
 *
 * These screens are long — a bank of four thousand questions is a table you scroll for a
 * while — and two things must survive that scroll. **Where you are**, because a table of
 * rows with no header above it is a table you have to scroll back up to identify; and **the
 * primary action**, because "new question" occurring to you on row 200 should not cost a
 * journey back to the top. Everything else — the title, the sentence explaining the screen —
 * is read once on arrival and is better out of the way afterwards, so it scrolls.
 *
 * The bar is 3rem and sets `--ab-sticky-top` to its own height, which `base.css` feeds into
 * `scroll-padding-top`. That is SC 2.4.11 Focus Not Obscured, and it is the reason a
 * keyboard user tabbing down a long table never lands on a row hidden underneath this.
 *
 * ## The trail is a trail, not a title repeated
 *
 * A single-item breadcrumb is decoration. This renders only when there is somewhere above
 * the current page to name, and the last item carries `aria-current="page"` rather than
 * being a link to where the user already is — a link that does nothing is a link that
 * teaches a screen-reader user to distrust the ones that do.
 */
export function PageBar({ crumbs, children }: PageBarProps): ReactNode {
  const last = crumbs.length - 1;

  return (
    <div className="ab-pagebar">
      <nav className="ab-pagebar__trail" aria-label="Breadcrumb">
        <ol className="ab-pagebar__crumbs">
          {crumbs.map((crumb, index) => (
            <li className="ab-pagebar__crumb" key={crumb.label}>
              {crumb.to === undefined || index === last ? (
                <span
                  className={index === last ? 'ab-pagebar__here' : 'ab-pagebar__step'}
                  {...(index === last ? { 'aria-current': 'page' as const } : {})}
                >
                  {crumb.label}
                </span>
              ) : (
                <Link className="ab-pagebar__link" to={crumb.to}>
                  {crumb.label}
                </Link>
              )}
              {/* The separator is a presentational glyph, hidden from the accessibility
                  tree: a screen reader reading "Question bank slash Questions" is being
                  read punctuation, and the list already conveys the nesting. */}
              {index < last ? (
                <span className="ab-pagebar__sep" aria-hidden="true">
                  /
                </span>
              ) : null}
            </li>
          ))}
        </ol>
      </nav>

      {children === undefined ? null : <div className="ab-pagebar__actions">{children}</div>}
    </div>
  );
}
