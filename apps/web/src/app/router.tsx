/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useAnnounce } from '@assaybank/ui';
import {
  Link,
  Outlet,
  createRootRoute,
  createRoute,
  createRouter,
  useNavigate,
  useRouterState,
} from '@tanstack/react-router';
import { useEffect, useRef, type ReactNode } from 'react';

import { Placeholder } from '../routes/Placeholder.js';
import {
  MAX_DIFFICULTY,
  MIN_DIFFICULTY,
  QUESTION_KINDS,
  QUESTION_STATUSES,
  type QuestionKind,
  type QuestionStatus,
} from '@assaybank/contracts';

import { type QuestionFilters } from '../api/questions.js';
import { QuestionEditor } from '../routes/QuestionEditor.js';
import { QuestionsScreen } from '../routes/QuestionsScreen.js';
import { AppShellLayout } from './AppShell.js';
import { NavIcon } from './NavIcon.js';
import { ErrorEnvelopeView, toDisplayEnvelope } from './ErrorBoundary.js';
import {
  documentTitleFor,
  navSections,
  routeAnnouncementFor,
  routeFor,
  type ConsolePath,
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
 *
 * **None of the three happens on the first render.** A page the user has just loaded has not
 * been navigated to within the application: the browser has already announced it, focus is
 * already where the platform puts it, and moving it to the heading means a screen reader
 * says the title twice and a keyboard user's first Tab starts from somewhere they did not
 * choose. The title is still set, because the router owns it; the announcement and the
 * focus move are what a navigation adds.
 */
function RouteAnnouncer(): null {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const { announceRoute } = useAnnounce();
  // The last path announced, not a "have we started" flag. A flag is wrong under
  // StrictMode, which mounts, unmounts and mounts again: the ref survives the remount, so
  // the second mount looks like a navigation and steals focus on first load — which is
  // exactly the bug this guard exists to prevent, arriving through the guard itself.
  // Comparing the path is immune, because a remount carries the same one.
  const lastPath = useRef<string | null>(null);

  useEffect(() => {
    const route = routeFor(pathname);
    if (route === undefined) {
      return;
    }

    document.title = documentTitleFor(route);

    if (lastPath.current === pathname) {
      return;
    }

    const isFirstRender = lastPath.current === null;
    lastPath.current = pathname;
    if (isFirstRender) {
      return;
    }

    announceRoute(routeAnnouncementFor(route));

    const heading = document.getElementById('page-heading');
    heading?.focus();
  }, [pathname, announceRoute]);

  return null;
}

/**
 * The console's primary navigation, built from the one route manifest.
 *
 * A list per section rather than one flat list: a screen-reader user hears "Question bank,
 * list, 1 item" and can skip the group, which is the whole point of grouping. The section
 * heading names the list through `aria-labelledby` so the group has a name rather than
 * being a visual cluster with nothing behind it.
 */
function ConsoleNav(): ReactNode {
  return (
    <>
      {navSections().map((group) => {
        const headingId = `nav-section-${group.section.replace(/\s+/gu, '-').toLowerCase()}`;
        return (
          <div className="ab-console__nav-group" key={group.section}>
            <h2 className="ab-console__nav-heading" id={headingId}>
              {group.section}
            </h2>
            <ul className="ab-console__nav-list" aria-labelledby={headingId}>
              {group.routes.map((route) => (
                <li key={route.path}>
                  <Link
                    to={route.path}
                    className="ab-console__nav-link"
                    // `exact` on the dashboard only: without it "/" is a prefix of every
                    // path and every item renders as current at once.
                    activeOptions={{ exact: route.path === '/' }}
                    activeProps={{
                      'aria-current': 'page',
                      className: 'ab-console__nav-link ab-console__nav-link--current',
                    }}
                  >
                    <NavIcon path={route.path} />
                    <span className="ab-console__nav-label">{route.title}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
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

/**
 * The question bank's filters live in the query string.
 *
 * `validateSearch` is the parse-at-the-edge rule (docs/17 §1) applied to the URL: a user
 * can type anything into the address bar, so `?difficulty=banana` has to become a screen
 * with no difficulty filter rather than a request carrying `banana` to the API. Anything
 * unrecognised is dropped, which also keeps a stale link from a previous release working.
 */
function parseQuestionSearch(search: Record<string, unknown>): QuestionFilters {
  const str = (value: unknown): string | undefined =>
    typeof value === 'string' && value.trim() !== '' ? value : undefined;

  const kind = str(search['kind']);
  const status = str(search['status']);
  const difficulty = Number(search['difficulty']);

  return {
    q: str(search['q']),
    kind: QUESTION_KINDS.includes(kind as QuestionKind) ? (kind as QuestionKind) : undefined,
    status: QUESTION_STATUSES.includes(status as QuestionStatus)
      ? (status as QuestionStatus)
      : undefined,
    difficulty:
      Number.isInteger(difficulty) && difficulty >= MIN_DIFFICULTY && difficulty <= MAX_DIFFICULTY
        ? difficulty
        : undefined,
    cursor: str(search['cursor']),
  };
}

/**
 * Connects the question bank screen to the URL.
 *
 * The adapter is the only part that knows about routing, so the screen stays a function of
 * its props and can be rendered — and asserted — without a router.
 */
function QuestionsRouteScreen(): ReactNode {
  const filters = questionsRoute.useSearch();
  const navigate = useNavigate();

  return (
    <QuestionsScreen
      filters={filters}
      onFiltersChange={(next) => {
        // `replace` for a filter, push for a page. Typing into the search box should not
        // put a history entry behind every keystroke; turning a page should be undoable
        // with Back, which is what makes the pager need only a "Next".
        void navigate({
          to: '/questions',
          search: next,
          replace: next.cursor === undefined,
        });
      }}
    />
  );
}

const questionsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/questions',
  validateSearch: parseQuestionSearch,
  // The first route with a real screen behind it. The rest still resolve through the
  // manifest, so an unbuilt one says which phase builds it rather than rendering blank.
  component: QuestionsRouteScreen,
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

/**
 * One question, open for authoring.
 *
 * A child path of `/questions` rather than a sibling, so the sidebar keeps `/questions` current
 * while a question is open and Back returns to the list with its filters intact — they are in
 * the URL the browser is returning to.
 */
function QuestionDetailScreen(): ReactNode {
  const { questionId } = questionDetailRoute.useParams();

  return (
    <QuestionEditor
      questionId={questionId}
      onBack={() => {
        // `history.back()` rather than a link to `/questions`: the list's filters live in the
        // URL, so going back restores them, and navigating forward to a bare `/questions`
        // would silently clear them.
        globalThis.history.back();
      }}
    />
  );
}

const questionDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/questions/$questionId',
  component: QuestionDetailScreen,
});

/** The route tree. Exported so a test can build a router with a memory history. */
export const routeTree = rootRoute.addChildren([
  dashboardRoute,
  questionsRoute,
  questionDetailRoute,
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
