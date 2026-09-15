/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Alert, Skeleton } from '@assaybank/ui';
import { type ReactNode } from 'react';

import { type RouteDescriptor } from '../app/routes.js';

/** The id of the heading focus moves to on navigation. One per page, so one `<h1>`. */
export const PAGE_HEADING_ID = 'page-heading';

/** Props for {@link Placeholder}. */
export interface PlaceholderProps {
  /** The route this screen stands in for. */
  route: RouteDescriptor;
}

/**
 * A screen P0 does not build, saying which phase does.
 *
 * The phase note is the whole point. An empty screen and a broken screen look identical,
 * and the first thing somebody does with a repository they did not write is click every
 * link in it. "P2 builds the bank" is the difference between "this is unfinished on
 * purpose" and "this is broken, is anything else?".
 *
 * It is a real screen rather than a `<div>TODO</div>`: it carries the focusable `<h1>` the
 * router moves focus to, and it uses the alert and skeleton primitives, so the shell's
 * accessibility baseline is under test from the first commit rather than from the first
 * real screen.
 *
 * It announces nothing and sets no document title. Both of those belong to the router,
 * once per navigation, in one place — see `RouteAnnouncer` in `../app/router.tsx`. A
 * screen that announces itself is how an application ends up announcing twice.
 */
export function Placeholder({ route }: PlaceholderProps): ReactNode {
  return (
    <article className="ab-page" aria-labelledby={PAGE_HEADING_ID}>
      {/* tabIndex -1 so the router can move focus here on navigation: a single-page
          application that changes content without moving focus leaves a screen-reader
          user reading the previous screen (docs/15 §9.1). */}
      <h1 id={PAGE_HEADING_ID} className="ab-page__heading" tabIndex={-1}>
        {route.title}
      </h1>

      <p className="ab-page__summary">{route.summary}</p>

      <Alert tone="info" title={`Built in ${route.phase}`}>
        <p>{route.phaseNote}</p>
      </Alert>

      {/* Decorative: a sketch of the shape the real screen will take. aria-hidden, and
          not announced, because a skeleton carries no information — see the Skeleton
          component in @assaybank/ui. */}
      <div className="ab-page__sketch">
        <Skeleton height="2rem" width="40%" />
        <Skeleton height="1rem" />
        <Skeleton height="1rem" width="85%" />
        <Skeleton height="1rem" width="60%" />
      </div>
    </article>
  );
}
