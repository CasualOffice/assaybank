/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The bank job outbox and record (migration 0010, ADR-021).
 *
 * Rows only. What a job *does* — parsing a file, importing items, building an export — is the
 * worker's; this module creates the row, hands out claims, and records progress, and every
 * function but {@link claimBankJobs} runs in a transaction `withOrg` has scoped.
 *
 * ## The checkpoint
 *
 * {@link advanceImport} is called inside the transaction that writes one item — or, for a refused
 * item, in a transaction of its own — and moves `next_index` past it in the same commit. That is
 * what makes a retried import resume rather than repeat: an item is either written *and* counted,
 * or neither, and the worker starts from `next_index`.
 */

import { sql } from 'drizzle-orm';

import type { OrgId } from '@assaybank/contracts';

import { PLATFORM_ORG_ID, withOrg, type Database, type DbTransaction } from './client.js';

/**
 * postgres.js sends a `Buffer` as `bytea` and would serialise a plain `Uint8Array` as something
 * else, so bytes are wrapped — without copying — before they become a parameter.
 */
const asBuffer = (bytes: Uint8Array): Buffer =>
  Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);

export type BankJobKind = 'import' | 'export';
export type BankJobFormat = 'json' | 'qti';
export type BankJobStatus = 'queued' | 'dispatched' | 'running' | 'succeeded' | 'failed';

/** The largest file either direction may carry, matching the `bank_jobs_*_bytes_check` constraints. */
export const MAX_BANK_JOB_BYTES = 32 * 1024 * 1024;

/** At most this many problems are kept on a row; the rest are counted, not stored. */
export const MAX_STORED_PROBLEMS = 1000;

export interface StoredProblem {
  readonly index: number;
  readonly ref: string | null;
  readonly path: string;
  readonly message: string;
}

export interface BankJobRow {
  readonly id: string;
  readonly orgId: string;
  readonly kind: BankJobKind;
  readonly format: BankJobFormat;
  readonly status: BankJobStatus;
  readonly requestedBy: string;
  readonly options: Record<string, unknown>;
  readonly inputBytes: number | null;
  readonly resultContentType: string | null;
  readonly resultBytes: number | null;
  readonly nextIndex: number;
  readonly createdCount: number;
  readonly skippedCount: number;
  readonly problems: readonly StoredProblem[];
  readonly problemsTruncated: boolean;
  readonly failure: string | null;
  readonly createdAt: Date;
  readonly startedAt: Date | null;
  readonly finishedAt: Date | null;
  readonly expiresAt: Date | null;
}

type DbRow = {
  id: string;
  org_id: string;
  kind: BankJobKind;
  format: BankJobFormat;
  status: BankJobStatus;
  requested_by: string;
  options: Record<string, unknown>;
  input_bytes: number | null;
  result_content_type: string | null;
  result_bytes: number | null;
  next_index: number;
  created_count: number;
  skipped_count: number;
  problems: StoredProblem[];
  problems_truncated: boolean;
  failure: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  expires_at: string | null;
};

const COLUMNS = sql`id, org_id, kind, format, status, requested_by, options, input_bytes,
  result_content_type, result_bytes, next_index, created_count, skipped_count, problems,
  problems_truncated, failure, created_at::text AS created_at, started_at::text AS started_at,
  finished_at::text AS finished_at, expires_at::text AS expires_at`;

const date = (v: string | null): Date | null => (v === null ? null : new Date(v));

function toRow(r: DbRow): BankJobRow {
  return {
    id: r.id,
    orgId: r.org_id,
    kind: r.kind,
    format: r.format,
    status: r.status,
    requestedBy: r.requested_by,
    options: r.options,
    inputBytes: r.input_bytes,
    resultContentType: r.result_content_type,
    resultBytes: r.result_bytes,
    nextIndex: r.next_index,
    createdCount: r.created_count,
    skippedCount: r.skipped_count,
    problems: r.problems,
    problemsTruncated: r.problems_truncated,
    failure: r.failure,
    createdAt: new Date(r.created_at),
    startedAt: date(r.started_at),
    finishedAt: date(r.finished_at),
    expiresAt: date(r.expires_at),
  };
}

