/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Composing an assessment from a role, end to end (`H-179`, docs/18 §2.2).
 *
 * `compose.test.ts` in `packages/core-domain` covers the arithmetic against fixtures. What
 * only a database can answer is the half the composer cannot see: whether the bank actually
 * holds what a rule asks for. `available` has to count the same questions the draw will later
 * find — published, not archived, current version in band — and a count that drifted from
 * that definition would show a recruiter a feasible plan and hand the first candidate a
 * broken paper.
 *
 * So the bank here is real rows at known difficulties, and every count in every assertion is
 * one somebody could recount by hand from the fixture.
 */

import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { StaffPrincipal } from '@assaybank/auth';
import { API_BASE_PATH, OrgIdSchema, UserIdSchema } from '@assaybank/contracts';

import { setPrincipal } from '../../src/principal.js';
import { buildServer } from '../../src/server.js';
import { testConfig } from '../../src/test-support.js';
import { startTestPostgres, type TestPostgres } from './postgres-fixture.js';

const ACME = '11111111-0000-4000-8000-0000000000a1';
const RIVAL = '11111111-0000-4000-8000-0000000000a2';
const USER = '11111111-0000-4000-8000-0000000000b1';
const PEPPER = 'an-example-token-pepper-for-tests';
/** Fixed, so an expiry assertion is arithmetic rather than a race with the wall clock. */
const NOW = new Date('2026-10-13T09:00:00.000Z');

let pg: TestPostgres | undefined;
let app: FastifyInstance | undefined;
let acting: StaffPrincipal;
/** Role ids, by the code they were seeded under. */
const roles = new Map<string, string>();

function fixture(): TestPostgres {
  if (pg === undefined) throw new Error('postgres is not ready');
  return pg;
}

function staff(orgId: string): StaffPrincipal {
  return {
    kind: 'staff',
    userId: UserIdSchema.parse(USER),
    orgId: OrgIdSchema.parse(orgId),
    permissions: new Set(['question.read', 'question.write', 'assessment.write', 'invite.send']),
  };
}

/** Seeds a skill with `published` questions spread over the difficulties given. */
async function seedSkill(orgId: string, key: string, difficulties: number[]): Promise<string> {
  const { owner } = fixture();
  const [skill] = await owner<{ id: string }[]>`
    INSERT INTO skills (org_id, key, name) VALUES (${orgId}, ${key}, ${key}) RETURNING id
  `;
  const skillId = skill?.id ?? '';

  for (const difficulty of difficulties) {
    const [question] = await owner<{ id: string }[]>`
      INSERT INTO questions (org_id, kind, status) VALUES (${orgId}, 'coding', 'published')
      RETURNING id
    `;
    const questionId = question?.id ?? '';
    const [version] = await owner<{ id: string }[]>`
      INSERT INTO question_versions (question_id, version_no, prompt_md, difficulty, published_at)
      VALUES (${questionId}, 1, ${`A question at ${String(difficulty)}`}, ${difficulty}, now())
      RETURNING id
    `;
    await owner`UPDATE questions SET current_version_id = ${version?.id ?? ''} WHERE id = ${questionId}`;
    await owner`INSERT INTO question_skills (question_id, skill_id) VALUES (${questionId}, ${skillId})`;
  }

  return skillId;
}

async function seedRole(
  orgId: string,
  code: string,
  skills: { skillId: string; weight: number; min: number; max: number; required?: boolean }[],
): Promise<string> {
  const { owner } = fixture();
  const [role] = await owner<{ id: string }[]>`
    INSERT INTO job_roles (org_id, code, title, is_active)
    VALUES (${orgId}, ${code}, ${code}, true) RETURNING id
  `;
  const roleId = role?.id ?? '';
  for (const skill of skills) {
    await owner`
      INSERT INTO job_role_skills (job_role_id, skill_id, weight, min_difficulty, max_difficulty, is_required)
      VALUES (${roleId}, ${skill.skillId}, ${skill.weight}, ${skill.min}, ${skill.max},
              ${skill.required ?? true})
    `;
  }
  roles.set(code, roleId);
  return roleId;
}

