/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The candidate route tree.
 *
 * ## Four routes, and no more
 *
 * `/`, `/t/{token}`, `/attempt` and `/join/{room_code}`. That is the entire public
 * surface of this application, and it matches the one CODE-GRAPH records for it. There
 * is no `/bank`, no `/reports`, no `/admin` and no `/candidates` — not gated, not lazy,
 * absent. Those live in `apps/web`, in a different bundle, on a different origin
 * (ADR-013). A route guard gates rendering, not the bundle; the guarantee this
 * application offers is the second kind.
 *
 * ## Code-based routes on purpose
 *
 * The tree is declared here rather than generated from a file-system convention. With
 * four routes the convention buys nothing, and an explicit tree means the full route
 * list of the candidate bundle is one screen of code that a reviewer can check against
 * ADR-013 — which is exactly the review this application exists to make cheap.
 *
 * ## Focus on navigation
 *
 * Route changes are announced through the shell's route announcer (`useRouteAnnouncement`
 * in each route component), because a single-page navigation produces none of the
 * document-level signals a screen-reader user relies on.
 */

import {
  Outlet,
  createRootRoute,
  createRoute,
  createRouter,
  useParams,
} from '@tanstack/react-router';
import type { JSX } from 'react';

import { AttemptRoute } from './routes/attempt-route';
import { JoinRoute } from './routes/join-route';
import { NotFoundRoute } from './routes/not-found-route';
import { RedeemRoute } from './routes/redeem-route';
import { WelcomeRoute } from './routes/welcome-route';
import { CandidateShell } from './shell/candidate-shell';
import { ErrorBoundary } from './shell/error-boundary';

/**
 * Route parameters, read as the untrusted input they are.
 *
 * A path parameter comes from the address bar. It is not validated by the router beyond
 * having matched a segment, so it is a string of the user's choosing arriving at the
 * edge of the application, and the standard applies: parse at the edge, trust inside
 * (docs/17 §1). The router's own inference for the loose form is `any`, which is exactly
 * the type this codebase does not use, so the shape is stated once, here, and every route
 * reads through it.
 *
 * What *validation* a parameter needs is the route's business: `token` is an opaque
 * bearer credential redeemed by the server and never parsed here, while `roomCode` is
 * shown to the candidate and will be shape-checked in M3 before it is sent anywhere.
 */
function useRouteParams(): Readonly<Record<string, string | undefined>> {
  const raw = useParams({ strict: false }) as unknown;
  if (typeof raw !== 'object' || raw === null) return {};

  const params: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    // A non-string parameter cannot come out of a URL path, so anything else is a
    // router-internal value and is not this application's business.
    if (typeof value === 'string') params[key] = value;
  }
  return params;
}

/**
 * The shell wraps every route, so the live regions, the countdown region and the
 * connection banner exist for the whole life of the application rather than being
 * mounted per screen (docs/15 §5.1).
 *
 * The error boundary sits *inside* the shell so that a route crash does not take the
 * chrome with it — a candidate who can still see their time remaining and "your answers
 * are saved" is in a very different position from one looking at a white page.
 */
function RootLayout(): JSX.Element {
  return (
    <CandidateShell>
      <ErrorBoundary>
        <Outlet />
      </ErrorBoundary>
    </CandidateShell>
  );
}

const rootRoute = createRootRoute({
  component: RootLayout,
  notFoundComponent: NotFoundRoute,
});

const welcomeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: WelcomeRoute,
});

/**
 * `/t/{token}` — the emailed invitation link.
 *
 * The token stays in the URL and nowhere else: it is not copied into local storage, not
 * put in the document title and not included in any announcement. It is a bearer
 * credential for a whole attempt.
 */
const redeemRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/t/$token',
  component: function RedeemRouteBinding(): JSX.Element {
    const params = useRouteParams();
    return <RedeemRoute token={params.token ?? ''} />;
  },
});

const attemptRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/attempt',
  component: AttemptRoute,
});

const joinRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/join/$roomCode',
  component: function JoinRouteBinding(): JSX.Element {
    const params = useRouteParams();
    return <JoinRoute roomCode={params.roomCode ?? ''} />;
  },
});

/** The complete route list of this bundle. Adding to it is an ADR-013 decision. */
export const CANDIDATE_ROUTE_PATHS = ['/', '/t/$token', '/attempt', '/join/$roomCode'] as const;

const routeTree = rootRoute.addChildren([welcomeRoute, redeemRoute, attemptRoute, joinRoute]);

/** Build the router. A function, so a test can build an isolated one. */
export function createCandidateRouter(): ReturnType<typeof createRouter<typeof routeTree>> {
  return createRouter({ routeTree, defaultNotFoundComponent: NotFoundRoute });
}

export type CandidateRouter = ReturnType<typeof createCandidateRouter>;
