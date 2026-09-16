/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The question bank contract — docs/03-API-spec.md §4, and the serialisation boundary
 * that P2 exists to establish.
 *
 * Three things live here and the third is the one that matters.
 *
 * **The vocabulary.** `question_kind` and `question_status` as zod enums, difficulty
 * bounds, the request schemas for the seven endpoints in docs/03 §4. Written once, so an
 * author's console, the importer and the assessment composer cannot disagree about what
 * a difficulty is.
 *
 * **The record.** {@link QuestionRecord} and {@link QuestionVersionRecord} are the
 * *complete* author-side truth as the database holds it: every option with its
 * `is_correct`, the coding spec with its reference solution, every test case including
 * the hidden ones, every short-answer key. It is deliberately not a response type. It
 * carries `Date` objects and plain numbers — the shapes a driver returns — and nothing in
 * this package ever serves one. `packages/db` builds it; the two serialisers below
 * consume it.
 *
 * **The two views, which are different types.** docs/17 §3:
 *
 * > Candidate-facing and staff-facing serialisers for the same entity are different
 * > types, not the same type with a flag. A boolean parameter deciding whether to include
 * > answer keys will eventually be passed wrong; two types cannot be.
 *
 * {@link AuthorQuestionView} is everything. {@link CandidateQuestionView} is what a
 * candidate may see. There is no third type with a flag, no `options?: { is_correct?: … }`
 * that happens to be absent at runtime, and no function that takes an audience parameter.
 * {@link toAuthorView} and {@link toCandidateView} have different return types and neither
 * can produce the other's.
 *
 * And the candidate type is checked rather than trusted: `./audience.ts` carries a
 * compile-time predicate over the field names that belong to an answer key, and the
 * `Satisfied<IsCandidateSafe<…>>` declarations below fail the build the moment one of
 * them appears in a candidate view — including by being nested there inside a type
 * somebody reused from the author side, which is how it would actually happen.
 *
 * ## What a candidate is *not* sent, and why each is a decision
 *
 * - **No `explanation_md`.** It is the worked answer, written for the review screen after
 *   an attempt is over. A question carrying its own explanation is an answer key.
 * - **No test-case rows at all — not even the samples.** The obvious design serves
 *   `is_sample = true` rows with their `stdin` and their `expected_stdout` and filters the
 *   rest. This one serves neither, because it does not have to: FR-11 runs a candidate's
 *   code against the sample cases *on the server* and returns pass or fail, so the client
 *   never needs the inputs, and worked examples belong in `prompt_md`, where an author
 *   writes them on purpose. The consequence is worth the restriction —
 *   {@link CandidateCodingQuestion} is structurally incapable of carrying test-case
 *   content, so the guarantee does not depend on a `.filter()` anybody could widen.
 *   Counts are served instead, because "3 sample cases, 12 hidden" is what the runner has
 *   to render.
 * - **No `difficulty`.** Calibration metadata. Telling a candidate a question is rated 5
 *   changes how they answer it, which is a psychometric problem before it is a fairness
 *   one.
 * - **No question id, only a version id.** ADR-003: an attempt references a version,
 *   never a question. Serving the stable identity would let a candidate correlate two
 *   sittings of the same item across a re-version.
 * - **`max_score` and `negative_score` are served.** A candidate deciding whether to
 *   guess must know whether a wrong answer costs them. Withholding it is not security.
 *
 * Nothing here performs I/O or reads a clock.
 */

import './openapi-extension.js';

import { z } from 'zod';

import { type IsCandidateSafe, type Satisfied } from './audience.js';
import {
  QuestionIdSchema,
  QuestionVersionIdSchema,
  SkillIdSchema,
  UserIdSchema,
  type QuestionId,
  type QuestionVersionId,
  type SkillId,
  type UserId,
} from './ids.js';
import {
  PaginationQuerySchema,
  Rfc3339Schema,
  UuidSchema,
  paginated,
  type Uuid,
} from './primitives.js';

// --- paths -------------------------------------------------------------------

/**
 * The collection path, relative to `/api/v1`. Exported so the route, the generated
 * document and the tests cannot drift apart over a string.
 */
export const QUESTIONS_PATH = '/questions';

/** One question. `{id}` is Fastify's `:id` in the route and OpenAPI's `{id}` here. */
export const QUESTION_PATH = '/questions/{id}';

/** The version collection of one question. */
export const QUESTION_VERSIONS_PATH = '/questions/{id}/versions';

/** One version of one question, addressed by its `version_no` rather than its uuid. */
export const QUESTION_VERSION_PATH = '/questions/{id}/versions/{v}';

/** Publishing one version — a distinct action requiring `question.publish`. */
export const QUESTION_VERSION_PUBLISH_PATH = '/questions/{id}/versions/{v}/publish';

/** `POST` — run code against a question's sample cases. */
export const QUESTION_PREVIEW_PATH = '/questions/{id}/preview';

// --- vocabulary --------------------------------------------------------------

/**
 * `question_kind` from docs/hiring_platform_schema.sql §4, in the order the enum
 * declares them.
 *
 * The single source of truth for the union: `@assaybank/core-domain` re-exports this
 * rather than restating it, because a draw rule filtering on a kind the bank cannot hold
 * is a bug nobody would find until an assessment failed to compose.
 */
export const QUESTION_KINDS = [
  'mcq_single',
  'mcq_multi',
  'true_false',
  'short_answer',
  'coding',
  'sql',
  'subjective',
  'system_design',
] as const;

/** What kind of thing a question is, which determines how it is answered and graded. */
export const QuestionKindSchema = z
  .enum(QUESTION_KINDS)
  .describe('What kind of thing a question is, which determines how it is answered.')
  .openapi('QuestionKind');

/** What kind of thing a question is. */
export type QuestionKind = z.infer<typeof QuestionKindSchema>;

/** The kinds answered by choosing among presented options. */
export const CHOICE_KINDS = ['mcq_single', 'mcq_multi', 'true_false'] as const;

