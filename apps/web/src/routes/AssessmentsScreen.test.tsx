/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The assessments list (`H-179`).
 *
 * A thin screen, with two things worth holding in place: the empty state points *backwards*
 * to where the flow starts, and the row somebody just saved is findable without reading every
 * row — both of which are easy to lose in a refactor and neither of which anyone would notice
 * was gone.
 */

import { LiveRegionProvider } from '@assaybank/ui';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ApiProvider } from '../api/api.js';
import { ApiClient } from '../api/client.js';
import { AssessmentsScreen } from './AssessmentsScreen.js';

function assessment(over: { id: string; name: string; questions?: number; seconds?: number }) {
  return {
    id: over.id,
    job_role_id: '33333333-0000-4000-8000-000000000001',
    name: over.name,
    duration_seconds: over.seconds ?? 1800,
    status: 'draft',
    question_count: over.questions ?? 6,
    created_at: '2026-09-21T09:00:00.000Z',
  };
}

async function render(rows: ReturnType<typeof assessment>[], created?: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(['assessments'], { data: rows });

  const rootRoute = createRootRoute({
    component: () =>
      created === undefined ? <AssessmentsScreen /> : <AssessmentsScreen created={created} />,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      createRoute({ getParentRoute: () => rootRoute, path: '/roles' }),
      createRoute({ getParentRoute: () => rootRoute, path: '/questions' }),
    ]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });

  await router.load();

  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <ApiProvider client={new ApiClient({ baseUrl: '/api/v1', csrfToken: () => undefined })}>
        <LiveRegionProvider>
          <RouterProvider router={router} />
        </LiveRegionProvider>
      </ApiProvider>
    </QueryClientProvider>,
  );
}

const text = (markup: string): string =>
  markup
    .replace(/<[^>]*>/gu, ' ')
    .replace(/&#x27;|&#x2019;/gu, "'")
    .replace(/\s+/gu, ' ');

describe('the list', () => {
  it('shows the paper’s size and length in terms somebody reads', async () => {
    const body = text(
      await render([assessment({ id: 'a1', name: 'Backend', questions: 8, seconds: 2400 })]),
    );

    expect(body).toContain('Backend');
    expect(body).toContain('8');
    // Minutes, not 2400.
    expect(body).toContain('40 min');
  });

  it('marks the one just saved, in words and not only in colour', async () => {
    const markup = await render(
      [assessment({ id: 'a1', name: 'First' }), assessment({ id: 'a2', name: 'Second' })],
      'a2',
    );

    expect(markup).toContain('ab-assessments__new');
    expect(text(markup)).toContain('just saved');
  });

  it('marks nothing when the visitor did not arrive from a save', async () => {
    const markup = await render([assessment({ id: 'a1', name: 'First' })]);

    expect(markup).not.toContain('ab-assessments__new');
    expect(text(markup)).not.toContain('just saved');
  });

  it('says draft quietly rather than badging every row', async () => {
    // docs/17 §11b: draft is what everything composed so far *is*, so it is not news.
    const markup = await render([assessment({ id: 'a1', name: 'First' })]);

    expect(text(markup)).toContain('Draft');
    expect(markup).toContain('ab-questions__quiet');
  });
});

describe('the empty state', () => {
  it('points back to roles, because that is where composing starts', async () => {
    const markup = await render([]);

    expect(text(markup)).toContain('Nothing composed yet');
    expect(text(markup)).toContain('composed from a role');
    // Not a "New assessment" button: there is nothing on this screen that could compose one,
    // and an action that cannot work is worse than no action.
    expect(markup).toContain('href="/roles"');
    expect(text(markup)).not.toContain('New assessment');
  });
});
