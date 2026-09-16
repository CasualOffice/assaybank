/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * One real PostgreSQL, migrated, with both application roles usable — for the API's own
 * integration suites.
 *
 * Row-level security, `GRANT`, `SECURITY DEFINER` and `SELECT … FOR UPDATE` do not exist
 * in a fake (docs/17 §8), and the two properties this phase is about — that a redemption
 * is single-use under concurrency, and that its audit row shares the transaction — are
 * properties of the database rather than of the code that calls it. Faking them would
 * prove that the fake is single-use.
 *
 * Seeding goes through the **owner**, which is exempt from its own policies (0002
 * deliberately does not use `FORCE ROW LEVEL SECURITY`). Seeding through the application
 * role would be circular: the thing under test would be deciding what the fixture
 * contains.
 */

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import postgres from 'postgres';

import { hashToken } from '@assaybank/auth';
import {
  AssessmentIdSchema,
  InvitationIdSchema,
  OrgIdSchema,
  SessionIdSchema,
  type AssessmentId,
  type InvitationId,
  type OrgId,
  type SessionId,
} from '@assaybank/contracts';
import { createDb, migrate, type Database } from '@assaybank/db';

/** Pinned to the version docker-compose.yml runs, so the policies are tested on it. */
const POSTGRES_IMAGE = 'postgres:16-alpine';

const OWNER = 'hiring';
const APP_PASSWORD = 'hiring_app_api_test';
const JOB_PASSWORD = 'hiring_job_api_test';

/** A migrated database, plus an owner connection for seeding and for out-of-band reads. */
export interface TestPostgres {
  /** The handle the code under test uses. Application role: policies enforced. */
  readonly db: Database;
  /** The owner connection. Seeds fixtures and asserts on rows the app role cannot see. */
  readonly owner: postgres.Sql;
  stop(): Promise<void>;
}

/** Starts the container, applies every migration, and gives the roles a password. */
export async function startTestPostgres(): Promise<TestPostgres> {
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer(POSTGRES_IMAGE)
    .withDatabase(OWNER)
    .withUsername(OWNER)
    .withPassword(OWNER)
    .start();

  const host = container.getHost();
  const port = container.getPort();
  const ownerUrl = `postgres://${OWNER}:${OWNER}@${host}:${port}/${OWNER}`;

  await migrate({ url: ownerUrl });

  const owner = postgres(ownerUrl, { max: 2 });
  await owner.unsafe(`ALTER ROLE hiring_app WITH PASSWORD '${APP_PASSWORD}'`);
  await owner.unsafe(`ALTER ROLE hiring_job WITH PASSWORD '${JOB_PASSWORD}'`);

  const db = createDb({
    url: `postgres://hiring_app:${APP_PASSWORD}@${host}:${port}/${OWNER}`,
    jobUrl: `postgres://hiring_job:${JOB_PASSWORD}@${host}:${port}/${OWNER}`,
    // More than one, deliberately: two concurrent redemptions must take two connections,
    // or the contention the suite is asserting on would be the pool rather than the row.
    poolMax: 8,
  });

  return {
    db,
    owner,
    stop: async (): Promise<void> => {
      await db.close();
      await owner.end();
      await container.stop();
    },
  };
}

/** What a seeded organisation gives a suite to work with. */
export interface SeededOrg {
  readonly orgId: OrgId;
  readonly label: string;
  readonly assessmentId: AssessmentId;
  readonly invitationId: InvitationId;
  /** The plaintext invitation token. Exists only here and in the test. */
  readonly token: string;
  readonly sessionId: SessionId;
}

/** How a seeded organisation may differ from the ordinary, redeemable case. */
export interface SeedOptions {
  /** Defaults to `published`. `draft` makes the invitation unredeemable. */
  readonly assessmentStatus?: string;
  /** Defaults to seven days ahead. */
  readonly expiresAt?: Date;
  /** Defaults to absent. */
  readonly opensAt?: Date;
  /** Defaults to 1, the schema's own default. */
  readonly maxAttempts?: number;
  /** Defaults to true. False leaves the invitation with no application, and no candidate. */
  readonly withApplication?: boolean;
}

