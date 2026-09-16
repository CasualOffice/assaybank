/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The interchange model: one question, as it crosses an organisation boundary (FR-29, M0 exit).
 *
 * Both file formats map to and from this shape and nothing else — the JSON bank document is this
 * shape serialised, and the QTI package is this shape spread across standard QTI and a namespaced
 * extension. A round trip is therefore a property of one type, provable without a database.
 *
 * ## Explicit, not defaulted
 *
 * The API's version input is a patch — every field optional, the rest copied forward. That is
 * right for an author and wrong for a file: a file must say what the question *is*, and a reader
 * in two years must not need to know this schema's column defaults to reconstruct it. So every
 * field here is present, `null` where absent, and "lossless" has a precise meaning: an item parsed
 * from an export is `toStrictEqual` to the item exported.
 *
 * ## What never crosses
 *
 * Identifiers, timestamps, authorship and exposure counts. They belong to the organisation that
 * minted them; an importer mints its own. Skills cross **by key**, because a skill id means
 * nothing in another tenant, and publication crosses as a flag rather than an instant.
 */

import { z } from 'zod';

import {
  DifficultySchema,
  ExternalRefSchema,
  MAX_ANSWER_KEYS,
  MAX_EXPLANATION_LENGTH,
  MAX_OPTIONS,
  MAX_PROMPT_LENGTH,
  MAX_TEST_CASES,
  QuestionKindSchema,
  QuestionStatusSchema,
  SkillKeySchema,
  SourceLicenseSchema,
  type QuestionKind,
  type QuestionStatus,
} from '@assaybank/contracts';
import { validateKindContent, type KindContentShape } from '@assaybank/core-domain';

export const BankOptionSchema = z.strictObject({
  body_md: z.string().min(1).max(MAX_PROMPT_LENGTH),
  is_correct: z.boolean(),
  score_delta: z.number().nullable(),
  rationale_md: z.string().max(MAX_EXPLANATION_LENGTH).nullable(),
});

export const BankCodingSpecSchema = z.strictObject({
  allowed_languages: z.array(z.string().min(1).max(50)).min(1).max(20),
  starter_code: z.record(z.string(), z.string()),
  solution_code: z.record(z.string(), z.string()),
  time_limit_ms: z.number().int().min(100).max(60_000),
  memory_limit_kb: z.number().int().min(1024).max(2_097_152),
  grading_mode: z.enum(['test_cases', 'unit_tests', 'custom_checker']),
  checker_code: z.string().nullable(),
  fixture_sql: z.string().nullable(),
});

export const BankTestCaseSchema = z.strictObject({
  label: z.string().max(200).nullable(),
  stdin: z.string(),
  expected_stdout: z.string().nullable(),
  args: z.array(z.string()).nullable(),
  is_sample: z.boolean(),
  weight: z.number().positive(),
});

export const BankAnswerKeySchema = z.strictObject({
  match_type: z.enum(['exact', 'ci', 'regex', 'numeric_tolerance']),
  pattern: z.string().min(1).max(2000),
  tolerance: z.number().nullable(),
  score: z.number(),
});

export const BankVersionSchema = z.strictObject({
  version_no: z.number().int().min(1),
  /** Whether this version was published — frozen and servable (ADR-003). Not when. */
  published: z.boolean(),
  locale: z.string().min(2).max(35),
  prompt_md: z.string().min(1).max(MAX_PROMPT_LENGTH),
  explanation_md: z.string().max(MAX_EXPLANATION_LENGTH).nullable(),
  difficulty: DifficultySchema,
  est_seconds: z.number().int().min(1).max(86_400),
  max_score: z.number().min(0).max(10_000),
  negative_score: z.number().min(0).max(10_000),
  options: z.array(BankOptionSchema).max(MAX_OPTIONS),
  coding_spec: BankCodingSpecSchema.nullable(),
  test_cases: z.array(BankTestCaseSchema).max(MAX_TEST_CASES),
  answer_keys: z.array(BankAnswerKeySchema).max(MAX_ANSWER_KEYS),
});

export const BankSkillSchema = z.strictObject({
  key: SkillKeySchema,
  weight: z.number().min(0).max(99.99),
});

/** The most versions one exported question may carry. A bound, not an expectation. */
export const MAX_BANK_VERSIONS = 500;

