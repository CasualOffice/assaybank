/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Bank import and export over HTTP — docs/03 §4 "Bulk", ADR-021 — against a real PostgreSQL.
 *
 * The API's half of the outbox: a request writes a row and its audit record in one commit and
 * answers 202; the job URL reports the row; a finished export's file downloads until it expires.
 * The worker's half — claiming, importing, exporting — is proven in
 * `apps/worker/test/integration/bank-job.integration.test.ts`; here a finished job is written by
 * the owner, so this suite does not depend on the worker.
 *
 * The principal is deposited rather than logged in, for the reason `questions.test.ts` gives.
 */

import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { KnownPermission, StaffPrincipal } from '@assaybank/auth';
import {
  OrgIdSchema,
  UserIdSchema,
  type BankJobAccepted,
  type BankJobView,
  type ErrorEnvelope,
  type OrgId,
  type UserId,
} from '@assaybank/contracts';

import {
  BANK_JOB_ACTIONS,
  EXPORT_JOB_ROUTE,
  IMPORT_JOB_ROUTE,
  QUESTIONS_ATTRIBUTIONS_ROUTE,
  QUESTIONS_EXPORT_ROUTE,
  QUESTIONS_IMPORT_ROUTE,
} from '../../src/bank-jobs/routes.js';
import { setPrincipal } from '../../src/principal.js';
import { buildServer } from '../../src/server.js';
import { testConfig } from '../../src/test-support.js';
import { startTestPostgres, type TestPostgres } from './postgres-fixture.js';

const AT = new Date('2026-10-20T09:00:00.000Z');

const ACME: OrgId = OrgIdSchema.parse('6c3e1a92-4d75-4b08-8e21-9f0a3b7c5d14');
const RIVAL: OrgId = OrgIdSchema.parse('b15f73d8-2e46-4a9c-9d03-5c8e1f2a7b69');
const ADA: UserId = UserIdSchema.parse('55555555-5555-4555-8555-555555555555');
const BEA: UserId = UserIdSchema.parse('66666666-6666-4666-8666-666666666666');

let pg: TestPostgres | undefined;
let app: FastifyInstance | undefined;
let auditWatermark = '0';

function required<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new Error(`fixture ${name} was not initialised`);
  return value;
}
const fixture = (): TestPostgres => required(pg, 'postgres');
const server = (): FastifyInstance => required(app, 'server');

const staff = (orgId: OrgId, userId: UserId, ...held: KnownPermission[]): StaffPrincipal => ({
  kind: 'staff',
  orgId,
  userId,
  permissions: new Set<string>(held),
});
const author = (): StaffPrincipal => staff(ACME, ADA, 'question.read', 'question.write');
const reader = (): StaffPrincipal => staff(ACME, ADA, 'question.read');
const rival = (): StaffPrincipal => staff(RIVAL, BEA, 'question.read', 'question.write');

let acting: StaffPrincipal = author();
let pythonSkill = '';

const FILE = Buffer.from(
  JSON.stringify({
    format: 'assaybank.bank',
    format_version: 1,
    exported_at: AT.toISOString(),
    attributions: [],
    items: [],
  }),
  'utf8',
);

beforeAll(async () => {
  pg = await startTestPostgres();
  const owner = fixture().owner;
  for (const [org, slug, user] of [
    [ACME, 'acme-bank', ADA],
    [RIVAL, 'rival-bank', BEA],
  ] as const) {
    await owner`INSERT INTO organizations (id, name, slug) VALUES (${org}, ${slug}, ${slug})`;
    await owner`INSERT INTO users (id, org_id, email, full_name) VALUES (${user}, ${org}, ${`s@${slug}.example`}, 'S')`;
  }
  const [skill] = await owner<{ id: string }[]>`
    INSERT INTO skills (org_id, key, name) VALUES (${ACME}, 'python', 'Python') RETURNING id`;
  pythonSkill = required(skill, 'skill').id;
}, 300_000);

afterAll(async () => {
  await app?.close();
  await pg?.stop();
});

