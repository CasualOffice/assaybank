/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The seam between a route and the shell.
 *
 * A route needs three things from the chrome around it: to announce something, to say
 * what it is called when it becomes the current screen, and — once M1 starts attempts —
 * to hand over the server-issued countdown clock. It gets those through this context
 * rather than through props threaded down a router, and it gets nothing else.
 *
 * Keeping the surface this small is the point. The shell is the one component every
 * candidate screen renders inside, so a wide context here becomes a back door through
 * which any route can reach any other route's state.
 *
 * Note what a route deliberately *cannot* do through this API: it cannot move a
 * deadline. `setCountdownClock` accepts a clock built from a server response, and
 * `CountdownClock` itself has no method that adds or subtracts time (ADR-006).
 */

import type { ReactNode } from 'react';
import { createContext, useContext, useEffect } from 'react';

import type { ConnectionMonitor } from '../net/connection';
import type { CountdownClock } from '../time/countdown';
import type { AnnouncerChannel } from './announcer';

export interface CandidateShellApi {
  /** Publish to a live region, subject to that region's budget (docs/15 §5.1). */
  readonly announce: (channel: AnnouncerChannel, message: string) => void;
  /** Name the current screen for the route announcer. */
  readonly setRouteAnnouncement: (message: string) => void;
  /**
   * Install the countdown for the attempt in progress, or clear it.
   *
   * Built from a `POST /attempt/start` or heartbeat response, never from local time.
   */
  readonly setCountdownClock: (clock: CountdownClock | null) => void;
  /** The connection state machine, so a route's autosave can report buffering. */
  readonly connection: ConnectionMonitor;
}

const CandidateShellContext = createContext<CandidateShellApi | null>(null);

export interface CandidateShellProviderProps {
  readonly value: CandidateShellApi;
  readonly children: ReactNode;
}

export function CandidateShellProvider(props: CandidateShellProviderProps): ReactNode {
  return (
    <CandidateShellContext.Provider value={props.value}>
      {props.children}
    </CandidateShellContext.Provider>
  );
}

/**
 * Access the shell from a route.
 *
 * Throws rather than returning a no-op when used outside the shell: a silent no-op here
 * means an announcement that never reaches a screen-reader user, which is precisely the
 * class of bug that is invisible to everyone who can see the screen.
 */
export function useCandidateShell(): CandidateShellApi {
  const api = useContext(CandidateShellContext);
  if (api === null) {
    throw new Error('useCandidateShell was called outside CandidateShellProvider');
  }
  return api;
}

/**
 * Announce the current screen once, when it becomes current (docs/15 §8).
 *
 * A single-page application replaces the document without a page load, so the title
 * change a screen-reader user relies on never happens. Announcing the screen's name is
 * the replacement, and doing it in one hook means every route does it the same way
 * rather than each one improvising.
 */
export function useRouteAnnouncement(title: string): void {
  const { setRouteAnnouncement } = useCandidateShell();
  useEffect(() => {
    setRouteAnnouncement(title);
  }, [setRouteAnnouncement, title]);
}