beforeAll(async () => {
  pg = await startTestPostgres();
  const { owner } = fixture();

  for (const [id, slug] of [
    [ACME, 'acme'],
    [RIVAL, 'rival'],
  ] as const) {
    await owner`INSERT INTO organizations (id, name, slug) VALUES (${id}, ${slug}, ${slug})`;
  }
  await owner`
    INSERT INTO users (id, org_id, email, full_name, timezone)
    VALUES (${USER}, ${ACME}, 'ada@acme.test', 'Ada', 'UTC')
  `;

  // Deep: 8 published, all inside 2–4. Shallow: 2, and one of those out of band.
  const deep = await seedSkill(ACME, 'deep', [2, 2, 3, 3, 3, 4, 4, 4]);
  const shallow = await seedSkill(ACME, 'shallow', [3, 5]);

  await seedRole(ACME, 'plentiful', [
    { skillId: deep, weight: 1, min: 2, max: 4 },
    { skillId: shallow, weight: 1, min: 2, max: 4 },
  ]);
  await seedRole(ACME, 'weighted', [
    { skillId: deep, weight: 3, min: 2, max: 4 },
    { skillId: shallow, weight: 1, min: 2, max: 4 },
  ]);
  await seedRole(ACME, 'optional-only', [
    { skillId: deep, weight: 1, min: 2, max: 4, required: false },
  ]);
}, 300_000);

afterAll(async () => {
  await app?.close();
  await pg?.stop();
});

beforeEach(async () => {
  acting = staff(ACME);
  const instance = buildServer({
    config: testConfig(),
    logger: false,
    db: fixture().db,
    // The pepper the invitation tokens are hashed under. Without it the publish and invite
    // routes are not registered at all — see `server.ts`.
    invitations: { tokenPepper: PEPPER },
    now: () => NOW,
  });
  instance.addHook('onRequest', (request, _reply, done) => {
    setPrincipal(request, acting);
    done();
  });
  await instance.ready();
  app = instance;
});

afterEach(async () => {
  await app?.close();
  app = undefined;
});

function server(): FastifyInstance {
  if (app === undefined) throw new Error('no server');
  return app;
}

const roleId = (code: string): string => roles.get(code) ?? '';

async function plan(code: string, query = '') {
  const response = await server().inject({
    method: 'GET',
    url: `${API_BASE_PATH}/job-roles/${roleId(code)}/assessment-plan${query}`,
  });
  return { status: response.statusCode, body: response.json<Record<string, never>>() };
}

async function create(body: unknown) {
  const response = await server().inject({
    method: 'POST',
    url: `${API_BASE_PATH}/assessments/auto`,
    headers: { origin: 'https://console.example.test', 'sec-fetch-site': 'same-origin' },
    payload: body as Record<string, unknown>,
  });
  return { status: response.statusCode, body: response.json<Record<string, never>>() };
}

interface PlanBody {
  question_count: number;
  duration_seconds: number;
  feasible: boolean;
  role_title: string;
  sections: { rules: { skill_name: string; pick_count: number; available: number }[] }[];
}

const rulesOf = (body: unknown) => (body as PlanBody).sections.flatMap((s) => s.rules);

describe('GET /job-roles/:id/assessment-plan', () => {
  it('composes a default paper of two questions per required skill', async () => {
    const { status, body } = await plan('plentiful');

    expect(status).toBe(200);
    expect((body as unknown as PlanBody).question_count).toBe(4);
    // Note it is *not* feasible: `shallow` holds one in band and this asks for two. The
    // default is about what a role deserves to be measured on, not about what the bank
    // happens to hold — conflating the two would quietly shrink papers to fit a thin bank.
    expect((body as unknown as PlanBody).feasible).toBe(false);
    expect(rulesOf(body).map((r) => [r.skill_name, r.pick_count])).toEqual([
      ['deep', 2],
      ['shallow', 2],
    ]);
  });

  it('counts what the bank actually holds in each rule’s band', async () => {
    const { body } = await plan('plentiful');
    const byName = new Map(rulesOf(body).map((r) => [r.skill_name, r.available]));

    // deep has eight published, every one inside 2–4.
    expect(byName.get('deep')).toBe(8);
    // shallow has two published and one of them is difficulty 5, outside the role's band.
    // Counting published rather than in-band would say 2 here and hand the draw a paper it
    // cannot fill.
    expect(byName.get('shallow')).toBe(1);
  });

  it('reports infeasible when a rule asks for more than the band holds', async () => {
    const { body } = await plan('plentiful', '?question_count=10');

    expect((body as unknown as PlanBody).feasible).toBe(false);
    // Five needed from a band that holds one.
    expect(rulesOf(body).find((r) => r.skill_name === 'shallow')).toMatchObject({
      pick_count: 5,
      available: 1,
    });
  });

  it('splits the paper by weight', async () => {
    const { body } = await plan('weighted', '?question_count=8');

    expect(rulesOf(body).map((r) => [r.skill_name, r.pick_count])).toEqual([
      ['deep', 6],
      ['shallow', 2],
    ]);
  });

  it('derives a duration from the paper, and lets the caller override it', async () => {
    expect((await plan('plentiful')).body).toMatchObject({ duration_seconds: 4 * 300 });
    expect((await plan('plentiful', '?duration_seconds=3600')).body).toMatchObject({
      duration_seconds: 3600,
    });
  });

  it('refuses a paper too short to cover the role', async () => {
    const { status, body } = await plan('plentiful', '?question_count=1');

    expect(status).toBe(422);
    expect(body).toMatchObject({ error: { code: 'validation_failed' } });
  });

  it('refuses a role with no required skill', async () => {
    expect((await plan('optional-only')).status).toBe(422);
  });

  it('is a 404 for a role that does not exist, not an empty plan', async () => {
    const response = await server().inject({
      method: 'GET',
      url: `${API_BASE_PATH}/job-roles/11111111-0000-4000-8000-00000000ffff/assessment-plan`,
    });
    expect(response.statusCode).toBe(404);
  });

  it('cannot see another organisation’s role', async () => {
    acting = staff(RIVAL);
    expect((await plan('plentiful')).status).toBe(404);
  });
});

