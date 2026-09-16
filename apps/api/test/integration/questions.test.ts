/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The question bank over HTTP — docs/03 §4, against a real PostgreSQL.
 *
 * `packages/db`'s own suite proves the rows and the triggers. This one proves the
 * *endpoint*: the status codes, the error envelopes, the audit rows, and above all the
 * two things P2 exists to establish.
 *
 * **ADR-003 is a signpost rather than a wall.** A `PATCH` against a published version
 * answers `409` with code `version_immutable` and a `details` that names where the edit
 * belongs — and then the suite takes that route and shows it works. The roadmap's phrasing
 * for this phase is that the API should "make that the natural path rather than a wall
 * people hit", and the way to assert it is to walk the path.
 *
 * **The audience boundary holds over the wire.** Every response on this surface is the
 * author view, because these ten routes are staff-only by permission — and the suite
 * checks the *serialised body*, because what a type says and what crossed the socket are
 * two different claims. The candidate half is `tests/leak/`.
 *
 * ## Why the principal is deposited rather than logged in
 *
 * `org-settings.test.ts` drives a real Better Auth login, and proves the cookie path once
 * for the whole application. Repeating it here would test the same five stages again and
 * make each of these cases three times slower; what is under test is the ten handlers, so
 * the suite deposits the principal an earlier hook would have produced. Everything after
 * that stage is real: the authorisation check, `withOrg`, the policies, the audit writer
 * and the database.
 *
 * The one thing that must *not* be faked is the permission set, because a route that
 * checks the wrong permission passes every test written against a principal that holds all
 * of them. So there are three principals — a reader, an author and a publisher — and the
 * cases assert which one each route refuses.
 */

import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { PERMISSIONS, type KnownPermission, type StaffPrincipal } from '@assaybank/auth';
import {
  OrgIdSchema,
  UserIdSchema,
  type AuthorQuestionVersionView,
  type AuthorQuestionView,
  type ErrorEnvelope,
  type OrgId,
  type QuestionListResponse,
  type QuestionVersionListResponse,
  type UserId,
} from '@assaybank/contracts';
import { findAnswerKeyFields } from '@assaybank/contracts';

import { setPrincipal } from '../../src/principal.js';
import {
  QUESTIONS_ROUTE,
  QUESTION_ACTIONS,
} from '../../src/questions/routes.js';
import { buildServer } from '../../src/server.js';
import { testConfig } from '../../src/test-support.js';
import { startTestPostgres, type TestPostgres } from './postgres-fixture.js';

/** Injected, never the wall clock (ADR-006, docs/17 §8). */
const AT = new Date('2026-10-20T09:00:00.000Z');

const ACME: OrgId = OrgIdSchema.parse('4a1c9e70-2b83-4d51-8f6a-0c7d5e91b204');
const RIVAL: OrgId = OrgIdSchema.parse('9f3d81b2-6c47-4e05-9a1d-73b5e0c82f61');

const ADA: UserId = UserIdSchema.parse('11111111-1111-4111-8111-111111111111');
const BEA: UserId = UserIdSchema.parse('22222222-2222-4222-8222-222222222222');

let pg: TestPostgres | undefined;
let app: FastifyInstance | undefined;
/** The highest `audit_log.id` before the current block ran. See `org-settings.test.ts`. */
let auditWatermark = '0';

function required<T>(value: T | undefined, name: string): T {
  if (value === undefined) {
    throw new Error(`fixture ${name} was not initialised; the suite cannot assert anything`);
  }
  return value;
}

function fixture(): TestPostgres {
  return required(pg, 'postgres');
}

function server(): FastifyInstance {
  return required(app, 'server');
}

/** A staff principal holding exactly the permissions named, and no others. */
function staff(orgId: OrgId, userId: UserId, ...held: KnownPermission[]): StaffPrincipal {
  return { kind: 'staff', orgId, userId, permissions: new Set<string>(held) };
}

/** Holds every question permission. The ordinary author-and-publisher. */
const bankAdmin = (): StaffPrincipal =>
  staff(ACME, ADA, 'question.read', 'question.write', 'question.publish');
/** Can look, and nothing else. */
const reader = (): StaffPrincipal => staff(ACME, ADA, 'question.read');
/** Can author but not publish — the separation docs/03 §4 asks for. */
const author = (): StaffPrincipal => staff(ACME, ADA, 'question.read', 'question.write');
/** A different tenant's administrator. */
const outsider = (): StaffPrincipal =>
  staff(RIVAL, BEA, 'question.read', 'question.write', 'question.publish');

/** The principal the next request will carry. Set per case. */
let acting: StaffPrincipal = bankAdmin();

async function seedOrg(orgId: OrgId, slug: string, userId: UserId): Promise<void> {
  const owner = fixture().owner;
  await owner`INSERT INTO organizations (id, name, slug) VALUES (${orgId}, ${slug}, ${slug})`;
  await owner`
    INSERT INTO users (id, org_id, email, full_name)
    VALUES (${userId}, ${orgId}, ${`staff@${slug}.example`}, ${`Staff ${slug}`})
  `;
}

