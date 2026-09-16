/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * One organisation with exactly one row in every table that carries `org_id`.
 *
 * The shape the isolation suite needs: two of these, and every generated case becomes
 * "org A must not see org B's row, and org B must see its own". The second half is the
 * positive control, and it is why the seed writes to *every* tenant table rather than to
 * the interesting ones — a table seeded with nothing gives a zero-rows assertion that
 * passes whether or not a policy exists.
 *
 * Written by the owner, which is exempt from its own policies (0002 deliberately does not
 * use FORCE ROW LEVEL SECURITY). Seeding through the application role would be circular:
 * the thing under test would decide what the fixture contains.
 *
 * A test fixture, not a product seeder. `make seed` is a different thing that lives in
 * `src/` when it arrives.
 */

import type postgres from 'postgres';

import { OrgIdSchema, type OrgId } from '@assaybank/contracts';

import { required } from './postgres-fixture.js';

/** The identifiers a suite needs to hang further rows off, or to assert against. */
export interface SeededOrg {
  readonly orgId: OrgId;
  readonly label: string;
  readonly userId: string;
  readonly candidateId: string;
  readonly assessmentId: string;
  readonly jobRoleId: string;
  readonly jobOpeningId: string;
  readonly questionId: string;
}

export async function seedOrg(client: postgres.Sql, label: string): Promise<SeededOrg> {
  const [org] = await client<{ id: string }[]>`
    INSERT INTO organizations (name, slug) VALUES (${label}, ${label}) RETURNING id
  `;
  const orgId = required(org, `organizations row for ${label}`).id;

  const [user] = await client<{ id: string }[]>`
    INSERT INTO users (org_id, email, full_name)
    VALUES (${orgId}, ${`staff@${label}.example`}, ${`Staff ${label}`})
    RETURNING id
  `;
  const userId = required(user, `users row for ${label}`).id;

  await client`
    INSERT INTO user_roles (org_id, key, name) VALUES (${orgId}, 'recruiter', 'Recruiter')
  `;

  const [skill] = await client<{ id: string }[]>`
    INSERT INTO skills (org_id, key, name) VALUES (${orgId}, ${`python-${label}`}, 'Python')
    RETURNING id
  `;
  required(skill, `skills row for ${label}`);

  const [jobRole] = await client<{ id: string }[]>`
    INSERT INTO job_roles (org_id, code, title) VALUES (${orgId}, 'BE-SDE1', 'Backend Engineer')
    RETURNING id
  `;
  const jobRoleId = required(jobRole, `job_roles row for ${label}`).id;

  const [opening] = await client<{ id: string }[]>`
    INSERT INTO job_openings (org_id, job_role_id, title)
    VALUES (${orgId}, ${jobRoleId}, 'Backend Engineer')
    RETURNING id
  `;
  const jobOpeningId = required(opening, `job_openings row for ${label}`).id;

  const [question] = await client<{ id: string }[]>`
    INSERT INTO questions (org_id, kind, status, author_id)
    VALUES (${orgId}, 'mcq_single', 'published', ${userId})
    RETURNING id
  `;
  const questionId = required(question, `questions row for ${label}`).id;

  const [assessment] = await client<{ id: string }[]>`
    INSERT INTO assessments (org_id, name, duration_seconds, created_by)
    VALUES (${orgId}, 'Screening', 3600, ${userId})
    RETURNING id
  `;
  const assessmentId = required(assessment, `assessments row for ${label}`).id;

  const [candidate] = await client<{ id: string }[]>`
    INSERT INTO candidates (org_id, email, full_name)
    VALUES (${orgId}, ${`candidate@${label}.example`}, ${`Candidate ${label}`})
    RETURNING id
  `;
  const candidateId = required(candidate, `candidates row for ${label}`).id;

  await client`
    INSERT INTO applications (org_id, candidate_id, job_opening_id)
    VALUES (${orgId}, ${candidateId}, ${jobOpeningId})
  `;

  await client`
    INSERT INTO invitations (org_id, assessment_id, token_hash, expires_at, created_by)
    VALUES (${orgId}, ${assessmentId}, ${`hash-${label}`}, now() + interval '7 days', ${userId})
  `;

  await client`
    INSERT INTO attempts (org_id, candidate_id, assessment_id, assessment_version)
    VALUES (${orgId}, ${candidateId}, ${assessmentId}, 1)
  `;

  await client`
    INSERT INTO submissions (org_id, language, language_version, source_code)
    VALUES (${orgId}, 'python', '3.12.0', 'print(1)')
  `;

  await client`
    INSERT INTO interview_sessions (org_id, room_code, created_by)
    VALUES (${orgId}, ${`room-${label}`}, ${userId})
  `;

  await client`
    INSERT INTO scorecard_templates (org_id, name) VALUES (${orgId}, 'Backend loop')
  `;

  await client`
    INSERT INTO audit_log (org_id, actor_user_id, action, entity_type)
    VALUES (${orgId}, ${userId}, 'question.publish', 'question')
  `;

  // The staff identity pair (migration 0006). Seeded as the owner like everything else
  // here, so org_id is given explicitly rather than falling to its
  // `DEFAULT public.app_current_org()` — the seeder is not inside withOrg() and the
  // default would evaluate to NULL.
  await client`
    INSERT INTO staff_accounts (org_id, user_id, account_id, provider_id, password)
    VALUES (${orgId}, ${userId}, ${userId}, 'credential', ${`$argon2id$not-a-real-hash-${label}`})
  `;

  await client`
    INSERT INTO staff_verifications (org_id, identifier, value, expires_at)
    VALUES (${orgId}, ${`state-${label}`}, ${`verifier-${label}`}, now() + interval '5 minutes')
  `;

  return {
    // Parsed, not cast: the fixture earns the brand the same way a request does, so a
    // seed that somehow produced a non-UUID fails here rather than deep inside a policy.
    orgId: OrgIdSchema.parse(orgId),
    label,
    userId,
    candidateId,
    assessmentId,
    jobRoleId,
    jobOpeningId,
    questionId,
  };
}
