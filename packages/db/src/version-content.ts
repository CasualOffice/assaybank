/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Copy-forward: what a new version inherits from the one before it.
 *
 * ADR-003 makes every edit to a published question a *new version*. That is the right
 * invariant and it has an authoring cost, which this module is the answer to. If
 * `POST /questions/{id}/versions` demanded a complete body, then fixing a typo in the
 * prompt of a forty-option question would mean resending forty options — and the author
 * who resent them has introduced a second difference nobody asked for, in a bank where
 * "what changed between version 3 and version 4" is supposed to be answerable. The
 * invariant would be intact and the audit trail would be worthless.
 *
 * So the request body is a *patch over the previous version*: what it names changes, and
 * everything else is carried across unchanged. {@link mergeVersionContent} is that rule,
 * and it is pure — no transaction, no clock, no identifiers — so the whole of the
 * copy-forward behaviour is provable in a unit test with no database, rather than being
 * an emergent property of a hundred lines of SQL.
 *
 * ## The three merge behaviours, and why they differ
 *
 * **Scalars are per-field.** `undefined` means "unchanged"; a value replaces. `null`
 * clears the nullable ones. The distinction between "absent" and "null" is why this is
 * written out field by field rather than as an object spread — a spread cannot tell them
 * apart under `exactOptionalPropertyTypes`, and `??` would read a deliberate `null` as an
 * absence and refuse to clear anything.
 *
 * **Collections are wholesale.** Naming `options` replaces every option; omitting it
 * copies them all. Per-row patching would need stable per-row identity across versions,
 * and the schema deliberately has none: an option belongs to exactly one version, and a
 * new version's options are new rows with new ids. Inventing a cross-version option
 * identity to support a patch would be inventing a second, weaker version of the thing
 * ADR-003 already gives.
 *
 * **The coding spec is per-field, because it is a row rather than a collection.**
 * Raising a time limit should not mean restating the language list and every starter
 * file. An explicit `null` removes the spec.
 *
 * ## What it refuses to guess
 *
 * A question's *first* version has nothing to copy forward from, so `prompt_md` and
 * `difficulty` have no source. {@link missingFirstVersionFields} names them before any
 * merge is attempted, so the caller answers `422` naming the fields rather than
 * inventing an empty prompt or a difficulty of 3. Defaults are fine for a time estimate
 * and a score; they are not fine for the two fields that say what the question is and how
 * hard it is.
 */

import {
  FIRST_VERSION_FIELDS,
  MAX_DIFFICULTY,
  MIN_DIFFICULTY,
  type QuestionVersionInput,
  type QuestionVersionRecord,
} from '@assaybank/contracts';

/** One MCQ option's content, without the identity the database mints for it. */
export interface McqOptionContent {
  readonly bodyMd: string;
  readonly isCorrect: boolean;
  readonly scoreDelta: number | null;
  readonly rationaleMd: string | null;
}

/** The execution spec's content. */
export interface CodingSpecContent {
  readonly allowedLanguages: readonly string[];
  readonly starterCode: Readonly<Record<string, string>>;
  readonly solutionCode: Readonly<Record<string, string>>;
  readonly timeLimitMs: number;
  readonly memoryLimitKb: number;
  readonly gradingMode: string;
  readonly checkerCode: string | null;
  readonly fixtureSql: string | null;
}

/** One test case's content. */
export interface TestCaseContent {
  readonly label: string | null;
  readonly stdin: string;
  readonly expectedStdout: string | null;
  readonly args: readonly string[] | null;
  readonly isSample: boolean;
  readonly weight: number;
}

/** One short-answer key's content. */
export interface AnswerKeyContent {
  readonly matchType: string;
  readonly pattern: string;
  readonly tolerance: number | null;
  readonly score: number;
}

/**
 * Everything a `question_versions` row and its four child tables hold, with no
 * identifiers and no timestamps.
 *
 * The shape the repository writes. Separating it from the row means the merge can be
 * tested without a database and means a version is written from one value rather than
 * from five arguments that could disagree.
 */
export interface VersionContent {
  readonly locale: string;
  readonly promptMd: string;
  readonly explanationMd: string | null;
  readonly difficulty: number;
  readonly estSeconds: number;
  readonly maxScore: number;
  readonly negativeScore: number;
  readonly options: readonly McqOptionContent[];
  readonly codingSpec: CodingSpecContent | null;
  readonly testCases: readonly TestCaseContent[];
  readonly answerKeys: readonly AnswerKeyContent[];
}