/** The highest `audit_log.id`, as text because it is a bigserial. */
async function maxAuditId(): Promise<string> {
  const [row] = await fixture().owner<{ id: string }[]>`
    SELECT coalesce(max(id), 0)::text AS id FROM audit_log
  `;
  return required(row, 'the audit watermark').id;
}

/** Audit rows written since the watermark, newest last. */
async function auditSince(): Promise<
  { action: string; entity_type: string; entity_id: string | null; before: unknown; after: unknown }[]
> {
  return fixture().owner<
    { action: string; entity_type: string; entity_id: string | null; before: unknown; after: unknown }[]
  >`
    SELECT action, entity_type, entity_id, before, after
      FROM audit_log
     WHERE id > ${auditWatermark}::bigint
     ORDER BY id
  `;
}

beforeAll(async () => {
  pg = await startTestPostgres();
  await seedOrg(ACME, 'acme', ADA);
  await seedOrg(RIVAL, 'rival', BEA);
}, 300_000);

afterAll(async () => {
  await app?.close();
  await pg?.stop();
});

beforeEach(async () => {
  acting = bankAdmin();

  // A fresh instance per test: `@fastify/rate-limit`'s default store is per instance, and
  // a shared one would have a late case refused for reasons unrelated to what it asserts.
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

  auditWatermark = await maxAuditId();
});

afterEach(async () => {
  await app?.close();
  app = undefined;
});

// --- request helpers ---------------------------------------------------------

/** One HTTP exchange, reduced to what every assertion below actually looks at. */
interface Exchange {
  readonly status: number;
  readonly body: unknown;
}

async function send(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  payload?: Record<string, unknown>,
): Promise<Exchange> {
  const response = await server().inject({
    method,
    url,
    ...(payload === undefined ? {} : { payload }),
  });
  return { status: response.statusCode, body: response.json<unknown>() };
}

const get = async (url: string): Promise<Exchange> => send('GET', url);
const post = async (url: string, payload?: Record<string, unknown>): Promise<Exchange> =>
  send('POST', url, payload);
const patch = async (url: string, payload: Record<string, unknown>): Promise<Exchange> =>
  send('PATCH', url, payload);
const remove = async (url: string): Promise<Exchange> => send('DELETE', url);

function asQuestion(body: unknown): AuthorQuestionView {
  return body as AuthorQuestionView;
}

function asVersion(body: unknown): AuthorQuestionVersionView {
  return body as AuthorQuestionVersionView;
}

function asEnvelope(body: unknown): ErrorEnvelope {
  return body as ErrorEnvelope;
}

/** Creates a question and its first version, through the API. Returns both ids. */
async function createQuestionWithVersion(
  kind: string,
  version: Record<string, unknown>,
): Promise<{ id: string; versionNo: number }> {
  const created = await post(QUESTIONS_ROUTE, { kind });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const id = asQuestion(created.body).id;

  const wrote = await post(`${QUESTIONS_ROUTE}/${id}/versions`, version);
  expect(wrote.status).toBe(201);

  return { id, versionNo: asVersion(wrote.body).version_no };
}

/** Takes a question all the way to published, through the API, as the bank administrator. */
async function publishedQuestion(
  kind: string,
  version: Record<string, unknown>,
): Promise<{ id: string; versionNo: number }> {
  const { id, versionNo } = await createQuestionWithVersion(kind, version);
  expect((await patch(`${QUESTIONS_ROUTE}/${id}`, { status: 'review' })).status).toBe(200);
  const published = await post(`${QUESTIONS_ROUTE}/${id}/versions/${versionNo}/publish`);
  expect(published.status).toBe(200);
  return { id, versionNo };
}

// --- the cases ---------------------------------------------------------------

describe('POST /questions', () => {
  it('creates a draft with no version, and records one audit row', async () => {
    const response = await post(QUESTIONS_ROUTE, { kind: 'coding', source_license: 'MIT' });

    expect(response.status).toBe(201);
    const question = asQuestion(response.body);
    expect(question.status).toBe('draft');
    expect(question.kind).toBe('coding');
    expect(question.source_license).toBe('MIT');
    expect(question.current_version).toBeNull();

    const rows = await auditSince();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.action).toBe(QUESTION_ACTIONS.create);
    expect(rows[0]?.entity_type).toBe('question');
    // The id does not exist until the INSERT has run, so the handler amends it in.
    expect(rows[0]?.entity_id).toBe(question.id);
  });

  it('refuses an unrecognised field rather than silently dropping it', async () => {
    // ajv is configured with `removeAdditional: true` here, which is why the body is
    // parsed with zod in the handler. Answering 201 while quietly discarding a field the
    // caller believed they had set is the failure this guards.
    const response = await post(QUESTIONS_ROUTE, { kind: 'coding', status: 'published' });

    expect(response.status).toBe(422);
    expect(asEnvelope(response.body).error.code).toBe('validation_failed');
  });

  it('refuses a kind the schema does not define', async () => {
    const response = await post(QUESTIONS_ROUTE, { kind: 'interpretive_dance' });
    expect(response.status).toBe(422);
  });

  it('is refused for a principal holding only question.read', async () => {
    acting = reader();
    const response = await post(QUESTIONS_ROUTE, { kind: 'coding' });
    expect(response.status).toBe(403);
    expect(asEnvelope(response.body).error.code).toBe('forbidden');
  });
});

