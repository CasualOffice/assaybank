/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Application entry point for the candidate bundle.
 *
 * This file is the root of the module graph that Vite follows, which makes it the thing
 * ADR-013 is actually about: everything reachable from here ends up readable in a
 * candidate's browser with devtools open. Nothing staff-scoped is reachable from here,
 * and `scripts/check-bundle.mjs` checks the built output rather than trusting that
 * sentence.
 *
 * Kept deliberately thin. The shell, the router and the stores are all separately
 * testable modules; this only attaches them to a DOM node.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { createCandidateRouter } from './router';
import './styles.css';

const container = document.getElementById('root');

if (container === null) {
  throw new Error('index.html is missing the #root container');
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      /*
       * A candidate on a flaky connection must not have the application silently refetch
       * under them mid-answer, and must not have a stale question set quietly replaced:
       * the served set is materialised once at attempt start and never re-rolled
       * (ADR-004). Refetching is therefore explicit, per query, at the call site.
       */
      refetchOnWindowFocus: false,
      retry: 2,
    },
  },
});

const router = createCandidateRouter();

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
