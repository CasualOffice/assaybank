/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from 'react';

import {
  AnnouncementQueue,
  ASSERTIVE_INTERVAL_MS,
  POLITE_INTERVAL_MS,
  type Politeness,
  ROUTE_INTERVAL_MS,
} from './announcer.js';

/**
 * The three regions of docs/15 §5.1, by id.
 *
 * Stable ids so an end-to-end test can assert on them, and so a bug report can name the
 * region that spoke.
 */
export const LIVE_REGION_IDS = Object.freeze({
  polite: 'ab-status-polite',
  assertive: 'ab-status-assertive',
  route: 'ab-route-announcer',
});

/** What a component uses to say something. */
export interface Announcer {
  /**
   * Announces a status message. Polite by default.
   *
   * Budgeted: one polite message per two seconds, one assertive per ten. A message
   * offered inside the window replaces whatever was waiting rather than joining a queue,
   * because the newer message is the current state.
   */
  announce: (message: string, politeness?: Politeness) => void;
  /**
   * Announces a navigation — "Questions. Staff console." — in the dedicated region, once
   * per navigation and unbudgeted (docs/15 §9.1).
   */
  announceRoute: (message: string) => void;
}

const AnnouncerContext = createContext<Announcer | null>(null);

/** Props for {@link LiveRegionProvider}. */
export interface LiveRegionProviderProps {
  children: ReactNode;
}

/**
 * Mounts the three live regions and provides {@link useAnnounce}.
 *
 * Wrap the whole application in exactly one of these, above the router. Three properties
 * of this component are the reason it exists rather than each screen adding an
 * `aria-live` attribute where it seemed useful:
 *
 * **The regions exist from first paint and start empty.** A region inserted into the DOM
 * at the same moment its content changes is frequently not announced at all — the screen
 * reader never observed it as a live region. This is the single most common reason a
 * correctly-written announcement is silent (docs/15 §5.1).
 *
 * **There are three, and only three.** Ad-hoc regions scattered through a screen are how
 * an application announces four things at once, of which a screen reader reads one at
 * random.
 *
 * **They are budgeted.** See `AnnouncementQueue`.
 */
export function LiveRegionProvider({ children }: LiveRegionProviderProps): ReactNode {
  const [polite, setPolite] = useState('');
  const [assertive, setAssertive] = useState('');
  const [route, setRoute] = useState('');

  const queues = useMemo(
    () => ({
      polite: new AnnouncementQueue({ intervalMs: POLITE_INTERVAL_MS }),
      assertive: new AnnouncementQueue({ intervalMs: ASSERTIVE_INTERVAL_MS }),
      route: new AnnouncementQueue({ intervalMs: ROUTE_INTERVAL_MS }),
    }),
    [],
  );

  useEffect(() => {
    const unsubscribe = [
      queues.polite.subscribe(setPolite),
      queues.assertive.subscribe(setAssertive),
      queues.route.subscribe(setRoute),
    ];

    return () => {
      for (const off of unsubscribe) {
        off();
      }
      queues.polite.dispose();
      queues.assertive.dispose();
      queues.route.dispose();
    };
  }, [queues]);

  const announcer = useMemo<Announcer>(
    () => ({
      announce: (message, politeness = 'polite') => {
        queues[politeness].push(message);
      },
      announceRoute: (message) => {
        queues.route.push(message);
      },
    }),
    [queues],
  );

  return (
    <AnnouncerContext.Provider value={announcer}>
      {/* Rendered before the application so the regions are in the DOM, and empty, from
          the very first commit. */}
      <LiveRegions polite={polite} assertive={assertive} route={route} />
      {children}
    </AnnouncerContext.Provider>
  );
}

/** Props for {@link LiveRegions}. */
export interface LiveRegionsProps {
  polite: string;
  assertive: string;
  route: string;
}

/**
 * The three regions themselves.
 *
 * Exported for tests and for the rare shell that manages its own state; an application
 * uses {@link LiveRegionProvider}, which renders this.
 *
 * `aria-atomic` is on so the whole message is read rather than the diff — a region that
 * announces only what changed turns "10 minutes remaining" into "10".
 */
export function LiveRegions({ polite, assertive, route }: LiveRegionsProps): ReactNode {
  return (
    <>
      <div
        id={LIVE_REGION_IDS.polite}
        className="ab-live-region"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {polite}
      </div>
      <div
        id={LIVE_REGION_IDS.assertive}
        className="ab-live-region"
        role="alert"
        aria-live="assertive"
        aria-atomic="true"
      >
        {assertive}
      </div>
      <div
        id={LIVE_REGION_IDS.route}
        className="ab-live-region"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {route}
      </div>
    </>
  );
}

/**
 * The announcer for the surrounding {@link LiveRegionProvider}.
 *
 * Throws when there is no provider. A no-op fallback would be friendlier and would mean
 * a screen-reader user silently receives nothing, which is the failure this whole module
 * exists to prevent — so it fails at the developer instead.
 */
export function useAnnounce(): Announcer {
  const announcer = useContext(AnnouncerContext);

  if (announcer === null) {
    throw new Error(
      'useAnnounce must be used inside a <LiveRegionProvider>. Mount one above the router: ' +
        'the live regions have to exist, and be empty, before anything tries to announce ' +
        '(docs/15 §5.1).',
    );
  }

  return announcer;
}