/** The kinds answered by writing and running code (`sql` included — ADR-002 runs both). */
export const CODE_KINDS = ['coding', 'sql'] as const;

/** The kinds answered in prose and graded by a human against a scorecard. */
export const PROSE_KINDS = ['subjective', 'system_design'] as const;

/**
 * `question_status` — the authoring lifecycle. `published` is the point after which a
 * version's content is frozen (ADR-003).
 *
 * The transitions themselves are not here. They are pure domain logic and live in
 * `@assaybank/core-domain`'s `transitionQuestion`, which this package must not import:
 * contracts is the root of the dependency graph and is consumed by two browser bundles.
 */
export const QUESTION_STATUSES = ['draft', 'review', 'published', 'retired'] as const;

/** The authoring lifecycle state of a question. */
export const QuestionStatusSchema = z
  .enum(QUESTION_STATUSES)
  .describe('Authoring lifecycle: draft → review → published → retired.')
  .openapi('QuestionStatus');

/** The authoring lifecycle state of a question. */
export type QuestionStatus = z.infer<typeof QuestionStatusSchema>;

/** The easiest a question may be rated. `smallint CHECK (difficulty BETWEEN 1 AND 5)`. */
export const MIN_DIFFICULTY = 1;

/** The hardest a question may be rated. */
export const MAX_DIFFICULTY = 5;

/** Difficulty, on the schema's own 1–5 scale. */
export const DifficultySchema = z
  .number()
  .int()
  .min(MIN_DIFFICULTY)
  .max(MAX_DIFFICULTY)
  .describe(`Calibrated difficulty, ${MIN_DIFFICULTY} (easiest) to ${MAX_DIFFICULTY}.`);

/**
 * The longest prompt this API will accept, in characters.
 *
 * docs/17 §10: every endpoint has a cost ceiling, and the column is unbounded `text`. A
 * system-design prompt with a rubric and three diagrams described in prose is comfortably
 * inside this; a paste of a novel is not.
 */
export const MAX_PROMPT_LENGTH = 64_000;

/** The longest explanation. Author-facing only; never served to a candidate. */
export const MAX_EXPLANATION_LENGTH = 64_000;

/** The longest free-text search term a list request may carry. */
export const MAX_SEARCH_LENGTH = 200;

/** The most options one MCQ version may carry. Beyond this it is not a multiple choice. */
export const MAX_OPTIONS = 26;

/** The most test cases one coding version may carry, sample and hidden together. */
export const MAX_TEST_CASES = 200;

/** The most short-answer keys one version may carry. */
export const MAX_ANSWER_KEYS = 50;

/** The characters an excerpt of a prompt is truncated to, for a list row. */
export const PROMPT_EXCERPT_LENGTH = 200;

/** A `source_license` identifier: `MIT`, `Apache-2.0`, `CC-BY-4.0`, `proprietary`. */
export const SourceLicenseSchema = z
  .string()
  .min(1)
  .max(100)
  .describe('SPDX identifier or `proprietary`. Mandatory on import (docs/05 §2).');

/** An external reference for imported content: `humaneval/42`, `lbpp/17`. */
export const ExternalRefSchema = z
  .string()
  .min(1)
  .max(200)
  .describe('Where imported content came from, as `dataset/id`.');

// --- the record: the complete author-side truth ------------------------------
//
// Not a response type. `Date` and `number`, not RFC 3339 and not the numeric strings
// postgres.js returns — `packages/db` parses at its own edge and hands these across, and
// the serialisers below turn them into wire values. Nothing in this package serves a
// record.

/** One MCQ option, in full. Three of its five fields are answer-key material. */
export interface McqOptionRecord {
  readonly id: Uuid;
  readonly ordinal: number;
  readonly body_md: string;
  /** ANSWER KEY. */
  readonly is_correct: boolean;
  /** ANSWER KEY — overrides the default partial credit. */
  readonly score_delta: number | null;
  /** ANSWER KEY until the attempt is over and review is permitted. */
  readonly rationale_md: string | null;
}

/** The coding and SQL execution spec, in full. */
export interface CodingSpecRecord {
  readonly allowed_languages: readonly string[];
  readonly starter_code: Readonly<Record<string, string>>;
  /** REFERENCE SOLUTIONS. Never sent to a client, staff or candidate. */
  readonly solution_code: Readonly<Record<string, string>>;
  readonly time_limit_ms: number;
  readonly memory_limit_kb: number;
  /** `test_cases` | `unit_tests` | `custom_checker`. */
  readonly grading_mode: string;
  /** REFERENCE. A custom checker reveals the shape of the expected answer. */
  readonly checker_code: string | null;
  /** For `kind = 'sql'`: schema plus seed data for the fixture database. */
  readonly fixture_sql: string | null;
}

/** One test case, in full. Every field of a non-sample row is hidden content. */
export interface TestCaseRecord {
  readonly id: Uuid;
  readonly ordinal: number;
  readonly label: string | null;
  readonly stdin: string;
  /** HIDDEN. The expectation ADR-002 keeps out of the sandbox entirely. */
  readonly expected_stdout: string | null;
  readonly args: readonly string[] | null;
  readonly is_sample: boolean;
  readonly weight: number;
}

/** One auto-graded short-answer key. Every field is answer-key material. */
export interface AnswerKeyRecord {
  readonly id: Uuid;
  /** `exact` | `ci` | `regex` | `numeric_tolerance`. */
  readonly match_type: string;
  readonly pattern: string;
  readonly tolerance: number | null;
  readonly score: number;
}

/** What a question measures, and how much of it (ADR-009). */
export interface QuestionSkillRecord {
  readonly skill_id: SkillId;
  readonly weight: number;
}

/**
 * One version of one question, with every child row it owns.
 *
 * `published_at` is the freeze line: non-null means the row is read-only, enforced by the
 * trigger migration 0001 installs and answered as `409 version_immutable` at the API
 * (ADR-003).
 */
