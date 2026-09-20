/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The `bank.jobs` queue: relaying claimed rows onto it, and running what arrives (ADR-021).
 *
 * ## Relay
 *
 * {@link relayBankJobs} claims queued rows through `claim_bank_jobs` and adds each to `bank.jobs`
 * with the row id as its BullMQ job id. The row was committed by the API before anything here
 * saw it, so there is no request whose job can be lost between a commit and an enqueue; and a row
 * claimed twice — after a relay crashed between its claim and its enqueue — is added twice under
 * one id, which BullMQ ignores.
 *
 * ## Running
 *
 * {@link runBankJob} follows the three job rules (`./example.ts`): the payload is parsed at the
 * edge, the job is idempotent by the row id, and the result is on the row. An import resumes at
 * the row's `next_index`; a redelivery of a finished job returns without doing anything.
 *
 * A file the job cannot trust — not JSON, the wrong format, no manifest, over the limits — fails
 * the job with a message a person can act on. A problem with one item is recorded and the job
 * carries on. Anything unexpected is rethrown for BullMQ's retry, and marks the row failed on the
 * last attempt so no job is left `running` with nobody working on it.
 */

import { z } from 'zod';

import {
  OrgIdSchema,
  SkillIdSchema,
  SourceLicenseSchema,
  type OrgId,
  type UserId,
} from '@assaybank/contracts';
import {
  advanceImport,
  claimBankJobs,
  failBankJob,
  finishBankJob,
  MAX_BANK_JOB_BYTES,
  readBankJobInput,
  recordParseProblems,
  startBankJob,
  withOrg,
  type BankJobRow,
  type Database,
} from '@assaybank/db';
import type { Logger } from '@assaybank/observability';

import {
  buildBankDocument,
  readBankDocument,
  serialiseBankDocument,
  UnreadableDocumentError,
  type ReadResult,
} from '../interchange/bank-document.js';
import type { ItemProblem } from '../interchange/bank-item.js';
import {
  JSONL_DATASETS,
  readExercismTrack,
  readJsonlDataset,
  type JsonlDataset,
} from '../interchange/datasets/index.js';
import {
  readQtiPackage,
  unzipPackage,
  UnreadablePackageError,
  writeQtiPackage,
  zipPackage,
} from '../interchange/qti.js';
import { exportBank, importBankItems } from './bank-transfer.js';

export const BANK_JOB_NAME = 'bank.job';

/** An export's file is downloadable for this long, then gone. */
export const EXPORT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** A claim not enqueued within this long is claimed again. */
export const RELAY_STALE_SECONDS = 300;

export const BankJobPayloadSchema = z.strictObject({
  bank_job_id: z.uuid(),
  org_id: OrgIdSchema,
});
export type BankJobPayload = z.infer<typeof BankJobPayloadSchema>;

/** Whether a job's format is one of the line-delimited datasets. */
const isJsonlDataset = (format: string): format is JsonlDataset =>
  (JSONL_DATASETS as readonly string[]).includes(format);

/** What the API wrote into `options`, re-parsed here because it came out of a database column. */
export const ImportOptionsSchema = z.strictObject({
  source_license: SourceLicenseSchema,
  default_skill_ids: z.array(SkillIdSchema).max(20).default([]),
  default_difficulty: z.number().int().min(1).max(5).optional(),
});

export const ExportOptionsSchema = z.strictObject({
  status: z.enum(['draft', 'review', 'published', 'retired']).optional(),
  skill_id: SkillIdSchema.optional(),
});

/** The business key, and so the BullMQ job id (after `toJobId`). */
export const bankJobKey = (bankJobId: string): string => `${BANK_JOB_NAME}:${bankJobId}`;

export interface RelayDeps {
  readonly db: Database;
  readonly now: () => Date;
  readonly enqueue: (payload: BankJobPayload, key: string) => Promise<void>;
  readonly limit?: number;
}

/** Claims and enqueues one batch. Returns how many rows it relayed. */
export async function relayBankJobs(deps: RelayDeps): Promise<number> {
  const claimed = await claimBankJobs(deps.db, {
    limit: deps.limit ?? 20,
    now: deps.now(),
    staleSeconds: RELAY_STALE_SECONDS,
  });
  for (const job of claimed) {
    await deps.enqueue({ bank_job_id: job.id, org_id: job.orgId }, bankJobKey(job.id));
  }
  return claimed.length;
}

export interface RunDeps {
  readonly db: Database;
  readonly now: () => Date;
  readonly logger: Logger;
}

export type BankJobOutcome =
  | { readonly status: 'already_finished'; readonly bank_job_id: string }
  | { readonly status: 'succeeded' | 'failed'; readonly bank_job_id: string };

async function fail(
  deps: RunDeps,
  orgId: OrgId,
  id: string,
  message: string,
): Promise<BankJobOutcome> {
  await withOrg(deps.db, orgId, (tx) => failBankJob(tx, id, deps.now(), message));
  return { status: 'failed', bank_job_id: id };
}

const asStored = (p: ItemProblem) => ({
  index: p.index,
  ref: p.ref,
  path: p.path,
  message: p.message,
});

