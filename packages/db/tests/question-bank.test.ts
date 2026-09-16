/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The question-bank repository, against a real PostgreSQL.
 *
 * Three properties are asserted here and none of them exists in a fake (docs/17 §8):
 *
 * 1. **ADR-003 is enforced by the database, as the application role.** Migration 0001
 *    refuses an `UPDATE` of a published `question_versions` row; 0007 extends that to the
 *    four child tables that carry what the version *means* — the option that is correct,
 *    the reference solution, the hidden expectations, the answer keys. Both are exercised
 *    as `hiring_app`, which is the role the API runs as, rather than as the owner. The
 *    P2 exit gate asks for exactly this: *"a published version cannot be mutated by any
 *    path, including direct SQL as the app role"*.
 * 2. **Copy-forward writes what the merge produced.** `version-content.test.ts` proves the
 *    merge; this proves the rows. The distinction matters because a correct merge written
 *    through a wrong `INSERT` is still a lost test case.
 * 3. **Cursor pagination is stable under concurrent insertion.** Which is the entire
 *    reason docs/03 §2 mandates it, and cannot be demonstrated without a table.
 *
 * Seeding goes through the **owner**, which is exempt from its own policies (0002
 * deliberately does not use `FORCE ROW LEVEL SECURITY`). Seeding through the application
 * role would be circular: the thing under test would be deciding what the fixture
 * contains.
 */

import { sql } from 'drizzle-orm';
import { getContainerRuntimeClient } from 'testcontainers';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  OrgIdSchema,
  SkillIdSchema,
  type ListQuestionsQuery,
  type OrgId,
  type QuestionId,
  type QuestionVersionInput,
} from '@assaybank/contracts';

import {
  archiveQuestion,
  createDb,
  createQuestion,
  createVersion,
  getLatestVersion,
  getQuestionWithCurrentVersion,
  getVersion,
  listQuestions,
  listVersions,
  mergeVersionContent,
  migrate,
  publishVersion,
  restoreQuestion,
  retireQuestion,
  setQuestionSkills,
  setQuestionStatus,
  updateVersion,
  withOrg,
  type Database,
} from '../src/index.js';

/** Pinned to the version docker-compose.yml runs, so the triggers are tested on it. */
const POSTGRES_IMAGE = 'postgres:16-alpine';

const OWNER_USER = 'hiring';
const OWNER_PASSWORD = 'hiring';
const DATABASE = 'hiring';
const APP_PASSWORD = 'hiring_app_bank_test';
const JOB_PASSWORD = 'hiring_job_bank_test';

/** Injected, never the wall clock (ADR-006, docs/17 §8). */
const AT = new Date('2026-10-20T09:00:00.000Z');
const LATER = new Date('2026-10-21T11:30:00.000Z');

const runtime = await (async (): Promise<{ available: boolean; reason: string }> => {
  try {
    await getContainerRuntimeClient();
    return { available: true, reason: '' };
  } catch (error) {
    return { available: false, reason: error instanceof Error ? error.message : String(error) };
  }
})();

if (!runtime.available) {
  process.stderr.write(
    `\n[question-bank.test.ts] SKIPPED: no container runtime is reachable, so the ADR-003\n` +
      `triggers cannot be exercised. Start Docker (or Colima, or Podman) and re-run.\n` +
      `Reason reported by testcontainers: ${runtime.reason}\n\n`,
  );
}

const SUITE_NAME = runtime.available
  ? 'the question bank (ADR-003)'
  : `the question bank (ADR-003) — SKIPPED, no container runtime: ${runtime.reason}`;

let container: StartedPostgreSqlContainer | undefined;
let owner: postgres.Sql | undefined;
let db: Database | undefined;
let acme: OrgId | undefined;
let rival: OrgId | undefined;

/** Fails loudly rather than letting an undefined fixture turn into a vacuous pass. */
function required<T>(value: T | undefined, name: string): T {
  if (value === undefined) {
    throw new Error(`fixture ${name} was not initialised; the suite cannot assert anything`);
  }
  return value;
}

function database(): Database {
  return required(db, 'database');
}

function ownerSql(): postgres.Sql {
  return required(owner, 'owner connection');
}

/** Creates one organisation through the owner, and returns its id. */
async function seedOrg(slug: string): Promise<OrgId> {
  const [row] = await ownerSql()<{ id: string }[]>`
    INSERT INTO organizations (name, slug) VALUES (${slug}, ${slug}) RETURNING id
  `;
  return OrgIdSchema.parse(required(row, `organizations row for ${slug}`).id);
}

