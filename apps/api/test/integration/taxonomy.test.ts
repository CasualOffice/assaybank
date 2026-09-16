/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Skills, job roles, tagging and coverage over HTTP — docs/03 §3–4, against a real PostgreSQL.
 *
 * `packages/db/tests/taxonomy.test.ts` proves the queries. This suite proves the endpoints, and
 * it exists because the first version of these routes shipped with no HTTP test and two defects
 * nobody could see from the repository layer: they were registered outside `/api/v1`, and every
 * taxonomy refusal surfaced as a 500.
 *
 * The cases that matter most are the tenancy ones. A foreign key is checked without row-level
 * security, so a tag naming another organisation's skill id satisfies both the policy on
 * `question_skills` and the key — the route is the only thing that can refuse it. Those cases
 * assert the refusal *and* that nothing was written.
 *
 * The principal is deposited rather than logged in, for the reason `questions.test.ts` gives.
 */

import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { KnownPermission, StaffPrincipal } from '@assaybank/auth';
import {
  OrgIdSchema,
  UserIdSchema,
  type ErrorEnvelope,
  type JobRoleCoverage,
  type JobRoleView,
  type OrgId,
  type UserId,
} from '@assaybank/contracts';

import { setPrincipal } from '../../src/principal.js';
import { buildServer } from '../../src/server.js';
import { JOB_ROLES_ROUTE, SKILLS_ROUTE, TAXONOMY_ACTIONS } from '../../src/taxonomy/routes.js';
import { testConfig } from '../../src/test-support.js';
import { startTestPostgres, type TestPostgres } from './postgres-fixture.js';

const AT = new Date('2026-10-20T09:00:00.000Z');

const ACME: OrgId = OrgIdSchema.parse('5b2d0f81-3c94-4e62-9a7b-1d8e6fa2c315');
const RIVAL: OrgId = OrgIdSchema.parse('a04e92c3-7d58-4f16-8b2e-84c6f1d93a72');
const ADA: UserId = UserIdSchema.parse('33333333-3333-4333-8333-333333333333');
const BEA: UserId = UserIdSchema.parse('44444444-4444-4444-8444-444444444444');

const NOWHERE = '00000000-0000-4000-8000-000000000000';

let pg: TestPostgres | undefined;
let app: FastifyInstance | undefined;
let auditWatermark = '0';

function required<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new Error(`fixture ${name} was not initialised`);
  return value;
}
const fixture = (): TestPostgres => required(pg, 'postgres');
const server = (): FastifyInstance => required(app, 'server');

function staff(orgId: OrgId, userId: UserId, ...held: KnownPermission[]): StaffPrincipal {
  return { kind: 'staff', orgId, userId, permissions: new Set<string>(held) };
}
const everything = (): StaffPrincipal =>
  staff(ACME, ADA, 'question.read', 'question.write', 'assessment.write');
const bankAuthor = (): StaffPrincipal => staff(ACME, ADA, 'question.read', 'question.write');
const reader = (): StaffPrincipal => staff(ACME, ADA, 'question.read');
const rival = (): StaffPrincipal =>
  staff(RIVAL, BEA, 'question.read', 'question.write', 'assessment.write');

let acting: StaffPrincipal = everything();

/** Skill ids seeded once, as the owner. */
let python = '';
let sqlSkill = '';
let globalHttp = '';
let rivalSkill = '';
let acmeQuestion = '';
let rivalQuestion = '';

async function seedOrg(orgId: OrgId, slug: string, userId: UserId): Promise<void> {
  const owner = fixture().owner;
  await owner`INSERT INTO organizations (id, name, slug) VALUES (${orgId}, ${slug}, ${slug})`;
  await owner`INSERT INTO users (id, org_id, email, full_name)
              VALUES (${userId}, ${orgId}, ${`staff@${slug}.example`}, ${`Staff ${slug}`})`;
}

async function insertId(query: Promise<{ id: string }[]>, name: string): Promise<string> {
  return required((await query)[0], name).id;
}