describe('POST /assessments/auto', () => {
  // Three, not the default four: `shallow` holds exactly one question in band, so a paper
  // of four would ask it for two and be refused. That is the feasibility rule working, and
  // the create tests want a paper the bank can actually fill.
  const feasible = (extra: Record<string, unknown> = {}) => ({
    job_role_id: roleId('plentiful'),
    question_count: 3,
    ...extra,
  });

  it('writes the assessment, its section and its rules', async () => {
    const { status, body } = await create(feasible());

    expect(status).toBe(201);
    expect(body).toMatchObject({ question_count: 3, duration_seconds: 900, status: 'draft' });

    const id = (body as unknown as { id: string }).id;
    const { owner } = fixture();
    const [row] = await owner<{ n: string }[]>`
      SELECT count(*)::text AS n
        FROM section_rules sr
        JOIN assessment_sections s ON s.id = sr.section_id
       WHERE s.assessment_id = ${id}
    `;
    expect(row?.n, 'one rule per required skill').toBe('2');

    const [sum] = await owner<{ n: string }[]>`
      SELECT coalesce(sum(sr.pick_count), 0)::text AS n
        FROM section_rules sr
        JOIN assessment_sections s ON s.id = sr.section_id
       WHERE s.assessment_id = ${id}
    `;
    expect(sum?.n, 'the rules add up to the paper').toBe('3');
  });

  it('names it after the role unless told otherwise', async () => {
    expect((await create(feasible())).body).toMatchObject({ name: 'plentiful' });
    expect((await create(feasible({ name: 'Spring graduate round' }))).body).toMatchObject({
      name: 'Spring graduate round',
    });
  });

  it('refuses to save a paper the bank cannot fill, and says which skills fall short', async () => {
    // The case that matters. `resolveDraw` will not short-draw at attempt start, so this
    // assessment would not degrade — it would fail for the first candidate to open it.
    const { status, body } = await create({
      job_role_id: roleId('plentiful'),
      question_count: 10,
    });

    expect(status).toBe(422);
    expect(body).toMatchObject({
      error: {
        code: 'validation_failed',
        details: { shortfalls: [{ skill_name: 'shallow', needed: 5, available: 1 }] },
      },
    });
  });

  it('writes nothing when it refuses', async () => {
    const { owner } = fixture();
    const [before] = await owner<{ n: string }[]>`SELECT count(*)::text AS n FROM assessments`;

    await create({ job_role_id: roleId('plentiful'), question_count: 10 });

    const [after] = await owner<{ n: string }[]>`SELECT count(*)::text AS n FROM assessments`;
    expect(after?.n).toBe(before?.n);
  });

  it('records the composition in the audit log', async () => {
    const { owner } = fixture();
    const { body } = await create(feasible());
    const id = (body as unknown as { id: string }).id;

    const [row] = await owner<{ action: string; entity_id: string }[]>`
      SELECT action, entity_id::text AS entity_id FROM audit_log
       WHERE entity_id = ${id} ORDER BY id DESC LIMIT 1
    `;
    expect(row?.action).toBe('assessment.create');
  });
});

