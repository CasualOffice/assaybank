/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The seed: the permission catalogue, the system roles, and the starter skill taxonomy (H-018).
 *
 * These are **global rows** — `org_id IS NULL` — shared by every tenant. Migration 0002 lets a
 * tenant read them and write none, so this runs as the **object owner**, like a migration and for
 * the same reason: the application role must not be able to grant a permission.
 *
 * ## It is product data, not fixture data
 *
 * A fresh database with no permissions has no working authorisation: `can(principal, action)`
 * fails closed, so every staff route answers `403` and the first administrator of a new
 * installation cannot do anything at all. That is why this ships with the product and is part of
 * `make migrate && make seed`, not something a test writes.
 *
 * ## Idempotent, and it means it
 *
 * Every insert names an arbiter and does nothing on conflict, so a second run writes nothing and
 * says so. For the global rows the arbiter is the partial unique index from migration 0011 — the
 * ordinary `UNIQUE (org_id, key)` does not constrain a NULL `org_id` at all, so without it a
 * second run would silently produce a second copy of the whole taxonomy.
 *
 * What it never does is **update**. A row already there is left exactly as it is, because an
 * organisation may have edited a description or re-pointed a role, and a seed that overwrote that
 * would be a deploy quietly undoing a customer's configuration.
 */

import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

/** One permission, exactly as `permissions` stores it. */
export interface SeedPermission {
  readonly key: string;
  readonly description: string;
}

/**
 * The permission catalogue — the fixed set the product defines (docs/hiring_platform_schema.sql
 * §13). `packages/auth` holds the same list as a closed union for code that can be specific, and
 * a test there asserts the two agree.
 *
 * Migration 0001 writes these rows too, which is what makes a freshly migrated database usable.
 * They are repeated here because a migration that has already run never runs again: a permission
 * added in six months reaches an existing installation through `make seed` and through nothing
 * else. On a database created by 0001 this block therefore writes nothing, and that is correct.
 */
export const SEED_PERMISSIONS: readonly SeedPermission[] = [
  { key: 'question.read', description: 'View the question bank' },
  { key: 'question.write', description: 'Create and edit questions' },
  { key: 'question.publish', description: 'Publish a question version' },
  { key: 'assessment.write', description: 'Create and edit assessments' },
  { key: 'invite.send', description: 'Invite candidates to assessments' },
  { key: 'attempt.read', description: 'View attempts and results' },
  { key: 'attempt.grade', description: 'Manually grade or override scores' },
  { key: 'attempt.void', description: 'Void an attempt for integrity reasons' },
  { key: 'interview.host', description: 'Run live interview sessions' },
  { key: 'report.export', description: 'Export candidate and aggregate reports' },
  { key: 'org.admin', description: 'Manage users, roles and settings' },
];

export interface SeedRole {
  readonly key: string;
  readonly name: string;
  readonly permissions: readonly string[];
}

/**
 * The five staff roles, one per persona in `docs/01-PRD.md` §3 — not a set invented here. An
 * organisation may add its own; these are the ones that exist before anybody configures anything.
 *
 * Least privilege, with two separations worth stating because they are the ones people ask about:
 *
 * - **Publishing is not authoring.** `question.publish` is a distinct permission that
 *   `question.write` does not imply (docs/03 §4), so an organisation can grant a junior author
 *   write without publish. The `question_author` persona is "writes *and reviews* questions", so
 *   the seeded role holds both; the separation is available, not imposed.
 * - **Nobody but an administrator may void an attempt.** Voiding discards a candidate's sitting
 *   and requires a reason (FR-25). A recruiter chasing a schedule should not be able to.
 *
 * `admin` holds everything. The first user of a new organisation has to be able to reach every
 * surface, and an installation that cannot bootstrap itself needs a support ticket to become
 * usable, which is not a property of self-hosted software.
 */
