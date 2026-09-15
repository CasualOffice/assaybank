/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `/` — what a candidate sees if they arrive without a link.
 *
 * There is no sign-in here and there never will be. A candidate does not have an account
 * on this platform: they hold a single-use invitation link, and the whole authentication
 * story for this bundle is short-lived attempt tokens (ADR-013). Offering a login form
 * would invite a candidate to try credentials they do not have, and would put a
 * credential field in the one application that must never collect one.
 */

import type { JSX } from 'react';

import { useRouteAnnouncement } from '../shell/shell-context';
import { HELP_HREF } from '../shell/app-shell';

export function WelcomeRoute(): JSX.Element {
  useRouteAnnouncement('Assaybank assessment');

  return (
    <article className="route route--welcome">
      <h1>Open your assessment from your invitation link</h1>
      <p>
        Your invitation email contains a personal link. Open it on the device you want to use, and
        this page will take you through what happens next.
      </p>
      <p>
        If the link has expired or you cannot find it, <a href={HELP_HREF}>contact us</a> and we
        will send a new one.
      </p>
    </article>
  );
}