export interface QuestionVersionRecord {
  readonly id: QuestionVersionId;
  readonly question_id: QuestionId;
  readonly version_no: number;
  readonly locale: string;
  readonly prompt_md: string;
  readonly explanation_md: string | null;
  readonly difficulty: number;
  readonly est_seconds: number;
  readonly max_score: number;
  readonly negative_score: number;
  readonly published_at: Date | null;
  readonly created_by: UserId | null;
  readonly created_at: Date;
  readonly options: readonly McqOptionRecord[];
  readonly coding_spec: CodingSpecRecord | null;
  readonly test_cases: readonly TestCaseRecord[];
  readonly answer_keys: readonly AnswerKeyRecord[];
}

/** A question's stable identity and lifecycle, with its current version expanded. */
export interface QuestionRecord {
  readonly id: QuestionId;
  readonly kind: QuestionKind;
  readonly status: QuestionStatus;
  readonly external_ref: string | null;
  readonly source_license: string | null;
  readonly author_id: UserId | null;
  readonly exposure_count: number;
  readonly archived_at: Date | null;
  readonly created_at: Date;
  readonly skills: readonly QuestionSkillRecord[];
  /** Null between a question's own INSERT and its first version's. */
  readonly current_version: QuestionVersionRecord | null;
}

/**
 * A question as a list row: identity, lifecycle, and just enough of two versions.
 *
 * **Two versions, and the field names say which.** `questions.current_version_id` points
 * at the most recently *published* version and is null until a question has one —
 * `publishVersion` is the only thing that moves it, which is what stops a draft from ever
 * being the version an assessment draws (ADR-003). But a bank list that showed nothing at
 * all for a question still being written would be useless during exactly the week an
 * author is using it, so the display columns come from the *latest* version whatever its
 * state. The `current_` and `latest_` prefixes are there so nobody has to guess which is
 * which, and they are the same row for most questions most of the time.
 */
export interface QuestionSummaryRecord {
  readonly id: QuestionId;
  readonly kind: QuestionKind;
  readonly status: QuestionStatus;
  readonly external_ref: string | null;
  readonly source_license: string | null;
  readonly exposure_count: number;
  readonly archived_at: Date | null;
  readonly created_at: Date;
  /** The most recently published version, or null if there has never been one. */
  readonly current_version_id: QuestionVersionId | null;
  /** When that version was published. */
  readonly current_published_at: Date | null;
  /** The highest `version_no`, published or not. Null for a question with no version. */
  readonly latest_version_no: number | null;
  readonly latest_difficulty: number | null;
  readonly latest_prompt_md: string | null;
}

// --- the author view ---------------------------------------------------------

/** One MCQ option as an author sees it: body, correctness, credit and rationale. */
export const AuthorMcqOptionSchema = z
  .object({
    id: UuidSchema,
    ordinal: z.number().int().min(1),
    body_md: z.string(),
    is_correct: z.boolean(),
    score_delta: z.number().nullable(),
    rationale_md: z.string().nullable(),
  })
  .describe('One MCQ option, including the answer key. Staff only.')
  .openapi('AuthorMcqOption');

/** The execution spec as an author sees it, reference solution included. */
export const AuthorCodingSpecSchema = z
  .object({
    allowed_languages: z.array(z.string()),
    starter_code: z.record(z.string(), z.string()),
    solution_code: z.record(z.string(), z.string()),
    time_limit_ms: z.number().int().positive(),
    memory_limit_kb: z.number().int().positive(),
    grading_mode: z.string(),
    checker_code: z.string().nullable(),
    fixture_sql: z.string().nullable(),
  })
  .describe('Execution spec including reference solutions. Staff only.')
  .openapi('AuthorCodingSpec');

/** One test case as an author sees it, expectation included. */
export const AuthorTestCaseSchema = z
  .object({
    id: UuidSchema,
    ordinal: z.number().int().min(1),
    label: z.string().nullable(),
    stdin: z.string(),
    expected_stdout: z.string().nullable(),
    args: z.array(z.string()).nullable(),
    is_sample: z.boolean(),
    weight: z.number(),
  })
  .describe('One test case, including the expectation. Staff only.')
  .openapi('AuthorTestCase');

/** One short-answer key as an author sees it. */
export const AuthorAnswerKeySchema = z
  .object({
    id: UuidSchema,
    match_type: z.string(),
    pattern: z.string(),
    tolerance: z.number().nullable(),
    score: z.number(),
  })
  .describe('One auto-graded short-answer key. Staff only.')
  .openapi('AuthorAnswerKey');

/** One version of a question, in full, as an author sees it. */
export const AuthorQuestionVersionSchema = z
  .object({
    id: QuestionVersionIdSchema,
    question_id: QuestionIdSchema,
    version_no: z.number().int().min(1),
    locale: z.string(),
    prompt_md: z.string(),
    explanation_md: z.string().nullable(),
    difficulty: DifficultySchema,
    est_seconds: z.number().int().positive(),
    max_score: z.number(),
    negative_score: z.number(),
    /** Non-null is the freeze line. After this instant the version is read-only. */
    published_at: Rfc3339Schema.nullable(),
    created_by: UserIdSchema.nullable(),
    created_at: Rfc3339Schema,
    options: z.array(AuthorMcqOptionSchema),
    coding_spec: AuthorCodingSpecSchema.nullable(),
    test_cases: z.array(AuthorTestCaseSchema),
    answer_keys: z.array(AuthorAnswerKeySchema),
  })
  .describe('One question version in full, answer keys included. Staff only.')
  .openapi('AuthorQuestionVersion');

/** One version of a question, in full, as an author sees it. */
export type AuthorQuestionVersionView = z.infer<typeof AuthorQuestionVersionSchema>;

/** What a question measures, and how much of it. */
export const QuestionSkillSchema = z
  .object({ skill_id: SkillIdSchema, weight: z.number() })
  .describe('One skill this question measures, and its weight (ADR-009).')
  .openapi('QuestionSkill');

