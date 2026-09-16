/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Between the interchange type and the repository's shapes. Pure: no transaction, no clock.
 *
 * Two directions, and one asymmetry worth naming. Reading a record drops everything that belongs
 * to the organisation that minted it — ids, instants, authors, exposure — and turns skill ids into
 * keys. Writing content cannot put them back, and does not try; the importer mints its own.
 */

import type { QuestionVersionRecord } from '@assaybank/contracts';
import type { VersionContent } from '@assaybank/db';

import type { BankVersion } from './bank-item.js';

/** One stored version as it leaves the organisation. */
export function toBankVersion(record: QuestionVersionRecord): BankVersion {
  return {
    version_no: record.version_no,
    published: record.published_at !== null,
    locale: record.locale,
    prompt_md: record.prompt_md,
    explanation_md: record.explanation_md,
    difficulty: record.difficulty,
    est_seconds: record.est_seconds,
    max_score: record.max_score,
    negative_score: record.negative_score,
    options: record.options.map((o) => ({
      body_md: o.body_md,
      is_correct: o.is_correct,
      score_delta: o.score_delta,
      rationale_md: o.rationale_md,
    })),
    coding_spec:
      record.coding_spec === null
        ? null
        : {
            allowed_languages: [...record.coding_spec.allowed_languages],
            starter_code: { ...record.coding_spec.starter_code },
            solution_code: { ...record.coding_spec.solution_code },
            time_limit_ms: record.coding_spec.time_limit_ms,
            memory_limit_kb: record.coding_spec.memory_limit_kb,
            grading_mode: record.coding_spec.grading_mode as NonNullable<
              BankVersion['coding_spec']
            >['grading_mode'],
            checker_code: record.coding_spec.checker_code,
            fixture_sql: record.coding_spec.fixture_sql,
          },
    test_cases: record.test_cases.map((t) => ({
      label: t.label,
      stdin: t.stdin,
      expected_stdout: t.expected_stdout,
      args: t.args === null ? null : [...t.args],
      is_sample: t.is_sample,
      weight: t.weight,
    })),
    answer_keys: record.answer_keys.map((k) => ({
      match_type: k.match_type as BankVersion['answer_keys'][number]['match_type'],
      pattern: k.pattern,
      tolerance: k.tolerance,
      score: k.score,
    })),
  };
}

/** One interchange version as the repository writes it. Nothing is merged or defaulted. */
export function toVersionContent(version: BankVersion): VersionContent {
  return {
    locale: version.locale,
    promptMd: version.prompt_md,
    explanationMd: version.explanation_md,
    difficulty: version.difficulty,
    estSeconds: version.est_seconds,
    maxScore: version.max_score,
    negativeScore: version.negative_score,
    options: version.options.map((o) => ({
      bodyMd: o.body_md,
      isCorrect: o.is_correct,
      scoreDelta: o.score_delta,
      rationaleMd: o.rationale_md,
    })),
    codingSpec:
      version.coding_spec === null
        ? null
        : {
            allowedLanguages: version.coding_spec.allowed_languages,
            starterCode: version.coding_spec.starter_code,
            solutionCode: version.coding_spec.solution_code,
            timeLimitMs: version.coding_spec.time_limit_ms,
            memoryLimitKb: version.coding_spec.memory_limit_kb,
            gradingMode: version.coding_spec.grading_mode,
            checkerCode: version.coding_spec.checker_code,
            fixtureSql: version.coding_spec.fixture_sql,
          },
    testCases: version.test_cases.map((t) => ({
      label: t.label,
      stdin: t.stdin,
      expectedStdout: t.expected_stdout,
      args: t.args,
      isSample: t.is_sample,
      weight: t.weight,
    })),
    answerKeys: version.answer_keys.map((k) => ({
      matchType: k.match_type,
      pattern: k.pattern,
      tolerance: k.tolerance,
      score: k.score,
    })),
  };
}