describe('GET /assessments', () => {
  it('lists what this organisation composed, and nothing another one did', async () => {
    await create({ job_role_id: roleId('plentiful'), question_count: 3, name: 'Ours' });

    const mine = await server().inject({ method: 'GET', url: `${API_BASE_PATH}/assessments` });
    expect(mine.json<{ data: { name: string }[] }>().data.some((a) => a.name === 'Ours')).toBe(
      true,
    );

    acting = staff(RIVAL);
    const theirs = await server().inject({ method: 'GET', url: `${API_BASE_PATH}/assessments` });
    expect(theirs.json<{ data: unknown[] }>().data).toEqual([]);
  });
});

// --- publishing and inviting -------------------------------------------------

async function publish(assessmentId: string) {
  const response = await server().inject({
    method: 'POST',
    url: `${API_BASE_PATH}/assessments/${assessmentId}/publish`,
    headers: { origin: 'https://console.example.test', 'sec-fetch-site': 'same-origin' },
  });
  return { status: response.statusCode, body: response.json<Record<string, never>>() };
}

async function invite(assessmentId: string, body: unknown) {
  const response = await server().inject({
    method: 'POST',
    url: `${API_BASE_PATH}/assessments/${assessmentId}/invitations`,
    headers: { origin: 'https://console.example.test', 'sec-fetch-site': 'same-origin' },
    payload: body as Record<string, unknown>,
  });
  return { status: response.statusCode, body: response.json<Record<string, never>>() };
}

async function invitations(assessmentId: string) {
  const response = await server().inject({
    method: 'GET',
    url: `${API_BASE_PATH}/assessments/${assessmentId}/invitations`,
  });
  return {
    status: response.statusCode,
    body: response.json<{ data: { email: string; state: string; expires_at: string }[] }>(),
  };
}

/** Composes a feasible assessment and returns its id. */
async function composed(): Promise<string> {
  const { body } = await create(feasibleFor('plentiful'));
  return (body as unknown as { id: string }).id;
}

const feasibleFor = (code: string) => ({ job_role_id: roleId(code), question_count: 3 });