beforeAll(async () => {
  pg = await startTestPostgres();
  const owner = fixture().owner;
  await seedOrg(ACME, 'acme-tax', ADA);
  await seedOrg(RIVAL, 'rival-tax', BEA);

  python = await insertId(
    owner<
      { id: string }[]
    >`INSERT INTO skills (org_id, key, name) VALUES (${ACME}, 'python', 'Python') RETURNING id`,
    'python',
  );
  sqlSkill = await insertId(
    owner<
      { id: string }[]
    >`INSERT INTO skills (org_id, key, name) VALUES (${ACME}, 'sql', 'SQL') RETURNING id`,
    'sql',
  );
  globalHttp = await insertId(
    owner<
      { id: string }[]
    >`INSERT INTO skills (org_id, key, name) VALUES (NULL, 'http', 'HTTP') RETURNING id`,
    'global',
  );
  rivalSkill = await insertId(
    owner<
      { id: string }[]
    >`INSERT INTO skills (org_id, key, name) VALUES (${RIVAL}, 'secret-sauce', 'Rival internal skill') RETURNING id`,
    'rival skill',
  );
  acmeQuestion = await insertId(
    owner<
      { id: string }[]
    >`INSERT INTO questions (org_id, kind, status) VALUES (${ACME}, 'subjective', 'draft') RETURNING id`,
    'acme question',
  );
  rivalQuestion = await insertId(
    owner<
      { id: string }[]
    >`INSERT INTO questions (org_id, kind, status) VALUES (${RIVAL}, 'subjective', 'draft') RETURNING id`,
    'rival question',
  );
}, 300_000);

afterAll(async () => {
  await app?.close();
  await pg?.stop();
});

beforeEach(async () => {
  acting = everything();
  const instance = buildServer({
    config: testConfig(),
    logger: false,
    db: fixture().db,
    now: () => AT,
  });
  instance.addHook('onRequest', (request, _reply, done) => {
    setPrincipal(request, acting);
    done();
  });
  await instance.ready();
  app = instance;
  const [row] = await fixture().owner<
    { id: string }[]
  >`SELECT coalesce(max(id), 0)::text AS id FROM audit_log`;
  auditWatermark = required(row, 'watermark').id;
});

afterEach(async () => {
  await app?.close();
  app = undefined;
});

interface Exchange {
  readonly status: number;
  readonly body: unknown;
}