export const SEED_ROLES: readonly SeedRole[] = [
  {
    key: 'admin',
    name: 'Administrator',
    permissions: SEED_PERMISSIONS.map((p) => p.key),
  },
  {
    key: 'question_author',
    name: 'Question author',
    permissions: ['question.read', 'question.write', 'question.publish'],
  },
  {
    key: 'recruiter',
    name: 'Recruiter',
    permissions: [
      'question.read',
      'assessment.write',
      'invite.send',
      'attempt.read',
      'report.export',
    ],
  },
  {
    key: 'interviewer',
    name: 'Interviewer',
    // Grades what they saw, and reads the question during the round. No bank write.
    permissions: ['question.read', 'interview.host', 'attempt.read', 'attempt.grade'],
  },
  {
    key: 'hiring_manager',
    name: 'Hiring manager',
    // Compares candidates and makes the call. Reads results; changes none of them.
    permissions: ['attempt.read', 'report.export'],
  },
];

export interface SeedSkill {
  readonly key: string;
  readonly name: string;
  readonly category: string;
  readonly children?: readonly { readonly key: string; readonly name: string }[];
}

/**
 * A starter taxonomy: two levels, because ADR-009 caps the depth there, and deliberately small.
 *
 * It exists so a new installation can tag a question on day one without inventing a vocabulary
 * first, and so `GET /job-roles/{id}/coverage` has something to report against. It is a starting
 * point an organisation edits — an organisation's own skill with the same key takes precedence
 * over the global one everywhere a key is resolved.
 *
 * Kept short on purpose. A large seeded taxonomy is the taxonomy rot ADR-009 names, delivered
 * pre-built: nobody prunes a list they did not write, and the dead entries make coverage look
 * thinner than the bank actually is.
 */
export const SEED_SKILLS: readonly SeedSkill[] = [
  {
    key: 'python',
    name: 'Python',
    category: 'language',
    children: [
      { key: 'python.asyncio', name: 'asyncio' },
      { key: 'python.typing', name: 'Typing' },
    ],
  },
  {
    key: 'javascript',
    name: 'JavaScript',
    category: 'language',
    children: [
      { key: 'javascript.async', name: 'Asynchronous JavaScript' },
      { key: 'javascript.modules', name: 'Modules' },
    ],
  },
  { key: 'typescript', name: 'TypeScript', category: 'language' },
  { key: 'java', name: 'Java', category: 'language' },
  { key: 'go', name: 'Go', category: 'language' },
  {
    key: 'sql',
    name: 'SQL',
    category: 'language',
    children: [
      { key: 'sql.joins', name: 'Joins' },
      { key: 'sql.window-functions', name: 'Window functions' },
      { key: 'sql.indexing', name: 'Indexing' },
      { key: 'sql.transactions', name: 'Transactions' },
    ],
  },
  {
    key: 'algorithms',
    name: 'Algorithms',
    category: 'cs-fundamentals',
    children: [
      { key: 'algorithms.complexity', name: 'Complexity analysis' },
      { key: 'algorithms.sorting', name: 'Sorting and searching' },
      { key: 'algorithms.graphs', name: 'Graphs' },
      { key: 'algorithms.dynamic-programming', name: 'Dynamic programming' },
    ],
  },
  {
    key: 'data-structures',
    name: 'Data structures',
    category: 'cs-fundamentals',
    children: [
      { key: 'data-structures.trees', name: 'Trees' },
      { key: 'data-structures.hash-maps', name: 'Hash maps' },
    ],
  },
  {
    key: 'concurrency',
    name: 'Concurrency',
    category: 'cs-fundamentals',
    children: [
      { key: 'concurrency.locking', name: 'Locking' },
      { key: 'concurrency.async-io', name: 'Asynchronous I/O' },
    ],
  },
  {
    key: 'system-design',
    name: 'System design',
    category: 'cs-fundamentals',
    children: [
      { key: 'system-design.data-modelling', name: 'Data modelling' },
      { key: 'system-design.caching', name: 'Caching' },
      { key: 'system-design.queues', name: 'Queues and messaging' },
      { key: 'system-design.scaling', name: 'Scaling and availability' },
    ],
  },
  {
    key: 'security',
    name: 'Security',
    category: 'cs-fundamentals',
    children: [
      { key: 'security.authentication', name: 'Authentication and sessions' },
      { key: 'security.injection', name: 'Injection' },
      { key: 'security.secrets', name: 'Secret handling' },
    ],
  },
  {
    key: 'testing',
    name: 'Testing',
    category: 'cs-fundamentals',
    children: [{ key: 'testing.unit', name: 'Unit testing' }],
  },
  { key: 'react', name: 'React', category: 'framework' },
  { key: 'docker', name: 'Docker', category: 'cloud' },
  { key: 'kubernetes', name: 'Kubernetes', category: 'cloud' },
  {
    key: 'observability',
    name: 'Observability',
    category: 'cloud',
    children: [
      { key: 'observability.logging', name: 'Logging' },
      { key: 'observability.metrics', name: 'Metrics' },
    ],
  },
];

