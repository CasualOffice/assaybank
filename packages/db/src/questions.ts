/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The question bank, as rows: reading questions and versions, and writing them.
 *
 * Every function here takes a {@link DbTransaction} and none takes a {@link Database}.
 * That is the same signature-level guarantee the audit writer and the settings reader
 * make, for the same reason: the only way to obtain a transaction is from inside
 * `withOrg`, so a bank read cannot happen outside an organisation's context and a bank
 * write cannot happen outside the transaction that records it in `audit_log`. There is
 * deliberately no convenience overload that takes the pool.
 *
 * ## What is here and what is not
 *
 * Here: which rows, in which order, under which lock, and how a row becomes a
 * {@link QuestionRecord}. Not here: whether a transition is legal, which is
 * `transitionQuestion` in `@assaybank/core-domain`, and what a caller may see, which is
 * `toAuthorView` / `toCandidateView` in `@assaybank/contracts`. This module can write any
 * status to any question; the API is what decides it may.
 *
 * The one rule that *is* here is copy-forward, in `./version-content.ts`, because it is
 * the defining behaviour of `createVersion` rather than a policy layered on top of it.
 *
 * ## Three defences on every read, in this order
 *
 * 1. **Row-level security.** `withOrg` sets `app.current_org` transaction-locally and the
 *    `questions` policy is `org_id = app_current_org()` (migration 0002, B.3). The child
 *    tables reach their organisation through it. A forgotten predicate returns zero rows
 *    rather than another tenant's question bank — which docs/14 calls the highest-value
 *    target in the system, because it contains every reference solution and every hidden
 *    test case an organisation owns.
 * 2. **The predicate.** The statements below still say `WHERE question_id = :id`. It is
 *    not the guarantee and does not pretend to be; it states which rows are meant and
 *    keeps the plan an index lookup.
 * 3. **The serialiser.** Nothing here returns a row. Every function returns a record type
 *    from `@assaybank/contracts`, built field by field, which the API then turns into one
 *    of two audience-typed views.
 *
 * ## ADR-003, and where it is actually enforced
 *
 * In the database. Migration 0001 refuses any `UPDATE` of a published `question_versions`
 * row and 0007 extends that to its options, spec, test cases and answer keys, because the
 * API is not the only writer — the importer and future migrations are too.
 *
 * What this module adds is that the application never provokes those exceptions. Every
 * write against a version carries `AND published_at IS NULL`, so a race with a concurrent
 * publish returns *zero rows changed* instead of aborting the transaction, and the caller
 * answers `409 version_immutable` rather than `500`. The guard is the polite path; the
 * trigger is the guarantee. Removing the guard would make the API rude, and removing the
 * trigger would make it wrong.
 */

import { and, asc, desc, eq, isNull, sql, type SQL } from 'drizzle-orm';

import {
  QuestionIdSchema,
  QuestionVersionIdSchema,
  SkillIdSchema,
  UserIdSchema,
  type ListQuestionsQuery,
  type QuestionId,
  type QuestionKind,
  type QuestionRecord,
  type QuestionStatus,
  type QuestionSummaryRecord,
  type QuestionVersionRecord,
  type SkillId,
  type UserId,
} from '@assaybank/contracts';

import { type DbTransaction } from './client.js';
import { decodeKeysetCursor, encodeKeysetCursor, type Keyset } from './cursor.js';
import {
  codingSpecs,
  mcqOptions,
  questionSkills,
  questionVersions,
  questions,
  shortAnswerKeys,
  testCases,
} from './schema/index.js';
import { type VersionContent } from './version-content.js';

// --- value coercion ----------------------------------------------------------
//
// postgres.js hands `numeric` back as a string, because a numeric is arbitrary precision
// and a JavaScript number is not. Scores and weights in this schema are `numeric(6,2)`
// and `numeric(4,2)` — four significant figures either side of a decimal point, far
// inside what a double represents exactly — so converting is safe here and would not be
// for a currency column. It is done at this boundary, once, so that nothing above it ever
// has to wonder whether `max_score` is `"10.00"` or `10`.

/** A `numeric` column as a number. */
function num(value: string | number | null, fallback: number): number {
  if (value === null) return fallback;
  const parsed = typeof value === 'number' ? value : Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** A nullable `numeric` column as a number or null. */
function numOrNull(value: string | number | null): number | null {
  if (value === null) return null;
  const parsed = typeof value === 'number' ? value : Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * PostgreSQL's `timestamptz` rendering, split into the pieces ISO 8601 wants rearranged.
 *
 * `2026-10-20 09:00:00.123456+00`, `2026-10-20 09:00:00+05:30` and `…+0530` all match; the
 * minutes of the offset are optional, which is the part `new Date` refuses.
 */
const PG_TIMESTAMP =
  /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d+)?)([+-]\d{2})(?::?(\d{2}))?$/u;

/**
 * A `timestamptz` as a `Date`, whichever shape the driver handed it over in.
 *
 * Drizzle's query builder maps a `timestamptz` column to a `Date`; a raw
 * {@link DbTransaction.execute} does not, and hands back PostgreSQL's own text rendering
 * instead. The list query below is raw SQL — it needs a `LATERAL` join — so its timestamps
 * arrive as strings while every other read in this module gets `Date` objects.
 *
 * The record type promises a `Date`, and a serialiser calling `.toISOString()` on a string
 * is a 500 that only happens on the one endpoint that took the raw path. So the coercion
 * is here, at the boundary, rather than being a rule two callers have to remember
 * differently.
 */
