/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The not-found screen.
 *
 * It says nothing about what *does* exist. A 404 that helpfully lists the routes it
 * knows about is a map of the application handed to anyone who guesses a URL, and this
 * is the bundle that is served to the open internet.
 *
 * It is held to the same WCAG 2.1 AA bar as the runner (docs/15 §2.1) — a candidate who
 * cannot read the error page cannot recover from it.
 */

import type { JSX } from 'react';

import { HELP_HREF } from '../shell/app-shell';
import { useRouteAnnouncement } from '../shell/shell-context';

export function NotFoundRoute(): JSX.Element {
  useRouteAnnouncement('Page not found');

  return (
    <article className="route route--not-found">
      <h1>We could not find that page</h1>
      <p>
        The link may have been copied incompletely. Open your assessment from the original
        invitation email, or <a href={HELP_HREF}>contact us</a> and we will help.
      </p>
    </article>
  );
}