/** What a run wrote. Every count is rows *inserted*, so a second run reports zeroes. */
export interface SeedResult {
  readonly permissions: number;
  readonly roles: number;
  readonly rolePermissions: number;
  readonly skills: number;
}

export interface SeedOptions {
  /** The **owner** DSN. Global rows are an owner-level write (migration 0002). */
  readonly url: string;
}

/** Applies the seed. Safe to run repeatedly; a second run writes nothing. */
export async function seed(options: SeedOptions): Promise<SeedResult> {
  const client = postgres(options.url, { max: 1 });
  const db = drizzle(client);

  try {
    return await db.transaction(async (tx) => {
      const counted = async (statement: ReturnType<typeof sql>): Promise<number> =>
        (await tx.execute<{ id?: unknown }>(statement)).length;

      let permissions = 0;
      for (const p of SEED_PERMISSIONS) {
        permissions += await counted(sql`
          INSERT INTO permissions (key, description) VALUES (${p.key}, ${p.description})
          ON CONFLICT (key) DO NOTHING
          RETURNING key
        `);
      }

      let roles = 0;
      let rolePermissions = 0;
      for (const role of SEED_ROLES) {
        roles += await counted(sql`
          INSERT INTO user_roles (org_id, key, name, is_system)
          VALUES (NULL, ${role.key}, ${role.name}, true)
          ON CONFLICT (key) WHERE org_id IS NULL DO NOTHING
          RETURNING id
        `);
        for (const permission of role.permissions) {
          rolePermissions += await counted(sql`
            INSERT INTO user_role_permissions (user_role_id, permission_key)
            SELECT r.id, ${permission} FROM user_roles r
             WHERE r.org_id IS NULL AND r.key = ${role.key}
            ON CONFLICT DO NOTHING
            RETURNING permission_key
          `);
        }
      }

      let skills = 0;
      for (const parent of SEED_SKILLS) {
        skills += await counted(sql`
          INSERT INTO skills (org_id, parent_id, key, name, category)
          VALUES (NULL, NULL, ${parent.key}, ${parent.name}, ${parent.category})
          ON CONFLICT (key) WHERE org_id IS NULL DO NOTHING
          RETURNING id
        `);
        for (const child of parent.children ?? []) {
          // The parent is looked up rather than carried from the insert above, because on a
          // re-run that insert returns nothing and the parent is the row already there.
          skills += await counted(sql`
            INSERT INTO skills (org_id, parent_id, key, name, category)
            SELECT NULL, p.id, ${child.key}, ${child.name}, ${parent.category}
              FROM skills p
             WHERE p.org_id IS NULL AND p.key = ${parent.key}
            ON CONFLICT (key) WHERE org_id IS NULL DO NOTHING
            RETURNING id
          `);
        }
      }

      return { permissions, roles, rolePermissions, skills };
    });
  } finally {
    await client.end();
  }
}
