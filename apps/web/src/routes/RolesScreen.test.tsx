/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The verdict, which is the only thing this screen is for.
 *
 * A recruiter reads one sentence per role and decides whether to go further. These assert
 * that the sentence is the right one for the data behind it — including the case the
 * screen exists to prevent, which is offering "compose an assessment" for a role the bank
 * cannot fill.
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
import { JobRoleCoverageSchema, SkillCoverageSchema } from '@assaybank/contracts';

import { verdictFor, type JobRoleCoverage, type SkillCoverage } from '../api/roles.js';
import { RolesScreen } from './RolesScreen.js';

const ROLE_ID = '33333333-0000-4000-8000-000000000001';

/** A skill's coverage. Loosely typed on the way in so a fixture can be written by hand. */
function skill(over: Partial<Omit<SkillCoverage, 'skill_id'>> & { key: string }): SkillCoverage {
  const by = over.by_difficulty ?? { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 };
  return SkillCoverageSchema.parse({
    skill_id: `00000000-0000-4000-8000-${over.key
      .padEnd(12, '0')
      .slice(0, 12)
      .replace(/[^0-9a-f]/gu, '0')}`,
    skill_key: over.key,
    skill_name: over.skill_name ?? over.key,
    is_required: over.is_required ?? true,
    weight: over.weight ?? 1,
    // `in` rather than `??`: these two are nullable, and `null ?? 3` is 3 — which silently
    // replaced the unbounded-band case with a bounded one and made its test pass against
    // data it was never given.
    min_difficulty: 'min_difficulty' in over ? (over.min_difficulty ?? null) : 3,
    max_difficulty: 'max_difficulty' in over ? (over.max_difficulty ?? null) : 5,
    in_band: over.in_band ?? 0,
    published: over.published ?? 0,
    by_difficulty: by,
  });
}

/**
 * Built through the contract's own parser rather than cast into shape.
 *
 * `skill_id` and `job_role_id` are branded, so a literal will not type-check — and the cast
 * that would silence that would also silence a fixture that has drifted from the schema the
 * screen is fed by the real API. Parsing costs nothing here and keeps the fixtures honest.
 */
function coverage(skills: readonly SkillCoverage[]): JobRoleCoverage {
  return JobRoleCoverageSchema.parse({
    job_role_id: ROLE_ID,
    generated_at: '2026-09-20T12:00:00.000Z',
    skills,
    gaps: skills.filter((s) => s.is_required && s.in_band === 0).map((s) => s.skill_key),
  });
}

/**
 * Renders the screen with the two queries already resolved.
 *
 * Async because the screen links into the bank, so a router has to be in scope, and a
 * TanStack router renders nothing until it has loaded its matches — an empty string that
 * every assertion below would have passed against had this stayed synchronous.
 */
async function render(skills: readonly SkillCoverage[]): Promise<string> {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(['job-roles'], {
    data: [
      {
        id: ROLE_ID,
        code: 'be-senior',
        title: 'Senior backend engineer',
        family: 'Engineering',
        seniority: 'Senior',
        description: null,
        is_active: true,
        created_at: '2026-09-01T09:00:00.000Z',
      },
    ],
  });
  client.setQueryData(['job-roles', ROLE_ID, 'coverage'], coverage(skills));

  // The screen links into the bank, so it needs a router in scope. A memory router keeps
  // this a unit test: no document, no history, no navigation.
  const rootRoute = createRootRoute({ component: RolesScreen });
  const questions = createRoute({ getParentRoute: () => rootRoute, path: '/questions' });
  const router = createRouter({
    routeTree: rootRoute.addChildren([questions]),
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
    .replace(/\s+/gu, ' ');

describe('the verdict', () => {
  it('names the skills that block an assessment, and does not offer to compose one', async () => {
    const markup = await render([
      skill({ key: 'sql.window-functions', skill_name: 'SQL window functions', in_band: 0 }),
      skill({ key: 'api.rest-design', skill_name: 'REST API design', in_band: 9, published: 9 }),
    ]);

    expect(text(markup)).toContain('1 required skill has no published question in band');
    expect(text(markup)).toContain('SQL window functions');
    // The whole point. A button that produces a 422 is worse than no button.
    expect(text(markup)).not.toContain('Compose an assessment');
    expect(text(markup)).toContain('Add questions');
  });

  it('distinguishes thin from blocked, because they are different problems', async () => {
    const markup = await render([
      skill({ key: 'py.data-structures', skill_name: 'Python data structures', in_band: 3 }),
      skill({ key: 'api.rest-design', in_band: 12 }),
    ]);

    // Composable, and weaker than it looks: two candidates drawing from three questions
    // see mostly the same ones (docs/18 §3.2).
    expect(text(markup)).toContain('1 required skill is thin');
    expect(text(markup)).toContain('largely the same ones');
    expect(text(markup)).not.toContain('cannot be composed');
  });

  it('says so plainly when the bank is sufficient', async () => {
    const markup = await render([
      skill({ key: 'a', in_band: 20 }),
      skill({ key: 'b', in_band: 8 }),
    ]);

    // A screen that only ever warns is a screen people learn to ignore.
    expect(text(markup)).toContain('The bank can measure every required skill');
    expect(text(markup)).toContain('Compose an assessment');
  });

  it('ignores an optional skill with nothing in it', async () => {
    const markup = await render([
      skill({ key: 'a', in_band: 20 }),
      skill({ key: 'nice-to-have', is_required: false, in_band: 0 }),
    ]);

    expect(text(markup)).toContain('The bank can measure every required skill');
  });
});

describe('the evidence under it', () => {
  it('shows the distribution and marks the levels the role actually asks for', async () => {
    const markup = await render([
      skill({
        key: 'sql.query-tuning',
        skill_name: 'Query tuning',
        min_difficulty: 3,
        max_difficulty: 4,
        in_band: 10,
        published: 14,
        by_difficulty: { '1': 4, '2': 0, '3': 7, '4': 3, '5': 0 },
      }),
    ]);

    expect(text(markup)).toContain('difficulty 3–4');
    // Marked with a class rather than only a colour, and asserted here because "which
    // levels count" is information (SC 1.4.1).
    expect(markup.match(/ab-roles__in-band/gu)).toHaveLength(2);
  });

  it('describes an unbounded band as any difficulty rather than as 1 to 5', async () => {
    const markup = await render([
      skill({ key: 'a', min_difficulty: null, max_difficulty: null, in_band: 9 }),
    ]);

    expect(text(markup)).toContain('any difficulty');
  });
});

describe('verdictFor', () => {
  it('is the single definition of blocked and thin, so the screen and a test agree', () => {
    const v = verdictFor(
      coverage([
        skill({ key: 'blocked', in_band: 0 }),
        skill({ key: 'thin', in_band: 2 }),
        skill({ key: 'fine', in_band: 30 }),
        skill({ key: 'optional-empty', is_required: false, in_band: 0 }),
      ]),
    );

    expect(v.blocked.map((s) => s.skill_key)).toEqual(['blocked']);
    expect(v.thin.map((s) => s.skill_key)).toEqual(['thin']);
    expect(v.ready).toBe(false);
  });
});
