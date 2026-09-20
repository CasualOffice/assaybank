/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The first screen after signing in.
 *
 * `dashboard-guidance.test.ts` covers which rule fires. These cover the things only the
 * rendered screen can be wrong about: that the sentence is withheld until it is true, that
 * the panels are evidence for it rather than four things competing to be read, and that an
 * empty queue reads as the good state rather than as a panel that failed to load.
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

import { JobRoleCoverageSchema, SkillCoverageSchema } from '@assaybank/contracts';

import { ApiProvider } from '../api/api.js';
import { ApiClient } from '../api/client.js';
import { questionsQueryKey } from '../api/questions.js';
import { DashboardScreen } from './DashboardScreen.js';

const ROLE_ID = '33333333-0000-4000-8000-000000000001';
const QUESTION_ID = '44444444-0000-4000-8000-000000000001';

/** One skill's coverage, parsed through the contract so a drifted fixture fails here. */
function skill(key: string, inBand: number, name?: string) {
  return SkillCoverageSchema.parse({
    skill_id: `00000000-0000-4000-8000-0000000000${key.length.toString().padStart(2, '0')}`,
    skill_key: key,
    skill_name: name ?? key,
    is_required: true,
    weight: 1,
    min_difficulty: 3,
    max_difficulty: 5,
    in_band: inBand,
    published: inBand,
    by_difficulty: { '1': 0, '2': 0, '3': inBand, '4': 0, '5': 0 },
  });
}

/** A question as `GET /questions` returns it. */
function question(id: string, excerpt: string | null) {
  return {
    id,
    kind: 'coding',
    status: 'review',
    external_ref: null,
    source_license: null,
    exposure_count: 0,
    archived_at: null,
    created_at: '2026-09-01T09:00:00.000Z',
    current_version_id: null,
    current_published_at: null,
    latest_version_no: 1,
    latest_difficulty: 3,
    latest_prompt_excerpt: excerpt,
  };
}

interface Seed {
  readonly roles?: readonly { id: string; title: string }[];
  /** Coverage per role id. A role absent from this map has a query still in flight. */
  readonly coverage?: Readonly<Record<string, readonly ReturnType<typeof skill>[]>>;
  readonly review?: readonly ReturnType<typeof question>[];
  readonly reviewCursor?: string | null;
}

