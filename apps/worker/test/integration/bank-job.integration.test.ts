/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The bank job outbox against a real PostgreSQL (ADR-021, migration 0010).
 *
 * Valkey is not needed to prove what matters here: the relay's enqueue is a function, and the
 * properties under test are the database's — that a claim hands out each queued row once, that a
 * job resumes at its checkpoint instead of importing a file twice, and that the row is an honest
 * record of what happened.
 */

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import postgres from 'postgres';
import { getContainerRuntimeClient } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { OrgIdSchema, UserIdSchema, type OrgId, type UserId } from '@assaybank/contracts';
import {
  createBankJob,
  createDb,
  getBankJob,
  migrate,
  readBankJobResult,
  withOrg,
  type Database,
} from '@assaybank/db';
import { createLogger } from '@assaybank/observability';

import {
  buildBankDocument,
  readBankDocument,
  serialiseBankDocument,
} from '../../src/interchange/bank-document.js';
import { readQtiPackage, unzipPackage } from '../../src/interchange/qti.js';
import {
  EXPORT_RETENTION_MS,
  relayBankJobs,
  runBankJob,
  type BankJobPayload,
} from '../../src/jobs/bank-job.js';
import { ALL, EXACT, FIXTURES } from '../fixtures/bank-items.js';

const IMAGE = 'postgres:16-alpine';
const OWNER = 'hiring';
const OWNER_PASSWORD = 'hiring';
const DB = 'hiring';
const APP_PASSWORD = 'hiring_app_bankjob_test';
const JOB_PASSWORD = 'hiring_job_bankjob_test';

const runtime = await (async () => {
  try {
    await getContainerRuntimeClient();
    return { available: true };
  } catch {
    return { available: false };
  }
})();

function required<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new Error(`fixture did not produce ${name}`);
  return value;
}

const logger = createLogger({
  service: 'bank-job-test',
  env: 'test',
  level: 'fatal',
  pretty: false,
});