export interface CreateBankJobInput {
  readonly orgId: OrgId;
  readonly kind: BankJobKind;
  readonly format: BankJobFormat;
  readonly requestedBy: string;
  readonly options: Record<string, unknown>;
  /** The uploaded file, for an import. */
  readonly input?: Uint8Array | undefined;
  readonly at: Date;
}

/** Writes the queued row. Its commit is the hand-off to the worker; nothing else is enqueued. */
export async function createBankJob(
  tx: DbTransaction,
  job: CreateBankJobInput,
): Promise<BankJobRow> {
  const rows = await tx.execute<DbRow>(sql`
    INSERT INTO bank_jobs (org_id, kind, format, requested_by, options, input, input_bytes, created_at)
    VALUES (${job.orgId}::uuid, ${job.kind}, ${job.format}, ${job.requestedBy}::uuid,
            ${JSON.stringify(job.options)}::jsonb,
            ${job.input === undefined ? null : asBuffer(job.input)},
            ${job.input === undefined ? null : job.input.byteLength},
            ${job.at.toISOString()}::timestamptz)
    RETURNING ${COLUMNS}
  `);
  const row = rows[0];
  if (row === undefined) throw new Error('INSERT INTO bank_jobs returned no row');
  return toRow(row);
}

export async function getBankJob(
  tx: DbTransaction,
  id: string,
  options: { readonly forUpdate?: boolean } = {},
): Promise<BankJobRow | undefined> {
  const rows = await tx.execute<DbRow>(sql`
    SELECT ${COLUMNS} FROM bank_jobs WHERE id = ${id}::uuid
    ${options.forUpdate === true ? sql`FOR UPDATE` : sql``}
  `);
  const row = rows[0];
  return row === undefined ? undefined : toRow(row);
}

/** The uploaded file, or undefined once the job has finished and cleared it. */
export async function readBankJobInput(
  tx: DbTransaction,
  id: string,
): Promise<Uint8Array | undefined> {
  const rows = await tx.execute<{ input: Uint8Array | null }>(sql`
    SELECT input FROM bank_jobs WHERE id = ${id}::uuid
  `);
  return rows[0]?.input ?? undefined;
}

/** An export's file, if the job succeeded and the file has not expired at `now`. */
export async function readBankJobResult(
  tx: DbTransaction,
  id: string,
  now: Date,
): Promise<{ readonly bytes: Uint8Array; readonly contentType: string } | undefined> {
  const rows = await tx.execute<{
    result: Uint8Array | null;
    result_content_type: string | null;
  }>(sql`
    SELECT result, result_content_type FROM bank_jobs
     WHERE id = ${id}::uuid AND kind = 'export' AND status = 'succeeded'
       AND (expires_at IS NULL OR expires_at > ${now.toISOString()}::timestamptz)
  `);
  const row = rows[0];
  if (row?.result === null || row?.result === undefined || row.result_content_type === null) {
    return undefined;
  }
  return { bytes: row.result, contentType: row.result_content_type };
}

/**
 * Claims up to `limit` queued jobs — or dispatched ones stale past `staleSeconds` — across every
 * organisation, returning ids and organisation ids only. See `claim_bank_jobs` in 0010.
 */
export async function claimBankJobs(
  db: Database,
  claim: { readonly limit: number; readonly now: Date; readonly staleSeconds: number },
): Promise<{ readonly id: string; readonly orgId: OrgId }[]> {
  const rows = await withOrg(db, PLATFORM_ORG_ID, (tx) =>
    tx.execute<{ id: string; org_id: string }>(sql`
      SELECT id, org_id FROM public.claim_bank_jobs(
        ${claim.limit}::int, ${claim.now.toISOString()}::timestamptz, ${claim.staleSeconds}::int)
    `),
  );
  return rows.map((r) => ({ id: r.id, orgId: r.org_id as OrgId }));
}

/**
 * Moves a dispatched (or re-delivered running) job to running, stamping `started_at` the first
 * time. Returns the row, or undefined when the job has already finished — a redelivery after
 * success, which the caller treats as done.
 */
