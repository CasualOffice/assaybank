/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The attributions page (`H-032`, docs/05 §2).
 *
 * This page is a licence obligation rather than a report, so what is asserted is that the
 * obligation is legible: the licence is named, the source is named, and the sentence beside
 * each says what it actually requires of us.
 */

import { type AttributionView } from '@assaybank/contracts';
import { LiveRegionProvider } from '@assaybank/ui';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ApiProvider } from '../api/api.js';
import { obligationOf } from '../api/attributions.js';
import { ApiClient } from '../api/client.js';
import { AttributionsScreen } from './AttributionsScreen.js';

let current: readonly AttributionView[] = [];

const rootRoute = createRootRoute({ component: AttributionsScreen });
const router = createRouter({
  routeTree: rootRoute,
  history: createMemoryHistory({ initialEntries: ['/'] }),
});

await router.load();

function render(rows: readonly AttributionView[]): string {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(['questions', 'attributions'], { data: rows });
  current = rows;

  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <ApiProvider client={new ApiClient({ baseUrl: '/api/v1' })}>
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
    .replace(/&#x27;/gu, "'")
    .replace(/&amp;/gu, '&')
    .replace(/&quot;/gu, '"')
    .replace(/\s+/gu, ' ');

const row = (over: Partial<AttributionView>): AttributionView => ({
  source_license: 'MIT',
  dataset: 'humaneval',
  questions: 164,
  published: 40,
  ...over,
});

describe('the credit itself', () => {
  it('names the licence and the source it came from', () => {
    const markup = render([row({ source_license: 'CC-BY-4.0', dataset: 'mbpp' })]);

    expect(text(markup)).toContain('CC-BY-4.0');
    expect(text(markup)).toContain('mbpp');
  });

  it('says what the licence actually requires, not just that one applies', () => {
    const markup = render([row({ source_license: 'CC-BY-4.0', dataset: 'mbpp' })]);

    // A page that listed licence names without their obligations would be a list, not the
    // "reasonable manner" CC-BY asks for.
    expect(text(markup)).toContain('Credit required wherever the content appears');
  });

  it('distinguishes the obligations, because they differ in kind', () => {
    expect(obligationOf('CC-BY-4.0')).toContain('Credit required');
    expect(obligationOf('Apache-2.0')).toContain('notice travels');
    expect(obligationOf('MIT')).toContain('copyright notice');
  });

  it('says so plainly when there is nothing to credit', () => {
    const markup = render([]);

    expect(text(markup)).toContain('Nothing to credit');
    expect(text(markup)).toContain('written in-house');
  });
});

describe('the contamination warning', () => {
  it('appears when published questions came from a dataset', () => {
    const markup = render([row({ published: 40 })]);

    // docs/05 §2: these datasets are in the training data of every model a candidate might
    // use, and somebody has to be able to see how much of the published bank is theirs.
    expect(text(markup)).toContain('40 published questions');
    expect(text(markup)).toContain('close to worthless above that');
  });

  it('sums across sources rather than warning once per row', () => {
    const markup = render([
      row({ source_license: 'MIT', dataset: 'humaneval', published: 40 }),
      row({ source_license: 'CC-BY-4.0', dataset: 'mbpp', published: 60 }),
    ]);

    expect(text(markup)).toContain('100 published questions');
  });

  it('stays quiet when nothing imported has been published', () => {
    const markup = render([row({ questions: 164, published: 0 })]);

    // The obligation still stands for the drafts, so the table is there — but nothing
    // imported is being served, so the warning about serving it would be noise.
    expect(text(markup)).toContain('humaneval');
    expect(text(markup)).not.toContain('close to worthless');
  });

  it('counts held questions separately from published ones', () => {
    const markup = render([row({ questions: 164, published: 3 })]);

    // The licence follows every copy; the ratio is about what candidates actually see.
    expect(text(markup)).toContain('164');
    expect(text(markup)).toContain('3');
  });
});

describe('content with no recorded source', () => {
  it('says so rather than showing an empty cell', () => {
    expect(text(render([row({ dataset: null })]))).toContain('No source recorded');
    expect(current).toHaveLength(1);
  });
});