export const BankItemSchema = z
  .strictObject({
    /**
     * Unique within one document, and nothing more. It lets an error say which item it is
     * about and a QTI manifest point at an item file. It is not an identity across imports.
     */
    ref: z
      .string()
      .min(1)
      .max(200)
      // Starts alphanumeric so it can never be `.` or `..` as a file name inside a package.
      .regex(
        /^[A-Za-z0-9][A-Za-z0-9._-]*$/u,
        'a ref starts with a letter or digit, then letters, digits, dot, underscore or hyphen',
      ),
    kind: QuestionKindSchema,
    status: QuestionStatusSchema,
    source_license: SourceLicenseSchema.nullable(),
    external_ref: ExternalRefSchema.nullable(),
    skills: z.array(BankSkillSchema).max(50),
    /** Oldest first. Numbers ascend strictly; the last published one is what is served. */
    versions: z.array(BankVersionSchema).min(1).max(MAX_BANK_VERSIONS),
  })
  .superRefine((item, ctx) => {
    const numbers = item.versions.map((v) => v.version_no);
    for (let i = 1; i < numbers.length; i += 1) {
      if ((numbers[i] ?? 0) <= (numbers[i - 1] ?? 0)) {
        ctx.addIssue({
          code: 'custom',
          path: ['versions', i, 'version_no'],
          message: 'version numbers must ascend strictly',
        });
      }
    }
    const keys = item.skills.map((s) => s.key);
    if (new Set(keys).size !== keys.length) {
      ctx.addIssue({ code: 'custom', path: ['skills'], message: 'each skill may appear once' });
    }
    const anyPublished = item.versions.some((v) => v.published);
    // A published or retired question has been served, so it must have a published version to
    // point at; a draft or in-review one must not, or its lifecycle and its content disagree.
    if ((item.status === 'published' || item.status === 'retired') !== anyPublished) {
      ctx.addIssue({
        code: 'custom',
        path: ['status'],
        message: anyPublished
          ? `a ${item.status} question cannot carry a published version`
          : `a ${item.status} question needs at least one published version`,
      });
    }
  });

export type BankOption = z.infer<typeof BankOptionSchema>;
export type BankCodingSpec = z.infer<typeof BankCodingSpecSchema>;
export type BankTestCase = z.infer<typeof BankTestCaseSchema>;
export type BankAnswerKey = z.infer<typeof BankAnswerKeySchema>;
export type BankVersion = z.infer<typeof BankVersionSchema>;
export type BankSkill = z.infer<typeof BankSkillSchema>;
export type BankItem = z.infer<typeof BankItemSchema>;

/** The counts the kind rule needs, from one version. */
export function shapeOfBankVersion(version: BankVersion): KindContentShape {
  return {
    optionCount: version.options.length,
    correctOptionCount: version.options.filter((o) => o.is_correct).length,
    hasCodingSpec: version.coding_spec !== null,
    hasFixtureSql: (version.coding_spec?.fixture_sql ?? '') !== '',
    testCaseCount: version.test_cases.length,
    hiddenTestCaseCount: version.test_cases.filter((t) => !t.is_sample).length,
    answerKeyCount: version.answer_keys.length,
  };
}

/** One problem with one item, located well enough for a person to fix the file. */
export interface ItemProblem {
  /** Position in the file, from zero. */
  readonly index: number;
  /** The item's `ref` when it could be read, else null. */
  readonly ref: string | null;
  /** Slash-separated path inside the item: `versions/0/options`. Empty for the item itself. */
  readonly path: string;
  readonly message: string;
}

/**
 * Validates one item as an importer must: the schema, then the kind rule per version.
 *
 * A published version is held to the publish bar and a draft to the draft bar — the same split
 * the API applies (docs/03 §4), so an import can never create a question the API would have
 * refused to publish.
 */
export function checkBankItem(
  value: unknown,
  index: number,
): { readonly item: BankItem } | { readonly problems: ItemProblem[] } {
  const ref =
    typeof value === 'object' && value !== null && 'ref' in value && typeof value.ref === 'string'
      ? value.ref
      : null;

  const parsed = BankItemSchema.safeParse(value);
  if (!parsed.success) {
    return {
      problems: parsed.error.issues.map((issue) => ({
        index,
        ref,
        path: issue.path.map(String).join('/'),
        message: issue.message,
      })),
    };
  }

  const item = parsed.data;
  const problems = item.versions.flatMap((version, v) =>
    validateKindContent(
      item.kind,
      shapeOfBankVersion(version),
      version.published ? 'publish' : 'draft',
    ).map((issue) => ({
      index,
      ref: item.ref,
      path: `versions/${String(v)}/${issue.field}`,
      message: issue.message,
    })),
  );
  return problems.length === 0 ? { item } : { problems };
}

/** The version a QTI export carries: the last published, or the last of all when none is. */
export function servedOrLatest(item: BankItem): BankVersion {
  const published = item.versions.filter((v) => v.published);
  const chosen = published[published.length - 1] ?? item.versions[item.versions.length - 1];
  if (chosen === undefined) throw new Error(`item ${item.ref} has no versions`);
  return chosen;
}

export type { QuestionKind, QuestionStatus };
