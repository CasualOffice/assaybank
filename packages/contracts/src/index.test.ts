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
      ['primitives', 'ids', 'errors', 'openapi', 'openapi-extension', 'index'].map(async (name) => {
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