/** A question with its current version expanded — `GET /questions/{id}` (docs/03 §4). */
export const AuthorQuestionSchema = z
  .object({
    id: QuestionIdSchema,
    kind: QuestionKindSchema,
    status: QuestionStatusSchema,
    external_ref: z.string().nullable(),
    source_license: z.string().nullable(),
    author_id: UserIdSchema.nullable(),
    exposure_count: z.number().int().min(0),
    archived_at: Rfc3339Schema.nullable(),
    created_at: Rfc3339Schema,
    skills: z.array(QuestionSkillSchema),
    current_version: AuthorQuestionVersionSchema.nullable(),
  })
  .describe('A bank question with its current version expanded. Staff only.')
  .openapi('AuthorQuestion');

/** A question with its current version expanded, as an author sees it. */
export type AuthorQuestionView = z.infer<typeof AuthorQuestionSchema>;

/** One row of `GET /questions` — enough to render a bank list, and no more. */
export const AuthorQuestionSummarySchema = z
  .object({
    id: QuestionIdSchema,
    kind: QuestionKindSchema,
    status: QuestionStatusSchema,
    external_ref: z.string().nullable(),
    source_license: z.string().nullable(),
    exposure_count: z.number().int().min(0),
    archived_at: Rfc3339Schema.nullable(),
    created_at: Rfc3339Schema,
    current_version_id: QuestionVersionIdSchema.nullable().describe(
      'The most recently published version, or null if this question has never had one.',
    ),
    current_published_at: Rfc3339Schema.nullable(),
    latest_version_no: z
      .number()
      .int()
      .min(1)
      .nullable()
      .describe('The highest version number, published or not.'),
    latest_difficulty: DifficultySchema.nullable(),
    latest_prompt_excerpt: z.string().nullable(),
  })
  .describe('One question as a list row. Staff only.')
  .openapi('AuthorQuestionSummary');

/** One row of `GET /questions`. */
export type AuthorQuestionSummaryView = z.infer<typeof AuthorQuestionSummarySchema>;

/** The body of `GET /questions`: a page of summaries plus a cursor. */
export const QuestionListResponseSchema = paginated(AuthorQuestionSummarySchema)
  .describe('One page of the question bank.')
  .openapi('QuestionListResponse');

/** The body of `GET /questions`. */
export type QuestionListResponse = z.infer<typeof QuestionListResponseSchema>;

/** The body of `GET /questions/{id}/versions`: a page of versions, newest first. */
export const QuestionVersionListResponseSchema = paginated(AuthorQuestionVersionSchema)
  .describe('One page of a question’s versions, newest first.')
  .openapi('QuestionVersionListResponse');

/** The body of `GET /questions/{id}/versions`. */
export type QuestionVersionListResponse = z.infer<typeof QuestionVersionListResponseSchema>;

// --- the candidate view ------------------------------------------------------
//
// A separate set of types, not a projection of the ones above with fields removed. The
// difference is the guarantee: a field cannot be forgotten out of a type that never
// named it.

/** One option as a candidate sees it: which one it is, and what it says. */
export const CandidateOptionSchema = z
  .object({
    id: UuidSchema.describe('The option’s own id, which the answer will name.'),
    ordinal: z
      .number()
      .int()
      .min(1)
      .describe('The author’s ordering. The served order is the attempt’s shuffle (FR-7).'),
    body_md: z.string(),
  })
  .describe('One selectable option. Carries no correctness, credit or rationale.')
  .openapi('CandidateOption');

/** Fields every candidate-facing question carries, whatever its kind. */
const candidateCommon = {
  question_version_id: QuestionVersionIdSchema.describe(
    'The version served. An attempt references a version, never a question (ADR-003).',
  ),
  prompt_md: z.string().describe('The question itself, as markdown. Sanitise on render.'),
  est_seconds: z.number().int().positive().describe('The author’s time estimate, for pacing.'),
  max_score: z.number().describe('Points available. Shown so a candidate can prioritise.'),
  negative_score: z
    .number()
    .describe('Points deducted for a wrong answer, or 0. Shown so guessing is an informed choice.'),
};

/** A question answered by choosing among presented options. */
export const CandidateChoiceQuestionSchema = z
  .object({
    ...candidateCommon,
    kind: z.enum(CHOICE_KINDS),
    options: z.array(CandidateOptionSchema),
  })
  .describe('An MCQ or true/false question as served to a candidate.')
  .openapi('CandidateChoiceQuestion');

/** A question answered by typing a short string, auto-graded against keys the candidate never sees. */
export const CandidateShortAnswerQuestionSchema = z
  .object({ ...candidateCommon, kind: z.literal('short_answer') })
  .describe('A short-answer question as served to a candidate.')
  .openapi('CandidateShortAnswerQuestion');

/**
 * What a candidate needs to write and run code: languages, starter files and the limits
 * the sandbox will enforce.
 *
 * `fixture_sql` is served for `kind = 'sql'` and only there: it is the schema and seed
 * data the candidate is querying, so withholding it would make the question unanswerable.
 * It is not an expectation — ADR-002 keeps those out of the sandbox and this type out of
 * their reach.
 *
 * The two counts replace the test-case rows entirely. See the module comment.
 */
export const CandidateCodingBriefSchema = z
  .object({
    allowed_languages: z.array(z.string()),
    starter_code: z.record(z.string(), z.string()).describe('Per-language starting files.'),
    time_limit_ms: z.number().int().positive(),
    memory_limit_kb: z.number().int().positive(),
    fixture_sql: z.string().nullable().describe('The fixture schema for a SQL question, or null.'),
    sample_case_count: z
      .number()
      .int()
      .min(0)
      .describe('How many cases a trial run executes against. The cases themselves stay server-side.'),
    hidden_case_count: z
      .number()
      .int()
      .min(0)
      .describe('How many further cases grading will use. A count only, never the content.'),
  })
  .describe('Everything a candidate needs to write code, and nothing about what is expected.')
  .openapi('CandidateCodingBrief');