/** The default list query, with every filter off. */
function listAll(overrides: Partial<ListQuestionsQuery> = {}): ListQuestionsQuery {
  return { limit: 50, ...overrides };
}

/** Creates a question with a first version, through the repository under test. */
async function seedQuestion(
  org: OrgId,
  kind: 'mcq_single' | 'coding' | 'short_answer' | 'subjective',
  input: QuestionVersionInput,
): Promise<QuestionId> {
  return withOrg(database(), org, async (tx) => {
    const question = await createQuestion(tx, { orgId: org, kind });
    const content = mergeVersionContent(undefined, input);
    await createVersion(tx, question.id, content, { at: AT });
    return question.id;
  });
}

/** Moves a question to `published` with version 1 published, the ordinary happy path. */
async function seedPublished(
  org: OrgId,
  kind: 'mcq_single' | 'coding' | 'short_answer' | 'subjective',
  input: QuestionVersionInput,
): Promise<QuestionId> {
  const questionId = await seedQuestion(org, kind, input);
  await withOrg(database(), org, async (tx) => {
    await setQuestionStatus(tx, questionId, 'review');
    await publishVersion(tx, questionId, 1, AT);
    await setQuestionStatus(tx, questionId, 'published');
  });
  return questionId;
}

/**
 * True when `error`, or anything in its `cause` chain, is the ADR-003 refusal.
 *
 * The chain is walked because Drizzle wraps a driver error in a `DrizzleQueryError` whose
 * own message is `Failed query: …` — so asserting on the top-level message would assert
 * that *a* query failed rather than that the trigger refused it, and would keep passing if
 * the statement started failing for a typo instead.
 */
function isImmutabilityRefusal(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && typeof current === 'object' && current !== null; depth += 1) {
    if ('message' in current && typeof current.message === 'string' && /immutable/iu.test(current.message)) {
      return true;
    }
    current = 'cause' in current ? current.cause : undefined;
  }
  return false;
}

/** Asserts that `work` is refused by the ADR-003 trigger, and not merely that it failed. */
async function expectImmutabilityRefusal(work: Promise<unknown>): Promise<void> {
  let thrown: unknown;
  try {
    await work;
  } catch (error) {
    thrown = error;
  }
  expect(thrown, 'the statement was expected to be refused, and was not').toBeDefined();
  expect(isImmutabilityRefusal(thrown), `not an ADR-003 refusal: ${String(thrown)}`).toBe(true);
}

/** The `mcq_options` row of a version, read through the owner so policies do not hide it. */
async function optionRows(versionId: string): Promise<{ id: string; is_correct: boolean }[]> {
  return ownerSql()<{ id: string; is_correct: boolean }[]>`
    SELECT id, is_correct FROM mcq_options WHERE question_version_id = ${versionId}
  `;
}