describe('POST /questions/{id}/versions', () => {
  it('requires a prompt and a difficulty for the first version, naming both', async () => {
    const created = await post(QUESTIONS_ROUTE, { kind: 'subjective' });
    const id = asQuestion(created.body).id;

    const response = await post(`${QUESTIONS_ROUTE}/${id}/versions`, {});

    expect(response.status).toBe(422);
    const envelope = asEnvelope(response.body);
    expect(envelope.error.code).toBe('validation_failed');
    expect(envelope.error.details?.['fields']).toStrictEqual([
      { field: 'body/prompt_md', rule: 'required' },
      { field: 'body/difficulty', rule: 'required' },
    ]);
  });

  it('copies forward everything the body did not name', async () => {
    const { id } = await createQuestionWithVersion('mcq_single', {
      prompt_md: 'What is 2 + 2?',
      difficulty: 1,
      explanation_md: 'Addition.',
      est_seconds: 45,
      options: [
        { body_md: '4', is_correct: true, rationale_md: 'Correct.' },
        { body_md: '5', is_correct: false },
      ],
    });

    const second = await post(`${QUESTIONS_ROUTE}/${id}/versions`, {
      prompt_md: 'What is two plus two?',
    });

    expect(second.status).toBe(201);
    const version = asVersion(second.body);
    expect(version.version_no).toBe(2);
    expect(version.prompt_md).toBe('What is two plus two?');
    // Authoring a fix must not mean retyping the question.
    expect(version.explanation_md).toBe('Addition.');
    expect(version.est_seconds).toBe(45);
    expect(version.options.map((option) => option.body_md)).toStrictEqual(['4', '5']);
    expect(version.options[0]?.is_correct).toBe(true);
    expect(version.options[0]?.rationale_md).toBe('Correct.');
    expect(version.published_at).toBeNull();
  });

  it('does not make a new version current until it is published', async () => {
    const { id, versionNo } = await publishedQuestion('short_answer', {
      prompt_md: 'Capital of France?',
      difficulty: 1,
      answer_keys: [{ match_type: 'ci', pattern: 'paris' }],
    });

    await post(`${QUESTIONS_ROUTE}/${id}/versions`, { prompt_md: 'What is the capital of France?' });

    const question = asQuestion((await get(`${QUESTIONS_ROUTE}/${id}`)).body);
    // The draft exists and the pointer has not followed it, which is what stops a
    // candidate from ever being served an unpublished version.
    expect(question.current_version?.version_no).toBe(versionNo);
    expect(question.current_version?.prompt_md).toBe('Capital of France?');

    const versionsExchange = await get(`${QUESTIONS_ROUTE}/${id}/versions`);
    expect(versionsExchange.status, JSON.stringify(versionsExchange.body)).toBe(200);
    const versions = versionsExchange.body as QuestionVersionListResponse;
    expect(versions.data.map((v) => v.version_no).sort()).toStrictEqual([1, 2]);
  });
});