/** The schema's own column defaults, for the fields a first version may omit. */
const DEFAULTS = {
  locale: 'en',
  estSeconds: 120,
  maxScore: 1,
  negativeScore: 0,
  timeLimitMs: 5000,
  memoryLimitKb: 262_144,
  gradingMode: 'test_cases',
  testCaseWeight: 1,
  answerKeyScore: 1,
} as const;

/**
 * The fields this input cannot supply and the previous version cannot lend.
 *
 * Empty means the merge will succeed. A non-empty array is a `422` naming exactly what is
 * missing, which is the difference between "your request was wrong" and "something went
 * wrong".
 */
export function missingFirstVersionFields(
  prior: QuestionVersionRecord | undefined,
  input: QuestionVersionInput,
): string[] {
  if (prior !== undefined) return [];
  return FIRST_VERSION_FIELDS.filter((field) => input[field] === undefined);
}

/** The patched value when the patch names the field, and the current one when it does not. */
function chosen<T>(patched: T | undefined, current: T): T {
  return patched === undefined ? current : patched;
}

/** One option as written, with the defaults the input schema leaves to the database. */
function optionFrom(input: NonNullable<QuestionVersionInput['options']>[number]): McqOptionContent {
  return {
    bodyMd: input.body_md,
    isCorrect: input.is_correct,
    scoreDelta: input.score_delta ?? null,
    rationaleMd: input.rationale_md ?? null,
  };
}

/** One test case as written. */
function testCaseFrom(
  input: NonNullable<QuestionVersionInput['test_cases']>[number],
): TestCaseContent {
  return {
    label: input.label ?? null,
    stdin: input.stdin,
    expectedStdout: input.expected_stdout ?? null,
    args: input.args ?? null,
    isSample: input.is_sample,
    weight: input.weight ?? DEFAULTS.testCaseWeight,
  };
}

/** One short-answer key as written. */
function answerKeyFrom(
  input: NonNullable<QuestionVersionInput['answer_keys']>[number],
): AnswerKeyContent {
  return {
    matchType: input.match_type,
    pattern: input.pattern,
    tolerance: input.tolerance ?? null,
    score: input.score ?? DEFAULTS.answerKeyScore,
  };
}

/**
 * The execution spec after the patch, or `null` when the patch removed it.
 *
 * Per field, over the previous spec if there was one and over the schema's defaults if
 * there was not. `undefined` leaves the previous spec entirely alone — including the case
 * where there was none, which stays none.
 */
function mergeCodingSpec(
  prior: CodingSpecContent | null,
  patch: QuestionVersionInput['coding_spec'],
): CodingSpecContent | null {
  if (patch === undefined) return prior;
  if (patch === null) return null;

  const base: CodingSpecContent = prior ?? {
    allowedLanguages: [],
    starterCode: {},
    solutionCode: {},
    timeLimitMs: DEFAULTS.timeLimitMs,
    memoryLimitKb: DEFAULTS.memoryLimitKb,
    gradingMode: DEFAULTS.gradingMode,
    checkerCode: null,
    fixtureSql: null,
  };

  return {
    allowedLanguages: chosen(patch.allowed_languages, base.allowedLanguages),
    starterCode: chosen(patch.starter_code, base.starterCode),
    solutionCode: chosen(patch.solution_code, base.solutionCode),
    timeLimitMs: chosen(patch.time_limit_ms, base.timeLimitMs),
    memoryLimitKb: chosen(patch.memory_limit_kb, base.memoryLimitKb),
    gradingMode: chosen(patch.grading_mode, base.gradingMode),
    checkerCode: chosen(patch.checker_code, base.checkerCode),
    fixtureSql: chosen(patch.fixture_sql, base.fixtureSql),
  };
}