beforeEach(async () => {
  acting = author();
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

async function upload(
  query: string,
  body: Buffer = FILE,
  contentType = 'application/octet-stream',
) {
  const response = await server().inject({
    method: 'POST',
    url: `${QUESTIONS_IMPORT_ROUTE}?${query}`,
    headers: { 'content-type': contentType },
    payload: body,
  });
  return { status: response.statusCode, body: response.json<unknown>() };
}

async function get(url: string) {
  const response = await server().inject({ method: 'GET', url });
  return response;
}

const audit = async () =>
  fixture().owner<
    { action: string; entity_id: string | null; after: Record<string, unknown> | null }[]
  >`
    SELECT action, entity_id, after FROM audit_log WHERE id > ${auditWatermark}::bigint ORDER BY id`;

describe('POST /questions/import', () => {
  it('stores the upload as a queued job, audits it, and answers 202 with where to look', async () => {
    const res = await upload(`format=json&source_license=MIT&default_skill_id=${pythonSkill}`);
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    const accepted = res.body as BankJobAccepted;
    expect(accepted.status).toBe('queued');
    expect(accepted.job_url).toBe(`/api/v1/import-jobs/${accepted.job_id}`);

    const [row] = await fixture().owner<
      { status: string; input_bytes: number; options: unknown; org_id: string }[]
    >`
      SELECT status, input_bytes, options, org_id FROM bank_jobs WHERE id = ${accepted.job_id}`;
    expect(row).toEqual({
      status: 'queued',
      input_bytes: FILE.byteLength,
      options: { source_license: 'MIT', default_skill_ids: [pythonSkill] },
      org_id: ACME,
    });
    expect((await audit()).map((a) => [a.action, a.entity_id])).toEqual([
      [BANK_JOB_ACTIONS.import, accepted.job_id],
    ]);
  });

  it('refuses an import with no source_license (docs/05 §2), and stores nothing', async () => {
    const before = await fixture().owner<{ n: number }[]>`SELECT count(*)::int AS n FROM bank_jobs`;
    const res = await upload('format=json');
    expect(res.status).toBe(422);
    expect((res.body as ErrorEnvelope).error.code).toBe('validation_failed');
    const after = await fixture().owner<{ n: number }[]>`SELECT count(*)::int AS n FROM bank_jobs`;
    expect(after[0]?.n).toBe(before[0]?.n);
  });

  it('refuses a JSON body — the file is the body, as octet-stream', async () => {
    const res = await upload('format=json&source_license=MIT', FILE, 'application/json');
    expect(res.status).toBe(422);
  });

  it('refuses an empty file and an unknown format', async () => {
    expect((await upload('format=json&source_license=MIT', Buffer.alloc(0))).status).toBe(422);
    expect((await upload('format=csv&source_license=MIT')).status).toBe(422);
  });

  it('refuses another organisation’s skill as a default, by position', async () => {
    const [theirs] = await fixture().owner<{ id: string }[]>`
      INSERT INTO skills (org_id, key, name) VALUES (${RIVAL}, 'rust', 'Rust') RETURNING id`;
    const res = await upload(
      `format=json&source_license=MIT&default_skill_id=${pythonSkill}&default_skill_id=${required(theirs, 'rust').id}`,
    );
    expect(res.status).toBe(422);
    expect((res.body as ErrorEnvelope).error.details?.['fields']).toEqual([
      expect.objectContaining({ field: 'querystring/default_skill_id/1', rule: 'not_found' }),
    ]);
  });

  it('takes a file far over the API’s 1 MiB body limit, and refuses one over 32 MiB unstored', async () => {
    // The route's own limit, not the server's: a 2 MiB bank is ordinary.
    const two = Buffer.concat([FILE, Buffer.alloc(2 * 1024 * 1024, 0x20)]);
    expect((await upload('format=json&source_license=MIT', two)).status).toBe(202);

    const before = await fixture().owner<{ n: number }[]>`SELECT count(*)::int AS n FROM bank_jobs`;
    const res = await upload('format=json&source_license=MIT', Buffer.alloc(32 * 1024 * 1024 + 1));
    // The API answers every refusal Fastify makes before a handler runs — 413 included — as
    // validation_failed (src/errors.ts), so clients branch on one code.
    expect(res.status).toBe(422);
    const after = await fixture().owner<{ n: number }[]>`SELECT count(*)::int AS n FROM bank_jobs`;
    expect(after[0]?.n).toBe(before[0]?.n);
  });

  it('requires question.write — reading the bank is not enough to add to it', async () => {
    acting = reader();
    expect((await upload('format=json&source_license=MIT')).status).toBe(403);
  });
});

describe('GET /import-jobs/{id}', () => {
  it('reports the job, and nobody else’s', async () => {
    const accepted = (await upload('format=json&source_license=MIT')).body as BankJobAccepted;

    acting = reader();
    const mine = await get(accepted.job_url);
    expect(mine.statusCode).toBe(200);
    const view = mine.json<BankJobView>();
    expect(view).toEqual(
      expect.objectContaining({
        id: accepted.job_id,
        kind: 'import',
        status: 'queued',
        created: 0,
        file_url: null,
      }),
    );

    acting = rival();
    expect((await get(accepted.job_url)).statusCode).toBe(404);
  });

  it('does not answer for an export id under /import-jobs', async () => {
    const res = await server().inject({
      method: 'POST',
      url: `${QUESTIONS_EXPORT_ROUTE}?format=json`,
    });
    const accepted = res.json<BankJobAccepted>();
    expect((await get(`${IMPORT_JOB_ROUTE.replace(':id', accepted.job_id)}`)).statusCode).toBe(404);
  });
});

describe('export', () => {
  it('queues, reports, and serves the finished file until it expires — auditing the download', async () => {
    const res = await server().inject({
      method: 'POST',
      url: `${QUESTIONS_EXPORT_ROUTE}?format=qti&status=published`,
    });
    expect(res.statusCode).toBe(202);
    const accepted = res.json<BankJobAccepted>();
    expect(accepted.job_url).toBe(`/api/v1/export-jobs/${accepted.job_id}`);

    // What the worker writes when it finishes.
    const bytes = Buffer.from('PK-not-really-a-zip');
    const expires = new Date(AT.getTime() + 60_000);
    await fixture().owner`
      UPDATE bank_jobs SET status = 'succeeded', finished_at = ${AT}, result = ${bytes},
             result_content_type = 'application/zip', result_bytes = ${bytes.byteLength}, expires_at = ${expires}
       WHERE id = ${accepted.job_id}`;

    const view = (await get(accepted.job_url)).json<BankJobView>();
    expect(view.file_bytes).toBe(bytes.byteLength);
    expect(view.file_url).toBe(`/api/v1/export-jobs/${accepted.job_id}/file`);

    // Reading a job's status is question.read; taking the file is not.
    acting = reader();
    expect((await get(required(view.file_url ?? undefined, 'url'))).statusCode).toBe(403);

    acting = author();
    const file = await get(required(view.file_url ?? undefined, 'url'));
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toBe('application/zip');
    expect(file.headers['content-disposition']).toContain('attachment;');
    expect(file.rawPayload.equals(bytes)).toBe(true);
    expect((await audit()).map((a) => a.action)).toEqual([
      BANK_JOB_ACTIONS.export,
      BANK_JOB_ACTIONS.download,
    ]);

    acting = rival();
    expect((await get(required(view.file_url ?? undefined, 'url'))).statusCode).toBe(404);

    acting = author();
    await fixture()
      .owner`UPDATE bank_jobs SET expires_at = ${new Date(AT.getTime() - 1)} WHERE id = ${accepted.job_id}`;
    expect((await get(required(view.file_url ?? undefined, 'url'))).statusCode).toBe(404);
  });

  it('refuses an export by a reader', async () => {
    acting = reader();
    const res = await server().inject({
      method: 'POST',
      url: `${QUESTIONS_EXPORT_ROUTE}?format=json`,
    });
    expect(res.statusCode).toBe(403);
    expect(EXPORT_JOB_ROUTE).toBe('/api/v1/export-jobs/:id');
  });
});

describe('GET /questions/attributions', () => {
  // This file seeds no questions elsewhere and cleans none up, so these tests clear their own
  // rows rather than reading each other's. Scoped to this block so nothing else changes.
  beforeEach(async () => {
    await fixture().owner`DELETE FROM questions`;
  });

  /** Puts a question in `org` with a licence and a source, at a given status. */
  const seed = async (
    org: OrgId,
    ref: string,
    licence: string,
    status: 'draft' | 'published',
  ): Promise<void> => {
    await fixture().owner`
      INSERT INTO questions (org_id, kind, status, source_license, external_ref)
      VALUES (${org}, 'coding', ${status}::question_status, ${licence}, ${ref})`;
  };

  it('credits every source in this organisation, and no other organisation’s', async () => {
    await seed(ACME, 'humaneval/HumanEval/0', 'MIT', 'published');
    await seed(ACME, 'humaneval/HumanEval/1', 'MIT', 'draft');
    await seed(ACME, 'mbpp/601', 'CC-BY-4.0', 'published');
    // The rival's bank is under the same licence and must not appear in ours (ADR-010).
    await seed(RIVAL, 'mbpp/602', 'CC-BY-4.0', 'published');

    acting = reader();
    const res = await get(QUESTIONS_ATTRIBUTIONS_ROUTE);

    expect(res.statusCode).toBe(200);
    expect(res.json<{ data: unknown[] }>().data).toEqual([
      { source_license: 'CC-BY-4.0', dataset: 'mbpp', questions: 1, published: 1 },
      { source_license: 'MIT', dataset: 'humaneval', questions: 2, published: 1 },
    ]);
  });

  it('counts what is held separately from what is served', async () => {
    // The licence obligation follows every copy; the ratio docs/05 §2 asks teams to watch is
    // about the published bank, so the two are different numbers and both are reported.
    await seed(ACME, 'humaneval/HumanEval/7', 'MIT', 'draft');

    acting = reader();
    const [row] = (await get(QUESTIONS_ATTRIBUTIONS_ROUTE)).json<{
      data: { questions: number; published: number }[];
    }>().data;

    expect(row).toEqual(expect.objectContaining({ questions: 1, published: 0 }));
  });

  it('says nothing about questions written in-house', async () => {
    await fixture().owner`
      INSERT INTO questions (org_id, kind, status, source_license)
      VALUES (${ACME}, 'coding', 'draft', 'proprietary')`;

    acting = reader();
    expect((await get(QUESTIONS_ATTRIBUTIONS_ROUTE)).json<{ data: unknown[] }>().data).toEqual([]);
  });

  it('is readable by anyone who can read the bank, not only by an exporter', async () => {
    // Gating the record of what we owe behind the ability to download the bank would hide it
    // from most of the people who need to know about it.
    acting = reader();
    expect((await get(QUESTIONS_ATTRIBUTIONS_ROUTE)).statusCode).toBe(200);
  });
});
