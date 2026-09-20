/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Bank import and export — docs/03 §4 "Bulk", ADR-021.
 *
 * Each request writes one `bank_jobs` row inside `request.audited`, and that commit is the whole
 * hand-off: the worker's relay claims committed rows, so there is no enqueue here that could be
 * lost after the commit or sent before it. The API never reads an uploaded file; it checks the
 * query, the size and the default skills, stores the bytes, and answers `202`.
 *
 * ## Permissions
 *
 * Import and export both need `question.write`. Reading a job needs `question.read`. An export is
 * a copy of the whole bank, reference solutions and hidden test cases included — the asset
 * docs/14 §3 calls the crown jewel — so it is not granted by the permission to look at questions
 * one at a time, and every request for one and every download of one is audited (T-031).
 *
 * ## The upload
 *
 * The request body is the file, `Content-Type: application/octet-stream`, up to
 * {@link MAX_BANK_FILE_BYTES}. The parser for that type is registered inside this plugin's scope
 * only, so no other route accepts a raw body.
 */

import type { FastifyInstance } from 'fastify';

import {
  ApiError,
  API_BASE_PATH,
  BankJobParamsSchema,
  EXPORT_JOB_FILE_PATH,
  EXPORT_JOB_PATH,
  ExportQuerySchema,
  IMPORT_JOB_PATH,
  ImportQuerySchema,
  MAX_BANK_FILE_BYTES,
  QUESTIONS_ATTRIBUTIONS_PATH,
  QUESTIONS_EXPORT_PATH,
  type AttributionListResponse,
  QUESTIONS_IMPORT_PATH,
  parseRequestPart,
  type BankJobAccepted,
  type BankJobView,
} from '@assaybank/contracts';
import {
  createBankJob,
  getBankJob,
  listAttributions,
  invisibleSkillIds,
  readBankJobResult,
  withOrg,
  type BankJobRow,
  type Database,
} from '@assaybank/db';

import { requirePermission } from '../authorisation.js';
import { fastifyPath } from '../paths.js';
import { staffOnly } from '../principal.js';
import { rateLimitFor } from '../rate-limit.js';

export interface BankJobRouteOptions {
  readonly db: Database;
  readonly now: () => Date;
}

export const QUESTIONS_IMPORT_ROUTE = fastifyPath(QUESTIONS_IMPORT_PATH);
export const QUESTIONS_EXPORT_ROUTE = fastifyPath(QUESTIONS_EXPORT_PATH);
export const QUESTIONS_ATTRIBUTIONS_ROUTE = fastifyPath(QUESTIONS_ATTRIBUTIONS_PATH);
export const IMPORT_JOB_ROUTE = fastifyPath(IMPORT_JOB_PATH);
export const EXPORT_JOB_ROUTE = fastifyPath(EXPORT_JOB_PATH);
export const EXPORT_JOB_FILE_ROUTE = fastifyPath(EXPORT_JOB_FILE_PATH);

export const BANK_JOB_ACTIONS = {
  import: 'bank_job.import',
  export: 'bank_job.export',
  download: 'bank_job.download',
} as const;

const BANK_JOB_ENTITY = 'bank_job';
const OCTET_STREAM = 'application/octet-stream';

const jobUrl = (row: BankJobRow): string =>
  `${API_BASE_PATH}${(row.kind === 'import' ? IMPORT_JOB_PATH : EXPORT_JOB_PATH).replace('{id}', row.id)}`;

function toView(row: BankJobRow): BankJobView {
  const downloadable =
    row.kind === 'export' && row.status === 'succeeded' && row.resultBytes !== null;
  return {
    id: row.id,
    kind: row.kind,
    format: row.format,
    status: row.status,
    created: row.createdCount,
    skipped: row.skippedCount,
    problems: row.problems,
    problems_truncated: row.problemsTruncated,
    failure: row.failure,
    created_at: row.createdAt.toISOString(),
    started_at: row.startedAt?.toISOString() ?? null,
    finished_at: row.finishedAt?.toISOString() ?? null,
    expires_at: row.expiresAt?.toISOString() ?? null,
    file_bytes: downloadable ? row.resultBytes : null,
    file_url: downloadable
      ? `${API_BASE_PATH}${EXPORT_JOB_FILE_PATH.replace('{id}', row.id)}`
      : null,
  };
}

function accepted(row: BankJobRow): BankJobAccepted {
  return { job_id: row.id, status: 'queued', job_url: jobUrl(row) };
}