async function runImport(deps: RunDeps, orgId: OrgId, job: BankJobRow): Promise<BankJobOutcome> {
  const options = ImportOptionsSchema.safeParse(job.options);
  if (!options.success)
    return fail(deps, orgId, job.id, 'The import options on this job are invalid.');

  const input = await withOrg(deps.db, orgId, (tx) => readBankJobInput(tx, job.id));
  if (input === undefined) {
    return fail(deps, orgId, job.id, 'The uploaded file is no longer available; upload it again.');
  }

  const difficulty =
    options.data.default_difficulty === undefined
      ? {}
      : { defaultDifficulty: options.data.default_difficulty };

  let read: ReadResult;
  try {
    // A dataset format is a third-party file shape we read and never write (`H-032`). Its
    // licence comes from the descriptor rather than from `options.source_license`, which is
    // the whole point: docs/05 §2 is the record of what a dataset's terms are, and an uploader
    // is not the authority on somebody else's licence.
    read = isJsonlDataset(job.format)
      ? readJsonlDataset(job.format, Buffer.from(input).toString('utf8'), difficulty)
      : job.format === 'exercism'
        ? // A track is a repository, so it arrives as a zip — the same reader a QTI package
          // uses, because the hazards of an untrusted archive are the same either way.
          readExercismTrack(unzipPackage(input), difficulty)
        : job.format === 'json'
          ? readBankDocument(Buffer.from(input).toString('utf8'))
          : readQtiPackage(unzipPackage(input), difficulty);
  } catch (error) {
    if (error instanceof UnreadableDocumentError || error instanceof UnreadablePackageError) {
      return fail(deps, orgId, job.id, error.message);
    }
    throw error;
  }

  // Parse problems are recorded once: on a first run the checkpoint and the counts are untouched.
  const firstRun = job.nextIndex === 0 && job.createdCount === 0 && job.skippedCount === 0;
  if (firstRun && read.problems.length > 0) {
    await withOrg(deps.db, orgId, (tx) =>
      recordParseProblems(tx, job.id, read.problems.map(asStored)),
    );
  }

  await importBankItems(
    deps.db,
    {
      orgId,
      requestedBy: job.requestedBy as UserId,
      sourceLicense: options.data.source_license,
      defaultSkillIds: options.data.default_skill_ids,
    },
    read.items,
    deps.now,
    {
      from: job.nextIndex,
      checkpoint: async (tx, step) =>
        advanceImport(tx, job.id, {
          nextIndex: step.position + 1,
          created: step.created,
          problems: step.problem === null ? [] : [asStored(step.problem)],
        }),
    },
  );

  await withOrg(deps.db, orgId, (tx) => finishBankJob(tx, job.id, { at: deps.now() }));
  return { status: 'succeeded', bank_job_id: job.id };
}

async function runExport(deps: RunDeps, orgId: OrgId, job: BankJobRow): Promise<BankJobOutcome> {
  const options = ExportOptionsSchema.safeParse(job.options);
  if (!options.success)
    return fail(deps, orgId, job.id, 'The export options on this job are invalid.');

  const at = deps.now();
  const items = await exportBank(deps.db, orgId, {
    status: options.data.status,
    skillId: options.data.skill_id,
  });
  const bytes =
    job.format === 'json'
      ? Buffer.from(serialiseBankDocument(buildBankDocument(items, at)), 'utf8')
      : zipPackage(writeQtiPackage(items));

  if (bytes.byteLength > MAX_BANK_JOB_BYTES) {
    return fail(
      deps,
      orgId,
      job.id,
      `The export is ${String(bytes.byteLength)} bytes, over the ${String(MAX_BANK_JOB_BYTES)}-byte limit; narrow it by status or skill.`,
    );
  }

  await withOrg(deps.db, orgId, (tx) =>
    finishBankJob(tx, job.id, {
      at,
      result: {
        bytes,
        contentType: job.format === 'json' ? 'application/json' : 'application/zip',
        expiresAt: new Date(at.getTime() + EXPORT_RETENTION_MS),
      },
    }),
  );
  return { status: 'succeeded', bank_job_id: job.id };
}

/**
 * Runs one bank job. `finalAttempt` is true when BullMQ will not retry this delivery, so an
 * unexpected error marks the row failed before it is rethrown.
 */
export async function runBankJob(
  data: unknown,
  deps: RunDeps,
  finalAttempt: boolean,
): Promise<BankJobOutcome> {
  const payload = BankJobPayloadSchema.parse(data);
  const orgId = payload.org_id;
  const id = payload.bank_job_id;

  const job = await withOrg(deps.db, orgId, (tx) => startBankJob(tx, id, deps.now()));
  if (job === undefined) return { status: 'already_finished', bank_job_id: id };

  try {
    return job.kind === 'import'
      ? await runImport(deps, orgId, job)
      : await runExport(deps, orgId, job);
  } catch (error) {
    deps.logger.error(
      {
        event: 'bank_job.error',
        bank_job_id: id,
        kind: job.kind,
        final_attempt: finalAttempt,
        err: error,
      },
      'bank job failed unexpectedly',
    );
    if (finalAttempt) {
      await fail(
        deps,
        orgId,
        id,
        'The job stopped unexpectedly. Items already imported are kept; see the problems list.',
      );
    }
    throw error;
  }
}