describe('POST /assessments/:id/publish', () => {
  it('makes a draft sittable', async () => {
    const id = await composed();
    const { status, body } = await publish(id);

    expect(status).toBe(200);
    expect(body).toMatchObject({ status: 'published' });
  });

  it('refuses a second publish as a conflict rather than pretending', async () => {
    const id = await composed();
    await publish(id);

    const { status, body } = await publish(id);
    expect(status).toBe(409);
    expect(body).toMatchObject({ error: { code: 'conflict' } });
  });

  it('re-checks the bank, because a question can be retired after composition', async () => {
    // The case the snapshot at composition cannot cover. The paper was feasible when it was
    // composed; publishing is the act that lets somebody try to sit it, so the check runs
    // again against the bank as it is.
    const id = await composed();
    const { owner } = fixture();

    await owner`UPDATE questions SET status = 'retired'
                 WHERE id IN (
                   SELECT q.id FROM questions q
                     JOIN question_skills qs ON qs.question_id = q.id
                     JOIN skills s ON s.id = qs.skill_id
                    WHERE s.key = 'deep'
                 )`;
    try {
      const { status, body } = await publish(id);
      expect(status).toBe(422);
      expect(body).toMatchObject({ error: { code: 'validation_failed' } });
    } finally {
      await owner`UPDATE questions SET status = 'published'
                   WHERE id IN (
                     SELECT q.id FROM questions q
                       JOIN question_skills qs ON qs.question_id = q.id
                       JOIN skills s ON s.id = qs.skill_id
                      WHERE s.key = 'deep'
                   )`;
    }
  });

  it('is a 404 for an assessment that does not exist', async () => {
    const response = await server().inject({
      method: 'POST',
      url: `${API_BASE_PATH}/assessments/11111111-0000-4000-8000-0000000000ff/publish`,
      headers: { origin: 'https://console.example.test', 'sec-fetch-site': 'same-origin' },
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('POST /assessments/:id/invitations', () => {
  it('refuses to invite anybody to a draft', async () => {
    // An invitation to an unpublished assessment is refused at redemption, so issuing one
    // produces a link the recipient finds broken and the recruiter hears about later.
    const id = await composed();

    const { status, body } = await invite(id, { emails: ['ada@example.test'] });
    expect(status).toBe(422);
    expect(body).toMatchObject({ error: { code: 'validation_failed' } });
  });

  it('issues a link per address, exactly once', async () => {
    const id = await composed();
    await publish(id);

    const { status, body } = await invite(id, {
      emails: ['ada@example.test', 'grace@example.test'],
    });
    const issued = (body as unknown as { issued: { email: string; url: string }[] }).issued;

    expect(status).toBe(201);
    expect(issued.map((i) => i.email).sort()).toEqual(['ada@example.test', 'grace@example.test']);
    // The link points at the candidate app's redemption route, built from configuration and
    // never from a Host header.
    expect(issued[0]?.url).toMatch(/^https:\/\/sit\.example\.test\/t\/[A-Za-z0-9_-]{20,}$/u);
    // Two candidates, two different tokens.
    expect(issued[0]?.url).not.toBe(issued[1]?.url);
  });

  it('stores a hash and never the token', async () => {
    const id = await composed();
    await publish(id);
    const { body } = await invite(id, { emails: ['ada@example.test'] });
    const url = (body as unknown as { issued: { url: string }[] }).issued[0]?.url ?? '';
    const token = url.slice(url.lastIndexOf('/') + 1);

    const { owner } = fixture();
    const rows = await owner<{ token_hash: string }[]>`
      SELECT token_hash FROM invitations WHERE assessment_id = ${id}
    `;

    expect(token.length).toBeGreaterThan(20);
    // A dump of this table is not a set of live credentials.
    expect(rows[0]?.token_hash).not.toContain(token);
    expect(rows[0]?.token_hash).toMatch(/^v1\$[0-9a-f]{64}$/u);
  });

  it('does not hand a second live link to somebody who already has one', async () => {
    // Pasting the same list twice is a thing that happens; two live links is two sittings
    // nobody decided to allow.
    const id = await composed();
    await publish(id);
    await invite(id, { emails: ['ada@example.test'] });

    const { body } = await invite(id, { emails: ['ada@example.test', 'new@example.test'] });
    const result = body as unknown as { issued: { email: string }[]; skipped: string[] };

    expect(result.skipped).toEqual(['ada@example.test']);
    expect(result.issued.map((i) => i.email)).toEqual(['new@example.test']);
  });

  it('treats one address twice in one request as one invitation', async () => {
    const id = await composed();
    await publish(id);

    const { body } = await invite(id, {
      emails: ['ada@example.test', 'ADA@example.test'],
    });
    expect((body as unknown as { issued: unknown[] }).issued).toHaveLength(1);
  });

  it('creates one candidate row per person, however many assessments they are invited to', async () => {
    const first = await composed();
    const second = await composed();
    await publish(first);
    await publish(second);
    await invite(first, { emails: ['repeat@example.test'] });
    await invite(second, { emails: ['repeat@example.test'] });

    const { owner } = fixture();
    const rows = await owner<{ n: string }[]>`
      SELECT count(*)::text AS n FROM candidates WHERE email = 'repeat@example.test'
    `;
    expect(rows[0]?.n).toBe('1');
  });

  it('expires the link on the server’s clock, not the caller’s', async () => {
    const id = await composed();
    await publish(id);

    const { body } = await invite(id, { emails: ['ada@example.test'], expires_in_days: 7 });
    const expires = (body as unknown as { issued: { expires_at: string }[] }).issued[0]?.expires_at;

    expect(new Date(expires ?? '').toISOString()).toBe('2026-10-20T09:00:00.000Z');
  });
});

describe('GET /assessments/:id/invitations', () => {
  it('reports who was invited and where they got to, and never the token', async () => {
    const id = await composed();
    await publish(id);
    const created = await invite(id, { emails: ['ada@example.test'] });
    const url = (created.body as unknown as { issued: { url: string }[] }).issued[0]?.url ?? '';
    const token = url.slice(url.lastIndexOf('/') + 1);

    const { status, body } = await invitations(id);

    expect(status).toBe(200);
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({ email: 'ada@example.test', state: 'issued' });
    expect(JSON.stringify(body)).not.toContain(token);
  });

  it('cannot see another organisation’s invitations', async () => {
    const id = await composed();
    await publish(id);
    await invite(id, { emails: ['ada@example.test'] });

    acting = staff(RIVAL);
    expect((await invitations(id)).status).toBe(404);
  });
});
