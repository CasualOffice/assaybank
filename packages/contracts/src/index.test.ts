/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';

import * as contracts from './index.js';

/**
 * Every other workspace imports this package, so its surface is a contract in the
 * literal sense: a rename here breaks twelve workspaces at once. This test is the list
 * of names those workspaces are entitled to rely on.
 */
const PUBLIC_SURFACE = [
  'AttributionListResponseSchema',
  'AttributionSchema',
  'QUESTIONS_ATTRIBUTIONS_PATH',
  'WORKSPACE_NAME',
  // primitives
  'UuidSchema',
  'Rfc3339Schema',
  'CursorSchema',
  'PaginationQuerySchema',
  'DEFAULT_PAGE_SIZE',
  'MAX_PAGE_SIZE',
  'paginated',
  // identifiers
  'OrgIdSchema',
  'UserIdSchema',
  'CandidateIdSchema',
  'QuestionIdSchema',
  'QuestionVersionIdSchema',
  'AssessmentIdSchema',
  'SectionIdSchema',
  'AttemptIdSchema',
  'AttemptQuestionIdSchema',
  'AnswerIdSchema',
  'SubmissionIdSchema',
  'SessionIdSchema',
  'InvitationIdSchema',
  'SkillIdSchema',
  'JobRoleIdSchema',
  'JobRoleListResponseSchema',
  'ScorecardIdSchema',
  'ID_SCHEMAS',
  // errors
  'ERROR_CODES',
  'ERROR_CODE_STATUS',
  'ERROR_CODE_MESSAGES',
  'INTERNAL_ERROR_MESSAGE',
  'ErrorCodeSchema',
  'ErrorDetailsSchema',
  'ErrorEnvelopeSchema',
  'ApiError',
  'isErrorCode',
  'statusForErrorCode',
  'toErrorEnvelope',
  // organisation settings (docs/03 §13)
  'ORG_SETTINGS_PATH',
  'MAX_BRANDING_NAME_LENGTH',
  'MAX_LOGO_URL_LENGTH',
  'OrgBrandingSchema',
  'OrgBrandingPatchSchema',
  'OrgIdentitySchema',
  'OrgProctoringDefaultsSchema',
  'OrgProctoringDefaultsPatchSchema',
  'OrgSettingsSchema',
  'OrgSettingsPatchSchema',
  'OrgSettingsResponseSchema',
  'defaultOrgSettings',
  'mergeOrgSettings',
  'projectOrgSettings',
  // parsing at the edge
  'MAX_VALIDATION_FIELDS',
  'parseRequestPart',
  'validationFieldsFor',
  // the audience boundary (docs/17 §3, FR-12)
  'ANSWER_KEY_FIELDS',
  'findAnswerKeyFields',
  // question bank (docs/03 §4)
  'AnswerKeyInputSchema',
  'AuthorAnswerKeySchema',
  'AuthorCodingSpecSchema',
  'AuthorMcqOptionSchema',
  'AuthorQuestionSchema',
  'AuthorQuestionSummarySchema',
  'AuthorQuestionVersionSchema',
  'AuthorTestCaseSchema',
  'CHOICE_KINDS',
  'CODE_KINDS',
  'CandidateChoiceQuestionSchema',
  'CandidateCodingBriefSchema',
  'CandidateCodingQuestionSchema',
  'CandidateOptionSchema',
  'CandidateProseQuestionSchema',
  'CandidateQuestionSchema',
  'CandidateShortAnswerQuestionSchema',
  'CodingSpecInputSchema',
  'CreateQuestionSchema',
  'DifficultySchema',
  'ExternalRefSchema',
  'FIRST_VERSION_FIELDS',
  'ListQuestionsQuerySchema',
  'MAX_ANSWER_KEYS',
  'MAX_ASSERTION_LENGTH',
  'MAX_DIFFICULTY',
  'MAX_EXPLANATION_LENGTH',
  'MAX_OPTIONS',
  'MAX_PROMPT_LENGTH',
  'MAX_SEARCH_LENGTH',
  'MAX_TEST_CASES',
  'MIN_DIFFICULTY',
  'McqOptionInputSchema',
  'PATCHABLE_STATUSES',
  'PROMPT_EXCERPT_LENGTH',
  'PROSE_KINDS',
  'PatchQuestionSchema',
  'QUESTIONS_PATH',
  'QUESTION_KINDS',
  'QUESTION_PATH',
  'QUESTION_STATUSES',
  'QUESTION_VERSIONS_PATH',
  'QUESTION_VERSION_PATH',
  'QUESTION_VERSION_PUBLISH_PATH',
  'QuestionKindSchema',
  'QuestionListResponseSchema',
  'QuestionParamsSchema',
  'QuestionSkillSchema',
  'QuestionStatusSchema',
  'QuestionVersionInputSchema',
  'QuestionVersionListResponseSchema',
  'QuestionVersionParamsSchema',
  'SourceLicenseSchema',
  'TestCaseInputSchema',
  'toAuthorSummaryView',
  'toAuthorVersionView',
  'toAuthorView',
  'toCandidateView',
  'QUESTION_PREVIEW_PATH',
  'QUESTION_STATS_PATH',
  'QuestionStatsResponseSchema',
  'QuestionPreviewRequestSchema',
  'hasAtMostTwoDecimals',
  'MAX_SCORE_VALUE',
  'MAX_WEIGHT_VALUE',
  'scoreValue',
  // taxonomy — skills, job roles and the join between them (ADR-009)
  'SkillKeySchema',
  'SkillCategorySchema',
  'CreateSkillSchema',
  'UpdateSkillSchema',
  'ListSkillsQuerySchema',
  'MergeSkillSchema',
  'JobRoleCodeSchema',
  'JobRoleCoverageSchema',
  'CreateJobRoleSchema',
  'UpdateJobRoleSchema',
  'JobRoleParamsSchema',
  'JobRoleSchema',
  'ListJobRolesQuerySchema',
  'JobRoleSkillSchema',
  'PutJobRoleSkillsSchema',
  'QuestionSkillInputSchema',
  'PutQuestionSkillsSchema',
  'SKILLS_PATH',
  'SKILL_MERGE_PATH',
  'JOB_ROLES_PATH',
  'JOB_ROLE_PATH',
  'JOB_ROLE_SKILLS_PATH',
  'JOB_ROLE_COVERAGE_PATH',
  'QUESTION_SKILLS_PATH',
  'SkillCoverageSchema',
  'SkillParamsSchema',
  // bank jobs — import and export (ADR-021)
  'QUESTIONS_IMPORT_PATH',
  'QUESTIONS_EXPORT_PATH',
  'IMPORT_JOB_PATH',
  'EXPORT_JOB_PATH',
  'EXPORT_JOB_FILE_PATH',
  'BANK_FORMATS',
  'BankFormatSchema',
  'EXPORT_FORMATS',
  'ExportFormatSchema',
  'MAX_BANK_FILE_BYTES',
  'ImportQuerySchema',
  'ExportQuerySchema',
  'BankJobParamsSchema',
  'BANK_JOB_STATUSES',
  // openapi
  'API_BASE_PATH',
  'buildOpenApiDocument',
] as const;

describe('@assaybank/contracts', () => {
  it('names itself with the workspace name declared in package.json', () => {
    expect(contracts.WORKSPACE_NAME).toBe('@assaybank/contracts');
  });

  it('exports exactly the agreed surface, no more and no less', () => {
    expect(Object.keys(contracts).sort()).toEqual([...PUBLIC_SURFACE].sort());
  });

  it('performs no I/O and reads no environment variable (CODE-GRAPH L3)', async () => {
    const sources = await Promise.all(
      [
        'primitives',
        'ids',
        'errors',
        'parse',
        'org-settings',
        'audience',
        'questions',
        'openapi',
        'openapi-extension',
        'index',
      ].map(async (name) => {
        const { readFile } = await import('node:fs/promises');
        const url = new URL(`./${name}.ts`, import.meta.url);
        return [name, await readFile(url, 'utf8')] as const;
      }),
    );

    for (const [name, source] of sources) {
      expect(source, name).not.toMatch(/process\.env/);
      expect(source, name).not.toMatch(/\bfrom '(node:|fs|http|https|net|dns)/);
      expect(source, name).not.toMatch(/from '@assaybank\//);
      expect(source, name).not.toMatch(/Date\.now\(\)|new Date\(\)/);
    }
  });
});
