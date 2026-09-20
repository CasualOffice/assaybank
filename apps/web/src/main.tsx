/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Application entry point.
//
// The nesting order is the whole of the accessibility baseline's setup cost, and it is an
// ordering property rather than a component property — which is why `index.test.ts`
// asserts it against this file rather than against a rendered tree:
//
//   RootErrorBoundary    catches a render crash below it and shows the standard envelope
//   QueryClientProvider  server state, with a retry policy that branches on the error code
//   ApiProvider          the one HTTP client, so a test can replace it without module state
//   LiveRegionProvider   mounts the live regions, empty, before anything can announce
//   RouterProvider       renders the shell, which carries the skip link and the landmarks
//
// LiveRegionProvider must sit *above* the router, not inside a screen. docs/15 §5.1: a
// region added to the DOM at the same moment its content changes is frequently not
// announced at all, so the regions have to exist and be empty from the first paint —
// which they cannot be if they mount with the first screen that wants to speak.

import '@assaybank/ui/styles.css';
import './styles.css';

import { LiveRegionProvider } from '@assaybank/ui';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { ApiProvider, createApiClient } from './api/api.js';
import { createQueryClient } from './api/queryClient.js';
import { RootErrorBoundary } from './app/ErrorBoundary.js';
import { router } from './app/router.js';

const container = document.getElementById('root');

if (container === null) {
  throw new Error('index.html is missing the #root container');
}

const queryClient = createQueryClient();
const apiClient = createApiClient();

createRoot(container).render(
  <StrictMode>
    <RootErrorBoundary
      onError={(error) => {
        // The browser console is the only sink this bundle has. Shipping client errors to
        // the API is a P7 decision with a privacy question attached (docs/11), not
        // something to slip in here.
        console.error('Unhandled error in the staff console', error);
      }}
    >
      <QueryClientProvider client={queryClient}>
        <ApiProvider client={apiClient}>
          <LiveRegionProvider>
            <RouterProvider router={router} />
          </LiveRegionProvider>
        </ApiProvider>
      </QueryClientProvider>
    </RootErrorBoundary>
  </StrictMode>,
);
