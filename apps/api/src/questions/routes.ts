/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The question bank — docs/03-API-spec.md §4, and the first business surface built on the
 * P1 spine.
 *
 * ```
 * GET    /api/v1/questions                            question.read
 * POST   /api/v1/questions                            question.write
 * GET    /api/v1/questions/:id                        question.read
 * PATCH  /api/v1/questions/:id                        question.write
 * DELETE /api/v1/questions/:id                        question.write
 * GET    /api/v1/questions/:id/versions               question.read
 * POST   /api/v1/questions/:id/versions               question.write
 * GET    /api/v1/questions/:id/versions/:v            question.read
 * PATCH  /api/v1/questions/:id/versions/:v            question.write
 * POST   /api/v1/questions/:id/versions/:v/publish    question.publish
 * ```
 *
 * Ten routes, ten declarations, and `route-authorisation.test.ts` enumerates the table to
 * prove none of them forgot — a route that forgets looks identical, from outside, to a
 * route that is deliberately public, and the missing line is not in the diff.
 *
 * ## The shape of every handler
 *
 * The same four steps, in the same order, because P1 built them: the session became a
 * principal, the permission was checked before the handler ran, `request.audited` opens
 * the one transaction carrying both the change and its record, and `withOrg` inside it is
 * what makes the read see one tenant. What is left here is the part that is actually
 * about questions.
 *
 * ## Where each rule lives, and why not here
 *
 * - **Whether a transition is legal** is `transitionQuestion` in `@assaybank/core-domain`,
 *   a pure function with an exhaustive table test. A handler that decided it inline would
 *   be a sixteen-cell truth table spread across three `if` statements.
 * - **What a caller may see** is `toAuthorView` in `@assaybank/contracts`. These routes
 *   are staff-only by permission, so they serve the author view; the candidate view has
 *   no route here at all, and arrives in P3 attached to the attempt endpoints. That is
 *   the audience boundary working: there is no flag on this endpoint that could serve the
 *   other one.
 * - **Immutability** is the database's, through the triggers migrations 0001 and 0007
 *   install. What this file adds is that a caller is told `409 version_immutable` instead
 *   of meeting a constraint violation — see {@link registerQuestionRoutes}'s `PATCH`.
 *
 * ## `Idempotency-Key`, and why it is still not read
 *
 * For the reason `../org/routes.ts` gives: the replay store does not exist yet and is not
 * this endpoint's to invent. It matters more here than it did there — a double-clicked
 * "publish" is a real thing — so it is worth saying what happens instead. The publish
 * write carries `AND published_at IS NULL`, so the second of two concurrent publishes
 * changes no rows and answers `409` rather than re-stamping a new instant onto a version
 * candidates have already been graded against. The retry is safe; it is merely not
 * silent.
 */

import type { FastifyInstance } from 'fastify';

import {
  API_BASE_PATH,
  ApiError,
  CreateQuestionSchema,
  FIRST_VERSION_FIELDS,
  ListQuestionsQuerySchema,
  PaginationQuerySchema,
  PatchQuestionSchema,
  QUESTIONS_PATH,
  QUESTION_PATH,
  QUESTION_VERSIONS_PATH,
  QUESTION_VERSION_PATH,
  QUESTION_VERSION_PUBLISH_PATH,
  QuestionParamsSchema,
  QuestionVersionInputSchema,
  QuestionVersionParamsSchema,
  parseRequestPart,
  toAuthorSummaryView,
  toAuthorVersionView,
  toAuthorView,
  type AuthorQuestionVersionView,
  type AuthorQuestionView,
  type QuestionId,
  type QuestionListResponse,
  type QuestionRecord,
  type QuestionVersionListResponse,
  type QuestionVersionRecord,
} from '@assaybank/contracts';
import { isErr, transitionQuestion, type QuestionEvent } from '@assaybank/core-domain';
import {
  archiveQuestion,
  createQuestion,
  createVersion,
  getLatestVersion,
  getQuestionWithCurrentVersion,
  getVersion,
  listQuestions,
  listVersions,
  mergeVersionContent,
  missingFirstVersionFields,
  publishVersion,
  restoreQuestion,
  setQuestionStatus,
  updateVersion,
  withOrg,
  type Database,
  type DbTransaction,
} from '@assaybank/db';

import { requirePermission } from '../authorisation.js';
import { staffOnly } from '../principal.js';
import { rateLimitFor } from '../rate-limit.js';

