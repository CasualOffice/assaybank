/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Bank import and export over HTTP — docs/03 §4 "Bulk", ADR-021.
 *
 * Both directions are jobs. A request writes a row and answers `202` with its id; the worker does
 * the work; the job's own URL reports what happened. The upload is the request body itself, as
 * `application/octet-stream`, with the options in the query string: one file per request, and no
 * multipart parser between the socket and the bytes.
 */

import { z } from 'zod';

import { SkillIdSchema } from './ids.js';
import { QuestionStatusSchema, SourceLicenseSchema } from './questions.js';

export const QUESTIONS_IMPORT_PATH = '/questions/import';
export const QUESTIONS_EXPORT_PATH = '/questions/export';
export const IMPORT_JOB_PATH = '/import-jobs/{id}';
export const EXPORT_JOB_PATH = '/export-jobs/{id}';
export const EXPORT_JOB_FILE_PATH = '/export-jobs/{id}/file';

/**
 * The formats an import or export job speaks.
 *
 * `json` and `qti` are ours and go both ways. The three dataset formats are **import only**
 * (`H-032`): they are somebody else's file shape, we do not own them, and writing one back out
 * would claim a fidelity we cannot promise — a question edited here has no MBPP row to become.
 * An export of imported content is a JSON bank document, which keeps its `source_license` and
 * `external_ref` and so keeps the attribution CC-BY-4.0 requires (docs/05 §2).
 */
export const BANK_FORMATS = ['json', 'qti', 'humaneval', 'mbpp', 'lbpp'] as const;

/** The formats an export may be asked for. A dataset format is not one of them. */
export const EXPORT_FORMATS = ['json', 'qti'] as const;
export const ExportFormatSchema = z.enum(EXPORT_FORMATS);
export type ExportFormat = z.infer<typeof ExportFormatSchema>;
export const BankFormatSchema = z.enum(BANK_FORMATS);
export type BankFormat = z.infer<typeof BankFormatSchema>;

/** The largest upload or export, in bytes. Matches the `bank_jobs` column checks. */
export const MAX_BANK_FILE_BYTES = 32 * 1024 * 1024;

/** A query parameter that may be given once or repeated, always read as a list. */
const repeated = <T extends z.ZodType>(item: T) =>
  z.preprocess(
    (v): unknown[] => (v === undefined ? [] : Array.isArray(v) ? (v as unknown[]) : [v]),
    z.array(item).max(20),
  );

/**
 * `POST /questions/import?format=&source_license=&default_skill_id=&default_difficulty=`
 *
 * `source_license` is mandatory (docs/05 §2): it is applied to every item that carries none of its
 * own. `default_difficulty` is used only for QTI items from other tools, which have no difficulty.
 *
 * For a **named dataset** `source_license` is still required and is still ignored for the items
 * themselves: HumanEval is MIT because it is MIT, and an import that let an uploader relabel it
 * would put content in the bank whose real terms nobody could reconstruct (`H-032`). The dataset's
 * own licence is in `apps/worker/src/interchange/datasets/spec.ts`, from docs/05 §2.
 */
export const ImportQuerySchema = z.strictObject({
  format: BankFormatSchema,
  source_license: SourceLicenseSchema,
  default_skill_id: repeated(SkillIdSchema),
  default_difficulty: z.coerce.number().int().min(1).max(5).optional(),
});
export type ImportQuery = z.infer<typeof ImportQuerySchema>;

/**
 * `POST /questions/export?format=&status=&skill_id=`
 *
 * `ExportFormatSchema`, not `BankFormatSchema`: a dataset format is import-only, so asking for
 * one here is a `422` rather than a job that fails later with the same information.
 */
export const ExportQuerySchema = z.strictObject({
  format: ExportFormatSchema,
  status: QuestionStatusSchema.optional(),
  skill_id: SkillIdSchema.optional(),
});
export type ExportQuery = z.infer<typeof ExportQuerySchema>;

export const BankJobParamsSchema = z.strictObject({ id: z.uuid() });

export const BANK_JOB_STATUSES = [
  'queued',
  'dispatched',
  'running',
  'succeeded',
  'failed',
] as const;

/** One item a job could not import, located in the uploaded file. */
export interface BankJobProblemView {
  readonly index: number;
  readonly ref: string | null;
  readonly path: string;
  readonly message: string;
}

export interface BankJobAccepted {
  readonly job_id: string;
  readonly status: 'queued';
  /** Where to poll. */
  readonly job_url: string;
}

export interface BankJobView {
  readonly id: string;
  readonly kind: 'import' | 'export';
  readonly format: BankFormat;
  readonly status: (typeof BANK_JOB_STATUSES)[number];
  readonly created: number;
  readonly skipped: number;
  /** At most 1,000; `problems_truncated` says whether there were more. */
  readonly problems: readonly BankJobProblemView[];
  readonly problems_truncated: boolean;
  readonly failure: string | null;
  readonly created_at: string;
  readonly started_at: string | null;
  readonly finished_at: string | null;
  /** For an export: when its file stops being downloadable. */
  readonly expires_at: string | null;
  /** For a finished export: the file's size, and where to fetch it until `expires_at`. */
  readonly file_bytes: number | null;
  readonly file_url: string | null;
}
