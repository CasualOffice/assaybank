/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The offline / reconnect banner.
 *
 * ## Why this is in the shell and not in the runner
 *
 * A candidate losing work is the failure that ends trust in an assessment platform.
 * There is no apology for it and no way to give the time back, so the reassurance has to
 * be present on every screen the candidate can be on when the network goes — including
 * the ones that have not been built yet. Putting the banner in the shell means a route
 * added in M2 inherits it rather than remembering it.
 *
 * ## What it says, and why the wording is specific
 *
 * "Offline" is a status. "You are offline; your work is saved on this device and will
 * sync when you reconnect" is an answer to the question the candidate is actually
 * asking, which is whether the last twenty minutes still exist. The strings live in
 * `../net/connection.ts` next to the state machine that decides which one applies.
 *
 * ## Accessibility
 *
 * - The banner is **not** itself a live region. The announcement goes through the shared
 *   polite region (docs/15 §5.1) so it is subject to the same budget as everything else;
 *   a second `aria-live` node here is how an application ends up reading two messages at
 *   once.
 * - It is rendered before `<main>` in DOM order and is a `<section>` with an accessible
 *   name, so a screen-reader user who lands on it by navigating regions gets context.
 * - It never uses colour alone (SC 1.4.1): each state carries its own text and glyph.
 * - It does not steal focus. A candidate mid-sentence when the network drops must not
 *   lose their caret — the information is not worth the interruption, and taking focus
 *   during a timed exam is close to hostile.
 * - It is not `position: fixed`, so it cannot obscure a focused control (SC 2.4.11).
 */

import type { JSX } from 'react';

import type { ConnectionSnapshot } from '../net/connection';
import { CONNECTION_BANNER_TEXT } from '../net/connection';

/** Glyphs paired with the text, never standing in for it. */
const STATE_MARK = {
  online: '',
  offline: '⚠',
  reconnecting: '↻',
  syncing: '↑',
} as const;

export interface ConnectionBannerProps {
  readonly connection: ConnectionSnapshot;
}

export function ConnectionBanner(props: ConnectionBannerProps): JSX.Element | null {
  const { state, pendingWrites } = props.connection;
  const text = CONNECTION_BANNER_TEXT[state];

  // `online` with nothing buffered is the ordinary case and says nothing. A banner that
  // is always present is a banner nobody reads when it matters.
  if (text === null) return null;

  return (
    <section
      className={`connection-banner connection-banner--${state}`}
      aria-label="Connection status"
      data-testid="connection-banner"
      data-state={state}
    >
      <span className="connection-banner__mark" aria-hidden="true">
        {STATE_MARK[state]}
      </span>
      <p className="connection-banner__text">{text}</p>
      {pendingWrites > 0 ? (
        <p className="connection-banner__pending">
          {pendingWrites === 1
            ? '1 change is waiting to sync.'
            : `${String(pendingWrites)} changes are waiting to sync.`}
        </p>
      ) : null}
    </section>
  );
}