/**
 * OpenAPI writes a path parameter as `{id}` and Fastify as `:id`.
 *
 * Converted rather than declared twice: the document and the route table have to describe
 * the same URL, and two string literals that must match is two string literals that will
 * eventually not. `@assaybank/contracts` owns the spelling because it is the contract;
 * this is the one place that translates it.
 */
function fastifyPath(openApiPath: string): string {
  return `${API_BASE_PATH}${openApiPath.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/gu, ':$1')}`;
}

/** The registered paths, exported so the tests address the routes by the same constant. */
export const QUESTIONS_ROUTE = fastifyPath(QUESTIONS_PATH);
/** `/api/v1/questions/:id`. */
export const QUESTION_ROUTE = fastifyPath(QUESTION_PATH);
/** `/api/v1/questions/:id/versions`. */
export const QUESTION_VERSIONS_ROUTE = fastifyPath(QUESTION_VERSIONS_PATH);
/** `/api/v1/questions/:id/versions/:v`. */
export const QUESTION_VERSION_ROUTE = fastifyPath(QUESTION_VERSION_PATH);
/** `/api/v1/questions/:id/versions/:v/publish`. */
export const QUESTION_VERSION_PUBLISH_ROUTE = fastifyPath(QUESTION_VERSION_PUBLISH_PATH);

/**
 * The `audit_log.action` each write is recorded under.
 *
 * `question.` prefixed throughout, so `action LIKE 'question.%'` answers "what has anybody
 * done to the bank" — the query an organisation runs when a candidate disputes a result
 * and the item has been edited since. Exported because the integration suite reads rows
 * back by these exact strings, and a literal repeated in two places is a literal that will
 * eventually be two different strings.
 */
export const QUESTION_ACTIONS = {
  create: 'question.create',
  update: 'question.update',
  archive: 'question.archive',
  restore: 'question.restore',
  versionCreate: 'question.version.create',
  versionUpdate: 'question.version.update',
  versionPublish: 'question.version.publish',
} as const;

/** `audit_log.entity_type` values. Lowercase snake case, matching the table names. */
const QUESTION_ENTITY = 'question';
const VERSION_ENTITY = 'question_version';

/** What the routes need from the composition root. */
export interface QuestionRouteOptions {
  /** The connection handle. `request.audited` opens its own transaction from the same one. */
  readonly db: Database;
  /** ADR-006: every instant this file writes comes from here, never from the wall clock. */
  readonly now: () => Date;
}

/**
 * The staff principal behind this request.
 *
 * Unreachable as a refusal — `can()` denies a candidate principal every permission,
 * including ones invented after it was written — and written as a refusal anyway, for the
 * reason `../org/routes.ts` gives: a narrowing enforced by an `if` stays true when
 * somebody moves the route onto the public allow-list by mistake, and a cast does not.
 *
 * It matters more on this surface than on any other. These ten routes are the only place
 * in the system that serves `is_correct`, `solution_code` and `expected_stdout`, so "no
 * candidate principal reaches this handler" is FR-12's first line of defence and the
 * standing leak suite's first assertion.
 */

/**
 * The question named in the path, or `not_found`.
 *
 * `not_found`, never `forbidden`, for a question another organisation holds: a `403` would
 * confirm that somebody owns the id, which is a cross-tenant disclosure made of nothing
 * but a status code (ADR-010, docs/14 `H-128`). Row-level security has already made the
 * two indistinguishable from in here — the policy admits no row either way — and this
 * function is what keeps them indistinguishable from outside.
 */
async function requireQuestion(
  tx: DbTransaction,
  questionId: QuestionId,
  options: { readonly forUpdate?: boolean; readonly includeArchived?: boolean } = {},
): Promise<QuestionRecord> {
  const question = await getQuestionWithCurrentVersion(tx, questionId, options);
  if (question === undefined) throw ApiError.notFound();
  return question;
}

/**
 * Applies a lifecycle event, or turns the domain's refusal into a `409`.
 *
 * The translation layer between `@assaybank/core-domain` and HTTP, and the only place it
 * happens. The domain returns a `DomainError` value rather than throwing because an
 * illegal transition is an expected outcome of a legitimate request (`result.ts`); what
 * the API owes it is a status code and an error envelope carrying the same `from` and
 * `event` the domain named — states and event names only, never content, because an error
 * envelope is a place leaks hide (docs/14).
 */
