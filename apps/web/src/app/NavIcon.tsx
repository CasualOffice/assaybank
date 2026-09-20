/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { type ReactNode } from 'react';

import { type ConsolePath } from './routes.js';

/**
 * The sidebar's icons.
 *
 * **They are decoration and are marked as such.** `aria-hidden` with the label beside them
 * as real text: an icon-only navigation forces a screen-reader user to rely on an
 * `aria-label` that nobody tests, and forces a sighted user to learn four glyphs. The icon's
 * job is to give the eye a fixed landmark per row so the list is scanned by shape rather
 * than re-read — which is what makes a twelve-item sidebar usable at a glance.
 *
 * Drawn inline rather than loaded: four icons is less markup than the request that would
 * fetch them, they inherit `currentColor` so the active and hover states need no second
 * asset, and a sprite that fails to load leaves a navigation of blank squares.
 *
 * One consistent construction — a 16px box, a 1.5px stroke on a 24px grid scaled down,
 * square caps rounded — because a set drawn at different weights reads as four icons
 * borrowed from four places, which is the specific thing that makes an interface look
 * assembled rather than designed.
 */

const PATHS: Readonly<Record<ConsolePath, ReactNode>> = {
  // Four panes: the shape every console uses for "everything at a glance".
  '/': (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </>
  ),
  // A stack, not a question mark: the bank is a collection of versioned things, and a
  // question mark would read as "help" on every console anyone has used.
  '/questions': (
    <>
      <path d="M12 3 3 7.5l9 4.5 9-4.5L12 3Z" />
      <path d="m3 12.5 9 4.5 9-4.5" />
      <path d="m3 17 9 4.5 9-4.5" />
    </>
  ),
  // A briefcase: the job, which is what a role is. Not a person — that is `/candidates`
  // below, and the two must not read as variations of one another.
  '/roles': (
    <>
      <rect x="2.5" y="7" width="19" height="13" rx="2" />
      <path d="M9 7V5.5a1.5 1.5 0 0 1 1.5-1.5h3A1.5 1.5 0 0 1 15 5.5V7" />
      <path d="M2.5 12h19" />
    </>
  ),
  // A checklist on a clipboard: a composed assessment is a list of things to be done.
  '/assessments': (
    <>
      <path d="M9 4H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-2" />
      <rect x="9" y="2.5" width="6" height="3.5" rx="1" />
      <path d="m8.5 12 2 2 4-4" />
    </>
  ),
  // A person. The only one of the four that is a literal depiction, because a candidate
  // is the only one of the four that is a person.
  '/candidates': (
    <>
      <circle cx="12" cy="8" r="3.5" />
      <path d="M4.5 20a7.5 7.5 0 0 1 15 0" />
    </>
  ),
};

/** Props for {@link NavIcon}. */
export interface NavIconProps {
  /** Which route's icon to draw. */
  path: ConsolePath;
}

/** The 16px icon for a navigation item. Decorative; the label beside it carries the name. */
export function NavIcon({ path }: NavIconProps): ReactNode {
  return (
    <svg
      className="ab-console__nav-icon"
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[path]}
    </svg>
  );
}