describe('PATCH /questions/{id}/versions/{v} — ADR-003', () => {
  it('edits a draft version in place', async () => {
    const { id, versionNo } = await createQuestionWithVersion('subjective', {
      prompt_md: 'Draft.',
      difficulty: 2,
    });

    const response = await patch(`${QUESTIONS_ROUTE}/${id}/versions/${versionNo}`, {
      prompt_md: 'Draft, revised.',
    });

    expect(response.status).toBe(200);
    expect(asVersion(response.body).version_no).toBe(versionNo);
    expect(asVersion(response.body).prompt_md).toBe('Draft, revised.');
  });

  it('answers 409 version_immutable against a published version, and says where to go', async () => {
    const { id, versionNo } = await publishedQuestion('mcq_single', {
      prompt_md: 'Which is prime?',
      difficulty: 2,
      // Two options at least: one option is not a question, and the kind rule now refuses
      // to publish it.
      options: [
        { body_md: '7', is_correct: true },
        { body_md: '8', is_correct: false },
      ],
    });

    const response = await patch(`${QUESTIONS_ROUTE}/${id}/versions/${versionNo}`, {
      prompt_md: 'Which of these is prime?',
    });

    expect(response.status).toBe(409);
    const envelope = asEnvelope(response.body);
    expect(envelope.error.code).toBe('version_immutable');
    expect(envelope.error.details?.['version_no']).toBe(versionNo);
    // The remedy travels in the envelope: a client author needs to know the edit is
    // possible and where it goes, not merely that this request failed.
    expect(envelope.error.details?.['create_version_at']).toBe('/questions/{id}/versions');
    // And it is an error envelope like every other one (docs/03 §2).
    expect(typeof envelope.error.request_id).toBe('string');
    expect(typeof envelope.error.message).toBe('string');
  });

  it('leaves the published version untouched after the refusal', async () => {
    const { id, versionNo } = await publishedQuestion('subjective', {
      prompt_md: 'Design a rate limiter.',
      difficulty: 4,
    });

    await patch(`${QUESTIONS_ROUTE}/${id}/versions/${versionNo}`, { prompt_md: 'tampered' });

    const version = asVersion((await get(`${QUESTIONS_ROUTE}/${id}/versions/${versionNo}`)).body);
    expect(version.prompt_md).toBe('Design a rate limiter.');
  });

  it('writes no audit row for a refused edit', async () => {
    const { id, versionNo } = await publishedQuestion('subjective', {
      prompt_md: 'Unchanged.',
      difficulty: 3,
    });

    auditWatermark = await maxAuditId();
    await patch(`${QUESTIONS_ROUTE}/${id}/versions/${versionNo}`, { prompt_md: 'tampered' });

    // The work and the record roll back together, so history does not claim an edit that
    // never happened.
    expect(await auditSince()).toHaveLength(0);
  });

  it('offers a path that works: the same edit as a new version', async () => {
    // The roadmap's phrasing for this phase is that the API should make the new-version
    // path "the natural path rather than a wall people hit". This case walks it.
    const { id, versionNo } = await publishedQuestion('mcq_single', {
      prompt_md: 'Which is the largest?',
      difficulty: 2,
      options: [
        { body_md: '10', is_correct: true },
        { body_md: '9', is_correct: false },
      ],
    });

    const refused = await patch(`${QUESTIONS_ROUTE}/${id}/versions/${versionNo}`, {
      prompt_md: 'Which of these is largest?',
    });
    expect(refused.status).toBe(409);

    const redirected = await post(`${QUESTIONS_ROUTE}/${id}/versions`, {
      prompt_md: 'Which of these is largest?',
    });
    expect(redirected.status).toBe(201);

    const next = asVersion(redirected.body);
    expect(next.version_no).toBe(versionNo + 1);
    // The one-field edit, with both options carried across untouched.
    expect(next.prompt_md).toBe('Which of these is largest?');
    expect(next.options).toHaveLength(2);
    expect(next.options[0]?.is_correct).toBe(true);

    const published = await post(`${QUESTIONS_ROUTE}/${id}/versions/${next.version_no}/publish`);
    expect(published.status).toBe(200);

    const question = asQuestion((await get(`${QUESTIONS_ROUTE}/${id}`)).body);
    expect(question.current_version?.version_no).toBe(next.version_no);
    // And the old version is still there, still frozen, still what past attempts saw.
    const old = asVersion((await get(`${QUESTIONS_ROUTE}/${id}/versions/${versionNo}`)).body);
    expect(old.prompt_md).toBe('Which is the largest?');
    expect(old.published_at).not.toBeNull();
  });
});

