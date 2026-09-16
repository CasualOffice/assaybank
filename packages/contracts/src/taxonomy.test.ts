/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';

import {
  CreateJobRoleSchema,
  ListJobRolesQuerySchema,
  PutJobRoleSkillsSchema,
  PutQuestionSkillsSchema,
  UpdateJobRoleSchema,
} from './taxonomy.js';

const SKILL_A = '6f1d2c3b-4a59-4e87-9b10-2c3d4e5f6a7b';
const SKILL_B = '7a2e3d4c-5b6a-4f98-8c21-3d4e5f6a7b8c';

describe('ListJobRolesQuerySchema', () => {
  it('reads ?active=false as false — z.coerce.boolean would have made it true', () => {
    expect(ListJobRolesQuerySchema.parse({ active: 'false' }).active).toBe(false);
    expect(ListJobRolesQuerySchema.parse({ active: 'true' }).active).toBe(true);
    expect(ListJobRolesQuerySchema.parse({}).active).toBeUndefined();
  });

  it('refuses anything that is not a literal true or false', () => {
    for (const value of ['0', '1', 'yes', '']) {
      expect(ListJobRolesQuerySchema.safeParse({ active: value }).success).toBe(false);
    }
  });
});

describe('job role bodies', () => {
  it('fixes the code format so imports and templates can refer to a role by it', () => {
    expect(CreateJobRoleSchema.safeParse({ code: 'BE-SDE1', title: 'x' }).success).toBe(true);
    expect(CreateJobRoleSchema.safeParse({ code: 'be-sde1', title: 'x' }).success).toBe(false);
    expect(CreateJobRoleSchema.safeParse({ code: 'BE SDE1', title: 'x' }).success).toBe(false);
  });

  it('refuses a PATCH naming nothing, and a PATCH trying to change the code', () => {
    expect(UpdateJobRoleSchema.safeParse({}).success).toBe(false);
    expect(UpdateJobRoleSchema.safeParse({ code: 'NEW' }).success).toBe(false);
    expect(UpdateJobRoleSchema.safeParse({ is_active: false }).success).toBe(true);
  });
});

describe('replacing skill sets', () => {
  it('refuses the same skill twice rather than guessing which weight was meant', () => {
    expect(
      PutJobRoleSkillsSchema.safeParse([
        { skill_id: SKILL_A, weight: 1 },
        { skill_id: SKILL_A, weight: 2 },
      ]).success,
    ).toBe(false);
    expect(
      PutQuestionSkillsSchema.safeParse([
        { skill_id: SKILL_A, weight: 1 },
        { skill_id: SKILL_B, weight: 2 },
      ]).success,
    ).toBe(true);
  });

  it('defaults a requirement to required', () => {
    const [row] = PutJobRoleSkillsSchema.parse([{ skill_id: SKILL_A, weight: 1 }]);
    expect(row?.is_required).toBe(true);
  });

  it('has no field for tagging a question with a job role (ADR-009)', () => {
    expect(PutQuestionSkillsSchema.safeParse([{ job_role_id: SKILL_A, weight: 1 }]).success).toBe(
      false,
    );
    expect(
      PutQuestionSkillsSchema.safeParse([{ skill_id: SKILL_A, job_role_id: SKILL_B, weight: 1 }])
        .success,
    ).toBe(false);
  });
});