function nextStatus(question: QuestionRecord, event: QuestionEvent): QuestionRecord['status'] {
  const outcome = transitionQuestion(question.status, event);
  if (isErr(outcome)) {
    throw ApiError.conflict(outcome.error.message, {
      details: { ...outcome.error.details },
    });
  }
  return outcome.value;
}

/** The event a `PATCH` body's target status means, given where the question is now. */
function eventForTargetStatus(
  from: QuestionRecord['status'],
  to: 'draft' | 'review' | 'retired',
): QuestionEvent {
  if (to === 'review') return { type: 'submit_for_review' };
  if (to === 'retired') return { type: 'retire' };
  // `draft` is reachable by exactly one event, and only from `review`. Naming it here
  // rather than branching on `from` keeps the legality decision in one place: if `from`
  // is not `review`, `transitionQuestion` refuses and the caller gets a 409 that says so.
  void from;
  return { type: 'request_changes' };
}

/**
 * The version named in the path, or `not_found`.
 *
 * Addressed by `version_no` because that is what docs/03 §4 puts in the path and what an
 * author says out loud. The question is looked up first so that a version number under a
 * question this tenant cannot see answers `not_found` for the question rather than
 * `not_found` for the version — the same answer, reached without a second query that
 * would have had to be right about tenancy on its own.
 */
async function requireVersion(
  tx: DbTransaction,
  questionId: QuestionId,
  versionNo: number,
  options: { readonly forUpdate?: boolean } = {},
): Promise<QuestionVersionRecord> {
  const version = await getVersion(tx, questionId, versionNo, options);
  if (version === undefined) throw ApiError.notFound();
  return version;
}

/**
 * A compact audit payload for a question.
 *
 * Identity and lifecycle, never content. Three reasons, and each would be enough: the
 * writer caps `before` + `after` at 64KB and a prompt is `text`; an `audit_log` row is
 * kept for seven years, so a reference solution written into one outlives every rotation
 * and every erasure policy the organisation has; and the question a reader of this log
 * asks is "who changed the state of this item, and when", which content does not answer.
 * The content itself is already immutable and addressable — that is what versions are for.
 */
function auditQuestion(question: QuestionRecord): Record<string, unknown> {
  return {
    status: question.status,
    kind: question.kind,
    archived: question.archived_at !== null,
    current_version_id: question.current_version?.id ?? null,
  };
}

/** A compact audit payload for a version. Identity and freeze state, never content. */
function auditVersion(version: QuestionVersionRecord): Record<string, unknown> {
  return {
    version_no: version.version_no,
    locale: version.locale,
    difficulty: version.difficulty,
    published_at: version.published_at?.toISOString() ?? null,
    // Counts, because "the edit removed eleven test cases" is a thing a dispute needs and
    // the cases themselves are neither small nor safe to keep for seven years.
    option_count: version.options.length,
    test_case_count: version.test_cases.length,
    answer_key_count: version.answer_keys.length,
  };
}

/**
 * Registers all ten routes.
 *
 * Called from `server.ts` inside `app.after()`, for the reason recorded there: the rate
 * limiter and the authorisation table both install themselves through `onRoute` hooks,
 * which Fastify runs synchronously as each route is declared, so a route added before they
 * exist is silently unlimited and — worse — silently unchecked.
 */