async function render(seed: Seed): Promise<string> {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });

  const roles = seed.roles ?? [{ id: ROLE_ID, title: 'Senior backend engineer' }];
  client.setQueryData(['job-roles'], {
    data: roles.map((role) => ({
      id: role.id,
      code: 'be-senior',
      title: role.title,
      family: 'Engineering',
      seniority: 'Senior',
      description: null,
      is_active: true,
      created_at: '2026-09-01T09:00:00.000Z',
    })),
  });

  for (const [id, skills] of Object.entries(seed.coverage ?? {})) {
    client.setQueryData(
      ['job-roles', id, 'coverage'],
      JobRoleCoverageSchema.parse({
        job_role_id: ROLE_ID,
        generated_at: '2026-09-20T12:00:00.000Z',
        skills,
        gaps: skills.filter((s) => s.in_band === 0).map((s) => s.skill_key),
      }),
    );
  }

  client.setQueryData(questionsQueryKey({ status: 'review' }), {
    data: seed.review ?? [],
    next_cursor: seed.reviewCursor ?? null,
  });

  const rootRoute = createRootRoute({ component: DashboardScreen });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      createRoute({ getParentRoute: () => rootRoute, path: '/roles' }),
      createRoute({ getParentRoute: () => rootRoute, path: '/questions' }),
      createRoute({ getParentRoute: () => rootRoute, path: '/questions/$questionId' }),
    ]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });

  await router.load();

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
    .replace(/&#x2F;/gu, '/')
    .replace(/\s+/gu, ' ');

describe('the sentence at the top', () => {
  it('leads with what to do, not with a number', async () => {
    const markup = await render({
      coverage: { [ROLE_ID]: [skill('sql.tuning', 0, 'SQL tuning'), skill('api.rest', 9)] },
    });

    expect(text(markup)).toContain('Senior backend engineer cannot be assessed yet');
    expect(text(markup)).toContain('SQL tuning');
  });

  it('does not call a role with gaps an error', async () => {
    // The `danger` tone labels itself "Error" by default, which is right for a request that
    // failed and wrong here: a role the bank cannot cover is the system reporting correctly,
    // not malfunctioning. A red box that cries wolf is a red box people stop reading.
    const markup = await render({
      coverage: { [ROLE_ID]: [skill('sql.tuning', 0, 'SQL tuning')] },
    });

    expect(text(markup)).toContain('Blocked');
    expect(text(markup)).not.toContain('ERROR');
  });

  it('is withheld until every coverage query has settled', async () => {
    // A role whose coverage has not arrived. Showing "every role can be measured" for the
    // 200ms before it lands is a sentence that is wrong when it is read.
    const markup = await render({ coverage: {} });

    expect(text(markup)).not.toContain('can be measured');
    expect(markup).toContain('aria-busy="true"');
  });

  it('carries the action as a link rather than a disabled button', async () => {
    const markup = await render({
      coverage: { [ROLE_ID]: [skill('sql.tuning', 0, 'SQL tuning')] },
    });

    expect(markup).toContain('href="/questions"');
  });
});

describe('the roles panel', () => {
  it('gives each role a verdict in a word, with colour repeating it rather than carrying it', async () => {
    const markup = await render({
      roles: [
        { id: ROLE_ID, title: 'Senior backend engineer' },
        { id: '33333333-0000-4000-8000-000000000002', title: 'Data engineer' },
      ],
      coverage: {
        [ROLE_ID]: [skill('sql.tuning', 0, 'SQL tuning')],
        '33333333-0000-4000-8000-000000000002': [skill('py.core', 20)],
      },
    });

    const body = text(markup);
    expect(body).toContain('Blocked');
    expect(body).toContain('Ready');
    // Not a colour alone (SC 1.4.1): the badge carries the word and a label naming what it
    // is a verdict about.
    expect(markup).toContain('Coverage');
  });

  it('distinguishes thin from ready, which is the distinction the whole flow rests on', async () => {
    const markup = await render({ coverage: { [ROLE_ID]: [skill('api.rest', 3)] } });

    expect(text(markup)).toContain('Thin');
    expect(text(markup)).toContain('two candidates would see much the same paper');
  });

  it('invites the first role rather than showing an empty box', async () => {
    const markup = await render({ roles: [], coverage: {} });

    expect(text(markup)).toContain('No roles yet');
    expect(text(markup)).toContain('what an assessment is composed from');
  });
});

describe('the review queue', () => {
  it('lists the questions waiting, each a link to the one that is waiting', async () => {
    const markup = await render({
      coverage: { [ROLE_ID]: [skill('api.rest', 20)] },
      review: [question(QUESTION_ID, 'Implement an LRU cache')],
    });

    expect(text(markup)).toContain('Implement an LRU cache');
    expect(markup).toContain(`href="/questions/${QUESTION_ID}"`);
    // The kind, so a reviewer can tell a coding question from a written one before opening it.
    expect(text(markup)).toContain('Coding');
  });

  it('names a question with no prompt yet rather than rendering an empty link', async () => {
    const markup = await render({
      coverage: { [ROLE_ID]: [skill('api.rest', 20)] },
      review: [question(QUESTION_ID, null)],
    });

    expect(text(markup)).toContain('Untitled question');
  });

  it('says an empty queue is the good state, not a panel that failed', async () => {
    const markup = await render({ coverage: { [ROLE_ID]: [skill('api.rest', 20)] } });

    expect(text(markup)).toContain('Nothing is waiting');
    expect(text(markup)).toContain('An empty queue is the good state');
  });

  it('stops at five and links to the rest rather than growing without bound', async () => {
    const rows = Array.from({ length: 7 }, (_, index) =>
      question(
        `44444444-0000-4000-8000-00000000000${String(index + 1)}`,
        `Question ${String(index + 1)}`,
      ),
    );
    const markup = await render({ coverage: { [ROLE_ID]: [skill('api.rest', 20)] }, review: rows });

    const body = text(markup);
    expect(body).toContain('Question 5');
    expect(body).not.toContain('Question 6');
    expect(body).toContain('2 more waiting');
  });

  it('does not report a full page as a total', async () => {
    const rows = Array.from({ length: 7 }, (_, index) =>
      question(
        `44444444-0000-4000-8000-00000000000${String(index + 1)}`,
        `Question ${String(index + 1)}`,
      ),
    );
    const markup = await render({
      coverage: { [ROLE_ID]: [skill('api.rest', 20)] },
      review: rows,
      reviewCursor: 'more',
    });

    expect(text(markup)).toContain('More are waiting than fit here');
    expect(text(markup)).toContain('More than 7 questions are waiting for review');
  });
});

describe('what the screen must never become', () => {
  it('says out loud that it ranks nobody', async () => {
    // The screen most likely to grow a "top candidates" panel is the dashboard, and the
    // sentence on it is cheaper to keep than the ADR is to re-argue (ADR-011, invariant 4).
    const markup = await render({ coverage: { [ROLE_ID]: [skill('api.rest', 20)] } });

    expect(text(markup)).toContain('no candidate is scored, ordered or recommended');
  });
});