function toDate(value: Date | string | null): Date | null {
  if (value === null) return null;
  if (value instanceof Date) return value;

  // PostgreSQL renders a `timestamptz` as `2026-10-20 09:00:00.123456+00`, which is two
  // characters away from ISO 8601 and fails to parse in both of them: the separator is a
  // space rather than a `T`, and the zone offset has no minutes. `new Date` on that string
  // is `Invalid Date` in V8 — not a wrong instant, which would at least be visible, but a
  // `NaN` that only surfaces when somebody calls `.toISOString()` on it three layers up.
  const parts = PG_TIMESTAMP.exec(value);
  const iso =
    parts === null
      ? value
      : `${parts[1] ?? ''}T${parts[2] ?? ''}${parts[3] ?? ''}:${parts[4] ?? '00'}`;

  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** {@link toDate} for a `NOT NULL` column, which cannot legitimately be absent. */
function requireDate(value: Date | string | null, column: string): Date {
  const parsed = toDate(value);
  if (parsed === null) {
    throw new Error(`${column} came back from the database as something that is not an instant.`);
  }
  return parsed;
}

/** A nullable uuid column as a branded {@link UserId}, parsed rather than cast. */
function userIdOrNull(value: string | null): UserId | null {
  return value === null ? null : UserIdSchema.parse(value);
}

// --- reading a version -------------------------------------------------------

/** The `question_versions` columns this module reads. Named, never `select *`. */
const VERSION_COLUMNS = {
  id: questionVersions.id,
  questionId: questionVersions.questionId,
  versionNo: questionVersions.versionNo,
  locale: questionVersions.locale,
  promptMd: questionVersions.promptMd,
  explanationMd: questionVersions.explanationMd,
  difficulty: questionVersions.difficulty,
  estSeconds: questionVersions.estSeconds,
  maxScore: questionVersions.maxScore,
  negativeScore: questionVersions.negativeScore,
  publishedAt: questionVersions.publishedAt,
  createdBy: questionVersions.createdBy,
  createdAt: questionVersions.createdAt,
} as const;

/** One row of {@link VERSION_COLUMNS}, before its children are attached. */
type VersionRow = {
  id: string;
  questionId: string;
  versionNo: number;
  locale: string;
  promptMd: string;
  explanationMd: string | null;
  difficulty: number;
  estSeconds: number;
  maxScore: string;
  negativeScore: string;
  publishedAt: Date | string | null;
  createdBy: string | null;
  createdAt: Date | string;
};

/**
 * Attaches the four child collections to a version row.
 *
 * Four statements rather than one join, deliberately. A single query joining a version to
 * its options *and* its test cases *and* its answer keys is a cartesian product — twelve
 * hidden cases times four options is forty-eight rows to reassemble, and reassembling
 * them wrongly is a bug that only appears for questions that have several of both. The
 * version detail endpoint is not a hot path; correctness by construction is worth three
 * extra round trips on it.
 */
async function loadVersionChildren(
  tx: DbTransaction,
  versionId: string,
): Promise<Pick<QuestionVersionRecord, 'options' | 'coding_spec' | 'test_cases' | 'answer_keys'>> {
  const [options, spec, cases, keys] = await Promise.all([
    tx
      .select({
        id: mcqOptions.id,
        ordinal: mcqOptions.ordinal,
        bodyMd: mcqOptions.bodyMd,
        isCorrect: mcqOptions.isCorrect,
        scoreDelta: mcqOptions.scoreDelta,
        rationaleMd: mcqOptions.rationaleMd,
      })
      .from(mcqOptions)
      .where(eq(mcqOptions.questionVersionId, versionId))
      .orderBy(asc(mcqOptions.ordinal)),
    tx
      .select({
        allowedLanguages: codingSpecs.allowedLanguages,
        starterCode: codingSpecs.starterCode,
        solutionCode: codingSpecs.solutionCode,
        timeLimitMs: codingSpecs.timeLimitMs,
        memoryLimitKb: codingSpecs.memoryLimitKb,
        gradingMode: codingSpecs.gradingMode,
        checkerCode: codingSpecs.checkerCode,
        fixtureSql: codingSpecs.fixtureSql,
      })
      .from(codingSpecs)
      .where(eq(codingSpecs.questionVersionId, versionId))
      .limit(1),
    tx
      .select({
        id: testCases.id,
        ordinal: testCases.ordinal,
        label: testCases.label,
        stdin: testCases.stdin,
        expectedStdout: testCases.expectedStdout,
        args: testCases.args,
        assertionCode: testCases.assertionCode,
        isSample: testCases.isSample,
        weight: testCases.weight,
      })
      .from(testCases)
      .where(eq(testCases.questionVersionId, versionId))
      .orderBy(asc(testCases.ordinal)),
    tx
      .select({
        id: shortAnswerKeys.id,
        matchType: shortAnswerKeys.matchType,
        pattern: shortAnswerKeys.pattern,
        tolerance: shortAnswerKeys.tolerance,
        score: shortAnswerKeys.score,
      })
      .from(shortAnswerKeys)
      .where(eq(shortAnswerKeys.questionVersionId, versionId))
      // Authored order (0009); rows from before it have no ordinal and follow, by id, so the
      // order is total either way (invariant 3).
      .orderBy(sql`${shortAnswerKeys.ordinal} ASC NULLS LAST`, asc(shortAnswerKeys.id)),
  ]);

  const codingSpec = spec[0];

  return {
    options: options.map((option) => ({
      id: option.id,
      ordinal: option.ordinal,
      body_md: option.bodyMd,
      is_correct: option.isCorrect,
      score_delta: numOrNull(option.scoreDelta),
      rationale_md: option.rationaleMd,
    })),
    coding_spec:
      codingSpec === undefined
        ? null
        : {
            allowed_languages: codingSpec.allowedLanguages,
            starter_code: codingSpec.starterCode,
            solution_code: codingSpec.solutionCode,
            time_limit_ms: codingSpec.timeLimitMs,
            memory_limit_kb: codingSpec.memoryLimitKb,
            grading_mode: codingSpec.gradingMode,
            checker_code: codingSpec.checkerCode,
            fixture_sql: codingSpec.fixtureSql,
          },
    test_cases: cases.map((testCase) => ({
      id: testCase.id,
      ordinal: testCase.ordinal,
      label: testCase.label,
      stdin: testCase.stdin,
      expected_stdout: testCase.expectedStdout,
      args: testCase.args,
      assertion_code: testCase.assertionCode,
      is_sample: testCase.isSample,
      weight: num(testCase.weight, 1),
    })),
    answer_keys: keys.map((key) => ({
      id: key.id,
      match_type: key.matchType,
      pattern: key.pattern,
      tolerance: numOrNull(key.tolerance),
      score: num(key.score, 1),
    })),
  };
}

/** Builds the complete record for one version row. */
async function toVersionRecord(tx: DbTransaction, row: VersionRow): Promise<QuestionVersionRecord> {
  const children = await loadVersionChildren(tx, row.id);

  return {
    // Parsed rather than cast. The value came out of the database, which is an input like
    // any other (docs/17 §1) — and it is the id the *policy* admitted rather than the one
    // the caller asked for.
    id: QuestionVersionIdSchema.parse(row.id),
    question_id: QuestionIdSchema.parse(row.questionId),
    version_no: row.versionNo,
    locale: row.locale,
    prompt_md: row.promptMd,
    explanation_md: row.explanationMd,
    difficulty: row.difficulty,
    est_seconds: row.estSeconds,
    max_score: num(row.maxScore, 1),
    negative_score: num(row.negativeScore, 0),
    published_at: toDate(row.publishedAt),
    created_by: userIdOrNull(row.createdBy),
    created_at: requireDate(row.createdAt, 'question_versions.created_at'),
    ...children,
  };
}

/** How a version row is read: plainly, or with the lock a read-modify-write needs. */
export interface ReadVersionOptions {
  /** `true` on the publish and edit paths. See {@link publishVersion}. */
  readonly forUpdate?: boolean | undefined;
}

/**
 * One version of one question, addressed by `version_no`, or `undefined`.
 *
 * `version_no` rather than the version's uuid because that is what docs/03 §4 puts in the
 * path (`/questions/{id}/versions/{v}`), and because it is what an author says out loud:
 * "version 3 of that question", never a uuid. The pair is unique per locale by
 * constraint, so the address is unambiguous.
 */
export async function getVersion(
  tx: DbTransaction,
  questionId: QuestionId,
  versionNo: number,
  options: ReadVersionOptions = {},
): Promise<QuestionVersionRecord | undefined> {
  const query = tx
    .select(VERSION_COLUMNS)
    .from(questionVersions)
    .where(
      and(eq(questionVersions.questionId, questionId), eq(questionVersions.versionNo, versionNo)),
    )
    .limit(1);

  const [row] = await (options.forUpdate === true ? query.for('update') : query);
  return row === undefined ? undefined : toVersionRecord(tx, row);
}

/** The highest-numbered version of a question, whatever its state, or `undefined`. */
export async function getLatestVersion(
  tx: DbTransaction,
  questionId: QuestionId,
): Promise<QuestionVersionRecord | undefined> {
  const [row] = await tx
    .select(VERSION_COLUMNS)
    .from(questionVersions)
    .where(eq(questionVersions.questionId, questionId))
    .orderBy(desc(questionVersions.versionNo))
    .limit(1);

  return row === undefined ? undefined : toVersionRecord(tx, row);
}

// --- reading a question ------------------------------------------------------

/** The `questions` columns this module reads. */
const QUESTION_COLUMNS = {
  id: questions.id,
  kind: questions.kind,
  status: questions.status,
  currentVersionId: questions.currentVersionId,
  externalRef: questions.externalRef,
  sourceLicense: questions.sourceLicense,
  authorId: questions.authorId,
  exposureCount: questions.exposureCount,
  archivedAt: questions.archivedAt,
  createdAt: questions.createdAt,
} as const;

type QuestionRow = {
  id: string;
  kind: QuestionKind;
  status: QuestionStatus;
  currentVersionId: string | null;
  externalRef: string | null;
  sourceLicense: string | null;
  authorId: string | null;
  exposureCount: number;
  archivedAt: Date | string | null;
  createdAt: Date | string;
};

/** What a question measures (ADR-009), ordered so two reads of one question agree. */
async function loadSkills(
  tx: DbTransaction,
  questionId: string,
): Promise<QuestionRecord['skills']> {
  const rows = await tx
    .select({ skillId: questionSkills.skillId, weight: questionSkills.weight })
    .from(questionSkills)
    .where(eq(questionSkills.questionId, questionId))
    .orderBy(asc(questionSkills.skillId));

  return rows.map((row) => ({
    skill_id: SkillIdSchema.parse(row.skillId),
    weight: num(row.weight, 1),
  }));
}

/** Builds the complete record for one question row, expanding its current version. */
async function toQuestionRecord(tx: DbTransaction, row: QuestionRow): Promise<QuestionRecord> {
  const [skills, currentVersion] = await Promise.all([
    loadSkills(tx, row.id),
    row.currentVersionId === null
      ? Promise.resolve(undefined)
      : tx
          .select(VERSION_COLUMNS)
          .from(questionVersions)
          .where(eq(questionVersions.id, row.currentVersionId))
          .limit(1)
          .then(async (rows) => {
            const version = rows[0];
            return version === undefined ? undefined : toVersionRecord(tx, version);
          }),
  ]);

  return {
    id: QuestionIdSchema.parse(row.id),
    kind: row.kind,
    status: row.status,
    external_ref: row.externalRef,
    source_license: row.sourceLicense,
    author_id: userIdOrNull(row.authorId),
    exposure_count: row.exposureCount,
    archived_at: toDate(row.archivedAt),
    created_at: requireDate(row.createdAt, 'questions.created_at'),
    skills,
    current_version: currentVersion ?? null,
  };
}

/** How a question row is read. */
export interface ReadQuestionOptions {
  /** `true` on every write path: a lifecycle change is a read-modify-write. */
  readonly forUpdate?: boolean | undefined;
  /** `true` to admit a soft-deleted question. The default hides one, as a delete should. */
  readonly includeArchived?: boolean | undefined;
}

/**
 * One question with its current version expanded — `GET /questions/{id}` (docs/03 §4).
 *
 * `undefined` rather than a thrown error, because the caller decides what absence means —
 * and on every endpoint here it means `not_found`, never `forbidden`. A `403` would
 * confirm that some other organisation holds the id, which is a cross-tenant disclosure
 * made of nothing but a status code (ADR-010, docs/14 `H-154`).
 *
 * "Current version" is the most recently *published* one, and it is null until a question
 * has one. `publishVersion` is the only thing that moves the pointer, which is what stops
 * a draft from ever being the version an assessment draws.
 */
export async function getQuestionWithCurrentVersion(
  tx: DbTransaction,
  questionId: QuestionId,
  options: ReadQuestionOptions = {},
): Promise<QuestionRecord | undefined> {
  const predicate =
    options.includeArchived === true
      ? eq(questions.id, questionId)
      : and(eq(questions.id, questionId), isNull(questions.archivedAt));

  const query = tx.select(QUESTION_COLUMNS).from(questions).where(predicate).limit(1);

  const [row] = await (options.forUpdate === true ? query.for('update') : query);
  return row === undefined ? undefined : toQuestionRecord(tx, row);
}

// --- listing -----------------------------------------------------------------

/** One page of a cursor-paginated list. */
export interface Page<T> {
  readonly rows: readonly T[];
  /** The cursor for the next page, or `null` when this is the last one. */
  readonly nextCursor: string | null;
}

/**
 * Escapes a user-supplied search term for `ILIKE`.
 *
 * `%` and `_` are wildcards, so `?q=100%` without this would match every prompt beginning
 * `100`, and `?q=%` would match the entire bank — an unbounded-cost query from a
 * four-character request (docs/17 §10). The backslash must be escaped first, or it would
 * escape the escapes.
 */
function escapeLike(term: string): string {
  return term.replace(/\\/gu, '\\\\').replace(/%/gu, '\\%').replace(/_/gu, '\\_');
}

/** One row of the list query, as PostgreSQL returns it. */
interface SummaryRow extends Record<string, unknown> {
  id: string;
  kind: QuestionKind;
  status: QuestionStatus;
  external_ref: string | null;
  source_license: string | null;
  exposure_count: number;
  /** Text, not a `Date`: this row comes from a raw `execute`. See {@link toDate}. */
  archived_at: Date | string | null;
  created_at: Date | string;
  /** The sort key at full precision, for the cursor. See `./cursor.ts`. */
  cursor_at: string;
  current_version_id: string | null;
  current_published_at: Date | string | null;
  latest_version_no: number | null;
  latest_difficulty: number | null;
  latest_prompt_md: string | null;
}

/**
 * A page of the question bank — `GET /questions` (docs/03 §4).
 *
 * ## Why this one is raw SQL
 *
 * Because it is a lateral join and two correlated `EXISTS` clauses, and the query builder
 * spelling of that is longer than the SQL and harder to read than the SQL. Every value is
 * a bound parameter — `sql` interpolation parameterises, it does not concatenate — so
 * docs/17 §7's "no string interpolation into SQL, ever" is satisfied by construction, and
 * the one place a literal *is* built (`escapeLike`) builds a `text` value that is then
 * itself bound.
 *
 * ## What the lateral join is for
 *
 * A bank list has to show something for a question somebody is still writing, and
 * `current_version_id` is null until the first publish. So the display columns come from
 * the latest version of any state, through a `LATERAL` that stops at one row, while
 * `current_version_id` and `current_published_at` describe the published one. The column
 * names carry the `latest_`/`current_` prefix so no reader has to work out which is which.
 *
 * ## The filters
 *
 * `kind`, `status` and `exposure_gt` are columns of `questions`. `difficulty` is the
 * latest version's, which is the number this list displays. `q` is an `EXISTS` over *any*
 * version of the question, because "find the one about balanced parentheses" should find
 * it whether that phrase is in version 1 or version 4, and because that spelling is what
 * uses the trigram index 0001 built over `prompt_md`. `skill_id` is an `EXISTS` over
 * `question_skills`, which is how ADR-009's indirection is actually queried.
 */
/**
 * One licence and dataset the bank holds content under, with how much of it.
 *
 * The same shape an export's header carries, computed over the live bank instead of over one
 * file — so the console can show the obligation without exporting first.
 */
export interface AttributionRecord {
  readonly source_license: string;
  /** The dataset, from the part of `external_ref` before the first `/`. Null when there is none. */
  readonly dataset: string | null;
  readonly questions: number;
  readonly published: number;
}

/**
 * What this organisation's bank owes credit for (`H-032`, docs/05 §2).
 *
 * CC-BY-4.0 requires attribution "in any reasonable manner", and for a hiring platform docs/05
 * §2 makes that concrete: an attributions page in the console and the credit preserved in every
 * export. The export half has existed since the interchange formats; this is the other half.
 *
 * `proprietary` is excluded, because a question written in-house is not somebody else's work to
 * credit — and the count of what remains is the metric docs/05 §2 asks teams to watch, since
 * imported content should be the minority of a published bank by month six.
 *
 * Archived questions are counted. An archived question is hidden from browsing, not deleted,
 * and the licence obligation follows the copy rather than its visibility.
 */
export async function listAttributions(tx: DbTransaction): Promise<AttributionRecord[]> {
  const rows = await tx.execute<{
    source_license: string;
    dataset: string | null;
    questions: string | number;
    published: string | number;
  }>(sql`
    SELECT
      q.source_license                                          AS source_license,
      NULLIF(split_part(COALESCE(q.external_ref, ''), '/', 1), '') AS dataset,
      count(*)                                                  AS questions,
      count(*) FILTER (WHERE q.status = 'published')            AS published
    FROM questions q
    WHERE q.source_license IS NOT NULL
      AND q.source_license <> 'proprietary'
    GROUP BY 1, 2
    ORDER BY 1, 2 NULLS FIRST
  `);

  return [...rows].map((row) => ({
    source_license: row.source_license,
    dataset: row.dataset,
    questions: Number(row.questions),
    published: Number(row.published),
  }));
}

export async function listQuestions(
  tx: DbTransaction,
  query: ListQuestionsQuery,
): Promise<Page<QuestionSummaryRecord>> {
  const keyset: Keyset | undefined =
    query.cursor === undefined ? undefined : decodeKeysetCursor(query.cursor);

  // One more than asked for, so "is there a next page" is answered by the query rather
  // than by a second `count(*)` over the same predicate.
  const limit = query.limit;
  const fetch = limit + 1;

  const conditions: SQL[] = [];

  if (query.include_archived !== true) {
    conditions.push(sql`q.archived_at IS NULL`);
  }
  if (query.kind !== undefined) {
    conditions.push(sql`q.kind = ${query.kind}::question_kind`);
  }
  if (query.status !== undefined) {
    conditions.push(sql`q.status = ${query.status}::question_status`);
  }
  if (query.exposure_gt !== undefined) {
    conditions.push(sql`q.exposure_count > ${query.exposure_gt}`);
  }
  if (query.difficulty !== undefined) {
    conditions.push(sql`latest.difficulty = ${query.difficulty}`);
  }
  if (query.skill_id !== undefined) {
    conditions.push(
      sql`EXISTS (
            SELECT 1 FROM question_skills qs
             WHERE qs.question_id = q.id AND qs.skill_id = ${query.skill_id}::uuid
          )`,
    );
  }
  if (query.q !== undefined) {
    const term = `%${escapeLike(query.q)}%`;
    conditions.push(
      sql`EXISTS (
            SELECT 1 FROM question_versions qv
             WHERE qv.question_id = q.id AND qv.prompt_md ILIKE ${term} ESCAPE '\\'
          )`,
    );
  }
  if (keyset !== undefined) {
    // A row comparison, not two predicates joined by OR: `(a, b) < (x, y)` is one
    // operation the planner can drive straight off the composite index 0007 builds.
    conditions.push(sql`(q.created_at, q.id) < (${keyset.at}::timestamptz, ${keyset.id}::uuid)`);
  }

  const where =
    conditions.length === 0
      ? sql`TRUE`
      : sql.join(
          conditions.map((condition) => sql`(${condition})`),
          sql` AND `,
        );

  const rows = await tx.execute<SummaryRow>(sql`
    SELECT q.id,
           q.kind,
           q.status,
           q.external_ref,
           q.source_license,
           q.exposure_count,
           q.archived_at,
           q.created_at,
           q.created_at::text          AS cursor_at,
           q.current_version_id,
           current_version.published_at AS current_published_at,
           latest.version_no            AS latest_version_no,
           latest.difficulty            AS latest_difficulty,
           latest.prompt_md             AS latest_prompt_md
      FROM questions q
      LEFT JOIN question_versions current_version
             ON current_version.id = q.current_version_id
      LEFT JOIN LATERAL (
             SELECT qv.version_no, qv.difficulty, qv.prompt_md
               FROM question_versions qv
              WHERE qv.question_id = q.id
              ORDER BY qv.version_no DESC
              LIMIT 1
           ) latest ON TRUE
     WHERE ${where}
     ORDER BY q.created_at DESC, q.id DESC
     LIMIT ${fetch}
  `);

  const page = rows.slice(0, limit);
  const last = page.at(-1);
  const hasMore = rows.length > limit;

  return {
    rows: page.map((row): QuestionSummaryRecord => ({
      id: QuestionIdSchema.parse(row.id),
      kind: row.kind,
      status: row.status,
      external_ref: row.external_ref,
      source_license: row.source_license,
      exposure_count: row.exposure_count,
      archived_at: toDate(row.archived_at),
      created_at: requireDate(row.created_at, 'questions.created_at'),
      current_version_id:
        row.current_version_id === null
          ? null
          : QuestionVersionIdSchema.parse(row.current_version_id),
      current_published_at: toDate(row.current_published_at),
      latest_version_no: row.latest_version_no,
      latest_difficulty: row.latest_difficulty,
      latest_prompt_md: row.latest_prompt_md,
    })),
    nextCursor:
      hasMore && last !== undefined
        ? encodeKeysetCursor({ at: last.cursor_at, id: last.id })
        : null,
  };
}

/**
 * One page of `GET /questions/{id}/versions`, newest first.
 *
 * The query builder rather than raw SQL, unlike {@link listQuestions}: there is no lateral
 * join to express here, and the builder maps a `timestamptz` column to a `Date` where a
 * raw `execute` hands back PostgreSQL's text rendering. The one raw fragment is the cursor
 * key, which *wants* to be text at full precision (see `./cursor.ts`).
 */
export async function listVersions(
  tx: DbTransaction,
  questionId: QuestionId,
  page: { readonly limit: number; readonly cursor?: string | undefined },
): Promise<Page<QuestionVersionRecord>> {
  const keyset = page.cursor === undefined ? undefined : decodeKeysetCursor(page.cursor);

  const predicate =
    keyset === undefined
      ? eq(questionVersions.questionId, questionId)
      : and(
          eq(questionVersions.questionId, questionId),
          // A row comparison rather than two predicates joined by OR: one operation the
          // planner can drive straight off the ordering index.
          sql`(${questionVersions.createdAt}, ${questionVersions.id}) < (${keyset.at}::timestamptz, ${keyset.id}::uuid)`,
        );

  const rows = await tx
    .select({
      ...VERSION_COLUMNS,
      cursorAt: sql<string>`${questionVersions.createdAt}::text`,
    })
    .from(questionVersions)
    .where(predicate)
    .orderBy(desc(questionVersions.createdAt), desc(questionVersions.id))
    .limit(page.limit + 1);

  const window = rows.slice(0, page.limit);
  const last = window.at(-1);

  return {
    rows: await Promise.all(window.map(async (row) => toVersionRecord(tx, row))),
    nextCursor:
      rows.length > page.limit && last !== undefined
        ? encodeKeysetCursor({ at: last.cursorAt, id: last.id })
        : null,
  };
}

// --- writing -----------------------------------------------------------------

/** What `POST /questions` supplies beyond the organisation and the author. */
export interface CreateQuestionInput {
  readonly orgId: string;
  readonly kind: QuestionKind;
  readonly authorId?: UserId | undefined;
  readonly sourceLicense?: string | undefined;
  readonly externalRef?: string | undefined;
}

/**
 * Creates an empty question in `draft`, and returns it.
 *
 * Empty is deliberate: content arrives as the question's first version, through the same
 * endpoint an edit uses. An authoring flow whose first save is special is an authoring
 * flow with two code paths through ADR-003, and the second one is the one that will get
 * the invariant wrong.
 *
 * `org_id` is passed even though row-level security would supply the tenant on read: it
 * is a `NOT NULL` column and the policy's `WITH CHECK` requires the inserted row to
 * belong to the current organisation, so a mismatched value is refused by the database
 * rather than stored.
 */
export async function createQuestion(
  tx: DbTransaction,
  input: CreateQuestionInput,
): Promise<QuestionRecord> {
  const [row] = await tx
    .insert(questions)
    .values({
      orgId: input.orgId,
      kind: input.kind,
      status: 'draft',
      ...(input.authorId === undefined ? {} : { authorId: input.authorId }),
      ...(input.sourceLicense === undefined ? {} : { sourceLicense: input.sourceLicense }),
      ...(input.externalRef === undefined ? {} : { externalRef: input.externalRef }),
    })
    .returning(QUESTION_COLUMNS);

  if (row === undefined) {
    throw new Error('INSERT INTO questions returned no row; the transaction cannot continue.');
  }
  return toQuestionRecord(tx, row);
}

/** Who created a version, and when. Both from the caller — never from the wall clock. */
export interface VersionAuthorship {
  readonly createdBy?: UserId | undefined;
  /** ADR-006: the server owns the clock, and this is the instant it chose. */
  readonly at: Date;
}

/** Writes the four child collections of a freshly inserted version. */
async function writeVersionChildren(
  tx: DbTransaction,
  versionId: string,
  content: VersionContent,
): Promise<void> {
  if (content.options.length > 0) {
    await tx.insert(mcqOptions).values(
      content.options.map((option, index) => ({
        questionVersionId: versionId,
        // The array order is the ordinal. An author reordering options is expressing an
        // order, and `ordinal` is the column that carries it; the *served* order is the
        // attempt's own shuffle and is not this (FR-7, ADR-004).
        ordinal: index + 1,
        bodyMd: option.bodyMd,
        isCorrect: option.isCorrect,
        scoreDelta: option.scoreDelta === null ? null : option.scoreDelta.toFixed(2),
        rationaleMd: option.rationaleMd,
      })),
    );
  }

  if (content.codingSpec !== null) {
    await tx.insert(codingSpecs).values({
      questionVersionId: versionId,
      allowedLanguages: [...content.codingSpec.allowedLanguages],
      starterCode: { ...content.codingSpec.starterCode },
      solutionCode: { ...content.codingSpec.solutionCode },
      timeLimitMs: content.codingSpec.timeLimitMs,
      memoryLimitKb: content.codingSpec.memoryLimitKb,
      gradingMode: content.codingSpec.gradingMode,
      checkerCode: content.codingSpec.checkerCode,
      fixtureSql: content.codingSpec.fixtureSql,
    });
  }

  if (content.testCases.length > 0) {
    await tx.insert(testCases).values(
      content.testCases.map((testCase, index) => ({
        questionVersionId: versionId,
        ordinal: index + 1,
        label: testCase.label,
        stdin: testCase.stdin,
        expectedStdout: testCase.expectedStdout,
        args: testCase.args === null ? null : [...testCase.args],
        assertionCode: testCase.assertionCode,
        isSample: testCase.isSample,
        weight: testCase.weight.toFixed(2),
      })),
    );
  }

  if (content.answerKeys.length > 0) {
    await tx.insert(shortAnswerKeys).values(
      content.answerKeys.map((key, ordinal) => ({
        questionVersionId: versionId,
        ordinal,
        matchType: key.matchType,
        pattern: key.pattern,
        // Exactly, not `toFixed`: the column is unbounded `numeric`, and fixing four places
        // turned a tolerance of 0.00001 into 0 — a key that only an exact answer could match.
        tolerance: key.tolerance === null ? null : String(key.tolerance),
        score: key.score.toFixed(2),
      })),
    );
  }
}

/**
 * Appends a new version to a question, and returns it.
 *
 * `content` is the *result* of the copy-forward merge (`./version-content.ts`), so this
 * function writes what it is given and decides nothing about what was inherited. The
 * separation is what lets the copy-forward rule be tested exhaustively with no database.
 *
 * ### What it does not do
 *
 * It does not move `questions.current_version_id`. A new version is a draft, and a draft
 * is not the version an assessment draws — {@link publishVersion} is the only thing that
 * moves the pointer, which makes "a candidate was served an unpublished version"
 * unreachable rather than merely unlikely.
 *
 * It does not change the question's status either. Whether writing a version should move
 * a question out of `review` is a lifecycle question, and lifecycle questions are
 * `transitionQuestion`'s (`@assaybank/core-domain`), applied by the API.
 *
 * ### Version numbering
 *
 * `max(version_no) + 1` over the whole question, read under the row lock the caller is
 * expected to be holding on the `questions` row. Per question rather than per locale:
 * `locale` records the language a version was *authored* in and is never a translation
 * (a translation is its own row in a future table, ADR-018), so two locales of one
 * question are two independent authorings and numbering them in one sequence keeps
 * "version 4" unambiguous in a sentence.
 */
export async function createVersion(
  tx: DbTransaction,
  questionId: QuestionId,
  content: VersionContent,
  authorship: VersionAuthorship,
): Promise<QuestionVersionRecord> {
  const [highest] = await tx
    .select({ versionNo: questionVersions.versionNo })
    .from(questionVersions)
    .where(eq(questionVersions.questionId, questionId))
    .orderBy(desc(questionVersions.versionNo))
    .limit(1);

  const versionNo = (highest?.versionNo ?? 0) + 1;

  const [row] = await tx
    .insert(questionVersions)
    .values({
      questionId,
      versionNo,
      locale: content.locale,
      promptMd: content.promptMd,
      explanationMd: content.explanationMd,
      difficulty: content.difficulty,
      estSeconds: content.estSeconds,
      maxScore: content.maxScore.toFixed(2),
      negativeScore: content.negativeScore.toFixed(2),
      createdAt: authorship.at,
      ...(authorship.createdBy === undefined ? {} : { createdBy: authorship.createdBy }),
    })
    .returning(VERSION_COLUMNS);

  if (row === undefined) {
    throw new Error('INSERT INTO question_versions returned no row.');
  }

  await writeVersionChildren(tx, row.id, content);
  return toVersionRecord(tx, row);
}

/**
 * Replaces the content of an *unpublished* version in place, and returns it.
 *
 * The editing path for a draft, which is the only version a `PATCH` may touch (ADR-003).
 * Returns `undefined` when no unpublished version with that number exists — either
 * because there is no such version, or because it has been published, including by a
 * concurrent request between the caller's read and this write. The caller distinguishes
 * the two by what its own read found, and answers `404` or `409 version_immutable`.
 *
 * Every statement carries `AND published_at IS NULL`. The database would refuse the write
 * anyway — the triggers from migrations 0001 and 0007 are the guarantee — but it would
 * refuse it by aborting the transaction, which the caller can only report as a `500`. The
 * guard turns that into zero rows changed and a `409` that says what happened.
 *
 * Children are deleted and rewritten rather than diffed. An option belongs to exactly one
 * version and carries no identity a client can name, so there is nothing to diff against;
 * "replace the collection" is both the simplest implementation and the documented
 * contract of the endpoint.
 */
export async function updateVersion(
  tx: DbTransaction,
  questionId: QuestionId,
  versionNo: number,
  content: VersionContent,
): Promise<QuestionVersionRecord | undefined> {
  const [row] = await tx
    .update(questionVersions)
    .set({
      locale: content.locale,
      promptMd: content.promptMd,
      explanationMd: content.explanationMd,
      difficulty: content.difficulty,
      estSeconds: content.estSeconds,
      maxScore: content.maxScore.toFixed(2),
      negativeScore: content.negativeScore.toFixed(2),
    })
    .where(
      and(
        eq(questionVersions.questionId, questionId),
        eq(questionVersions.versionNo, versionNo),
        isNull(questionVersions.publishedAt),
      ),
    )
    .returning(VERSION_COLUMNS);

  if (row === undefined) return undefined;

  await Promise.all([
    tx.delete(mcqOptions).where(eq(mcqOptions.questionVersionId, row.id)),
    tx.delete(codingSpecs).where(eq(codingSpecs.questionVersionId, row.id)),
    tx.delete(testCases).where(eq(testCases.questionVersionId, row.id)),
    tx.delete(shortAnswerKeys).where(eq(shortAnswerKeys.questionVersionId, row.id)),
  ]);

  await writeVersionChildren(tx, row.id, content);
  return toVersionRecord(tx, row);
}

/**
 * Freezes a version and makes it the question's current one — `POST …/publish`.
 *
 * Irreversible, and the whole of ADR-003's teeth. Two writes in one transaction:
 * `published_at` is set from the injected instant, and `questions.current_version_id` is
 * pointed at the row. After the first of those the database will refuse every further
 * `UPDATE` of that version and of its options, spec, test cases and answer keys.
 *
 * `AND published_at IS NULL` makes the write idempotent-safe under a race: the second of
 * two concurrent publishes changes zero rows and gets `undefined` back, rather than
 * silently re-stamping a different instant onto a version somebody has already been
 * graded against. The caller answers `409`.
 *
 * It does not move the question's status. That is `transitionQuestion`'s decision, applied
 * by the API in the same transaction — the two are separate because publishing a *second*
 * version of an already-published question must not be a status change at all.
 */
export async function publishVersion(
  tx: DbTransaction,
  questionId: QuestionId,
  versionNo: number,
  at: Date,
): Promise<QuestionVersionRecord | undefined> {
  const [row] = await tx
    .update(questionVersions)
    .set({ publishedAt: at })
    .where(
      and(
        eq(questionVersions.questionId, questionId),
        eq(questionVersions.versionNo, versionNo),
        isNull(questionVersions.publishedAt),
      ),
    )
    .returning(VERSION_COLUMNS);

  if (row === undefined) return undefined;

  await tx.update(questions).set({ currentVersionId: row.id }).where(eq(questions.id, questionId));

  return toVersionRecord(tx, row);
}

/**
 * Writes a question's lifecycle status.
 *
 * Takes the status the caller has already decided on, and decides nothing itself: whether
 * `review → published` is legal is `transitionQuestion`'s question, and answering it here
 * as well would be answering it twice and eventually differently. This is the write.
 *
 * Returns `undefined` when the question does not exist or is archived, which the caller
 * reports as `not_found`.
 */
export async function setQuestionStatus(
  tx: DbTransaction,
  questionId: QuestionId,
  status: QuestionStatus,
): Promise<QuestionRecord | undefined> {
  const [row] = await tx
    .update(questions)
    .set({ status })
    .where(and(eq(questions.id, questionId), isNull(questions.archivedAt)))
    .returning(QUESTION_COLUMNS);

  return row === undefined ? undefined : toQuestionRecord(tx, row);
}

/**
 * Withdraws a question from circulation — FR-4's end state.
 *
 * Nothing is deleted. Every version survives, every attempt that referenced one keeps
 * referencing it, and every score stays explainable; the question simply stops being
 * drawable, because `isServableStatus` admits `published` and nothing else. That is the
 * whole difference between retiring an item and losing the ability to defend a hiring
 * decision made with it.
 *
 * A thin wrapper over {@link setQuestionStatus}, and worth being one: `retireQuestion` is
 * the name the exposure-threshold job and the console both reach for, and a name is what
 * makes "who retires questions, and why" greppable.
 */
export async function retireQuestion(
  tx: DbTransaction,
  questionId: QuestionId,
): Promise<QuestionRecord | undefined> {
  return setQuestionStatus(tx, questionId, 'retired');
}

/**
 * Soft-deletes a question by stamping `archived_at` — `DELETE /questions/{id}`.
 *
 * A soft delete because a hard one is unavailable on principle: `attempt_questions`
 * references versions of this question, and removing the row would unexplain every score
 * it ever produced (ADR-003). The row stays, drops out of the default list, and can be
 * restored — the one kind of deletion this table supports.
 *
 * Distinct from retirement, and orthogonal to it. Retiring says "this was in circulation
 * and now is not"; archiving says "stop showing me this". A draft that turned out to be a
 * duplicate is archived, never retired.
 *
 * The instant comes from the caller's clock (ADR-006), never from `now()` in SQL, so a
 * test can assert on it and so a retention clock cannot be set by a request body.
 *
 * `IS NULL` in the predicate makes it idempotent in the way that matters: archiving an
 * already-archived question changes nothing and returns `undefined`, so a double-click
 * cannot move the timestamp forward and restart a retention clock.
 */
export async function archiveQuestion(
  tx: DbTransaction,
  questionId: QuestionId,
  at: Date,
): Promise<QuestionRecord | undefined> {
  const [row] = await tx
    .update(questions)
    .set({ archivedAt: at })
    .where(and(eq(questions.id, questionId), isNull(questions.archivedAt)))
    .returning(QUESTION_COLUMNS);

  return row === undefined ? undefined : toQuestionRecord(tx, row);
}

/** Restores a soft-deleted question. The inverse of {@link archiveQuestion}. */
export async function restoreQuestion(
  tx: DbTransaction,
  questionId: QuestionId,
): Promise<QuestionRecord | undefined> {
  const [row] = await tx
    .update(questions)
    .set({ archivedAt: null })
    .where(eq(questions.id, questionId))
    .returning(QUESTION_COLUMNS);

  return row === undefined ? undefined : toQuestionRecord(tx, row);
}

/**
 * Replaces the skills a question measures — `PUT /questions/{id}/skills` (docs/03 §4).
 *
 * Wholesale, matching the endpoint's `PUT`: the array the caller sends is the complete
 * set afterwards. Tagging is on the *question* rather than on a version, per ADR-009 and
 * the schema — what a question measures does not change when its prompt is reworded, and
 * a per-version tag would make the coverage report depend on which version you asked
 * about.
 */
export async function setQuestionSkills(
  tx: DbTransaction,
  questionId: QuestionId,
  skills: readonly { readonly skillId: SkillId; readonly weight: number }[],
): Promise<void> {
  await tx.delete(questionSkills).where(eq(questionSkills.questionId, questionId));

  if (skills.length === 0) return;

  await tx.insert(questionSkills).values(
    skills.map((skill) => ({
      questionId,
      skillId: skill.skillId,
      weight: skill.weight.toFixed(2),
    })),
  );
}