export function registerQuestionRoutes(app: FastifyInstance, options: QuestionRouteOptions): void {
  const { db, now } = options;

  const read = { ...rateLimitFor('staff_api'), ...requirePermission('question.read') };
  const write = { ...rateLimitFor('staff_api'), ...requirePermission('question.write') };
  const publish = { ...rateLimitFor('staff_api'), ...requirePermission('question.publish') };

  // --- GET /questions ----------------------------------------------------------
  app.get(
    QUESTIONS_ROUTE,
    { config: read },
    async (request): Promise<QuestionListResponse> => {
      const principal = staffOnly(request);
      const query = parseRequestPart(ListQuestionsQuerySchema, request.query, 'querystring');

      const page = await withOrg(db, principal.orgId, (tx) => listQuestions(tx, query));

      return { data: page.rows.map(toAuthorSummaryView), next_cursor: page.nextCursor };
    },
  );

  // --- POST /questions ---------------------------------------------------------
  app.post(
    QUESTIONS_ROUTE,
    { config: write },
    async (request, reply): Promise<AuthorQuestionView> => {
      const principal = staffOnly(request);
      // Parsed before the transaction opens, so a malformed body costs no lock and no
      // round trip. `parseRequestPart` rather than Fastify's own validator because ajv is
      // configured with `removeAdditional: true` here, which would silently strip an
      // unrecognised field and answer 201 (see @assaybank/contracts/parse).
      const body = parseRequestPart(CreateQuestionSchema, request.body, 'body');

      const question = await request.audited(
        { action: QUESTION_ACTIONS.create, entityType: QUESTION_ENTITY },
        async (tx, entry) => {
          const created = await createQuestion(tx, {
            orgId: principal.orgId,
            kind: body.kind,
            authorId: principal.userId,
            ...(body.source_license === undefined ? {} : { sourceLicense: body.source_license }),
            ...(body.external_ref === undefined ? {} : { externalRef: body.external_ref }),
          });

          // The id does not exist until the INSERT has run, which is why the spec above
          // names no entity and this amends one in.
          entry.amend({ entityId: created.id, after: auditQuestion(created) });
          return created;
        },
      );

      void reply.code(201);
      return toAuthorView(question);
    },
  );

  // --- GET /questions/:id ------------------------------------------------------
  app.get(QUESTION_ROUTE, { config: read }, async (request): Promise<AuthorQuestionView> => {
    const principal = staffOnly(request);
    const { id } = parseRequestPart(QuestionParamsSchema, request.params, 'params');

    // Archived questions are readable by id even though they are absent from the list: a
    // soft delete hides a row from browsing, and an audit row naming an archived question
    // has to remain followable or the record stops being a record.
    const question = await withOrg(db, principal.orgId, (tx) =>
      requireQuestion(tx, id, { includeArchived: true }),
    );

    return toAuthorView(question);
  });

  // --- PATCH /questions/:id ----------------------------------------------------
  app.patch(QUESTION_ROUTE, { config: write }, async (request): Promise<AuthorQuestionView> => {
    staffOnly(request); // Refused for a candidate principal before anything is read. `request.audited`
    // takes the organisation from the same principal, so this handler needs no other
    // reference to it.
    const { id } = parseRequestPart(QuestionParamsSchema, request.params, 'params');
    const patch = parseRequestPart(PatchQuestionSchema, request.body, 'body');

    const updated = await request.audited(
      { action: QUESTION_ACTIONS.update, entityType: QUESTION_ENTITY, entityId: id },
      async (tx, entry) => {
        // `FOR UPDATE`: a lifecycle change is a read-modify-write over the status column,
        // and two reviewers acting at once would otherwise both read `review` and both
        // succeed — one of them writing a transition the other's state never admitted.
        const before = await requireQuestion(tx, id, {
          forUpdate: true,
          includeArchived: true,
        });

        let current = before;

        if (patch.status !== undefined) {
          // The legality decision, made once, in the domain. `published` cannot reach
          // here: `PATCHABLE_STATUSES` does not contain it, because publishing requires
          // `question.publish` and a permission gate a sibling endpoint routes around is
          // not a gate.
          const target = nextStatus(current, eventForTargetStatus(current.status, patch.status));
          const written = await setQuestionStatus(tx, id, target);
          if (written === undefined) throw ApiError.notFound();
          current = written;
        }

        if (patch.archived !== undefined) {
          const written = patch.archived
            ? await archiveQuestion(tx, id, now())
            : await restoreQuestion(tx, id);
          // `undefined` from `archiveQuestion` means it was already archived, which is a
          // no-op rather than a failure — the row is re-read so the response describes
          // the database rather than the request.
          current = written ?? (await requireQuestion(tx, id, { includeArchived: true }));
        }

        entry.amend({ before: auditQuestion(before), after: auditQuestion(current) });
        return current;
      },
    );

    return toAuthorView(updated);
  });

  // --- DELETE /questions/:id ---------------------------------------------------
  app.delete(QUESTION_ROUTE, { config: write }, async (request): Promise<AuthorQuestionView> => {
    staffOnly(request); // Refused for a candidate principal before anything is read. `request.audited`
    // takes the organisation from the same principal, so this handler needs no other
    // reference to it.
    const { id } = parseRequestPart(QuestionParamsSchema, request.params, 'params');

    const archived = await request.audited(
      { action: QUESTION_ACTIONS.archive, entityType: QUESTION_ENTITY, entityId: id },
      async (tx, entry) => {
        const before = await requireQuestion(tx, id, { forUpdate: true, includeArchived: true });

        // A soft delete, because a hard one is unavailable on principle: attempts
        // reference versions of this question, and removing the row would unexplain every
        // score it ever produced (ADR-003). Archiving an already-archived question is a
        // no-op that returns the row unchanged rather than moving the timestamp forward
        // and restarting a retention clock.
        const after = (await archiveQuestion(tx, id, now())) ?? before;

        entry.amend({ before: auditQuestion(before), after: auditQuestion(after) });
        return after;
      },
    );

    // 200 with the archived row rather than 204. A soft delete leaves something to
    // describe, and `archived_at` is the thing the caller wants to see.
    return toAuthorView(archived);
  });

  // --- GET /questions/:id/versions ---------------------------------------------
  app.get(
    QUESTION_VERSIONS_ROUTE,
    { config: read },
    async (request): Promise<QuestionVersionListResponse> => {
      const principal = staffOnly(request);
      const { id } = parseRequestPart(QuestionParamsSchema, request.params, 'params');
      const page = parseRequestPart(PaginationQuerySchema, request.query, 'querystring');

      const versions = await withOrg(db, principal.orgId, async (tx) => {
        // The question is required first so that a version list for a question this
        // tenant cannot see is `not_found` rather than an empty page — an empty page
        // would say "this question exists and has no versions", which is a different and
        // untrue statement.
        await requireQuestion(tx, id, { includeArchived: true });
        return listVersions(tx, id, page);
      });

      return {
        data: versions.rows.map(toAuthorVersionView),
        next_cursor: versions.nextCursor,
      };
    },
  );

  // --- POST /questions/:id/versions --------------------------------------------
  app.post(
    QUESTION_VERSIONS_ROUTE,
    { config: write },
    async (request, reply): Promise<AuthorQuestionVersionView> => {
      const principal = staffOnly(request);
      const { id } = parseRequestPart(QuestionParamsSchema, request.params, 'params');
      const body = parseRequestPart(QuestionVersionInputSchema, request.body, 'body');

      const version = await request.audited(
        { action: QUESTION_ACTIONS.versionCreate, entityType: VERSION_ENTITY },
        async (tx, entry) => {
          // The row lock is on the *question*, not on any version: version numbering is
          // `max(version_no) + 1`, so two concurrent creates would otherwise both read 3
          // and both try to write 4, and the loser would meet the unique constraint as a
          // 500 rather than as a queue.
          await requireQuestion(tx, id, { forUpdate: true });

          const prior = await getLatestVersion(tx, id);

          // Asked before the merge, so that "your first version needs a prompt" is a 422
          // naming the fields rather than an exception from inside the merge.
          const missing = missingFirstVersionFields(prior, body);
          if (missing.length > 0) {
            throw ApiError.validationFailed(
              `A question's first version must supply ${missing.join(' and ')}.`,
              {
                details: {
                  fields: missing.map((field) => ({ field: `body/${field}`, rule: 'required' })),
                  first_version_fields: [...FIRST_VERSION_FIELDS],
                },
              },
            );
          }

          // Copy-forward. Everything the body did not name comes from `prior` unchanged,
          // which is what makes ADR-003's "every edit is a new version" affordable rather
          // than a reason to avoid editing (see @assaybank/db's version-content.ts).
          const content = mergeVersionContent(prior, body);

          const created = await createVersion(tx, id, content, {
            at: now(),
            createdBy: principal.userId,
          });

          entry.amend({
            entityId: created.id,
            ...(prior === undefined ? {} : { before: auditVersion(prior) }),
            after: auditVersion(created),
          });
          return created;
        },
      );

      void reply.code(201);
      return toAuthorVersionView(version);
    },
  );

  // --- GET /questions/:id/versions/:v ------------------------------------------
  app.get(
    QUESTION_VERSION_ROUTE,
    { config: read },
    async (request): Promise<AuthorQuestionVersionView> => {
      const principal = staffOnly(request);
      const { id, v } = parseRequestPart(QuestionVersionParamsSchema, request.params, 'params');

      const version = await withOrg(db, principal.orgId, async (tx) => {
        await requireQuestion(tx, id, { includeArchived: true });
        return requireVersion(tx, id, v);
      });

      return toAuthorVersionView(version);
    },
  );

  // --- PATCH /questions/:id/versions/:v ----------------------------------------
  //
  // ADR-003's front door. A draft version is editable in place; a published one is not,
  // and the refusal is `409 version_immutable` with a message that says where the edit
  // belongs. The database would refuse the write anyway — the triggers from migrations
  // 0001 and 0007 are the guarantee, and they bind the importer and a human at a psql
  // prompt as well as this handler — but it would refuse by aborting the transaction,
  // which a caller can only be told about as a 500. Checking first turns the invariant
  // from a wall into a signpost, which is the whole of what the roadmap asks this phase
  // to do with it.
  app.patch(
    QUESTION_VERSION_ROUTE,
    { config: write },
    async (request): Promise<AuthorQuestionVersionView> => {
      staffOnly(request); // Refused for a candidate principal before anything is read. `request.audited`
      // takes the organisation from the same principal, so this handler needs no other
      // reference to it.
      const { id, v } = parseRequestPart(QuestionVersionParamsSchema, request.params, 'params');
      const body = parseRequestPart(QuestionVersionInputSchema, request.body, 'body');

      const updated = await request.audited(
        { action: QUESTION_ACTIONS.versionUpdate, entityType: VERSION_ENTITY },
        async (tx, entry) => {
          await requireQuestion(tx, id, { forUpdate: true });
          const before = await requireVersion(tx, id, v, { forUpdate: true });

          if (before.published_at !== null) {
            throw ApiError.versionImmutable(undefined, {
              details: {
                version_no: before.version_no,
                published_at: before.published_at.toISOString(),
                // The remedy, in the envelope, because a client author reading this needs
                // to know the edit is possible and where it goes — not merely that this
                // request failed.
                create_version_at: QUESTION_VERSIONS_PATH,
              },
            });
          }

          // A patch over the version being edited, not over its predecessor: editing a
          // draft is changing what that draft says, and everything unnamed stays as this
          // draft already had it.
          const content = mergeVersionContent(before, body);

          const after = await updateVersion(tx, id, v, content);
          // Zero rows changed after a successful read under `FOR UPDATE` means the row was
          // published between the two, which the guard turned into a clean refusal rather
          // than a constraint violation.
          if (after === undefined) throw ApiError.versionImmutable();

          entry.amend({
            entityId: after.id,
            before: auditVersion(before),
            after: auditVersion(after),
          });
          return after;
        },
      );

      return toAuthorVersionView(updated);
    },
  );

  // --- POST /questions/:id/versions/:v/publish ---------------------------------
  app.post(
    QUESTION_VERSION_PUBLISH_ROUTE,
    { config: publish },
    async (request): Promise<AuthorQuestionVersionView> => {
      staffOnly(request); // Refused for a candidate principal before anything is read. `request.audited`
      // takes the organisation from the same principal, so this handler needs no other
      // reference to it.
      const { id, v } = parseRequestPart(QuestionVersionParamsSchema, request.params, 'params');

      const published = await request.audited(
        { action: QUESTION_ACTIONS.versionPublish, entityType: VERSION_ENTITY },
        async (tx, entry) => {
          const question = await requireQuestion(tx, id, { forUpdate: true });
          const before = await requireVersion(tx, id, v, { forUpdate: true });

          if (before.published_at !== null) {
            throw ApiError.conflict('This version is already published.', {
              details: {
                version_no: before.version_no,
                published_at: before.published_at.toISOString(),
              },
            });
          }

          // The question's own transition, decided before either write. From `review` this
          // is the first publication; from `published` it is a further version of a
          // question already in circulation and the status does not move. A draft nobody
          // reviewed, or a retired question, is refused here with a 409 — and refused
          // before `published_at` is stamped, so a rejected publish leaves no trace on the
          // version.
          const status = nextStatus(question, { type: 'publish' });

          const after = await publishVersion(tx, id, v, now());
          // Zero rows changed means a concurrent publish won the race. Answering 409
          // rather than re-stamping is the point: the other request's instant is the one
          // candidates will be graded against, and two publishes must not disagree about
          // when a version was frozen.
          if (after === undefined) throw ApiError.conflict('This version is already published.');

          if (status !== question.status) {
            const moved = await setQuestionStatus(tx, id, status);
            if (moved === undefined) throw ApiError.notFound();
          }

          entry.amend({
            entityId: after.id,
            before: { ...auditVersion(before), question_status: question.status },
            after: { ...auditVersion(after), question_status: status },
          });
          return after;
        },
      );

      return toAuthorVersionView(published);
    },
  );
}