describe('POST /questions/{id}/versions/{v}/publish', () => {
  it('requires question.publish, which question.write does not imply', async () => {
    const { id, versionNo } = await createQuestionWithVersion('subjective', {
      prompt_md: 'Needs review.',
      difficulty: 3,
    });
    await patch(`${QUESTIONS_ROUTE}/${id}`, { status: 'review' });

    acting = author();
    const response = await post(`${QUESTIONS_ROUTE}/${id}/versions/${versionNo}/publish`);

    expect(response.status).toBe(403);
    expect(asEnvelope(response.body).error.code).toBe('forbidden');
  });

  it('refuses to publish a draft nobody reviewed', async () => {
    const { id, versionNo } = await createQuestionWithVersion('subjective', {
      prompt_md: 'Straight to production.',
      difficulty: 3,
    });

    const response = await post(`${QUESTIONS_ROUTE}/${id}/versions/${versionNo}/publish`);

    expect(response.status).toBe(409);
    const envelope = asEnvelope(response.body);
    expect(envelope.error.code).toBe('conflict');
    // States and event names only — an error envelope is a place leaks hide (docs/14).
    expect(envelope.error.details).toStrictEqual({ from: 'draft', event: 'publish' });

    // And nothing was stamped: a refused publish leaves no trace on the version.
    const version = asVersion((await get(`${QUESTIONS_ROUTE}/${id}/versions/${versionNo}`)).body);
    expect(version.published_at).toBeNull();
  });

  it('freezes the version, moves the question and records both states', async () => {
    const { id, versionNo } = await createQuestionWithVersion('short_answer', {
      prompt_md: 'Capital of France?',
      difficulty: 1,
      answer_keys: [{ match_type: 'ci', pattern: 'paris' }],
    });
    await patch(`${QUESTIONS_ROUTE}/${id}`, { status: 'review' });

    auditWatermark = await maxAuditId();
    const response = await post(`${QUESTIONS_ROUTE}/${id}/versions/${versionNo}/publish`);

    expect(response.status).toBe(200);
    // ADR-006: the instant is the injected clock's, not the wall clock's.
    expect(asVersion(response.body).published_at).toBe(AT.toISOString());

    const question = asQuestion((await get(`${QUESTIONS_ROUTE}/${id}`)).body);
    expect(question.status).toBe('published');
    expect(question.current_version?.version_no).toBe(versionNo);

    const rows = await auditSince();
    expect(rows.map((row) => row.action)).toStrictEqual([QUESTION_ACTIONS.versionPublish]);
    const after = rows[0]?.after as Record<string, unknown>;
    expect(after['question_status']).toBe('published');
    expect(after['published_at']).toBe(AT.toISOString());
    // The payload is identity and lifecycle, never content: the row is kept for seven
    // years, and an answer key written into one outlives every erasure policy.
    expect(findAnswerKeyFields(rows)).toStrictEqual([]);
    expect(JSON.stringify(rows)).not.toContain('paris');
  });

  it('answers 409 to a second publish rather than re-stamping the instant', async () => {
    const { id, versionNo } = await publishedQuestion('subjective', {
      prompt_md: 'Once only.',
      difficulty: 3,
    });

    const again = await post(`${QUESTIONS_ROUTE}/${id}/versions/${versionNo}/publish`);
    expect(again.status).toBe(409);
    expect(asEnvelope(again.body).error.code).toBe('conflict');
  });

  it('publishes a second version of a live question without changing its status', async () => {
    const { id } = await publishedQuestion('subjective', {
      prompt_md: 'First.',
      difficulty: 3,
    });

    const second = asVersion(
      (await post(`${QUESTIONS_ROUTE}/${id}/versions`, { prompt_md: 'Second.' })).body,
    );
    const response = await post(`${QUESTIONS_ROUTE}/${id}/versions/${second.version_no}/publish`);

    expect(response.status).toBe(200);
    const question = asQuestion((await get(`${QUESTIONS_ROUTE}/${id}`)).body);
    expect(question.status).toBe('published');
    expect(question.current_version?.prompt_md).toBe('Second.');
  });
});

describe('PATCH /questions/{id}', () => {
  it('moves a draft to review and back', async () => {
    const { id } = await createQuestionWithVersion('subjective', {
      prompt_md: 'Round trip.',
      difficulty: 2,
    });

    expect(asQuestion((await patch(`${QUESTIONS_ROUTE}/${id}`, { status: 'review' })).body).status).toBe(
      'review',
    );
    expect(asQuestion((await patch(`${QUESTIONS_ROUTE}/${id}`, { status: 'draft' })).body).status).toBe(
      'draft',
    );
  });

  it('refuses an illegal transition with 409 and the states that were involved', async () => {
    const { id } = await createQuestionWithVersion('subjective', {
      prompt_md: 'Still a draft.',
      difficulty: 2,
    });

    const response = await patch(`${QUESTIONS_ROUTE}/${id}`, { status: 'retired' });

    expect(response.status).toBe(409);
    expect(asEnvelope(response.body).error.details).toStrictEqual({
      from: 'draft',
      event: 'retire',
    });
  });

  it('cannot publish by assigning a status', async () => {
    // docs/03 §4 makes publishing a distinct action requiring `question.publish`. A
    // permission gate a sibling endpoint routes around is not a gate — so `published` is
    // not a value this body can carry at all.
    const { id } = await createQuestionWithVersion('subjective', {
      prompt_md: 'Nice try.',
      difficulty: 2,
    });
    await patch(`${QUESTIONS_ROUTE}/${id}`, { status: 'review' });

    const response = await patch(`${QUESTIONS_ROUTE}/${id}`, { status: 'published' });
    expect(response.status).toBe(422);
  });

  it('refuses a body that names nothing to change', async () => {
    const { id } = await createQuestionWithVersion('subjective', {
      prompt_md: 'Nothing to do.',
      difficulty: 2,
    });
    expect((await patch(`${QUESTIONS_ROUTE}/${id}`, {})).status).toBe(422);
  });

  it('retires a published question without deleting anything', async () => {
    const { id, versionNo } = await publishedQuestion('short_answer', {
      prompt_md: 'Over-exposed.',
      difficulty: 2,
      answer_keys: [{ match_type: 'exact', pattern: '42' }],
    });

    const retired = await patch(`${QUESTIONS_ROUTE}/${id}`, { status: 'retired' });
    expect(retired.status).toBe(200);
    expect(asQuestion(retired.body).status).toBe('retired');

    // Every version survives, and so does every answer key: that is the difference between
    // retiring an item and losing the ability to defend a decision made with it.
    const version = asVersion((await get(`${QUESTIONS_ROUTE}/${id}/versions/${versionNo}`)).body);
    expect(version.answer_keys).toHaveLength(1);
    expect(version.published_at).not.toBeNull();
  });

  it('records before and after on the audit row', async () => {
    const { id } = await createQuestionWithVersion('subjective', {
      prompt_md: 'Audited.',
      difficulty: 2,
    });

    auditWatermark = await maxAuditId();
    await patch(`${QUESTIONS_ROUTE}/${id}`, { status: 'review' });

    const rows = await auditSince();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.action).toBe(QUESTION_ACTIONS.update);
    expect((rows[0]?.before as Record<string, unknown>)['status']).toBe('draft');
    expect((rows[0]?.after as Record<string, unknown>)['status']).toBe('review');
  });
});