async function send(
  method: 'GET' | 'POST' | 'PATCH' | 'PUT',
  url: string,
  payload?: unknown,
): Promise<Exchange> {
  const response = await server().inject({
    method,
    url,
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
  return { status: response.statusCode, body: response.json<unknown>() };
}

const envelope = (body: unknown): ErrorEnvelope => body as ErrorEnvelope;
const fields = (body: unknown): { field: string; rule: string }[] =>
  (envelope(body).error.details as { fields?: { field: string; rule: string }[] } | undefined)
    ?.fields ?? [];

async function auditSince(): Promise<
  {
    action: string;
    entity_id: string | null;
    reason: string | null;
    before: unknown;
    after: unknown;
  }[]
> {
  return fixture().owner`
    SELECT action, entity_id, after->>'reason' AS reason, before, after FROM audit_log
     WHERE id > ${auditWatermark}::bigint ORDER BY id`;
}

async function createRole(code: string, title = code): Promise<JobRoleView> {
  const created = await send('POST', JOB_ROLES_ROUTE, { code, title });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return created.body as JobRoleView;
}

// ---------------------------------------------------------------------------- the cases

describe('the version prefix', () => {
  it('serves the taxonomy under /api/v1, and not at the bare path it once had', async () => {
    expect(SKILLS_ROUTE).toBe('/api/v1/skills');
    expect((await send('GET', SKILLS_ROUTE)).status).toBe(200);
    expect((await send('GET', '/skills')).status).toBe(404);
  });
});

describe('POST /skills', () => {
  it('refuses an unknown parent as a named field, not a 500', async () => {
    const res = await send('POST', SKILLS_ROUTE, {
      key: 'orphan',
      name: 'Orphan',
      parent_id: NOWHERE,
    });
    expect(res.status).toBe(422);
    expect(fields(res.body)).toEqual([
      expect.objectContaining({ field: 'body/parent_id', rule: 'not_found' }),
    ]);
  });

  it('refuses a third level, naming the rule', async () => {
    const child = await send('POST', SKILLS_ROUTE, {
      key: 'python.typing',
      name: 'typing',
      parent_id: python,
    });
    expect(child.status).toBe(201);
    const grandchild = await send('POST', SKILLS_ROUTE, {
      key: 'python.typing.generics',
      name: 'generics',
      parent_id: (child.body as { id: string }).id,
    });
    expect(grandchild.status).toBe(422);
    expect(fields(grandchild.body)[0]?.rule).toBe('too_deep');
  });

  it('refuses another organisation’s skill as a parent exactly as it refuses a missing one', async () => {
    const res = await send('POST', SKILLS_ROUTE, {
      key: 'probe',
      name: 'Probe',
      parent_id: rivalSkill,
    });
    expect(res.status).toBe(422);
    expect(fields(res.body)[0]?.rule).toBe('not_found');
  });
});

describe('POST /skills/{id}/merge', () => {
  it('answers not_found for a source that does not exist', async () => {
    const res = await send('POST', `${SKILLS_ROUTE}/${NOWHERE}/merge`, {
      target_id: python,
      reason: 'dup',
    });
    expect(res.status).toBe(404);
  });

  it('refuses another organisation’s skill as the target, and writes nothing', async () => {
    const dup = await insertId(
      fixture().owner<
        { id: string }[]
      >`INSERT INTO skills (org_id, key, name) VALUES (${ACME}, 'py', 'py') RETURNING id`,
      'dup',
    );
    const res = await send('POST', `${SKILLS_ROUTE}/${dup}/merge`, {
      target_id: rivalSkill,
      reason: 'dup',
    });
    expect(res.status).toBe(422);
    expect(fields(res.body)[0]).toEqual(
      expect.objectContaining({ field: 'body/target_id', rule: 'not_found' }),
    );
    expect(await auditSince()).toEqual([]);
  });

  it('refuses to merge a global skill away', async () => {
    const res = await send('POST', `${SKILLS_ROUTE}/${globalHttp}/merge`, {
      target_id: python,
      reason: 'mine now',
    });
    expect(res.status).toBe(422);
    expect(fields(res.body)[0]?.rule).toBe('merge_refused');
    const still = await fixture().owner`SELECT 1 FROM skills WHERE id = ${globalHttp}`;
    expect(still.length).toBe(1);
  });

  it('merges a duplicate into a global skill and records the reason', async () => {
    const dup = await insertId(
      fixture().owner<
        { id: string }[]
      >`INSERT INTO skills (org_id, key, name) VALUES (${ACME}, 'http-1-1', 'HTTP/1.1') RETURNING id`,
      'dup',
    );
    const res = await send('POST', `${SKILLS_ROUTE}/${dup}/merge`, {
      target_id: globalHttp,
      reason: 'same thing',
    });
    expect(res.status).toBe(200);
    const audit = await auditSince();
    expect(audit.map((a) => [a.action, a.entity_id, a.reason])).toEqual([
      [TAXONOMY_ACTIONS.skillMerge, dup, 'same thing'],
    ]);
  });
});

describe('job roles', () => {
  it('creates a role and records it', async () => {
    const role = await createRole('BE-SDE1', 'Backend SDE 1');
    expect(role).toEqual(expect.objectContaining({ code: 'BE-SDE1', is_active: true }));
    expect(typeof role.created_at).toBe('string');
    const audit = await auditSince();
    expect(audit.map((a) => [a.action, a.entity_id])).toEqual([
      [TAXONOMY_ACTIONS.jobRoleCreate, role.id],
    ]);
  });

  it('answers 409 for a code already taken, and records nothing', async () => {
    await createRole('DUP-ROLE');
    auditWatermark = required(
      (await fixture().owner<{ id: string }[]>`SELECT max(id)::text AS id FROM audit_log`)[0],
      'w',
    ).id;
    const again = await send('POST', JOB_ROLES_ROUTE, { code: 'DUP-ROLE', title: 'Again' });
    expect(again.status).toBe(409);
    expect(await auditSince()).toEqual([]);
  });

  it('lets another organisation use the same code', async () => {
    await createRole('SHARED-CODE');
    acting = rival();
    expect(
      (await send('POST', JOB_ROLES_ROUTE, { code: 'SHARED-CODE', title: 'Theirs' })).status,
    ).toBe(201);
  });

  it('refuses a malformed code and an unknown field', async () => {
    expect((await send('POST', JOB_ROLES_ROUTE, { code: 'be sde', title: 'x' })).status).toBe(422);
    expect(
      (await send('POST', JOB_ROLES_ROUTE, { code: 'OK-CODE', title: 'x', job_role_id: 'x' }))
        .status,
    ).toBe(422);
  });

  it('requires assessment.write to create or change a role — question.write is not enough', async () => {
    acting = bankAuthor();
    expect((await send('POST', JOB_ROLES_ROUTE, { code: 'NOPE', title: 'x' })).status).toBe(403);
  });

  it('answers not_found for another organisation’s role, on every route', async () => {
    acting = rival();
    const theirs = await createRole('RIVAL-ONLY');
    acting = everything();
    expect((await send('GET', `${JOB_ROLES_ROUTE}/${theirs.id}`)).status).toBe(404);
    expect((await send('PATCH', `${JOB_ROLES_ROUTE}/${theirs.id}`, { title: 'mine' })).status).toBe(
      404,
    );
    expect((await send('GET', `${JOB_ROLES_ROUTE}/${theirs.id}/skills`)).status).toBe(404);
    expect((await send('PUT', `${JOB_ROLES_ROUTE}/${theirs.id}/skills`, [])).status).toBe(404);
    expect((await send('GET', `${JOB_ROLES_ROUTE}/${theirs.id}/coverage`)).status).toBe(404);
  });

  it('retires a role with PATCH, recording before and after', async () => {
    const role = await createRole('RETIRE-ME');
    const res = await send('PATCH', `${JOB_ROLES_ROUTE}/${role.id}`, { is_active: false });
    expect(res.status).toBe(200);
    expect((res.body as JobRoleView).is_active).toBe(false);
    const update = (await auditSince()).find((a) => a.action === TAXONOMY_ACTIONS.jobRoleUpdate);
    expect(update?.before).toEqual(expect.objectContaining({ is_active: true }));
    expect(update?.after).toEqual(expect.objectContaining({ is_active: false }));
  });

  it('refuses a PATCH that names nothing', async () => {
    const role = await createRole('EMPTY-PATCH');
    expect((await send('PATCH', `${JOB_ROLES_ROUTE}/${role.id}`, {})).status).toBe(422);
  });

  it('filters ?active=false to retired roles only — "false" is not truthy', async () => {
    const kept = await createRole('KEEP-ACTIVE');
    const gone = await createRole('GONE-INACTIVE');
    await send('PATCH', `${JOB_ROLES_ROUTE}/${gone.id}`, { is_active: false });

    const inactive = await send('GET', `${JOB_ROLES_ROUTE}?active=false`);
    const codes = (inactive.body as { data: JobRoleView[] }).data.map((r) => r.code);
    expect(codes).toContain('GONE-INACTIVE');
    expect(codes).not.toContain(kept.code);
    expect((await send('GET', `${JOB_ROLES_ROUTE}?active=maybe`)).status).toBe(422);
  });
});

describe('PUT /job-roles/{id}/skills', () => {
  it('replaces the requirements and reads them back required-first', async () => {
    const role = await createRole('DATA-ENG');
    const res = await send('PUT', `${JOB_ROLES_ROUTE}/${role.id}/skills`, [
      { skill_id: sqlSkill, weight: 1, is_required: false },
      { skill_id: python, weight: 3, min_difficulty: 2, max_difficulty: 4 },
    ]);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const data = (res.body as { data: { skill_key: string; is_required: boolean }[] }).data;
    expect(data.map((d) => [d.skill_key, d.is_required])).toEqual([
      ['python', true],
      ['sql', false],
    ]);
    const read = await send('GET', `${JOB_ROLES_ROUTE}/${role.id}/skills`);
    expect((read.body as { data: unknown[] }).data).toEqual(data);
  });

  it('refuses another organisation’s skill by position, and leaves the old set in place', async () => {
    const role = await createRole('TENANCY-PROBE');
    await send('PUT', `${JOB_ROLES_ROUTE}/${role.id}/skills`, [{ skill_id: python, weight: 1 }]);

    const res = await send('PUT', `${JOB_ROLES_ROUTE}/${role.id}/skills`, [
      { skill_id: python, weight: 1 },
      { skill_id: rivalSkill, weight: 2 },
    ]);
    expect(res.status).toBe(422);
    expect(fields(res.body)).toEqual([
      expect.objectContaining({ field: 'body/1/skill_id', rule: 'not_found' }),
    ]);

    const rows = await fixture().owner<{ skill_id: string }[]>`
      SELECT skill_id FROM job_role_skills WHERE job_role_id = ${role.id}`;
    expect(rows.map((r) => r.skill_id)).toEqual([python]);
  });

  it('accepts a global skill', async () => {
    const role = await createRole('WEB-ROLE');
    expect(
      (
        await send('PUT', `${JOB_ROLES_ROUTE}/${role.id}/skills`, [
          { skill_id: globalHttp, weight: 1 },
        ])
      ).status,
    ).toBe(200);
  });

  it('refuses a skill named twice, and an inverted difficulty band', async () => {
    const role = await createRole('BAD-BODY');
    const twice = await send('PUT', `${JOB_ROLES_ROUTE}/${role.id}/skills`, [
      { skill_id: python, weight: 1 },
      { skill_id: python, weight: 2 },
    ]);
    expect(twice.status).toBe(422);
    const inverted = await send('PUT', `${JOB_ROLES_ROUTE}/${role.id}/skills`, [
      { skill_id: python, weight: 1, min_difficulty: 4, max_difficulty: 2 },
    ]);
    expect(inverted.status).toBe(422);
  });
});

describe('GET /job-roles/{id}/coverage', () => {
  it('answers not_found for a role that does not exist, rather than a clean empty report', async () => {
    expect((await send('GET', `${JOB_ROLES_ROUTE}/${NOWHERE}/coverage`)).status).toBe(404);
  });

  it('refuses a malformed id as validation, not a database error', async () => {
    expect((await send('GET', `${JOB_ROLES_ROUTE}/not-a-uuid/coverage`)).status).toBe(422);
  });

  it('names a required skill with no published questions as a gap', async () => {
    const role = await createRole('COVERAGE-ROLE');
    await send('PUT', `${JOB_ROLES_ROUTE}/${role.id}/skills`, [{ skill_id: sqlSkill, weight: 1 }]);
    const res = await send('GET', `${JOB_ROLES_ROUTE}/${role.id}/coverage`);
    expect(res.status).toBe(200);
    const report = res.body as JobRoleCoverage;
    expect(report.gaps).toEqual(['sql']);
    expect(report.generated_at).toBe(AT.toISOString());
  });
});

describe('PUT /questions/{id}/skills', () => {
  const route = (id: string): string => `/api/v1/questions/${id}/skills`;

  it('replaces the tags and records before and after', async () => {
    const res = await send('PUT', route(acmeQuestion), [{ skill_id: python, weight: 2 }]);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({
      question_id: acmeQuestion,
      skills: [{ skill_id: python, weight: 2 }],
    });
    const audit = (await auditSince()).find(
      (a) => a.action === TAXONOMY_ACTIONS.questionSkillsReplace,
    );
    expect(audit?.after).toEqual({ skills: [expect.objectContaining({ skill_id: python })] });
  });

  it('refuses another organisation’s skill and leaves the tags as they were', async () => {
    await send('PUT', route(acmeQuestion), [{ skill_id: sqlSkill, weight: 1 }]);
    const res = await send('PUT', route(acmeQuestion), [{ skill_id: rivalSkill, weight: 1 }]);
    expect(res.status).toBe(422);
    expect(fields(res.body)[0]).toEqual(
      expect.objectContaining({ field: 'body/0/skill_id', rule: 'not_found' }),
    );
    const rows = await fixture().owner<{ skill_id: string }[]>`
      SELECT skill_id FROM question_skills WHERE question_id = ${acmeQuestion}`;
    expect(rows.map((r) => r.skill_id)).toEqual([sqlSkill]);
  });

  it('answers not_found for another organisation’s question', async () => {
    expect(
      (await send('PUT', route(rivalQuestion), [{ skill_id: python, weight: 1 }])).status,
    ).toBe(404);
  });

  it('has no way to tag a question with a job role (ADR-009)', async () => {
    const role = await createRole('NOT-A-TAG');
    const res = await send('PUT', route(acmeQuestion), [{ job_role_id: role.id, weight: 1 }]);
    expect(res.status).toBe(422);
  });

  it('requires question.write', async () => {
    acting = reader();
    expect((await send('PUT', route(acmeQuestion), [])).status).toBe(403);
  });
});