/** A coding or SQL question as served to a candidate. */
export const CandidateCodingQuestionSchema = z
  .object({
    ...candidateCommon,
    kind: z.enum(CODE_KINDS),
    coding: CandidateCodingBriefSchema,
  })
  .describe('A coding or SQL question as served to a candidate.')
  .openapi('CandidateCodingQuestion');

/** A question answered in prose and graded by a human. */
export const CandidateProseQuestionSchema = z
  .object({ ...candidateCommon, kind: z.enum(PROSE_KINDS) })
  .describe('A subjective or system-design question as served to a candidate.')
  .openapi('CandidateProseQuestion');

/**
 * A question as served to a candidate.
 *
 * A union rather than one wide optional shape, so a runner that renders a choice question
 * cannot reach for `coding` and a coding question has no `options` to accidentally
 * populate.
 */
export const CandidateQuestionSchema = z
  .union([
    CandidateChoiceQuestionSchema,
    CandidateShortAnswerQuestionSchema,
    CandidateCodingQuestionSchema,
    CandidateProseQuestionSchema,
  ])
  .describe('A question as served to a candidate. Carries no answer key of any kind (FR-12).')
  .openapi('CandidateQuestion');

/** A choice question as served to a candidate. */
export type CandidateChoiceQuestion = z.infer<typeof CandidateChoiceQuestionSchema>;
/** A short-answer question as served to a candidate. */
export type CandidateShortAnswerQuestion = z.infer<typeof CandidateShortAnswerQuestionSchema>;
/** A coding or SQL question as served to a candidate. */
export type CandidateCodingQuestion = z.infer<typeof CandidateCodingQuestionSchema>;
/** A subjective or system-design question as served to a candidate. */
export type CandidateProseQuestion = z.infer<typeof CandidateProseQuestionSchema>;

/** A question as served to a candidate, in any of its four shapes. */
export type CandidateQuestionView =
  | CandidateChoiceQuestion
  | CandidateShortAnswerQuestion
  | CandidateCodingQuestion
  | CandidateProseQuestion;

/**
 * The compile-time proof that the candidate view carries no answer key, at any depth, in
 * any member of the union.
 *
 * This is the assertion the whole boundary rests on. Adding `is_correct` to
 * {@link CandidateOptionSchema}, or nesting {@link AuthorTestCaseSchema} inside a
 * candidate type, makes `IsCandidateSafe<…>` resolve to `false`, and `Satisfied` refuses
 * it — here, at build time, in every editor, without anybody having to construct a
 * payload and run a test against it.
 *
 * `src/questions.type-test.ts` proves the check can fail, which is the half that makes it
 * worth anything: an assertion nobody has watched reject something is an assertion that
 * may be vacuous.
 */
export type _CandidateViewCarriesNoAnswerKey = Satisfied<IsCandidateSafe<CandidateQuestionView>>;

// --- request schemas ---------------------------------------------------------

/**
 * `POST /questions` — `{kind, source_license?, external_ref?}` (docs/03 §4).
 *
 * `strictObject`, so an unrecognised key is a 422 naming it rather than a silently
 * dropped field; `@fastify/ajv-compiler` is configured with `removeAdditional: true`
 * here, which is why the body is parsed with zod in the handler rather than by Fastify's
 * validator (see `@assaybank/contracts`'s `parse.ts`).
 *
 * Content is deliberately absent. A question is created empty and gains a first version
 * through `POST /questions/{id}/versions`, because that is the same path an *edit* takes,
 * and an authoring flow whose first save is special is an authoring flow with two code
 * paths through the invariant that matters (ADR-003).
 */
export const CreateQuestionSchema = z
  .strictObject({
    kind: QuestionKindSchema,
    source_license: SourceLicenseSchema.optional(),
    external_ref: ExternalRefSchema.optional(),
  })
  .describe('Create an empty question. Content arrives as its first version.')
  .openapi('CreateQuestion');

/** The parsed body of `POST /questions`. */
export type CreateQuestion = z.infer<typeof CreateQuestionSchema>;

/**
 * The lifecycle states `PATCH /questions/{id}` may move a question to.
 *
 * `published` is missing on purpose. docs/03 §4: *"Publishing is a distinct action
 * requiring `question.publish`"* — so it is `POST /questions/{id}/versions/{v}/publish`,
 * a route with its own permission, and not a status somebody with `question.write` can
 * assign. A permission gate that a sibling endpoint can route around is not a gate.
 */
export const PATCHABLE_STATUSES = ['draft', 'review', 'retired'] as const;

/**
 * `PATCH /questions/{id}` — `{status, archived_at}` in docs/03 §4, with one deliberate
 * difference.
 *
 * The spec writes `archived_at`, an instant. This accepts `archived`, a boolean, because
 * ADR-006 gives the clock to the server: a client that could choose the archival instant
 * could pre-date a retention clock, and every timestamp in this system is written from
 * the injected clock rather than from a request body. The observable behaviour is the
 * same — `archived: true` sets the column, `archived: false` clears it — and the response
 * still carries `archived_at`.
 */
export const PatchQuestionSchema = z
  .strictObject({
    status: z.enum(PATCHABLE_STATUSES).optional(),
    archived: z.boolean().optional(),
  })
  .refine((patch) => patch.status !== undefined || patch.archived !== undefined, {
    error: 'Name at least one of `status` or `archived`.',
  })
  .describe('Move a question through its lifecycle, or archive and restore it.')
  .openapi('PatchQuestion');

/** The parsed body of `PATCH /questions/{id}`. */
export type PatchQuestion = z.infer<typeof PatchQuestionSchema>;