describe.skipIf(!runtime.available)('bank job outbox (ADR-021)', () => {
  let container: StartedPostgreSqlContainer;
  let owner: postgres.Sql;
  let db: Database;
  let org: { id: OrgId; user: UserId };
  let other: { id: OrgId; user: UserId };

  const now = () => EXACT;
  const deps = () => ({ db, now, logger });

  async function seedOrg(slug: string): Promise<{ id: OrgId; user: UserId }> {
    const o = required(
      (
        await owner<
          { id: string }[]
        >`INSERT INTO organizations (name, slug) VALUES (${slug}, ${slug}) RETURNING id`
      )[0],
      'org',
    );
    const u = required(
      (
        await owner<
          { id: string }[]
        >`INSERT INTO users (org_id, email, full_name) VALUES (${o.id}, ${`a@${slug}.example`}, 'A') RETURNING id`
      )[0],
      'user',
    );
    await owner`INSERT INTO skills (org_id, key, name) VALUES (${o.id}, 'python', 'Python')`;
    return { id: OrgIdSchema.parse(o.id), user: UserIdSchema.parse(u.id) };
  }

  async function queueImport(
    target: { id: OrgId; user: UserId },
    file: Uint8Array,
    format: 'json' | 'qti' = 'json',
  ): Promise<string> {
    const job = await withOrg(db, target.id, (tx) =>
      createBankJob(tx, {
        orgId: target.id,
        kind: 'import',
        format,
        requestedBy: target.user,
        options: { source_license: 'MIT', default_skill_ids: [] },
        input: file,
        at: EXACT,
      }),
    );
    return job.id;
  }

  const jsonFile = (items = ALL): Uint8Array =>
    Buffer.from(serialiseBankDocument(buildBankDocument(items, EXACT)), 'utf8');

  beforeAll(async () => {
    container = await new PostgreSqlContainer(IMAGE)
      .withDatabase(DB)
      .withUsername(OWNER)
      .withPassword(OWNER_PASSWORD)
      .start();
    const host = container.getHost();
    const port = container.getPort();
    const ownerUrl = `postgres://${OWNER}:${OWNER_PASSWORD}@${host}:${port}/${DB}`;
    await migrate({ url: ownerUrl });
    owner = postgres(ownerUrl, { max: 2 });
    await owner.unsafe(`ALTER ROLE hiring_app WITH PASSWORD '${APP_PASSWORD}'`);
    await owner.unsafe(`ALTER ROLE hiring_job WITH PASSWORD '${JOB_PASSWORD}'`);
    db = createDb({
      url: `postgres://hiring_app:${APP_PASSWORD}@${host}:${port}/${DB}`,
      jobUrl: `postgres://hiring_job:${JOB_PASSWORD}@${host}:${port}/${DB}`,
      poolMax: 4,
    });
    await owner`INSERT INTO skills (org_id, key, name) VALUES (NULL, 'sql.window-functions', 'Window functions')`;
    org = await seedOrg('job-org');
    other = await seedOrg('job-other');
  }, 240_000);

  afterAll(async () => {
    await db?.close();
    await owner?.end();
    await container?.stop();
  });

  it('relays each queued row exactly once, across organisations, and returns ids only', async () => {
    const mine = await queueImport(org, jsonFile([FIXTURES.true_false]));
    const theirs = await queueImport(other, jsonFile([FIXTURES.true_false]));

    const enqueued: { payload: BankJobPayload; key: string }[] = [];
    const enqueue = (payload: BankJobPayload, key: string): Promise<void> => {
      enqueued.push({ payload, key });
      return Promise.resolve();
    };

    expect(await relayBankJobs({ db, now, enqueue })).toBe(2);
    expect(await relayBankJobs({ db, now, enqueue })).toBe(0);
    expect(enqueued.map((e) => e.payload.bank_job_id).sort()).toEqual([mine, theirs].sort());
    expect(enqueued.find((e) => e.payload.bank_job_id === theirs)?.payload.org_id).toBe(other.id);
    expect(enqueued[0]?.key).toMatch(/^bank\.job:/u);

    // A claim that was never enqueued — the relay died — is claimed again once stale.
    const later = () => new Date(EXACT.getTime() + 10 * 60 * 1000);
    expect(await relayBankJobs({ db, now: later, enqueue })).toBe(2);

    for (const e of enqueued.slice(0, 2)) await runBankJob(e.payload, deps(), false);
  });

  it('imports a file, records the counts, and clears the upload', async () => {
    const id = await queueImport(org, jsonFile());
    const outcome = await runBankJob({ bank_job_id: id, org_id: org.id }, deps(), false);
    expect(outcome.status).toBe('succeeded');

    const row = required(await withOrg(db, org.id, (tx) => getBankJob(tx, id)), 'row');
    expect(row).toEqual(
      expect.objectContaining({
        status: 'succeeded',
        createdCount: ALL.length,
        skippedCount: 0,
        nextIndex: ALL.length,
        problems: [],
      }),
    );
    const [input] = await owner<
      { input: Uint8Array | null }[]
    >`SELECT input FROM bank_jobs WHERE id = ${id}`;
    expect(input?.input).toBeNull();

    // A redelivery after success does nothing.
    expect((await runBankJob({ bank_job_id: id, org_id: org.id }, deps(), false)).status).toBe(
      'already_finished',
    );
  });

  it('resumes at the checkpoint rather than importing the file twice', async () => {
    const before = await owner<
      { n: number }[]
    >`SELECT count(*)::int AS n FROM questions WHERE org_id = ${other.id}`;
    const id = await queueImport(other, jsonFile());
    // A previous attempt wrote the first three items and died: the checkpoint says so.
    await owner`UPDATE bank_jobs SET status = 'running', next_index = 3, created_count = 3 WHERE id = ${id}`;

    await runBankJob({ bank_job_id: id, org_id: other.id }, deps(), false);

    const after = await owner<
      { n: number }[]
    >`SELECT count(*)::int AS n FROM questions WHERE org_id = ${other.id}`;
    expect((after[0]?.n ?? 0) - (before[0]?.n ?? 0)).toBe(ALL.length - 3);
    const row = required(await withOrg(db, other.id, (tx) => getBankJob(tx, id)), 'row');
    expect(row.createdCount).toBe(ALL.length);
    expect(row.nextIndex).toBe(ALL.length);
  });

  it('records per-item problems with the file position, and imports the rest', async () => {
    const bad = { ...FIXTURES.subjective, ref: 'needs-rust', skills: [{ key: 'rust', weight: 1 }] };
    const text = JSON.stringify({
      format: 'assaybank.bank',
      format_version: 1,
      items: [{ ref: 'broken', kind: 'nope' }, bad, FIXTURES.true_false],
    });
    const id = await queueImport(org, Buffer.from(text, 'utf8'));
    await runBankJob({ bank_job_id: id, org_id: org.id }, deps(), false);

    const row = required(await withOrg(db, org.id, (tx) => getBankJob(tx, id)), 'row');
    expect(row.status).toBe('succeeded');
    expect(row.createdCount).toBe(1);
    expect(row.skippedCount).toBe(2);
    expect(row.problems.map((p) => [p.index, p.ref])).toEqual(
      expect.arrayContaining([
        [0, 'broken'],
        [1, 'needs-rust'],
      ]),
    );
  });

  it('fails a file it cannot read, with a message a person can act on', async () => {
    const id = await queueImport(org, Buffer.from('not json', 'utf8'));
    expect((await runBankJob({ bank_job_id: id, org_id: org.id }, deps(), false)).status).toBe(
      'failed',
    );
    const row = required(await withOrg(db, org.id, (tx) => getBankJob(tx, id)), 'row');
    expect(row.failure).toBe('The file is not JSON.');
    expect(row.finishedAt).not.toBeNull();

    const zip = await queueImport(org, Buffer.from('not a zip', 'utf8'), 'qti');
    await runBankJob({ bank_job_id: zip, org_id: org.id }, deps(), false);
    expect((await withOrg(db, org.id, (tx) => getBankJob(tx, zip)))?.failure).toMatch(/zip/u);
  });

  it('exports to a downloadable file that expires', async () => {
    for (const format of ['json', 'qti'] as const) {
      const job = await withOrg(db, org.id, (tx) =>
        createBankJob(tx, {
          orgId: org.id,
          kind: 'export',
          format,
          requestedBy: org.user,
          options: { status: 'published' },
          at: EXACT,
        }),
      );
      expect(
        (await runBankJob({ bank_job_id: job.id, org_id: org.id }, deps(), false)).status,
      ).toBe('succeeded');

      const file = required(
        await withOrg(db, org.id, (tx) => readBankJobResult(tx, job.id, EXACT)),
        'file',
      );
      const items =
        format === 'json'
          ? readBankDocument(Buffer.from(file.bytes).toString('utf8'))
          : readQtiPackage(unzipPackage(file.bytes));
      expect(items.problems).toEqual([]);
      expect(items.items.length).toBeGreaterThan(0);
      expect(items.items.every((i) => i.item.status === 'published')).toBe(true);
      expect(file.contentType).toBe(format === 'json' ? 'application/json' : 'application/zip');

      const expired = new Date(EXACT.getTime() + EXPORT_RETENTION_MS + 1);
      expect(
        await withOrg(db, org.id, (tx) => readBankJobResult(tx, job.id, expired)),
      ).toBeUndefined();
      // And another organisation cannot read it at all.
      expect(
        await withOrg(db, other.id, (tx) => readBankJobResult(tx, job.id, EXACT)),
      ).toBeUndefined();
    }
  });
});
