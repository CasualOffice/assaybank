/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The three live regions of docs/15 §5.1.
 *
 * ## Mounted once, emptied never
 *
 * A live region added to the DOM at the same moment its content changes is frequently
 * not announced at all — the assistive technology has to have been watching the node
 * before the mutation. So these three elements are rendered by the shell, above the
 * router outlet, for the whole life of the application, and are empty at mount. Nothing
 * may conditionally render them, and no route may add a fourth.
 *
 * | Region              | ARIA                                                | Carries |
 * |---------------------|-----------------------------------------------------|---------|
 * | `#status-polite`    | `role="status"` `aria-live="polite"` atomic         | autosave transitions, execution progress, queue status |
 * | `#status-assertive` | `role="alert"` `aria-live="assertive"` atomic       | 1-minute warning, submission failure, connection lost |
 * | `#route-announcer`  | `role="status"` `aria-live="polite"`               | question navigation and route changes |
 *
 * `aria-atomic` is set on the two status regions so the whole message is read rather
 * than the diff — a partial re-read of "5 minutes remaining" as "5" is worse than
 * silence. The route announcer is left non-atomic because it always replaces its entire
 * content anyway.
 *
 * Budgets, coalescing and the decision about *what* is announced live in `announcer.ts`
 * and docs/15 §5.2 respectively. This component only renders.
 *
 * When `packages/ui` publishes its shared `LiveRegion` primitive (tracker H-125), this
 * file becomes a re-export from `src/ui.ts`. Until then it is written to the same
 * specification so that swap is a deletion.
 */

import type { JSX } from 'react';

/** Stable element ids, so a test or a future `aria-describedby` can address a region. */
export const LIVE_REGION_IDS = {
  polite: 'status-polite',
  assertive: 'status-assertive',
  route: 'route-announcer',
} as const;

/** Current text for each region. Empty string means "nothing to announce". */
export interface LiveRegionsProps {
  readonly polite: string;
  readonly assertive: string;
  readonly route: string;
}

/**
 * Visually hidden, but not hidden from assistive technology.
 *
 * `display: none` and `visibility: hidden` both remove a node from the accessibility
 * tree, which would make a live region that announces nothing — the single most common
 * way to ship a broken one. The `.visually-hidden` class in `styles.css` uses the
 * clip-rect technique instead.
 */
export function LiveRegions(props: LiveRegionsProps): JSX.Element {
  return (
    <>
      <div
        id={LIVE_REGION_IDS.polite}
        className="visually-hidden"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {props.polite}
      </div>
      <div
        id={LIVE_REGION_IDS.assertive}
        className="visually-hidden"
        role="alert"
        aria-live="assertive"
        aria-atomic="true"
      >
        {props.assertive}
      </div>
      <div id={LIVE_REGION_IDS.route} className="visually-hidden" role="status" aria-live="polite">
        {props.route}
      </div>
    </>
  );
}