/** One MCQ option as an author writes it. No id: the database mints one per version. */
export const McqOptionInputSchema = z
  .strictObject({
    body_md: z.string().min(1).max(MAX_PROMPT_LENGTH),
    is_correct: z.boolean().default(false),
    score_delta: z.number().nullable().optional(),
    rationale_md: z.string().max(MAX_EXPLANATION_LENGTH).nullable().optional(),
  })
  .describe('One MCQ option to write. Order is the array order.')
  .openapi('McqOptionInput');

/** The execution spec as an author writes it. */
export const CodingSpecInputSchema = z
  .strictObject({
    allowed_languages: z.array(z.string().min(1).max(50)).min(1).max(20),
    starter_code: z.record(z.string(), z.string()).optional(),
    solution_code: z.record(z.string(), z.string()).optional(),
    time_limit_ms: z.number().int().min(100).max(60_000).optional(),
    memory_limit_kb: z.number().int().min(1024).max(2_097_152).optional(),
    grading_mode: z.enum(['test_cases', 'unit_tests', 'custom_checker']).optional(),
    checker_code: z.string().nullable().optional(),
    fixture_sql: z.string().nullable().optional(),
  })
  .describe('The execution spec to write for a coding or SQL question.')
  .openapi('CodingSpecInput');

/** One test case as an author writes it. */
export const TestCaseInputSchema = z
  .strictObject({
    label: z.string().max(200).nullable().optional(),
    stdin: z.string().default(''),
    expected_stdout: z.string().nullable().optional(),
    args: z.array(z.string()).nullable().optional(),
    is_sample: z.boolean().default(false),
    weight: z.number().positive().optional(),
  })
  .describe('One test case to write. Order is the array order.')
  .openapi('TestCaseInput');

/** One short-answer key as an author writes it. */
export const AnswerKeyInputSchema = z
  .strictObject({
    match_type: z.enum(['exact', 'ci', 'regex', 'numeric_tolerance']),
    pattern: z.string().min(1).max(2000),
    tolerance: z.number().nullable().optional(),
    score: z.number().optional(),
  })
  .describe('One auto-graded short-answer key to write.')
  .openapi('AnswerKeyInput');

/**
 * The content of a version, as an author supplies it. Every field optional.
 *
 * **Optional is the point, and it is what makes authoring a fix bearable.** ADR-003 says
 * an edit to a published question is a new version, so the alternative — a body that
 * demands every field — would mean retyping a forty-option question to fix a typo in its
 * prompt, and an author who has retyped it has introduced a second difference nobody
 * asked for. `POST /questions/{id}/versions` therefore reads as a *patch over the
 * previous version*: what the body names is changed and everything else is copied forward
 * byte for byte, which is the behaviour `createVersion` in `@assaybank/db` implements.
 *
 * A child collection is replaced wholesale when it is named and copied forward when it is
 * not. Per-row patching of options would need stable per-row identity across versions,
 * which the schema deliberately does not have — an option belongs to one version, and a
 * new version's options are new rows.
 *
 * `coding_spec` is the one exception, because it is a row rather than a collection: its
 * named fields are merged over the previous spec and its unnamed ones are copied forward,
 * so raising a time limit does not mean restating the language list and the starter code.
 * An explicit `null` removes the spec entirely.
 *
 * The first version of a question has nothing to copy forward from, so `prompt_md` and
 * `difficulty` must be present. That is checked against {@link FIRST_VERSION_FIELDS}
 * rather than expressed here, because "required unless a prior version exists" is not a
 * property of the body and a schema that pretended otherwise would be lying to the
 * generated document.
 */
export const QuestionVersionInputSchema = z
  .strictObject({
    locale: z.string().min(2).max(35).optional(),
    prompt_md: z.string().min(1).max(MAX_PROMPT_LENGTH).optional(),
    explanation_md: z.string().max(MAX_EXPLANATION_LENGTH).nullable().optional(),
    difficulty: DifficultySchema.optional(),
    est_seconds: z.number().int().min(1).max(86_400).optional(),
    max_score: z.number().min(0).max(10_000).optional(),
    negative_score: z.number().min(0).max(10_000).optional(),
    options: z.array(McqOptionInputSchema).max(MAX_OPTIONS).optional(),
    coding_spec: CodingSpecInputSchema.nullable().optional(),
    test_cases: z.array(TestCaseInputSchema).max(MAX_TEST_CASES).optional(),
    answer_keys: z.array(AnswerKeyInputSchema).max(MAX_ANSWER_KEYS).optional(),
  })
  .describe('Version content. Omitted fields are copied forward from the previous version.')
  .openapi('QuestionVersionInput');

/** The parsed body of `POST /questions/{id}/versions` and of `PATCH …/versions/{v}`. */
export type QuestionVersionInput = z.infer<typeof QuestionVersionInputSchema>;

/**
 * `POST /questions/{id}/preview` — run code against a question's **sample** cases (docs/03 §4).
 *
 * Both fields optional: with neither, the question's own reference solution is run, which is how
 * an author checks a question before publishing it. Hidden cases are never run by a preview,
 * because a preview's output is shown to whoever asked.
 */
export const QuestionPreviewRequestSchema = z
  .strictObject({
    language: z.string().min(1).max(50).optional(),
    code: z.string().min(1).max(200_000).optional(),
  })
  .describe('Run code, or the reference solution, against sample cases only.')
  .openapi('QuestionPreviewRequest');

export type QuestionPreviewRequest = z.infer<typeof QuestionPreviewRequestSchema>;

/** `GET` — the recorded statistics for a question's current version. */
export const QUESTION_STATS_PATH = '/questions/{id}/stats';

/**
 * Item statistics for the question's **current version** (FR-5).
 *
 * Per version, never per question: a statistic pooled across versions describes a question
 * nobody was ever asked (ADR-003). `p_value` and `discrimination` stay null until
 * `min_responses` finalised responses exist, and a question the nightly sweep has not reached
 * answers zeros and nulls rather than 404 — it exists, it simply has not been measured.
 */