export async function startBankJob(
  tx: DbTransaction,
  id: string,
  at: Date,
): Promise<BankJobRow | undefined> {
  const rows = await tx.execute<DbRow>(sql`
    UPDATE bank_jobs
       SET status = 'running', started_at = coalesce(started_at, ${at.toISOString()}::timestamptz)
     WHERE id = ${id}::uuid AND status IN ('queued', 'dispatched', 'running')
     RETURNING ${COLUMNS}
  `);
  const row = rows[0];
  return row === undefined ? undefined : toRow(row);
}

/** Appends problems, keeping at most {@link MAX_STORED_PROBLEMS} and counting past that. */
function appendProblems(problems: readonly StoredProblem[]): ReturnType<typeof sql> {
  return sql`
    problems = CASE
      WHEN jsonb_array_length(problems) >= ${MAX_STORED_PROBLEMS} THEN problems
      ELSE (
        SELECT coalesce(jsonb_agg(p ORDER BY ord), '[]'::jsonb)
          FROM (
            SELECT p, ord FROM jsonb_array_elements(problems || ${JSON.stringify(problems)}::jsonb)
              WITH ORDINALITY AS e(p, ord)
             ORDER BY ord
             LIMIT ${MAX_STORED_PROBLEMS}
          ) kept
      )
    END,
    problems_truncated = problems_truncated
      OR jsonb_array_length(problems) + ${problems.length} > ${MAX_STORED_PROBLEMS}`;
}

/** Records file-level parse problems once, when an import first starts. */
export async function recordParseProblems(
  tx: DbTransaction,
  id: string,
  problems: readonly StoredProblem[],
): Promise<void> {
  if (problems.length === 0) return;
  const skipped = new Set(problems.map((p) => p.index)).size;
  await tx.execute(sql`
    UPDATE bank_jobs
       SET ${appendProblems(problems)}, skipped_count = skipped_count + ${skipped}
     WHERE id = ${id}::uuid
  `);
}

/**
 * Advances the checkpoint past one item, in the caller's transaction.
 *
 * For a written item, call inside the transaction that wrote it; for a refused item, pass its
 * problems. `nextIndex` is the position after the item in the worker's item list.
 */
export async function advanceImport(
  tx: DbTransaction,
  id: string,
  step: {
    readonly nextIndex: number;
    readonly created: boolean;
    readonly problems: readonly StoredProblem[];
  },
): Promise<void> {
  await tx.execute(sql`
    UPDATE bank_jobs
       SET next_index = ${step.nextIndex},
           created_count = created_count + ${step.created ? 1 : 0},
           skipped_count = skipped_count + ${step.created ? 0 : 1}
           ${step.problems.length === 0 ? sql`` : sql`, ${appendProblems(step.problems)}`}
     WHERE id = ${id}::uuid
  `);
}

/** Finishes a job successfully, clearing the uploaded file and storing an export's result. */
export async function finishBankJob(
  tx: DbTransaction,
  id: string,
  finish: {
    readonly at: Date;
    readonly result?:
      | { readonly bytes: Uint8Array; readonly contentType: string; readonly expiresAt: Date }
      | undefined;
  },
): Promise<void> {
  const result = finish.result;
  await tx.execute(sql`
    UPDATE bank_jobs
       SET status = 'succeeded', finished_at = ${finish.at.toISOString()}::timestamptz,
           input = NULL,
           result = ${result === undefined ? null : asBuffer(result.bytes)},
           result_content_type = ${result?.contentType ?? null},
           result_bytes = ${result === undefined ? null : result.bytes.byteLength},
           expires_at = ${result === undefined ? null : result.expiresAt.toISOString()}::timestamptz
     WHERE id = ${id}::uuid
  `);
}

/** Fails a job with a message fit for an operator, clearing the uploaded file. */
export async function failBankJob(
  tx: DbTransaction,
  id: string,
  at: Date,
  failure: string,
): Promise<void> {
  await tx.execute(sql`
    UPDATE bank_jobs
       SET status = 'failed', finished_at = ${at.toISOString()}::timestamptz, input = NULL,
           failure = ${failure.slice(0, 2000)}
     WHERE id = ${id}::uuid
  `);
}