export function registerBankJobRoutes(app: FastifyInstance, options: BankJobRouteOptions): void {
  const { db, now } = options;

  const read = { ...rateLimitFor('staff_api'), ...requirePermission('question.read') };
  const write = { ...rateLimitFor('staff_api'), ...requirePermission('question.write') };

  // A callback plugin rather than an async one: nothing here awaits, and registration order is
  // what scopes the octet-stream parser to this one route.
  void app.register((scoped, _options, done) => {
    scoped.addContentTypeParser(
      OCTET_STREAM,
      { parseAs: 'buffer', bodyLimit: MAX_BANK_FILE_BYTES },
      (_request, body, done) => {
        done(null, body);
      },
    );

    // --- POST /questions/import ----------------------------------------------------
    scoped.post(
      QUESTIONS_IMPORT_ROUTE,
      { config: write, bodyLimit: MAX_BANK_FILE_BYTES },
      async (request, reply): Promise<BankJobAccepted> => {
        const principal = staffOnly(request);
        const query = parseRequestPart(ImportQuerySchema, request.query, 'querystring');

        const contentType = request.headers['content-type']?.split(';')[0]?.trim();
        if (contentType !== OCTET_STREAM || !Buffer.isBuffer(request.body)) {
          throw ApiError.validationFailed(
            `Send the file itself as the request body, with Content-Type: ${OCTET_STREAM}.`,
            {
              details: {
                fields: [
                  { field: 'body', rule: 'content_type', message: `expected ${OCTET_STREAM}` },
                ],
              },
            },
          );
        }
        const file = request.body;
        if (file.byteLength === 0) {
          throw ApiError.validationFailed('The file is empty.', {
            details: { fields: [{ field: 'body', rule: 'empty', message: 'the file is empty' }] },
          });
        }

        const row = await request.audited(
          { action: BANK_JOB_ACTIONS.import, entityType: BANK_JOB_ENTITY },
          async (tx, entry) => {
            const invisible = new Set(await invisibleSkillIds(tx, query.default_skill_id));
            if (invisible.size > 0) {
              throw ApiError.validationFailed('A default skill does not exist.', {
                details: {
                  fields: query.default_skill_id.flatMap((id, i) =>
                    invisible.has(id)
                      ? [
                          {
                            field: `querystring/default_skill_id/${String(i)}`,
                            rule: 'not_found',
                            message: 'No such skill.',
                          },
                        ]
                      : [],
                  ),
                },
              });
            }
            const created = await createBankJob(tx, {
              orgId: principal.orgId,
              kind: 'import',
              format: query.format,
              requestedBy: principal.userId,
              options: {
                source_license: query.source_license,
                default_skill_ids: query.default_skill_id,
                ...(query.default_difficulty === undefined
                  ? {}
                  : { default_difficulty: query.default_difficulty }),
              },
              input: file,
              at: now(),
            });
            entry.amend({
              entityId: created.id,
              after: {
                format: query.format,
                bytes: file.byteLength,
                source_license: query.source_license,
              },
            });
            return created;
          },
        );

        reply.code(202);
        return accepted(row);
      },
    );
    done();
  });

  // --- POST /questions/export ------------------------------------------------------
  app.post(
    QUESTIONS_EXPORT_ROUTE,
    { config: write },
    async (request, reply): Promise<BankJobAccepted> => {
      const principal = staffOnly(request);
      const query = parseRequestPart(ExportQuerySchema, request.query, 'querystring');

      const row = await request.audited(
        { action: BANK_JOB_ACTIONS.export, entityType: BANK_JOB_ENTITY },
        async (tx, entry) => {
          const created = await createBankJob(tx, {
            orgId: principal.orgId,
            kind: 'export',
            format: query.format,
            requestedBy: principal.userId,
            options: {
              ...(query.status === undefined ? {} : { status: query.status }),
              ...(query.skill_id === undefined ? {} : { skill_id: query.skill_id }),
            },
            at: now(),
          });
          entry.amend({
            entityId: created.id,
            after: { format: query.format, ...created.options },
          });
          return created;
        },
      );

      reply.code(202);
      return accepted(row);
    },
  );

  // --- GET /questions/attributions -----------------------------------------------------
  //
  // The obligation, not a report. CC-BY-4.0 requires attribution "in any reasonable manner",
  // and docs/05 §2 makes that concrete for a hiring platform: a page in the console listing
  // the sources, and the credit preserved in every export. The export half has existed since
  // the interchange formats were built; this is the other half (`H-032`).
  //
  // `question.read`, not an export permission: it is a statement about the bank a recruiter
  // may look at, and gating it behind the ability to export would hide the obligation from
  // most of the people who need to know about it.
  app.get(
    QUESTIONS_ATTRIBUTIONS_ROUTE,
    { config: read },
    async (request): Promise<AttributionListResponse> => {
      const principal = staffOnly(request);
      const rows = await withOrg(db, principal.orgId, (tx) => listAttributions(tx));
      return { data: rows };
    },
  );

  // --- GET /import-jobs/:id and /export-jobs/:id -------------------------------------
  for (const [route, kind] of [
    [IMPORT_JOB_ROUTE, 'import'],
    [EXPORT_JOB_ROUTE, 'export'],
  ] as const) {
    app.get(route, { config: read }, async (request): Promise<BankJobView> => {
      const principal = staffOnly(request);
      const { id } = parseRequestPart(BankJobParamsSchema, request.params, 'params');
      const row = await withOrg(db, principal.orgId, (tx) => getBankJob(tx, id));
      // An export's id under /import-jobs is not an import job: 404, not a mislabelled answer.
      if (row?.kind !== kind) throw ApiError.notFound();
      return toView(row);
    });
  }

  // --- GET /export-jobs/:id/file -------------------------------------------------------
  app.get(EXPORT_JOB_FILE_ROUTE, { config: write }, async (request, reply) => {
    staffOnly(request);
    const { id } = parseRequestPart(BankJobParamsSchema, request.params, 'params');

    const file = await request.audited(
      { action: BANK_JOB_ACTIONS.download, entityType: BANK_JOB_ENTITY, entityId: id },
      async (tx, entry) => {
        const found = await readBankJobResult(tx, id, now());
        // Missing, not finished, another tenant's, or expired: all the same answer.
        if (found === undefined) throw ApiError.notFound();
        entry.amend({ after: { bytes: found.bytes.byteLength } });
        return found;
      },
    );

    const extension = file.contentType === 'application/zip' ? 'zip' : 'json';
    return reply
      .header('content-type', file.contentType)
      .header('content-disposition', `attachment; filename="assaybank-bank-${id}.${extension}"`)
      .header('cache-control', 'no-store')
      .send(Buffer.from(file.bytes));
  });
}