export const QuestionStatsResponseSchema = z
  .object({
    question_id: z.string().uuid(),
    version_no: z.number().int().nullable(),
    n_attempts: z.number().int().min(0),
    p_value: z.number().min(0).max(1).nullable(),
    discrimination: z.number().min(-1).max(1).nullable(),
    mean_seconds: z.number().min(0).nullable(),
    computed_at: z.string().nullable(),
    min_responses: z.number().int(),
  })
  .describe('Item statistics for the current version of a question.')
  .openapi('QuestionStatsResponse');

export type QuestionStatsResponse = z.infer<typeof QuestionStatsResponseSchema>;

/**
 * The fields a question's *first* version must carry, because there is nothing to copy
 * them forward from.
 *
 * A list rather than a second schema, so the 422 names the missing fields in the same
 * `details.fields` shape every other validation failure uses.
 */
export const FIRST_VERSION_FIELDS = ['prompt_md', 'difficulty'] as const;

/**
 * `GET /questions` — `?kind=&status=&skill_id=&difficulty=&q=&exposure_gt=` (docs/03 §4),
 * plus the cursor pagination every list endpoint carries.
 *
 * Explicit parameters, never a generic query language (docs/17 §3): a query language is
 * an injection surface and an unbounded-cost surface at once. `q` is bounded, and the
 * repository turns it into a parameterised `ILIKE` against the trigram index migration
 * 0001 builds over `prompt_md`.
 *
 * Archived questions are excluded unless `include_archived` asks for them. A soft delete
 * that still showed up in the default list would not be a delete.
 *
 * `difficulty` and `q` are matched against versions rather than against the question,
 * which has neither: `difficulty` against the latest version, which is the number the
 * list displays, and `q` against *any* version, because "find the question that mentions
 * balanced parentheses" should find it whether the phrase is in version 1 or version 4.
 */
export const ListQuestionsQuerySchema = z
  .object({
    kind: QuestionKindSchema.optional(),
    status: QuestionStatusSchema.optional(),
    skill_id: SkillIdSchema.optional(),
    difficulty: z.coerce.number().int().min(MIN_DIFFICULTY).max(MAX_DIFFICULTY).optional(),
    q: z.string().min(1).max(MAX_SEARCH_LENGTH).optional(),
    exposure_gt: z.coerce.number().int().min(0).optional(),
    include_archived: z.stringbool().optional(),
    ...PaginationQuerySchema.shape,
  })
  .describe('Filters for the question bank list (docs/03 §4).')
  .openapi('ListQuestionsQuery');

/** The parsed query string of `GET /questions`. */
export type ListQuestionsQuery = z.infer<typeof ListQuestionsQuerySchema>;

/** The path parameters of `GET /questions/{id}` and its siblings. */
export const QuestionParamsSchema = z
  .object({ id: QuestionIdSchema })
  .describe('Which question.')
  .openapi('QuestionParams');

/** The path parameters of the version endpoints: a question, and a `version_no`. */
export const QuestionVersionParamsSchema = z
  .object({
    id: QuestionIdSchema,
    v: z.coerce
      .number()
      .int()
      .min(1)
      .describe('The version number, as `question_versions.version_no`, not a uuid.'),
  })
  .describe('Which version of which question.')
  .openapi('QuestionVersionParams');

/** The parsed path parameters of the version endpoints. */
export type QuestionVersionParams = z.infer<typeof QuestionVersionParamsSchema>;

// --- serialisers -------------------------------------------------------------

/** An instant as the wire carries it, or `null`. */
function at(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

/** One MCQ option, for an author. */
function authorOption(option: McqOptionRecord): AuthorQuestionVersionView['options'][number] {
  return {
    id: option.id,
    ordinal: option.ordinal,
    body_md: option.body_md,
    is_correct: option.is_correct,
    score_delta: option.score_delta,
    rationale_md: option.rationale_md,
  };
}

/** The execution spec, for an author. */
function authorCodingSpec(
  spec: CodingSpecRecord,
): NonNullable<AuthorQuestionVersionView['coding_spec']> {
  return {
    allowed_languages: [...spec.allowed_languages],
    starter_code: { ...spec.starter_code },
    solution_code: { ...spec.solution_code },
    time_limit_ms: spec.time_limit_ms,
    memory_limit_kb: spec.memory_limit_kb,
    grading_mode: spec.grading_mode,
    checker_code: spec.checker_code,
    fixture_sql: spec.fixture_sql,
  };
}

/** One test case, for an author. */
function authorTestCase(testCase: TestCaseRecord): AuthorQuestionVersionView['test_cases'][number] {
  return {
    id: testCase.id,
    ordinal: testCase.ordinal,
    label: testCase.label,
    stdin: testCase.stdin,
    expected_stdout: testCase.expected_stdout,
    args: testCase.args === null ? null : [...testCase.args],
    is_sample: testCase.is_sample,
    weight: testCase.weight,
  };
}

/** One short-answer key, for an author. */
function authorAnswerKey(key: AnswerKeyRecord): AuthorQuestionVersionView['answer_keys'][number] {
  return {
    id: key.id,
    match_type: key.match_type,
    pattern: key.pattern,
    tolerance: key.tolerance,
    score: key.score,
  };
}

/**
 * One version, in full, for an author.
 *
 * Field by field rather than by spreading the record (docs/17 §12 — `SELECT *` into a
 * serialiser). A column added to `question_versions` does not reach a client until
 * somebody names it here, which is the only version of that guarantee that survives a
 * schema change made by someone who never read this file.
 */
export function toAuthorVersionView(version: QuestionVersionRecord): AuthorQuestionVersionView {
  return {
    id: version.id,
    question_id: version.question_id,
    version_no: version.version_no,
    locale: version.locale,
    prompt_md: version.prompt_md,
    explanation_md: version.explanation_md,
    difficulty: version.difficulty,
    est_seconds: version.est_seconds,
    max_score: version.max_score,
    negative_score: version.negative_score,
    published_at: at(version.published_at),
    created_by: version.created_by,
    created_at: version.created_at.toISOString(),
    options: version.options.map(authorOption),
    coding_spec: version.coding_spec === null ? null : authorCodingSpec(version.coding_spec),
    test_cases: version.test_cases.map(authorTestCase),
    answer_keys: version.answer_keys.map(authorAnswerKey),
  };
}

/**
 * A question with its current version, for an author.
 *
 * The author-facing half of the boundary: it carries everything, because an author who
 * cannot see the answer key cannot author the question. There is no audience parameter —
 * the only way to obtain this shape is to call this function, and the only way to obtain
 * a candidate's shape is to call the other one.
 */
export function toAuthorView(question: QuestionRecord): AuthorQuestionView {
  return {
    id: question.id,
    kind: question.kind,
    status: question.status,
    external_ref: question.external_ref,
    source_license: question.source_license,
    author_id: question.author_id,
    exposure_count: question.exposure_count,
    archived_at: at(question.archived_at),
    created_at: question.created_at.toISOString(),
    skills: question.skills.map((skill) => ({ skill_id: skill.skill_id, weight: skill.weight })),
    current_version:
      question.current_version === null ? null : toAuthorVersionView(question.current_version),
  };
}

/** Truncates a prompt for a list row, without splitting a surrogate pair. */
function excerpt(prompt: string | null): string | null {
  if (prompt === null) return null;
  const characters = [...prompt];
  return characters.length <= PROMPT_EXCERPT_LENGTH
    ? prompt
    : `${characters.slice(0, PROMPT_EXCERPT_LENGTH).join('')}…`;
}

/** One question as a list row, for an author. */
export function toAuthorSummaryView(row: QuestionSummaryRecord): AuthorQuestionSummaryView {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    external_ref: row.external_ref,
    source_license: row.source_license,
    exposure_count: row.exposure_count,
    archived_at: at(row.archived_at),
    created_at: row.created_at.toISOString(),
    current_version_id: row.current_version_id,
    current_published_at: at(row.current_published_at),
    latest_version_no: row.latest_version_no,
    latest_difficulty: row.latest_difficulty,
    latest_prompt_excerpt: excerpt(row.latest_prompt_md),
  };
}

