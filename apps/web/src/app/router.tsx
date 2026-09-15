/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useAnnounce } from '@assaybank/ui';
import {
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  Outlet,
  useRouterState,
} from '@tanstack/react-router';
import { type ReactNode, useEffect } from 'react';

import { Placeholder } from '../routes/Placeholder.js';
import { AppShellLayout } from './AppShell.js';
import { ErrorEnvelopeView, toDisplayEnvelope } from './ErrorBoundary.js';
import {
  type ConsolePath,
  documentTitleFor,
  ROUTE_MANIFEST,
  routeAnnouncementFor,
  routeFor,
} from './routes.js';

/**
 * Announces a navigation, once, in the dedicated route region.
 *
 * docs/15 §9.1: a single-page application moves content without moving focus, which leaves
 * a screen-reader user reading the previous screen. Three things answer that, and all
 * three live here rather than in each screen, because a screen that announces itself is a
 * screen that announces twice when it is rendered inside another one:
 *
 * 1. The document title changes — several screen readers announce that and nothing else.
 * 2. The route announcer says where the user is, politely, once per navigation.
 * 3. Focus moves to the page's `<h1>`, which carries `tabIndex={-1}`.
 *
 * Focus is moved rather than stolen: it happens because the user navigated, which is the
 * distinction §9.3 draws between this and an asynchronous result grabbing attention.
 */
function RouteAnnouncer(): null {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const { announceRoute } = useAnnounce();

  useEffect(() => {
    const route = routeFor(pathname);
    if (route === undefined) {
      return;
    }

    document.title = documentTitleFor(route);
    announceRoute(routeAnnouncementFor(route));

    const heading = document.getElementById('page-heading');
    heading?.focus();
  }, [pathname, announceRoute]);

  return null;
}

/** The console's primary navigation, built from the one route manifest. */
function ConsoleNav(): ReactNode {
  return (
    <>
      {ROUTE_MANIFEST.map((route) => (
        <li key={route.path} className="ab-console__nav-item">
          <Link
            to={route.path}
            className="ab-console__nav-link"
            // `exact` on the dashboard only: without it "/" is a prefix of every path and
            // every item renders as current at once.
            activeOptions={{ exact: route.path === '/' }}
            activeProps={{
              'aria-current': 'page',
              className: 'ab-console__nav-link ab-console__nav-link--current',
            }}
          >
            {route.title}
          </Link>
        </li>
      ))}
    </>
  );
}

/** The chrome every route renders inside. */
function RootLayout(): ReactNode {
  return (
    <AppShellLayout nav={<ConsoleNav />}>
      <RouteAnnouncer />
      <Outlet />
    </AppShellLayout>
  );
}

/**
 * The route-level error screen.
 *
 * TanStack hands it whatever was thrown — a loader rejection, a render crash inside the
 * route — and it goes through the same normalisation as everything else, so an API failure
 * and a component bug reach the user in one shape with one `code` to quote.
 */
function RouteErrorScreen({ error }: { error: unknown }): ReactNode {
  return (
    <ErrorEnvelopeView
      envelope={toDisplayEnvelope(error)}
      onRetry={() => {
        globalThis.location.reload();
      }}
    />
  );
}

/** The screen for a URL the console does not serve. */
function NotFoundScreen(): ReactNode {
  return (
    <ErrorEnvelopeView
      envelope={{
        error: {
          code: 'not_found',
          message: 'That page does not exist in the staff console.',
          request_id: '',
        },
      }}
    />
  );
}

const rootRoute = createRootRoute({
  component: RootLayout,
  errorComponent: RouteErrorScreen,
  notFoundComponent: NotFoundScreen,
});

/**
 * Builds a route's component from the manifest.
 *
 * Throwing for an unknown path rather than rendering an empty screen: the only way to
 * reach it is for a route to exist that the manifest does not describe, and the router
 * test asserts that cannot happen. A silent blank page would hide the very drift the
 * manifest exists to prevent.
 */
function screenFor(path: ConsolePath): () => ReactNode {
  return function Screen(): ReactNode {
    const route = routeFor(path);

    if (route === undefined) {
      throw new Error(`No manifest entry for the route ${path}. See app/routes.ts.`);
    }

    return <Placeholder route={route} />;
  };
}

const dashboardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: screenFor('/'),
});

const questionsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/questions',
  component: screenFor('/questions'),
});

const assessmentsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/assessments',
  component: screenFor('/assessments'),
});

const candidatesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/candidates',
  component: screenFor('/candidates'),
});

/** The route tree. Exported so a test can build a router with a memory history. */
export const routeTree = rootRoute.addChildren([
  dashboardRoute,
  questionsRoute,
  assessmentsRoute,
  candidatesRoute,
]);

/** The application's router. */
export const router = createRouter({
  routeTree,
  defaultPreload: 'intent',
  // A crash in a route is not a crash of the console: the chrome stays, the navigation
  // still works, and the user can get somewhere else without a reload.
  defaultErrorComponent: RouteErrorScreen,
  defaultNotFoundComponent: NotFoundScreen,
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
