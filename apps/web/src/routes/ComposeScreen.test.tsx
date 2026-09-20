/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The compose screen (`H-179`).
 *
 * The property worth pinning is the one that costs a candidate their morning if it breaks:
 * **an infeasible paper cannot be saved.** The server refuses it too, and the two refusals are
 * independent on purpose — this one keeps the recruiter from reaching a refusal they cannot
 * act on, and the server's keeps anything else from writing one.
 *
 * The rest is arithmetic a reader should not have to do: a rule asking for six against four in
 * the bank says "2 short", and says it in words rather than only in a tint.
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

import { AssessmentPlanSchema } from '@assaybank/contracts';

import { ApiProvider } from '../api/api.js';
import { ApiClient } from '../api/client.js';
import { ComposeScreen } from './ComposeScreen.js';

const ROLE = '33333333-0000-4000-8000-000000000001';

interface RuleSeed {
  name: string;
  pick: number;
  available: number;
  min?: number;
  max?: number;
}

function plan(rules: RuleSeed[], over: { questionCount?: number; duration?: number } = {}) {
  const built = rules.map((rule, index) => ({
    skill_id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    skill_name: rule.name,
    pick_count: rule.pick,
    min_difficulty: rule.min ?? 2,
    max_difficulty: rule.max ?? 4,
    available: rule.available,
  }));

  return AssessmentPlanSchema.parse({
    job_role_id: ROLE,
    role_title: 'Senior backend engineer',
    question_count: over.questionCount ?? built.reduce((t, r) => t + r.pick_count, 0),
    duration_seconds: over.duration ?? 1800,
    total_score: built.reduce((t, r) => t + r.pick_count, 0),
    sections: [{ name: 'Questions', rules: built }],
    feasible: built.every((rule) => rule.available >= rule.pick_count),
  });
}

async function render(rules: RuleSeed[], over?: { questionCount?: number; duration?: number }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(
    ['job-roles', ROLE, 'assessment-plan', { questionCount: null, durationSeconds: null }],
    plan(rules, over),
  );

  const rootRoute = createRootRoute({ component: () => <ComposeScreen roleId={ROLE} /> });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      createRoute({ getParentRoute: () => rootRoute, path: '/roles' }),
      createRoute({ getParentRoute: () => rootRoute, path: '/questions' }),
      createRoute({ getParentRoute: () => rootRoute, path: '/assessments' }),
    ]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });

  await router.load();

  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <ApiProvider client={new ApiClient({ baseUrl: '/api/v1', csrfToken: () => 'a.b' })}>
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
    .replace(/&amp;/gu, '&')
    .replace(/\s+/gu, ' ');

/** Whether the save control is offered as usable. */
function saveDisabled(markup: string): boolean {
  const button = markup.slice(
    markup.indexOf('Save assessment') - 400,
    markup.indexOf('Save assessment'),
  );
  return button.includes('disabled');
}

describe('a paper the bank can fill', () => {
  it('opens with the composed answer rather than an empty form', async () => {
    // The whole point of composing from a role: the four judgements are already made.
    const markup = await render([
      { name: 'Algorithms', pick: 4, available: 12 },
      { name: 'SQL', pick: 2, available: 9 },
    ]);
    const body = text(markup);

    expect(body).toContain('Senior backend engineer');
    expect(body).toContain('Algorithms');
    expect(body).toContain('SQL');
    expect(body).toContain('6 questions, about 30 minutes');
  });

  it('shows the band each skill is asked at', async () => {
    const markup = await render([{ name: 'Algorithms', pick: 2, available: 9, min: 3, max: 5 }]);

    expect(text(markup)).toContain('difficulty 3–5');
  });

  it('offers the save', async () => {
    const markup = await render([{ name: 'Algorithms', pick: 2, available: 9 }]);

    expect(saveDisabled(markup)).toBe(false);
  });
});

describe('a paper the bank cannot fill', () => {
  const short = [
    { name: 'Algorithms', pick: 4, available: 12 },
    { name: 'Sorting', pick: 4, available: 1 },
  ];

  it('refuses the save, because the server will too', async () => {
    // Not protectiveness. `resolveDraw` does not short-draw at attempt start (ADR-004), so
    // this assessment would not degrade — it would fail for the first candidate to open it.
    expect(saveDisabled(await render(short))).toBe(true);
  });

  it('names the skills that fall short, and does the arithmetic', async () => {
    const body = text(await render(short));

    expect(body).toContain('The bank is short for Sorting');
    // Both numbers are already in their columns; "3 short" is the subtraction nobody should
    // have to do while reading a table of twelve skills.
    expect(body).toContain('3 short');
  });

  it('does not carry the shortfall in colour alone', async () => {
    // SC 1.4.1. The row is tinted and the cell says so in words.
    const markup = await render(short);

    expect(markup).toContain('ab-compose__short');
    expect(text(markup)).toContain('short');
  });

  it('offers the way out rather than leaving a dead end', async () => {
    const markup = await render(short);

    expect(text(markup)).toContain('Add questions');
    expect(markup).toContain('href="/questions"');
  });

  it('marks a skill that has exactly enough as enough, not as short', async () => {
    // The boundary. Four needed and four held is feasible, and an off-by-one here would
    // block a perfectly good paper.
    const body = text(await render([{ name: 'Algorithms', pick: 4, available: 4 }]));

    expect(body).toContain('Enough');
    expect(body).not.toContain('short');
  });
});
