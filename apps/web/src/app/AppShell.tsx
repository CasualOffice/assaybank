/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { SkipLink } from '@assaybank/ui';
import { type ReactNode } from 'react';

import { Lockup } from './Lockup.js';
import { APP_NAME, SURFACE_NAME } from './routes.js';

/**
 * The id the skip link targets. Exported so the link and the landmark cannot drift apart
 * — a skip link pointing at an id that no longer exists is a bypass block that silently
 * does nothing.
 */
export const MAIN_CONTENT_ID = 'main-content';

/** Props for {@link AppShellLayout}. */
export interface AppShellLayoutProps {
  /** The navigation list. Supplied by the router-aware {@link AppShell}. */
  nav: ReactNode;
  /** The page. */
  children: ReactNode;
}

/**
 * The console chrome, with no router dependency.
 *
 * Split from {@link AppShell} so the layout — which is where the accessibility baseline
 * lives — can be rendered and asserted without a router context. That is not a testing
 * convenience bolted on afterwards: the landmark structure and the DOM order below are the
 * things every screen from P2 onward inherits, and they have to be verifiable on their
 * own.
 *
 * The structure, and why each part is the way it is:
 *
 * - **The skip link is first in the DOM**, so it is the first thing a keyboard user
 *   reaches (SC 2.4.1). It targets a `<main>` carrying `tabIndex={-1}`, without which the
 *   browser scrolls but leaves focus where it was — the failure that makes a skip link
 *   look implemented and not be (docs/15 §9.3).
 * - **One `<main>`, one `<header>`, one named `<nav>`.** Landmarks are how a screen-reader
 *   user moves around a page without reading it, and an unnamed `<nav>` in a page with two
 *   of them is a list of "navigation, navigation".
 * - **`aria-current="page"`** marks the active item, alongside a visible indicator that is
 *   not only a colour (SC 1.4.1).
 * - **The header is `surface-raised`, not an inverse panel.** An inverse header would have
 *   to carry the accent for its active-nav indicator, and the accent cannot clear 3:1 on
 *   an inverse surface in both themes — see `NON_TEXT_CONTRAST_PAIRS` in
 *   `@assaybank/ui`. The layout follows the token layer rather than fighting it.
 */
export function AppShellLayout({ nav, children }: AppShellLayoutProps): ReactNode {
  return (
    <div className="ab-console">
      <SkipLink targetId={MAIN_CONTENT_ID}>Skip to main content</SkipLink>

      <header className="ab-console__header">
        <div className="ab-console__brand">
          {/* The lockup inherits currentColor, so it is ink in the light theme and paper
              in the dark one with no second asset and no theme branch. */}
          <Lockup className="ab-console__lockup" title={`${APP_NAME} ${SURFACE_NAME}, home`} />
        </div>
        <nav className="ab-console__nav" aria-label={SURFACE_NAME}>
          <ul className="ab-console__nav-list">{nav}</ul>
        </nav>
      </header>

      <main id={MAIN_CONTENT_ID} className="ab-console__main" tabIndex={-1}>
        {children}
      </main>

      <footer className="ab-console__footer">
        <p>
          {APP_NAME} {SURFACE_NAME}. Assessment results are evidence for a human decision, never a
          decision.
        </p>
      </footer>
    </div>
  );
}