describe('DELETE /questions/{id}', () => {
  it('soft-deletes, hides from the list, and is still readable by id', async () => {
    const { id } = await createQuestionWithVersion('subjective', {
      prompt_md: 'A duplicate.',
      difficulty: 3,
    });

    const deleted = await remove(`${QUESTIONS_ROUTE}/${id}`);
    expect(deleted.status).toBe(200);
    expect(asQuestion(deleted.body).archived_at).toBe(AT.toISOString());

    const listedExchange = await get(QUESTIONS_ROUTE);
    expect(listedExchange.status, JSON.stringify(listedExchange.body)).toBe(200);
    const listed = listedExchange.body as QuestionListResponse;
    expect(listed.data.map((row) => row.id)).not.toContain(id);

    // Readable by id: an audit row naming an archived question has to remain followable,
    // or the record stops being a record.
    expect((await get(`${QUESTIONS_ROUTE}/${id}`)).status).toBe(200);

    const restored = await patch(`${QUESTIONS_ROUTE}/${id}`, { archived: false });
    expect(asQuestion(restored.body).archived_at).toBeNull();
  });
});

describe('GET /questions', () => {
  it('pages with a cursor and filters by kind', async () => {
    await createQuestionWithVersion('coding', {
      prompt_md: 'Balance the parentheses.',
      difficulty: 4,
      coding_spec: { allowed_languages: ['python'] },
    });
    await createQuestionWithVersion('mcq_multi', {
      prompt_md: 'Select all primes.',
      difficulty: 2,
    });

    const firstExchange = await get(`${QUESTIONS_ROUTE}?limit=1`);
    expect(firstExchange.status, JSON.stringify(firstExchange.body)).toBe(200);
    const firstPage = firstExchange.body as QuestionListResponse;
    expect(firstPage.data).toHaveLength(1);
    expect(firstPage.next_cursor).not.toBeNull();

    const secondPage = (
      await get(`${QUESTIONS_ROUTE}?limit=1&cursor=${encodeURIComponent(firstPage.next_cursor ?? '')}`)
    ).body as QuestionListResponse;
    expect(secondPage.data).toHaveLength(1);
    expect(secondPage.data[0]?.id).not.toBe(firstPage.data[0]?.id);

    const coding = (await get(`${QUESTIONS_ROUTE}?kind=coding`)).body as QuestionListResponse;
    expect(coding.data.every((row) => row.kind === 'coding')).toBe(true);
    expect(coding.data.length).toBeGreaterThan(0);
  });

  it('refuses a filter value outside the contract', async () => {
    expect((await get(`${QUESTIONS_ROUTE}?difficulty=9`)).status).toBe(422);
    expect((await get(`${QUESTIONS_ROUTE}?limit=100000`)).status).toBe(422);
    expect((await get(`${QUESTIONS_ROUTE}?status=banana`)).status).toBe(422);
  });

  it('is refused for a principal holding none of the question permissions', async () => {
    acting = staff(ACME, ADA, 'attempt.read');
    expect((await get(QUESTIONS_ROUTE)).status).toBe(403);
  });
});

describe('tenancy (ADR-010)', () => {
  it('answers not_found — never forbidden — for another organisation’s question', async () => {
    const { id, versionNo } = await publishedQuestion('coding', {
      prompt_md: 'A secret with a reference solution.',
      difficulty: 3,
      coding_spec: {
        allowed_languages: ['python'],
        solution_code: { python: 'the reference solution' },
      },
      test_cases: [{ stdin: 'secret input', expected_stdout: 'secret output', is_sample: false }],
    });

    acting = outsider();

    // A 403 would confirm that somebody holds the id, which is a cross-tenant disclosure
    // made of nothing but a status code (docs/14 H-128).
    for (const url of [
      `${QUESTIONS_ROUTE}/${id}`,
      `${QUESTIONS_ROUTE}/${id}/versions`,
      `${QUESTIONS_ROUTE}/${id}/versions/${versionNo}`,
    ]) {
      const response = await get(url);
      expect(response.status, url).toBe(404);
      expect(asEnvelope(response.body).error.code, url).toBe('not_found');
    }

    const listed = (await get(QUESTIONS_ROUTE)).body as QuestionListResponse;
    expect(listed.data.map((row) => row.id)).not.toContain(id);
  });

  it('refuses a cross-tenant write as not_found, leaving the row alone', async () => {
    const { id } = await createQuestionWithVersion('subjective', {
      prompt_md: 'Mine alone.',
      difficulty: 2,
    });

    acting = outsider();
    expect((await patch(`${QUESTIONS_ROUTE}/${id}`, { status: 'review' })).status).toBe(404);
    expect((await remove(`${QUESTIONS_ROUTE}/${id}`)).status).toBe(404);

    acting = bankAdmin();
    expect(asQuestion((await get(`${QUESTIONS_ROUTE}/${id}`)).body).status).toBe('draft');
  });
});

