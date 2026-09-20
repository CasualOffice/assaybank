/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { SkipLink } from '@assaybank/ui';
import { type ReactNode } from 'react';

import { Lockup } from './Lockup.js';
import { APP_NAME, SURFACE_NAME } from './routes.js';

/** The id the skip link targets and the router moves focus to. */
export const MAIN_CONTENT_ID = 'main-content';

/** Props for {@link AppShellLayout}. */
export interface AppShellLayoutProps {
  /** The grouped navigation. Supplied by the router-aware `ConsoleNav`. */
  nav: ReactNode;
  /** The page. */
  children: ReactNode;
}

/**
 * The console chrome: a fixed sidebar and a scrolling work area.
 *
 * ## Why a sidebar and not the top bar this replaced
 *
 * A horizontal bar is fine for four links and wrong for the twelve this console will have
 * by P6 — reports, interviews, integrations, settings, the review queue. A top bar answers
 * that by hiding things behind "More", which is where features go to be undiscovered. A
 * sidebar grows downwards, holds section headings so the twelve read as three groups of
 * four, and keeps the full width for the tables that are the actual work. It is what every
 * console of this shape converges on, and the convergence is not fashion: it is that the
 * content here is wide, dense and horizontally scrolled, so vertical chrome costs nothing
 * and horizontal chrome costs the thing the user came for.
 *
 * ## The accessibility contract, which the layout does not get to change
 *
 * - **The skip link is the first thing in the tab order.** A sidebar makes this matter
 *   more, not less: without it every keyboard user tabs through every navigation item on
 *   every page before reaching the table they are trying to read.
 * - **One `<main>`, one `<header>`, one named `<nav>`.** Landmarks are how a screen-reader
 *   user moves around a page without reading it.
 * - **`aria-current="page"`** marks the active item, alongside a visible indicator that is
 *   not only a colour (SC 1.4.1) — the active item carries a bar and a weight change.
 * - **The sidebar scrolls independently of the page**, so a long navigation never pushes
 *   the work area, and `--ab-sticky-top` stays honest for SC 2.4.11.
 *
 * The surfaces follow the token layer rather than fighting it: the sidebar is
 * `surface-sunken` against a `surface` work area, which is a one-token separation that
 * survives both themes. An inverse sidebar would need the accent to clear 3:1 on an
 * inverse ground, which `NON_TEXT_CONTRAST_PAIRS` in `@assaybank/ui` says it does not.
 */
export function AppShellLayout({ nav, children }: AppShellLayoutProps): ReactNode {
  return (
    <div className="ab-console">
      <SkipLink targetId={MAIN_CONTENT_ID}>Skip to main content</SkipLink>

      <header className="ab-console__sidebar">
        <div className="ab-console__brand">
          {/* The lockup inherits currentColor, so it is ink in the light theme and paper
              in the dark one with no second asset and no theme branch. */}
          <Lockup className="ab-console__lockup" title={`${APP_NAME} ${SURFACE_NAME}, home`} />
        </div>

        <nav className="ab-console__nav" aria-label={SURFACE_NAME}>
          {nav}
        </nav>

        {/* Not decoration. ADR-007 and ADR-011 are the product's central constraint, and a
            console that quietly drifted towards ranking candidates would do it one screen
            at a time — so the sentence sits where every screen carries it. */}
        <footer className="ab-console__footer">
          <p>Assessment results are evidence for a human decision, never a decision.</p>
        </footer>
      </header>

      <main id={MAIN_CONTENT_ID} className="ab-console__main" tabIndex={-1}>
        <div className="ab-console__work">{children}</div>
      </main>
    </div>
  );
}