/** The prior version's content, or the schema's defaults when there is no prior version. */
function baseline(prior: QuestionVersionRecord | undefined): VersionContent | undefined {
  if (prior === undefined) return undefined;

  return {
    locale: prior.locale,
    promptMd: prior.prompt_md,
    explanationMd: prior.explanation_md,
    difficulty: prior.difficulty,
    estSeconds: prior.est_seconds,
    maxScore: prior.max_score,
    negativeScore: prior.negative_score,
    options: prior.options.map((option) => ({
      bodyMd: option.body_md,
      isCorrect: option.is_correct,
      scoreDelta: option.score_delta,
      rationaleMd: option.rationale_md,
    })),
    codingSpec:
      prior.coding_spec === null
        ? null
        : {
            allowedLanguages: [...prior.coding_spec.allowed_languages],
            starterCode: { ...prior.coding_spec.starter_code },
            solutionCode: { ...prior.coding_spec.solution_code },
            timeLimitMs: prior.coding_spec.time_limit_ms,
            memoryLimitKb: prior.coding_spec.memory_limit_kb,
            gradingMode: prior.coding_spec.grading_mode,
            checkerCode: prior.coding_spec.checker_code,
            fixtureSql: prior.coding_spec.fixture_sql,
          },
    testCases: prior.test_cases.map((testCase) => ({
      label: testCase.label,
      stdin: testCase.stdin,
      expectedStdout: testCase.expected_stdout,
      args: testCase.args === null ? null : [...testCase.args],
      isSample: testCase.is_sample,
      weight: testCase.weight,
    })),
    answerKeys: prior.answer_keys.map((key) => ({
      matchType: key.match_type,
      pattern: key.pattern,
      tolerance: key.tolerance,
      score: key.score,
    })),
  };
}

/**
 * Applies a version patch to the previous version, producing the content to write.
 *
 * @throws when there is no previous version and the input omits a field
 * {@link missingFirstVersionFields} names. That is a programmer error rather than a
 * caller error by the time it gets here — the caller is expected to have asked, and to
 * have answered `422` — so it throws rather than returning a value that would have to be
 * checked at a second site and could be ignored at both.
 *
 * Writing every field out is deliberate beyond the `undefined`/`null` distinction: the
 * object literals below are exhaustive, so a column added to `question_versions` is a
 * compile error here until somebody decides what copying it forward means. The
 * alternative is a field that is readable, writable on a first version, and silently lost
 * on every edit after that.
 */
export function mergeVersionContent(
  prior: QuestionVersionRecord | undefined,
  input: QuestionVersionInput,
): VersionContent {
  const missing = missingFirstVersionFields(prior, input);
  if (missing.length > 0) {
    throw new Error(
      `A question's first version must supply ${missing.join(' and ')}: there is no previous ` +
        'version to copy them forward from. Call missingFirstVersionFields() and answer 422.',
    );
  }

  const base = baseline(prior);

  // Non-null by the check above: either `base` exists, or the input supplied them.
  const promptMd = input.prompt_md ?? base?.promptMd;
  const difficulty = input.difficulty ?? base?.difficulty;
  if (promptMd === undefined || difficulty === undefined) {
    throw new Error('unreachable: the first-version check admitted an incomplete input');
  }
  if (difficulty < MIN_DIFFICULTY || difficulty > MAX_DIFFICULTY) {
    // The column has a CHECK and the schema has a bound; this is the third fence, and it
    // is here because a difficulty out of range written by a copy-forward would abort the
    // transaction with a constraint violation rather than a message anybody could act on.
    throw new Error(
      `difficulty ${String(difficulty)} is outside ${String(MIN_DIFFICULTY)}–${String(MAX_DIFFICULTY)}.`,
    );
  }

  return {
    locale: chosen(input.locale, base?.locale ?? DEFAULTS.locale),
    promptMd,
    explanationMd: chosen(input.explanation_md, base?.explanationMd ?? null),
    difficulty,
    estSeconds: chosen(input.est_seconds, base?.estSeconds ?? DEFAULTS.estSeconds),
    maxScore: chosen(input.max_score, base?.maxScore ?? DEFAULTS.maxScore),
    negativeScore: chosen(input.negative_score, base?.negativeScore ?? DEFAULTS.negativeScore),
    options:
      input.options === undefined ? (base?.options ?? []) : input.options.map(optionFrom),
    codingSpec: mergeCodingSpec(base?.codingSpec ?? null, input.coding_spec),
    testCases:
      input.test_cases === undefined ? (base?.testCases ?? []) : input.test_cases.map(testCaseFrom),
    answerKeys:
      input.answer_keys === undefined
        ? (base?.answerKeys ?? [])
        : input.answer_keys.map(answerKeyFrom),
  };
}