describe('the author view is what staff receive', () => {
  it('serves the answer key, because an author who cannot see it cannot author', async () => {
    // Each key on the kind that genuinely carries it. This test once put options and answer
    // keys onto a coding question to assert all four in one place; the kind rule now refuses
    // that, correctly, because neither is ever served or graded on a coding question.
    const coding = await createQuestionWithVersion('coding', {
      prompt_md: 'Reverse a list.',
      difficulty: 3,
      explanation_md: 'Three pointers.',
      coding_spec: {
        allowed_languages: ['python'],
        solution_code: { python: 'return xs[::-1]' },
      },
      test_cases: [{ stdin: '1 2 3', expected_stdout: '3 2 1', is_sample: false }],
    });
    const choice = await createQuestionWithVersion('mcq_single', {
      prompt_md: 'Which reversal allocates no new list?',
      difficulty: 3,
      options: [
        { body_md: 'iteratively, in place', is_correct: true },
        { body_md: 'slicing', is_correct: false },
      ],
    });
    const short = await createQuestionWithVersion('short_answer', {
      prompt_md: 'Name the approach.',
      difficulty: 2,
      answer_keys: [{ match_type: 'ci', pattern: 'iteratively' }],
    });

    const read = async (q: { id: string; versionNo: number }) =>
      asVersion((await get(`${QUESTIONS_ROUTE}/${q.id}/versions/${String(q.versionNo)}`)).body);

    const codingView = await read(coding);
    const choiceView = await read(choice);
    const shortView = await read(short);

    // The deliberate opposite of the leak suite: this surface is permission-gated staff
    // territory, and withholding the key here would make the bank unusable.
    expect(choiceView.options[0]?.is_correct).toBe(true);
    expect(codingView.coding_spec?.solution_code).toStrictEqual({ python: 'return xs[::-1]' });
    expect(codingView.test_cases[0]?.expected_stdout).toBe('3 2 1');
    expect(shortView.answer_keys[0]?.pattern).toBe('iteratively');
    expect(codingView.explanation_md).toBe('Three pointers.');
  });
});

describe('question kinds carry only what they can use', () => {
  /** The fields named in a validation_failed envelope, as the client sent them. */
  function fieldsIn(body: unknown): string[] {
    const details = asEnvelope(body).error.details as
      | { fields?: Array<{ field: string; rule: string }> }
      | undefined;
    return (details?.fields ?? []).map((f) => `${f.field}:${f.rule}`);
  }

  it('refuses options on a coding question when the version is created', async () => {
    const created = await post(QUESTIONS_ROUTE, { kind: 'coding', source_license: 'MIT' });
    const { id } = asQuestion(created.body);

    const response = await post(`${QUESTIONS_ROUTE}/${id}/versions`, {
      prompt_md: 'Reverse a list.',
      difficulty: 3,
      options: [{ body_md: 'a', is_correct: true }],
    });

    expect(response.status).toBe(422);
    expect(fieldsIn(response.body)).toContain('body/options:wrong_kind');
  });

  it('refuses the same content added to a draft by PATCH — the edit is not a way round the rule', async () => {
    const { id, versionNo } = await createQuestionWithVersion('coding', {
      prompt_md: 'Reverse a list.',
      difficulty: 3,
    });

    const response = await patch(`${QUESTIONS_ROUTE}/${id}/versions/${String(versionNo)}`, {
      options: [{ body_md: 'a', is_correct: true }],
    });

    expect(response.status).toBe(422);
    expect(fieldsIn(response.body)).toContain('body/options:wrong_kind');
  });

  it('lets a draft be unfinished — a coding draft with no test cases saves', async () => {
    const created = await post(QUESTIONS_ROUTE, { kind: 'coding', source_license: 'MIT' });
    const { id } = asQuestion(created.body);

    const response = await post(`${QUESTIONS_ROUTE}/${id}/versions`, {
      prompt_md: 'Reverse a list.',
      difficulty: 3,
    });

    expect(response.status).toBe(201);
  });

  it('refuses to publish a coding question whose only case is visible, and stamps nothing', async () => {
    const { id, versionNo } = await createQuestionWithVersion('coding', {
      prompt_md: 'Reverse a list.',
      difficulty: 3,
      coding_spec: { allowed_languages: ['python'] },
      test_cases: [{ stdin: '1 2', expected_stdout: '2 1', is_sample: true }],
    });
    expect((await patch(`${QUESTIONS_ROUTE}/${id}`, { status: 'review' })).status).toBe(200);

    const response = await post(`${QUESTIONS_ROUTE}/${id}/versions/${String(versionNo)}/publish`);

    expect(response.status).toBe(422);
    expect(fieldsIn(response.body)).toContain('body/test_cases:incomplete');

    // The refusal leaves no trace: a version that could not be graded must not be frozen.
    const after = asVersion((await get(`${QUESTIONS_ROUTE}/${id}/versions/${String(versionNo)}`)).body);
    expect(after.published_at).toBeNull();
  });

  // The three kinds no other test in this file publishes end to end.
  it('publishes a complete true_false question', async () => {
    await publishedQuestion('true_false', {
      prompt_md: 'A published version can be edited in place.',
      difficulty: 1,
      options: [
        { body_md: 'True', is_correct: false },
        { body_md: 'False', is_correct: true },
      ],
    });
  });

  it('publishes a complete sql question, fixture database included', async () => {
    await publishedQuestion('sql', {
      prompt_md: 'Count the orders per customer.',
      difficulty: 2,
      coding_spec: {
        allowed_languages: ['sql'],
        fixture_sql: 'create table orders (customer_id int); insert into orders values (1),(1),(2);',
      },
      test_cases: [{ stdin: '', expected_stdout: '1|2\n2|1', is_sample: false }],
    });
  });

  it('refuses to publish an sql question with no fixture database', async () => {
    const { id, versionNo } = await createQuestionWithVersion('sql', {
      prompt_md: 'Count the orders per customer.',
      difficulty: 2,
      coding_spec: { allowed_languages: ['sql'] },
      test_cases: [{ stdin: '', expected_stdout: 'x', is_sample: false }],
    });
    expect((await patch(`${QUESTIONS_ROUTE}/${id}`, { status: 'review' })).status).toBe(200);

    const response = await post(`${QUESTIONS_ROUTE}/${id}/versions/${String(versionNo)}/publish`);

    expect(response.status).toBe(422);
    expect(fieldsIn(response.body)).toContain('body/coding_spec:incomplete');
  });

  it('publishes a system_design question, which is human-graded and needs no machine content', async () => {
    await publishedQuestion('system_design', {
      prompt_md: 'Design a URL shortener for 10k writes per second.',
      difficulty: 4,
    });
  });
});