/** Reads the single row a seeding statement returned, or fails loudly. */
function only<T>(rows: readonly T[], what: string): T {
  const first = rows[0];
  if (first === undefined) throw new Error(`the fixture did not create a ${what}`);
  return first;
}

/**
 * One organisation with everything a redemption needs: a candidate, an application, a
 * published assessment with two sections, an invitation whose `token_hash` is the
 * peppered hash of the returned plaintext, and one live interview session.
 */
export async function seedOrg(
  client: postgres.Sql,
  label: string,
  pepper: string,
  options: SeedOptions = {},
): Promise<SeededOrg> {
  const token = `invitation-token-for-${label}-${Math.random().toString(36).slice(2)}`;
  const status = options.assessmentStatus ?? 'published';
  const expiresAt = options.expiresAt ?? new Date(Date.now() + 7 * 24 * 3_600_000);
  const maxAttempts = options.maxAttempts ?? 1;
  const withApplication = options.withApplication ?? true;

  const org = only(
    await client<{ id: string }[]>`
      INSERT INTO organizations (name, slug) VALUES (${label}, ${label}) RETURNING id
    `,
    'organization',
  );

  const user = only(
    await client<{ id: string }[]>`
      INSERT INTO users (org_id, email, full_name)
      VALUES (${org.id}, ${`staff@${label}.example`}, ${`Staff ${label}`})
      RETURNING id
    `,
    'user',
  );

  const jobRole = only(
    await client<{ id: string }[]>`
      INSERT INTO job_roles (org_id, code, title)
      VALUES (${org.id}, 'BE-SDE1', 'Backend Engineer')
      RETURNING id
    `,
    'job role',
  );

  const opening = only(
    await client<{ id: string }[]>`
      INSERT INTO job_openings (org_id, job_role_id, title)
      VALUES (${org.id}, ${jobRole.id}, 'Backend Engineer')
      RETURNING id
    `,
    'job opening',
  );

  const candidate = only(
    await client<{ id: string }[]>`
      INSERT INTO candidates (org_id, email, full_name)
      VALUES (${org.id}, ${`candidate@${label}.example`}, ${`Candidate ${label}`})
      RETURNING id
    `,
    'candidate',
  );

  const application = only(
    await client<{ id: string }[]>`
      INSERT INTO applications (org_id, candidate_id, job_opening_id)
      VALUES (${org.id}, ${candidate.id}, ${opening.id})
      RETURNING id
    `,
    'application',
  );

  const assessment = only(
    await client<{ id: string }[]>`
      INSERT INTO assessments (org_id, name, duration_seconds, status, version_no, created_by)
      VALUES (${org.id}, ${`Screening ${label}`}, 3600, ${status}, 4, ${user.id})
      RETURNING id
    `,
    'assessment',
  );

  for (const ordinal of [1, 2]) {
    // No `org_id`: `assessment_sections` is isolated through its assessment rather than
    // by a tenant key of its own (0002, group B), and `kind` is an optional homogeneity
    // constraint the redemption never reads.
    await client`
      INSERT INTO assessment_sections (assessment_id, ordinal, name)
      VALUES (${assessment.id}, ${ordinal}, ${`Section ${ordinal}`})
    `;
  }

  const invitation = only(
    await client<{ id: string }[]>`
      INSERT INTO invitations (
        org_id, application_id, assessment_id, token_hash, opens_at, expires_at,
        max_attempts, sent_at, created_by
      )
      VALUES (
        ${org.id},
        ${withApplication ? application.id : null},
        ${assessment.id},
        ${hashToken(token, pepper)},
        ${options.opensAt ?? null},
        ${expiresAt},
        ${maxAttempts},
        now(),
        ${user.id}
      )
      RETURNING id
    `,
    'invitation',
  );

  const session = only(
    await client<{ id: string }[]>`
      INSERT INTO interview_sessions (org_id, room_code, status, created_by)
      VALUES (${org.id}, ${`room-${label}`}, 'live', ${user.id})
      RETURNING id
    `,
    'interview session',
  );

  return {
    orgId: OrgIdSchema.parse(org.id),
    label,
    assessmentId: AssessmentIdSchema.parse(assessment.id),
    invitationId: InvitationIdSchema.parse(invitation.id),
    token,
    sessionId: SessionIdSchema.parse(session.id),
  };
}
