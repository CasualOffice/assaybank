/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The console's one API client, and the React context that carries it.
 *
 * A context rather than a module-level singleton a screen imports directly. A singleton
 * is reachable from anywhere, which means a test cannot replace it without reaching into
 * module state, and two tests running in one process share whatever the last one set.
 * The provider makes the dependency visible in the tree and replaceable per test.
 *
 * `API_BASE_URL` is same-origin by default. The console is served by the same host as the
 * API in every environment (docs/13), and a same-origin default means the cookie is sent
 * without CORS credentials configuration — the setup that is easiest to get subtly wrong.
 */

import { API_BASE_PATH } from '@assaybank/contracts';
import { createContext, createElement, useContext, type ReactNode } from 'react';

import { ApiClient } from './client.js';

/** Where the API lives, from the build's environment, defaulting to same-origin. */
export const API_BASE_URL: string = import.meta.env.VITE_API_BASE_URL ?? API_BASE_PATH;

const ApiContext = createContext<ApiClient | undefined>(undefined);

/** Builds the client the application runs with. */
export function createApiClient(): ApiClient {
  return new ApiClient({ baseUrl: API_BASE_URL });
}

export interface ApiProviderProps {
  readonly client: ApiClient;
  readonly children: ReactNode;
}

/** Puts a client in the tree. */
export function ApiProvider({ client, children }: ApiProviderProps): ReactNode {
  return createElement(ApiContext.Provider, { value: client }, children);
}

/**
 * The client for the current tree.
 *
 * Throws when there is no provider rather than falling back to a default one: a screen
 * that silently talks to the wrong origin is harder to notice than one that fails at
 * mount with the reason.
 */
export function useApi(): ApiClient {
  const client = useContext(ApiContext);
  if (client === undefined) {
    throw new Error('No ApiProvider in the tree. The console mounts one in main.tsx.');
  }
  return client;
}