describe('POST /questions/{id}/preview — before the execution service exists', () => {
  const previewOf = (id: string) => `${QUESTIONS_ROUTE}/${id}/preview`;

  it('answers execution_unavailable and says plainly that nothing ran — never a stubbed pass', async () => {
    const { id } = await createQuestionWithVersion('coding', {
      prompt_md: 'Reverse a list.',
      difficulty: 3,
      coding_spec: { allowed_languages: ['python'], solution_code: { python: 'return xs[::-1]' } },
    });

    const response = await post(previewOf(id), { language: 'python', code: 'print(1)' });

    expect(response.status).toBe(503);
    const envelope = asEnvelope(response.body);
    expect(envelope.error.code).toBe('execution_unavailable');
    expect(envelope.error.details?.['ran']).toBe(false);
    // The failure this guards against: an author who reads "passed" publishes on it.
    expect(JSON.stringify(response.body)).not.toMatch(/"(passed|result|stdout)"/u);
  });

  it('accepts an empty body, which means "run the reference solution"', async () => {
    const { id } = await createQuestionWithVersion('sql', { prompt_md: 'Count.', difficulty: 2 });
    expect((await post(previewOf(id))).status).toBe(503);
  });

  it('checks the kind before reaching for the execution service', async () => {
    const { id } = await createQuestionWithVersion('subjective', { prompt_md: 'Discuss.', difficulty: 2 });

    const response = await post(previewOf(id));

    expect(response.status).toBe(422);
    expect(asEnvelope(response.body).error.code).toBe('validation_failed');
  });

  it('refuses an unknown body field rather than ignoring it', async () => {
    const { id } = await createQuestionWithVersion('coding', { prompt_md: 'Reverse.', difficulty: 3 });
    expect((await post(previewOf(id), { hidden: true })).status).toBe(422);
  });

  it('answers not_found for a question that does not exist', async () => {
    const response = await post(previewOf('00000000-0000-4000-8000-000000000000'));
    expect(response.status).toBe(404);
  });

  it('requires question.write — reading the bank is not enough to run code against it', async () => {
    const { id } = await createQuestionWithVersion('coding', { prompt_md: 'Reverse.', difficulty: 3 });

    acting = reader();
    const response = await post(previewOf(id));

    expect(response.status).toBe(403);
    expect(asEnvelope(response.body).error.code).toBe('forbidden');
  });
});

describe('the permission set is real', () => {
  it('names every permission this surface uses, so a typo is not a silent grant', () => {
    // A guard against the vacuous pass: if these keys were not in the seeded set, every
    // 403 above would be for the wrong reason.
    for (const permission of ['question.read', 'question.write', 'question.publish']) {
      expect(PERMISSIONS).toContain(permission);
    }
  });
});