/** True for the kinds answered by choosing among options. */
function isChoiceKind(kind: QuestionKind): kind is (typeof CHOICE_KINDS)[number] {
  return (CHOICE_KINDS as readonly QuestionKind[]).includes(kind);
}

/** True for the kinds answered by writing and running code. */
function isCodeKind(kind: QuestionKind): kind is (typeof CODE_KINDS)[number] {
  return (CODE_KINDS as readonly QuestionKind[]).includes(kind);
}

/** True for the kinds answered in prose. */
function isProseKind(kind: QuestionKind): kind is (typeof PROSE_KINDS)[number] {
  return (PROSE_KINDS as readonly QuestionKind[]).includes(kind);
}

/** One option, for a candidate. Three of the record's six fields have no home here. */
function candidateOption(option: McqOptionRecord): CandidateChoiceQuestion['options'][number] {
  return { id: option.id, ordinal: option.ordinal, body_md: option.body_md };
}

/**
 * The brief a candidate needs to write code, built from the spec and the case counts.
 *
 * The cases themselves are counted, never mapped. `sample_case_count` and
 * `hidden_case_count` are the only trace of `test_cases` that crosses the boundary — see
 * the module comment for why even the samples stay server-side.
 */
function candidateCodingBrief(version: QuestionVersionRecord): CandidateCodingQuestion['coding'] {
  const spec = version.coding_spec;
  let samples = 0;
  let hidden = 0;
  for (const testCase of version.test_cases) {
    if (testCase.is_sample) samples += 1;
    else hidden += 1;
  }

  return {
    allowed_languages: spec === null ? [] : [...spec.allowed_languages],
    starter_code: spec === null ? {} : { ...spec.starter_code },
    // The schema's own defaults, for the case where an author published a coding question
    // with no spec row. Serving zero would tell the runner the sandbox allows nothing.
    time_limit_ms: spec === null ? 5000 : spec.time_limit_ms,
    memory_limit_kb: spec === null ? 262_144 : spec.memory_limit_kb,
    fixture_sql: spec === null ? null : spec.fixture_sql,
    sample_case_count: samples,
    hidden_case_count: hidden,
  };
}

/**
 * A version as served to a candidate.
 *
 * The candidate-facing half of the boundary. `kind` is a parameter rather than a field of
 * the version record because kind lives on `questions` — the stable identity — while the
 * content that varies lives on the version, and the candidate is served the version
 * (ADR-003).
 *
 * Total over all eight kinds: the fall-through is the prose shape, and the three
 * predicates above are exhaustive over `QUESTION_KINDS`, which
 * `src/questions.test.ts` asserts by iterating the enum rather than by inspection.
 *
 * There is no options parameter, no `includeAnswerKey`, and no overload. Calling this is
 * the only way to obtain a {@link CandidateQuestionView}, and what it returns is
 * structurally incapable of carrying an answer key — proved at compile time by
 * {@link _CandidateViewCarriesNoAnswerKey} rather than by the reader's confidence.
 */
export function toCandidateView(
  kind: QuestionKind,
  version: QuestionVersionRecord,
): CandidateQuestionView {
  const common = {
    question_version_id: version.id,
    prompt_md: version.prompt_md,
    est_seconds: version.est_seconds,
    max_score: version.max_score,
    negative_score: version.negative_score,
  };

  if (isChoiceKind(kind)) {
    return { ...common, kind, options: version.options.map(candidateOption) };
  }

  if (isCodeKind(kind)) {
    return { ...common, kind, coding: candidateCodingBrief(version) };
  }

  if (isProseKind(kind)) {
    return { ...common, kind };
  }

  return { ...common, kind: 'short_answer' };
}
