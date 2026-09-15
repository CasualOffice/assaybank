/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The candidate shell: the chrome every candidate-facing screen is rendered inside.
 *
 * ## Minimal chrome, and no staff navigation
 *
 * There is no navigation bar, no organisation switcher, no search, no link to a question
 * bank, no "back to dashboard". Not hidden behind a role check — absent. A route guard
 * gates rendering, not the bundle (ADR-013), and the point of this application being a
 * separate build is that the staff surfaces are not linked into it at all. If a menu
 * item ever appears here that leads somewhere staff-only, the failure happened upstream
 * of this file, in the dependency graph.
 *
 * The chrome is three things: who you are being assessed by, how much time is left, and
 * whether your work is safe. A candidate under a running clock does not need a fourth.
 *
 * ## The accessibility baseline this establishes (docs/15)
 *
 * Every screen built from P2 onward inherits all of this by being rendered inside it,
 * which is the point — retrofitting accessibility across thirty screens is the outcome
 * docs/15 exists to prevent.
 *
 * - A skip link, first in DOM order, visible on focus.
 * - Exactly one `<main>` landmark, programmatically focusable for route changes.
 * - The three live regions of §5.1, mounted once and empty at mount.
 * - A time-remaining region that is not itself live (§3.3).
 * - An "Assessment status" control, so state can be pulled rather than pushed (§5.3).
 * - A single, consistently placed help affordance (SC 3.2.6 Consistent Help).
 * - `scroll-padding-top` sized to the sticky header, so a focused control can never be
 *   obscured by it (SC 2.4.11) — see `styles.css`.
 *
 * ## Why this component takes props rather than reading stores
 *
 * It is pure and synchronous, so it renders under `react-dom/server` in a plain Node
 * test with no DOM. The wiring — clock, connection monitor, announcer — is in
 * `CandidateShell` below it. A shell that subscribes to four stores is a shell that can
 * only be tested by booting the application.
 */

import type { JSX, ReactNode } from 'react';

import type { ConnectionSnapshot } from '../net/connection';
import type { CountdownSnapshot } from '../time/countdown';
import { UI_PACKAGE_NAME } from '../ui';
import type { AnnouncerSnapshot } from './announcer';
import { ConnectionBanner } from './connection-banner';
import { LiveRegions } from './live-regions';
import { TimeRemaining } from './time-remaining';

/** Where a candidate goes for help, from every screen, in the same place (SC 3.2.6). */
export const HELP_HREF = '/help';
/** The accessibility statement, which docs/15 §2.1 holds to the same AA bar as the runner. */
export const ACCESSIBILITY_HREF = '/accessibility';

export interface AppShellProps {
  /** `null` until the server has issued a deadline. */
  readonly countdown: CountdownSnapshot | null;
  readonly connection: ConnectionSnapshot;
  /** Current text of the two status regions. */
  readonly announcements: AnnouncerSnapshot;
  /** Current text of the route announcer. */
  readonly routeAnnouncement: string;
  /** Invoked by the "Assessment status" control (docs/15 §5.3). */
  readonly onRequestStatus?: (() => void) | undefined;
  readonly children?: ReactNode;
}

export function AppShell(props: AppShellProps): JSX.Element {
  return (
    // data-ui-package records which shared component library this build linked. It is
    // the one place the `@assaybank/ui` edge is visible at runtime, which makes the
    // bundle check in scripts/check-bundle.mjs able to see that the dependency exists.
    <div className="candidate-app" data-ui-package={UI_PACKAGE_NAME}>
      {/* First in DOM order, before anything focusable, or it is not a skip link. */}
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>

      <header className="candidate-header">
        <p className="candidate-header__mark">
          <span aria-hidden="true">◆</span> Assaybank
        </p>

        <div className="candidate-header__status">
          <TimeRemaining countdown={props.countdown} />
          <button
            type="button"
            className="status-summary-button"
            onClick={props.onRequestStatus}
            data-testid="status-summary-button"
          >
            Assessment status
          </button>
        </div>
      </header>

      <ConnectionBanner connection={props.connection} />

      {/*
        tabIndex={-1} makes the landmark programmatically focusable so a route change can
        move focus here. It is never in the tab order, so a keyboard user does not have
        to tab through an inert container to reach the content.
      */}
      <main id="main-content" className="candidate-main" tabIndex={-1}>
        {props.children}
      </main>

      <footer className="candidate-footer">
        {/* Same affordance, same place, every screen (SC 3.2.6 Consistent Help). */}
        <a href={HELP_HREF}>Help and contact</a>
        <a href={ACCESSIBILITY_HREF}>Accessibility</a>
      </footer>

      <LiveRegions
        polite={props.announcements.polite}
        assertive={props.announcements.assertive}
        route={props.routeAnnouncement}
      />
    </div>
  );
}