describe.skipIf(!runtime.available)(SUITE_NAME, () => {
  beforeAll(async () => {
    container = await new PostgreSqlContainer(POSTGRES_IMAGE)
      .withDatabase(DATABASE)
      .withUsername(OWNER_USER)
      .withPassword(OWNER_PASSWORD)
      .start();

    const host = container.getHost();
    const port = container.getPort();
    const ownerUrl = `postgres://${OWNER_USER}:${OWNER_PASSWORD}@${host}:${port}/${DATABASE}`;

    await migrate({ url: ownerUrl });

    owner = postgres(ownerUrl, { max: 2 });
    await owner.unsafe(`ALTER ROLE hiring_app WITH PASSWORD '${APP_PASSWORD}'`);
    await owner.unsafe(`ALTER ROLE hiring_job WITH PASSWORD '${JOB_PASSWORD}'`);

    db = createDb({
      url: `postgres://hiring_app:${APP_PASSWORD}@${host}:${port}/${DATABASE}`,
      jobUrl: `postgres://hiring_job:${JOB_PASSWORD}@${host}:${port}/${DATABASE}`,
      poolMax: 8,
    });

    acme = await seedOrg('acme');
    rival = await seedOrg('rival');
  }, 300_000);

  afterAll(async () => {
    await db?.close();
    await owner?.end();
    await container?.stop();
  });

  // ---- creation and the first version ------------------------------------

  describe('createQuestion', () => {
    it('creates an empty question in draft, with no version yet', async () => {
      const org = required(acme, 'acme');
      const question = await withOrg(database(), org, (tx) =>
        createQuestion(tx, { orgId: org, kind: 'coding', sourceLicense: 'MIT' }),
      );

      expect(question.status).toBe('draft');
      expect(question.kind).toBe('coding');
      expect(question.source_license).toBe('MIT');
      expect(question.current_version).toBeNull();
      expect(question.exposure_count).toBe(0);
      expect(question.archived_at).toBeNull();
    });
  });

  describe('createVersion', () => {
    it('writes the whole of a version, children included', async () => {
      const org = required(acme, 'acme');
      const questionId = await seedQuestion(org, 'coding', {
        prompt_md: 'Reverse a linked list.',
        difficulty: 4,
        est_seconds: 900,
        max_score: 10,
        negative_score: 2.5,
        coding_spec: {
          allowed_languages: ['python'],
          solution_code: { python: 'return xs[::-1]' },
          time_limit_ms: 3000,
        },
        test_cases: [
          { stdin: '1 2 3', expected_stdout: '3 2 1', is_sample: true },
          { stdin: '9 8 7', expected_stdout: '7 8 9', is_sample: false, weight: 2 },
        ],
      });

      const version = await withOrg(database(), org, (tx) => getVersion(tx, questionId, 1));

      expect(version?.version_no).toBe(1);
      expect(version?.published_at).toBeNull();
      expect(version?.difficulty).toBe(4);
      // Numerics come back from the driver as strings; the repository is the boundary
      // that turns them into numbers, so nothing above it has to wonder.
      expect(version?.max_score).toBe(10);
      expect(version?.negative_score).toBe(2.5);
      expect(version?.coding_spec?.solution_code).toStrictEqual({ python: 'return xs[::-1]' });
      expect(version?.test_cases).toHaveLength(2);
      expect(version?.test_cases[1]?.weight).toBe(2);
      // Array order is the ordinal, so an author's ordering survives the round trip.
      expect(version?.test_cases.map((c) => c.ordinal)).toStrictEqual([1, 2]);
    });

    it('does not move current_version_id: a draft is never the version served', async () => {
      const org = required(acme, 'acme');
      const questionId = await seedQuestion(org, 'subjective', {
        prompt_md: 'Design a URL shortener.',
        difficulty: 3,
      });

      const question = await withOrg(database(), org, (tx) =>
        getQuestionWithCurrentVersion(tx, questionId),
      );

      // The version exists and the pointer does not follow it. That is what makes "a
      // candidate was served an unpublished version" unreachable rather than unlikely.
      expect(question?.current_version).toBeNull();
      const latest = await withOrg(database(), org, (tx) => getLatestVersion(tx, questionId));
      expect(latest?.version_no).toBe(1);
    });

    it('numbers versions consecutively and copies forward what the body omits', async () => {
      const org = required(acme, 'acme');
      const questionId = await seedQuestion(org, 'mcq_single', {
        prompt_md: 'What is 2 + 2?',
        difficulty: 1,
        explanation_md: 'Addition.',
        options: [
          { body_md: '4', is_correct: true, rationale_md: 'Correct.' },
          { body_md: '5', is_correct: false },
        ],
      });

      const second = await withOrg(database(), org, async (tx) => {
        const prior = await getLatestVersion(tx, questionId);
        // One field named. Everything else — the explanation, both options with their
        // answer key and rationale — has to survive untouched, or ADR-003's "every edit is
        // a new version" is a tax authors will find a way around.
        const content = mergeVersionContent(prior, { prompt_md: 'What is two plus two?' });
        return createVersion(tx, questionId, content, { at: LATER });
      });

      expect(second.version_no).toBe(2);
      expect(second.prompt_md).toBe('What is two plus two?');
      expect(second.explanation_md).toBe('Addition.');
      expect(second.difficulty).toBe(1);
      expect(second.options).toHaveLength(2);
      expect(second.options[0]?.body_md).toBe('4');
      expect(second.options[0]?.is_correct).toBe(true);
      expect(second.options[0]?.rationale_md).toBe('Correct.');
      // New rows, not the old ones: an option belongs to exactly one version.
      const first = await withOrg(database(), org, (tx) => getVersion(tx, questionId, 1));
      expect(second.options[0]?.id).not.toBe(first?.options[0]?.id);
    });
  });

  // ---- ADR-003 ------------------------------------------------------------

  describe('ADR-003 — a published version is immutable', () => {
    it('publishes exactly once and points the question at the published version', async () => {
      const org = required(acme, 'acme');
      const questionId = await seedQuestion(org, 'short_answer', {
        prompt_md: 'Name the capital of France.',
        difficulty: 1,
        answer_keys: [{ match_type: 'ci', pattern: 'paris' }],
      });

      const published = await withOrg(database(), org, (tx) =>
        publishVersion(tx, questionId, 1, AT),
      );
      expect(published?.published_at).toStrictEqual(AT);

      const question = await withOrg(database(), org, (tx) =>
        getQuestionWithCurrentVersion(tx, questionId),
      );
      expect(question?.current_version?.id).toBe(published?.id);

      // A second publish changes no rows rather than re-stamping a new instant onto a
      // version candidates may already have been graded against.
      const again = await withOrg(database(), org, (tx) => publishVersion(tx, questionId, 1, LATER));
      expect(again).toBeUndefined();

      const unchanged = await withOrg(database(), org, (tx) => getVersion(tx, questionId, 1));
      expect(unchanged?.published_at).toStrictEqual(AT);
    });

    it('refuses updateVersion against a published version, returning undefined not throwing', async () => {
      const org = required(acme, 'acme');
      const questionId = await seedPublished(org, 'mcq_single', {
        prompt_md: 'Which is prime?',
        difficulty: 2,
        options: [{ body_md: '7', is_correct: true }],
      });

      const version = await withOrg(database(), org, (tx) => getVersion(tx, questionId, 1));
      const content = mergeVersionContent(version, { prompt_md: 'Which of these is prime?' });

      // The guard, not the trigger: zero rows changed, no aborted transaction, and the API
      // above answers 409 version_immutable rather than 500.
      const refused = await withOrg(database(), org, (tx) =>
        updateVersion(tx, questionId, 1, content),
      );
      expect(refused).toBeUndefined();

      const unchanged = await withOrg(database(), org, (tx) => getVersion(tx, questionId, 1));
      expect(unchanged?.prompt_md).toBe('Which is prime?');
    });

    it('refuses direct SQL against a published version, as the application role', async () => {
      // The P2 exit criterion, verbatim: "a published version cannot be mutated by any
      // path, including direct SQL as the app role". No repository function in sight.
      const org = required(acme, 'acme');
      const questionId = await seedPublished(org, 'subjective', {
        prompt_md: 'Design a rate limiter.',
        difficulty: 4,
      });

      const version = await withOrg(database(), org, (tx) => getVersion(tx, questionId, 1));
      const versionId = required(version, 'the published version').id;

      await expectImmutabilityRefusal(
        withOrg(database(), org, async (tx) =>
          tx.execute(sql`
            UPDATE question_versions SET prompt_md = 'tampered' WHERE id = ${versionId}
          `),
        ),
      );

      const unchanged = await withOrg(database(), org, (tx) => getVersion(tx, questionId, 1));
      expect(unchanged?.prompt_md).toBe('Design a rate limiter.');
    });

    it('refuses to change which option is correct, once the version is published', async () => {
      // The window 0001 left open and 0007 closes. The `question_versions` row would be
      // untouched and byte-identical, and the meaning of the version would have changed
      // underneath every attempt already graded against it.
      const org = required(acme, 'acme');
      const questionId = await seedPublished(org, 'mcq_single', {
        prompt_md: 'Which is even?',
        difficulty: 1,
        options: [
          { body_md: '2', is_correct: true },
          { body_md: '3', is_correct: false },
        ],
      });

      const version = await withOrg(database(), org, (tx) => getVersion(tx, questionId, 1));
      const versionId = required(version, 'the published version').id;
      const options = await optionRows(versionId);
      const wrongOption = required(
        options.find((option) => !option.is_correct),
        'the incorrect option',
      );

      await expectImmutabilityRefusal(
        ownerSql()`UPDATE mcq_options SET is_correct = true WHERE id = ${wrongOption.id}`,
      );

      await expectImmutabilityRefusal(
        ownerSql()`DELETE FROM mcq_options WHERE id = ${wrongOption.id}`,
      );

      await expectImmutabilityRefusal(
        ownerSql()`
          INSERT INTO mcq_options (question_version_id, ordinal, body_md, is_correct)
          VALUES (${versionId}, 99, 'a late option', true)
        `,
      );

      // And nothing moved.
      expect(await optionRows(versionId)).toHaveLength(2);
    });

    it('refuses to add a hidden test case to a published coding question', async () => {
      const org = required(acme, 'acme');
      const questionId = await seedPublished(org, 'coding', {
        prompt_md: 'Sum a list.',
        difficulty: 2,
        coding_spec: { allowed_languages: ['python'] },
        test_cases: [{ stdin: '1 2', expected_stdout: '3', is_sample: true }],
      });

      const version = await withOrg(database(), org, (tx) => getVersion(tx, questionId, 1));
      const versionId = required(version, 'the published version').id;

      await expectImmutabilityRefusal(
        ownerSql()`
          INSERT INTO test_cases (question_version_id, ordinal, stdin, expected_stdout, is_sample)
          VALUES (${versionId}, 50, '5 5', '10', false)
        `,
      );

      await expectImmutabilityRefusal(
        ownerSql()`
          UPDATE coding_specs SET solution_code = '{}'::jsonb
           WHERE question_version_id = ${versionId}
        `,
      );
    });

    it('still lets an erasure cascade take a published version and its children', async () => {
      // The reason 0001 exempts DELETE, honoured rather than contradicted: organisation
      // deletion and GDPR erasure (docs/11 §6) cascade through these tables, and a trigger
      // that blocked them would turn a legal obligation into an outage. The cascade works
      // because the parent version is already gone by the time the child trigger fires.
      const org = await seedOrg('erasable');
      const questionId = await seedPublished(org, 'mcq_single', {
        prompt_md: 'Erase me.',
        difficulty: 1,
        options: [{ body_md: 'yes', is_correct: true }],
      });

      const version = await withOrg(database(), org, (tx) => getVersion(tx, questionId, 1));
      const versionId = required(version, 'the published version').id;
      expect(await optionRows(versionId)).toHaveLength(1);

      await ownerSql()`DELETE FROM organizations WHERE id = ${org}`;

      expect(await optionRows(versionId)).toHaveLength(0);
      const [remaining] = await ownerSql()<{ n: string }[]>`
        SELECT count(*)::text AS n FROM question_versions WHERE id = ${versionId}
      `;
      expect(required(remaining, 'the count row').n).toBe('0');
    });

    it('lets a new version be written while an older one stays frozen', async () => {
      // The whole point of the invariant: an edit is not blocked, it is redirected.
      const org = required(acme, 'acme');
      const questionId = await seedPublished(org, 'mcq_single', {
        prompt_md: 'Which is the largest?',
        difficulty: 2,
        options: [
          { body_md: '10', is_correct: true },
          { body_md: '9', is_correct: false },
        ],
      });

      const second = await withOrg(database(), org, async (tx) => {
        const prior = await getLatestVersion(tx, questionId);
        const content = mergeVersionContent(prior, { prompt_md: 'Which of these is largest?' });
        return createVersion(tx, questionId, content, { at: LATER });
      });

      expect(second.version_no).toBe(2);
      expect(second.published_at).toBeNull();
      expect(second.options).toHaveLength(2);

      // The frozen version is untouched, and it is still the one an assessment would draw
      // until somebody publishes the new one.
      const first = await withOrg(database(), org, (tx) => getVersion(tx, questionId, 1));
      expect(first?.prompt_md).toBe('Which is the largest?');

      const question = await withOrg(database(), org, (tx) =>
        getQuestionWithCurrentVersion(tx, questionId),
      );
      expect(question?.current_version?.version_no).toBe(1);

      // Publishing the new one moves the pointer, and only then.
      await withOrg(database(), org, (tx) => publishVersion(tx, questionId, 2, LATER));
      const after = await withOrg(database(), org, (tx) =>
        getQuestionWithCurrentVersion(tx, questionId),
      );
      expect(after?.current_version?.version_no).toBe(2);
      expect(after?.current_version?.prompt_md).toBe('Which of these is largest?');
    });

    it('lets a draft version be edited in place, children and all', async () => {
      const org = required(acme, 'acme');
      const questionId = await seedQuestion(org, 'mcq_single', {
        prompt_md: 'Draft question.',
        difficulty: 2,
        options: [
          { body_md: 'a', is_correct: true },
          { body_md: 'b', is_correct: false },
        ],
      });

      const edited = await withOrg(database(), org, async (tx) => {
        const before = await getVersion(tx, questionId, 1);
        const content = mergeVersionContent(before, {
          options: [{ body_md: 'the only option', is_correct: true }],
        });
        return updateVersion(tx, questionId, 1, content);
      });

      expect(edited?.version_no).toBe(1);
      expect(edited?.options).toHaveLength(1);
      expect(edited?.options[0]?.body_md).toBe('the only option');
      expect(edited?.prompt_md).toBe('Draft question.');
    });
  });

  // ---- lifecycle ----------------------------------------------------------

  describe('retiring and archiving', () => {
    it('retires without deleting anything', async () => {
      const org = required(acme, 'acme');
      const questionId = await seedPublished(org, 'short_answer', {
        prompt_md: 'Over-exposed question.',
        difficulty: 2,
        answer_keys: [{ match_type: 'exact', pattern: '42' }],
      });

      const retired = await withOrg(database(), org, (tx) => retireQuestion(tx, questionId));

      expect(retired?.status).toBe('retired');
      // Every version, every answer key and every score that referenced them survives.
      // That is the whole difference between retiring an item and losing the ability to
      // defend a hiring decision made with it.
      expect(retired?.current_version?.answer_keys).toHaveLength(1);
      const versions = await withOrg(database(), org, (tx) =>
        listVersions(tx, questionId, { limit: 10 }),
      );
      expect(versions.rows).toHaveLength(1);
    });

    it('archives idempotently, so a double click cannot restart a retention clock', async () => {
      const org = required(acme, 'acme');
      const questionId = await seedQuestion(org, 'subjective', {
        prompt_md: 'A duplicate.',
        difficulty: 3,
      });

      const first = await withOrg(database(), org, (tx) => archiveQuestion(tx, questionId, AT));
      expect(first?.archived_at).toStrictEqual(AT);

      const second = await withOrg(database(), org, (tx) => archiveQuestion(tx, questionId, LATER));
      expect(second).toBeUndefined();

      const still = await withOrg(database(), org, (tx) =>
        getQuestionWithCurrentVersion(tx, questionId, { includeArchived: true }),
      );
      expect(still?.archived_at).toStrictEqual(AT);
    });

    it('hides an archived question from the list, and restores it', async () => {
      const org = await seedOrg('archival');
      const questionId = await seedQuestion(org, 'subjective', {
        prompt_md: 'Hide me.',
        difficulty: 3,
      });

      await withOrg(database(), org, (tx) => archiveQuestion(tx, questionId, AT));

      const hidden = await withOrg(database(), org, (tx) => listQuestions(tx, listAll()));
      expect(hidden.rows).toHaveLength(0);

      const shown = await withOrg(database(), org, (tx) =>
        listQuestions(tx, listAll({ include_archived: true })),
      );
      expect(shown.rows.map((row) => row.id)).toStrictEqual([questionId]);

      await withOrg(database(), org, (tx) => restoreQuestion(tx, questionId));
      const back = await withOrg(database(), org, (tx) => listQuestions(tx, listAll()));
      expect(back.rows.map((row) => row.id)).toStrictEqual([questionId]);
    });
  });

  // ---- listing ------------------------------------------------------------

  describe('listQuestions', () => {
    let listOrg: OrgId | undefined;
    const created: QuestionId[] = [];

    beforeAll(async () => {
      listOrg = await seedOrg('bank-list');
      const org = listOrg;

      created.push(
        await seedPublished(org, 'coding', {
          prompt_md: 'Balance a set of parentheses.',
          difficulty: 4,
          coding_spec: { allowed_languages: ['python'] },
        }),
      );
      created.push(
        await seedQuestion(org, 'mcq_single', {
          prompt_md: 'Which of these is a prime number?',
          difficulty: 1,
        }),
      );
      created.push(
        await seedQuestion(org, 'subjective', {
          prompt_md: 'Describe an index. 100% of the time.',
          difficulty: 5,
        }),
      );
    }, 120_000);

    it('orders newest first and pages with a cursor that loses nothing', async () => {
      const org = required(listOrg, 'list org');

      const first = await withOrg(database(), org, (tx) => listQuestions(tx, listAll({ limit: 2 })));
      expect(first.rows).toHaveLength(2);
      expect(first.nextCursor).not.toBeNull();

      const second = await withOrg(database(), org, (tx) =>
        listQuestions(tx, listAll({ limit: 2, ...(first.nextCursor === null ? {} : { cursor: first.nextCursor }) })),
      );
      expect(second.rows).toHaveLength(1);
      expect(second.nextCursor).toBeNull();

      const seen = [...first.rows, ...second.rows].map((row) => row.id);
      // Every seeded question exactly once: no duplicate across the boundary and nothing
      // skipped, which is the property offset pagination cannot promise.
      expect([...seen].sort()).toStrictEqual([...created].sort());
    });

    it('hands back real instants, whichever path read the row', async () => {
      // The list is raw SQL — it needs a LATERAL join — and a raw `execute` returns a
      // `timestamptz` as PostgreSQL's own text rendering rather than as a `Date`. That
      // rendering is two characters away from ISO 8601 and fails to parse in both of them,
      // so an unconverted value reaches a serialiser as `Invalid Date` and surfaces three
      // layers up as a 500 on one endpoint. The two paths must agree.
      const org = required(listOrg, 'list org');
      const page = await withOrg(database(), org, (tx) => listQuestions(tx, listAll()));
      const row = required(page.rows[0], 'a listed question');

      expect(row.created_at).toBeInstanceOf(Date);
      expect(Number.isNaN(row.created_at.getTime())).toBe(false);

      const direct = await withOrg(database(), org, (tx) =>
        getQuestionWithCurrentVersion(tx, row.id),
      );
      expect(row.created_at.toISOString()).toBe(direct?.created_at.toISOString());

      const published = page.rows.find((candidate) => candidate.current_published_at !== null);
      expect(published?.current_published_at).toStrictEqual(AT);
    });

    it('serves a stale cursor as the first page rather than as an error', async () => {
      const org = required(listOrg, 'list org');
      const page = await withOrg(database(), org, (tx) =>
        listQuestions(tx, listAll({ cursor: 'not-a-cursor-this-build-made' })),
      );
      expect(page.rows.length).toBeGreaterThan(0);
    });

    it('shows the latest version for a draft question the pointer does not follow', async () => {
      const org = required(listOrg, 'list org');
      const page = await withOrg(database(), org, (tx) =>
        listQuestions(tx, listAll({ status: 'draft' })),
      );

      const drafts = page.rows;
      expect(drafts.length).toBeGreaterThan(0);
      for (const row of drafts) {
        // A bank list that showed nothing for a question somebody is still writing would
        // be useless during exactly the week an author is using it.
        expect(row.current_version_id).toBeNull();
        expect(row.latest_version_no).toBe(1);
        expect(row.latest_prompt_md).not.toBeNull();
        expect(row.latest_difficulty).not.toBeNull();
      }
    });

    it('filters by kind, status and difficulty', async () => {
      const org = required(listOrg, 'list org');

      const coding = await withOrg(database(), org, (tx) =>
        listQuestions(tx, listAll({ kind: 'coding' })),
      );
      expect(coding.rows.map((row) => row.kind)).toStrictEqual(['coding']);

      const published = await withOrg(database(), org, (tx) =>
        listQuestions(tx, listAll({ status: 'published' })),
      );
      expect(published.rows).toHaveLength(1);
      expect(published.rows[0]?.current_version_id).not.toBeNull();

      const hard = await withOrg(database(), org, (tx) =>
        listQuestions(tx, listAll({ difficulty: 5 })),
      );
      expect(hard.rows).toHaveLength(1);
      expect(hard.rows[0]?.latest_difficulty).toBe(5);
    });

    it('searches prompts case-insensitively', async () => {
      const org = required(listOrg, 'list org');
      const page = await withOrg(database(), org, (tx) =>
        listQuestions(tx, listAll({ q: 'PARENTHESES' })),
      );
      expect(page.rows).toHaveLength(1);
      expect(page.rows[0]?.kind).toBe('coding');
    });

    it('treats a wildcard in the search term as a literal, not as a query language', async () => {
      const org = required(listOrg, 'list org');

      const everything = await withOrg(database(), org, (tx) => listQuestions(tx, listAll()));
      expect(everything.rows.length).toBeGreaterThan(1);

      // Without escaping, `%` is a wildcard and this one-character request would return
      // the whole bank — an unbounded-cost query, which docs/17 §10 forbids and docs/17 §3
      // names as the reason filtering uses explicit parameters and never a query language.
      // Escaped, it means what a person typing it means: prompts containing a per-cent
      // sign, of which the fixture has exactly one.
      const wildcard = await withOrg(database(), org, (tx) => listQuestions(tx, listAll({ q: '%' })));
      expect(wildcard.rows).toHaveLength(1);
      expect(wildcard.rows.length).toBeLessThan(everything.rows.length);

      // `_` is the other wildcard, and it matches any single character unescaped. No
      // prompt in the fixture contains an underscore, so an unescaped one would match
      // every prompt and an escaped one matches none.
      const underscore = await withOrg(database(), org, (tx) =>
        listQuestions(tx, listAll({ q: '_' })),
      );
      expect(underscore.rows).toHaveLength(0);

      const literal = await withOrg(database(), org, (tx) =>
        listQuestions(tx, listAll({ q: '100%' })),
      );
      expect(literal.rows).toHaveLength(1);
    });

    it('filters by skill, which is how ADR-009’s indirection is queried', async () => {
      const org = required(listOrg, 'list org');
      const [skill] = await ownerSql()<{ id: string }[]>`
        INSERT INTO skills (org_id, key, name) VALUES (${org}, 'python', 'Python') RETURNING id
      `;
      const skillId = required(skill, 'skills row').id;
      const target = required(created[0], 'the coding question');

      const parsedSkill = SkillIdSchema.parse(skillId);

      await withOrg(database(), org, (tx) =>
        setQuestionSkills(tx, target, [{ skillId: parsedSkill, weight: 1.5 }]),
      );

      const page = await withOrg(database(), org, (tx) =>
        listQuestions(tx, listAll({ skill_id: parsedSkill })),
      );
      expect(page.rows.map((row) => row.id)).toStrictEqual([target]);

      const question = await withOrg(database(), org, (tx) =>
        getQuestionWithCurrentVersion(tx, target),
      );
      expect(question?.skills).toStrictEqual([{ skill_id: skillId, weight: 1.5 }]);
    });

    it('filters by exposure, which is FR-4’s over-exposure query', async () => {
      const org = required(listOrg, 'list org');
      const target = required(created[0], 'the coding question');
      await ownerSql()`UPDATE questions SET exposure_count = 500 WHERE id = ${target}`;

      const page = await withOrg(database(), org, (tx) =>
        listQuestions(tx, listAll({ exposure_gt: 100 })),
      );
      expect(page.rows.map((row) => row.id)).toStrictEqual([target]);

      const none = await withOrg(database(), org, (tx) =>
        listQuestions(tx, listAll({ exposure_gt: 1000 })),
      );
      expect(none.rows).toHaveLength(0);
    });
  });

  // ---- tenancy ------------------------------------------------------------

  describe('row-level security (ADR-010)', () => {
    it('hides one organisation’s bank from another, by id and by list', async () => {
      const mine = required(acme, 'acme');
      const theirs = required(rival, 'rival');

      const questionId = await seedPublished(mine, 'coding', {
        prompt_md: 'A secret with a reference solution.',
        difficulty: 3,
        coding_spec: {
          allowed_languages: ['python'],
          solution_code: { python: 'the reference solution' },
        },
        test_cases: [{ stdin: 'secret input', expected_stdout: 'secret output', is_sample: false }],
      });

      // The highest-value target in the system, per docs/14: every reference solution and
      // every hidden test case an organisation owns.
      const bySomeoneElse = await withOrg(database(), theirs, (tx) =>
        getQuestionWithCurrentVersion(tx, questionId),
      );
      expect(bySomeoneElse).toBeUndefined();

      const listedBySomeoneElse = await withOrg(database(), theirs, (tx) =>
        listQuestions(tx, listAll()),
      );
      expect(listedBySomeoneElse.rows.map((row) => row.id)).not.toContain(questionId);

      const versionBySomeoneElse = await withOrg(database(), theirs, (tx) =>
        getVersion(tx, questionId, 1),
      );
      expect(versionBySomeoneElse).toBeUndefined();
    });

    it('refuses a cross-tenant write as zero rows rather than as an error', async () => {
      const mine = required(acme, 'acme');
      const theirs = required(rival, 'rival');
      const questionId = await seedQuestion(mine, 'subjective', {
        prompt_md: 'Mine alone.',
        difficulty: 2,
      });

      const attempted = await withOrg(database(), theirs, (tx) =>
        setQuestionStatus(tx, questionId, 'retired'),
      );
      expect(attempted).toBeUndefined();

      const unchanged = await withOrg(database(), mine, (tx) =>
        getQuestionWithCurrentVersion(tx, questionId),
      );
      expect(unchanged?.status).toBe('draft');
    });
  });
});
