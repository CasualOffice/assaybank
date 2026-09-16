/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What row-level security costs, measured — P1 step 2, risk R-09.
 *
 * ADR-010 accepts the cost in one clause: *"some query plans degrade — measure before
 * assuming."* R-09 names the shape of the failure precisely, and it is not "queries get a
 * bit slower": it is a plan flipping from an index scan to a sequential scan, invisible in
 * development because development has forty rows, and arriving at p95 during an exam
 * window with five hundred candidates mid-assessment.
 *
 * So this suite does two separate things, and only one of them is a test.
 *
 * **The test.** For each of the five hottest tenant-scoped queries it captures
 * `EXPLAIN (ANALYZE, BUFFERS)` twice — once as `hiring_app`, where the policies apply, and
 * once as `hiring_job`, which has `BYPASSRLS` — and asserts the two plans have the same
 * node structure. That is R-09's trigger stated as an assertion: *"any query plan in the
 * M0 baseline changing from index scan to sequential scan"*. It is deterministic, so it
 * can gate CI.
 *
 * **The measurement.** Execution and planning times are recorded into
 * `out/rls-plan-cost.md` and read into `docs/rls-plan-cost.md`, and are deliberately *not*
 * asserted on. At this volume the hot queries run in tens of microseconds, where run-to-run
 * noise is larger than the effect; a threshold there would be a flaky test wearing the
 * costume of a performance gate. Numbers are evidence for a human. Plan shape is the gate.
 *
 * **Volume is not optional.** `test/volume-fixture.ts` writes twelve organisations, twelve
 * thousand attempts and twenty-four thousand answers, then `ANALYZE`s. On the one-row
 * fixture the isolation suite uses, every plan is a sequential scan and every timing is
 * noise — a measurement taken there would look exactly like evidence and mean nothing.
 */

import { mkdirSync, writeFileSync } from 'node:fs';

import postgres from 'postgres';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDb, withOrg, type Database } from '../src/index.js';
import {
  announceSkip,
  containerRuntime,
  required,
  startTestDatabase,
  suiteName,
  type TestDatabase,
} from '../test/postgres-fixture.js';
import { DEFAULT_VOLUME, seedVolume, type SeededVolume } from '../test/volume-fixture.js';

announceSkip('rls-plan-cost.test.ts');

/** Repetitions per plan. The first is discarded cold; the median of the rest is kept. */
const RUNS = 7;

/**
 * A UUID, quoted as a SQL literal — the one place this repository interpolates a value
 * into SQL text, and the reason is specific to `EXPLAIN`.
 *
 * Both arms of the comparison must run byte-identical SQL or the comparison is not one,
 * and the `hiring_job` arm is a raw `postgres.js` call while the `hiring_app` arm goes
 * through `withOrg` and Drizzle. Sharing one literal string is the only way to guarantee
 * they are the same statement. The input is a UUID produced by the fixture seconds
 * earlier, and the regex refuses anything that is not, so the usual objection to
 * interpolation — that the value came from somewhere — does not apply here and does not
 * apply anywhere else in the tree.
 */
function uuidLiteral(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error(`refusing to build SQL from ${JSON.stringify(value)}: not a UUID`);
  }
  return `'${value}'::uuid`;
}

interface HotQuery {
  /** Stable key, used as the section anchor in the evidence document. */
  readonly key: string;
  /** What the query is, in the language of the product. */
  readonly title: string;
  /** Why it is on this list — the request that issues it, and how often. */
  readonly why: string;
  /** Builds the statement. Literals only; see {@link uuidLiteral}. */
  readonly build: (ids: Identifiers) => string;
}

interface Identifiers {
  readonly orgId: string;
  readonly attemptId: string;
}

/**
 * The five hottest tenant-scoped queries.
 *
 * Four of them carry **no `org_id` predicate at all**, which is the point. Under ADR-010
 * the application does not filter by tenant; the policy does. Measuring a query that
 * already says `WHERE org_id = $1` would measure a redundant predicate and conclude,
 * wrongly, that RLS is free. These are the statements the API will actually send.
 */
const HOT_QUERIES: readonly HotQuery[] = [
  {
    key: 'attempt-read',
    title: 'Read one attempt by id',
    why:
      'The single hottest tenant-scoped statement in the system. Every heartbeat, every ' +
      'autosave and every page of the candidate runner reconciles against this row, and ' +
      'ADR-006 makes it the authority for the countdown, so it is on the path of every ' +
      'candidate every few seconds for the whole of an exam window.',
    build: (ids) => `
      SELECT id, status, started_at, deadline_at, submitted_at
        FROM attempts
       WHERE id = ${uuidLiteral(ids.attemptId)}
    `,
  },
  {
    key: 'served-question-set',
    title: 'Read the materialised question set for an attempt',
    why:
      'ADR-004: the served set is written once at attempt start and read back verbatim on ' +
      'start, on resume and on every re-grade. It joins the bank, so it is the query where ' +
      'a policy on a child table (`question_versions` reaches its org through `questions`) ' +
      'has the most room to turn a lookup into a join.',
    build: (ids) => `
      SELECT aq.id, aq.ordinal, aq.max_score, qv.id AS version_id, qv.difficulty
        FROM attempt_questions aq
        JOIN question_versions qv ON qv.id = aq.question_version_id
       WHERE aq.attempt_id = ${uuidLiteral(ids.attemptId)}
       ORDER BY aq.ordinal
    `,
  },
  {
    key: 'attempt-answers',
    title: "Read an attempt's answers",
    why:
      'The autosave and resume path. `answers` has no tenant key of its own and reaches ' +
      'its organisation through `attempt_questions` and `attempts`, so its policy is a ' +
      'two-level EXISTS — the most expensive predicate shape in migration 0002, on the ' +
      'largest table in the schema.',
    build: (ids) => `
      SELECT a.id, a.attempt_question_id, a.seconds_spent, a.final_score
        FROM answers a
        JOIN attempt_questions aq ON aq.id = a.attempt_question_id
       WHERE aq.attempt_id = ${uuidLiteral(ids.attemptId)}
    `,
  },
  {
    key: 'staff-attempt-page',
    title: 'One page of the staff attempt list',
    why:
      'The recruiter console, and the only query here that names `org_id` itself — a ' +
      'listing has no other way to scope. It is the case where the policy predicate is ' +
      'redundant with the query predicate, and therefore the case that shows what a ' +
      'duplicated predicate costs on an ordered index page.',
    build: (ids) => `
      SELECT id, candidate_id, status, created_at
        FROM attempts
       WHERE org_id = ${uuidLiteral(ids.orgId)}
         AND status = 'submitted'
       ORDER BY created_at DESC
       LIMIT 50
    `,
  },
  {
    key: 'finalisation-guard',
    title: 'May this attempt be finalised?',
    why:
      'docs/17 §4: an attempt reaches `finalised` only when every `final_score` is ' +
      'non-null, checked in the same transaction that sets the status. It runs inside the ' +
      'finalisation transaction, so its cost is lock-holding time on the row every other ' +
      'writer for that attempt is queued behind.',
    build: (ids) => `
      SELECT count(*)::int AS unscored
        FROM attempt_questions aq
        JOIN answers a ON a.attempt_question_id = aq.id
       WHERE aq.attempt_id = ${uuidLiteral(ids.attemptId)}
         AND a.final_score IS NULL
    `,
  },
];

/** One captured `EXPLAIN (ANALYZE, BUFFERS)`. */
interface Plan {
  readonly text: string;
  readonly planningMs: number;
  readonly executionMs: number;
}

interface Measured {
  readonly query: HotQuery;
  readonly statement: string;
  readonly withRls: Plan;
  readonly withoutRls: Plan;
}

function timing(text: string, label: 'Planning' | 'Execution'): number {
  const match = new RegExp(`${label} Time: ([0-9.]+) ms`).exec(text);
  return match === null ? Number.NaN : Number.parseFloat(match[1] ?? 'NaN');
}

/**
 * Tables whose row count grows with usage rather than with configuration.
 *
 * The distinction is the whole of R-09. A sequential scan over `assessments` is a scan of
 * a few dozen rows and will still be a few dozen rows in three years. A sequential scan
 * over `answers` is a scan of everything every candidate has ever typed, and it is fine
 * in development for exactly as long as development has no candidates.
 */
const UNBOUNDED_TABLES: readonly string[] = [
  'attempts',
  'attempt_questions',
  'answers',
  'candidates',
  'submissions',
  'audit_log',
  'proctor_events',
];

/**
 * The plan's node structure: every line that carries a cost estimate, stripped to its
 * description and to the alias the planner happened to assign.
 *
 * Lines without `(cost=` are `Filter:`, `Buffers:`, `Index Cond:` and friends — the ones
 * that *do* differ between the two arms, because the policy predicate has to appear
 * somewhere. What matters is which relations were read and how.
 *
 * The alias is stripped because `attempts a_1` and `attempts a_2` are the same relation
 * read the same way; keeping the suffix would make a baseline fail on a renumbering that
 * means nothing.
 */
function planNodes(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.includes('(cost='))
    .map((line) => line.replace(/^->\s*/, '').replace(/\s*\(cost=.*$/, ''))
    .map((line) => line.replace(/ on ([a-z_][a-z0-9_]*) [a-z][a-z0-9_]*$/, ' on $1'));
}

/** Plan nodes that read one of the tables that grows without bound. */
function unboundedNodes(text: string): string[] {
  return planNodes(text).filter((node) =>
    UNBOUNDED_TABLES.some((table) => node.endsWith(` on ${table}`)),
  );
}

/** Runs one statement `RUNS` times, discards the cold first, keeps the median. */
async function capture(
  run: (statement: string) => Promise<string>,
  statement: string,
): Promise<Plan> {
  const explain = `EXPLAIN (ANALYZE, BUFFERS) ${statement}`;
  const plans: Plan[] = [];

  for (let i = 0; i < RUNS; i += 1) {
    const text = await run(explain);
    if (i === 0) continue; // cold: shared buffers are empty and the plan cache is not warm
    plans.push({
      text,
      planningMs: timing(text, 'Planning'),
      executionMs: timing(text, 'Execution'),
    });
  }

  plans.sort((left, right) => left.executionMs - right.executionMs);
  return required(plans[Math.floor(plans.length / 2)], 'a captured plan');
}

let fixture: TestDatabase | undefined;
let db: Database | undefined;
let job: postgres.Sql | undefined;
let volume: SeededVolume | undefined;
let measured: Measured[] | undefined;

describe.skipIf(!containerRuntime.available)(
  suiteName('row-level security plan cost (R-09, ADR-010)'),
  () => {
    beforeAll(async () => {
      fixture = await startTestDatabase();
      volume = await seedVolume(fixture.owner, DEFAULT_VOLUME);

      db = createDb({ url: fixture.appUrl, jobUrl: fixture.jobUrl, poolMax: 2 });

      // The RLS-off arm. `hiring_job` has BYPASSRLS (ADR-010), so the same statement runs
      // with the policies absent rather than merely satisfied — which is the comparison
      // R-09 asks for. Not `withElevated`: that writes an audit row, and an INSERT in the
      // transaction would be measured alongside the query under test.
      job = postgres(fixture.jobUrl, { max: 1 });

      const subject = volume.subject;
      const [row] = await fixture.owner<{ attempt_id: string }[]>`
        SELECT aq.attempt_id
          FROM attempt_questions aq
          JOIN attempts a ON a.id = aq.attempt_id
         WHERE a.org_id = ${subject.orgId}
         ORDER BY aq.attempt_id
         LIMIT 1
      `;
      const ids: Identifiers = {
        orgId: subject.orgId,
        attemptId: required(row, 'an attempt with a served question set').attempt_id,
      };

      const handle = db;
      const jobClient = job;

      const asApp = async (statement: string): Promise<string> =>
        withOrg(handle, subject.orgId, async (tx) => {
          const rows = await tx.execute<{ 'QUERY PLAN': string }>(sql.raw(statement));
          return rows.map((line) => line['QUERY PLAN']).join('\n');
        });

      const asJob = async (statement: string): Promise<string> => {
        const rows = await jobClient.unsafe<{ 'QUERY PLAN': string }[]>(statement);
        return rows.map((line) => line['QUERY PLAN']).join('\n');
      };

      const results: Measured[] = [];
      for (const query of HOT_QUERIES) {
        const statement = query.build(ids).trim();
        results.push({
          query,
          statement,
          withoutRls: await capture(asJob, statement),
          withRls: await capture(asApp, statement),
        });
      }
      measured = results;
    }, 600_000);

    afterAll(async () => {
      await job?.end();
      await db?.close();
      await fixture?.stop();
    });

    it('seeded enough rows for the planner to have a choice', () => {
      const counts = required(volume, 'volume').counts;
      // The P1 plan asks for at least ten thousand in both. Below that the planner picks a
      // sequential scan for everything and the whole exercise measures nothing.
      expect(counts.attempts).toBeGreaterThanOrEqual(10_000);
      expect(counts.answers).toBeGreaterThanOrEqual(10_000);
      expect(counts.organizations, 'one tenant makes the policy trivially true').toBeGreaterThan(1);
    });

    it('captured a real plan for every hot query, under both roles', () => {
      const results = required(measured, 'measured');
      expect(results).toHaveLength(HOT_QUERIES.length);
      for (const result of results) {
        // `EXPLAIN ANALYZE` without an execution time means the plan was not executed,
        // which would make every assertion below an assertion about an estimate.
        expect(result.withRls.executionMs, `${result.query.key} ran under RLS`).toBeGreaterThan(0);
        expect(result.withoutRls.executionMs, `${result.query.key} ran without`).toBeGreaterThan(0);
        expect(result.withRls.text).toContain('Buffers:');
      }
    });

    it('measured the policies, not an unsecured plan by accident', () => {
      // The vacuity control, and the one this suite would be worthless without. If the
      // "with RLS" arm ever ran as a role that bypasses policies, every plan below would
      // match its counterpart perfectly and every assertion would pass while proving the
      // opposite of what it claims. The accessor's name appearing in one plan and not the
      // other is the proof that two different things were measured.
      for (const result of required(measured, 'measured')) {
        expect(
          result.withRls.text,
          `${result.query.key} was not planned with the policy`,
        ).toContain("current_setting('app.current_org'");
        expect(
          result.withoutRls.text,
          `${result.query.key} carried the policy predicate even as the BYPASSRLS role`,
        ).not.toContain("current_setting('app.current_org'");
      }
    });

    describe.each(HOT_QUERIES.map((query) => query.key))('%s', (key) => {
      const measurement = (): Measured =>
        required(
          required(measured, 'measured').find((m) => m.query.key === key),
          `a measurement for ${key}`,
        );

      it('scans no unbounded table sequentially under row-level security (R-09)', () => {
        // R-09's trigger, stated as an assertion: "any query plan in the M0 baseline
        // changing from index scan to sequential scan". Scoped to the tables that grow
        // with usage, because those are the ones where the change is a production
        // incident rather than a rounding error.
        const result = measurement();
        const sequential = unboundedNodes(result.withRls.text).filter((node) =>
          node.startsWith('Seq Scan'),
        );
        expect(
          sequential,
          `${key} fell back to a sequential scan over a table that grows without ` +
            `bound:\n${result.withRls.text}`,
        ).toEqual([]);
      });

      it('reads every unbounded table the same way with row-level security on and off', () => {
        // Join order and join method may legitimately change — the policy predicates alter
        // row estimates, and a different join for two rows is not a regression. What must
        // not change is how the large relations are reached, because that is the part
        // whose cost scales with the data.
        const result = measurement();
        const before = unboundedNodes(result.withoutRls.text);
        const after = unboundedNodes(result.withRls.text);

        expect(
          before.filter((node) => !after.includes(node)),
          `row-level security changed how ${key} reaches a large table:\n\n` +
            `--- without RLS ---\n${result.withoutRls.text}\n\n` +
            `--- with RLS ---\n${result.withRls.text}`,
        ).toEqual([]);
      });
    });

    it('writes the evidence document', () => {
      const results = required(measured, 'measured');
      const counts = required(volume, 'volume').counts;
      const outDir = new URL('../out/', import.meta.url).pathname;
      mkdirSync(outDir, { recursive: true });
      writeFileSync(`${outDir}rls-plan-cost.md`, render(results, counts), 'utf8');
      // Written to out/, which is build output and git-ignored, rather than over
      // docs/rls-plan-cost.md. Timings differ per machine, and a suite that rewrites a
      // committed document on every run leaves CI with a dirty tree and the reader with no
      // idea which numbers were reviewed. The committed evidence is a capture a human read
      // and wrote a conclusion under; this is how to produce the next one.
      expect(results.length).toBeGreaterThan(0);
    });
  },
);

function render(results: readonly Measured[], counts: SeededVolume['counts']): string {
  const lines: string[] = [
    '<!-- Generated by packages/db/tests/rls-plan-cost.test.ts. -->',
    '',
    '# RLS plan cost — captured',
    '',
    `Volume: ${counts.organizations} organisations, ${counts.attempts} attempts, ` +
      `${counts.attemptQuestions} attempt_questions, ${counts.answers} answers. ` +
      `Median of ${RUNS - 1} runs after one discarded cold run.`,
    '',
    '| Query | Planning (RLS off → on) | Execution (RLS off → on) |',
    '|---|---|---|',
  ];

  for (const result of results) {
    lines.push(
      `| \`${result.query.key}\` | ${result.withoutRls.planningMs} → ${result.withRls.planningMs} ms ` +
        `| ${result.withoutRls.executionMs} → ${result.withRls.executionMs} ms |`,
    );
  }

  for (const result of results) {
    lines.push(
      '',
      `## ${result.query.title} (\`${result.query.key}\`)`,
      '',
      result.query.why,
      '',
      '```sql',
      result.statement,
      '```',
      '',
      '### Without RLS — `hiring_job`, `BYPASSRLS`',
      '',
      '```',
      result.withoutRls.text,
      '```',
      '',
      '### With RLS — `hiring_app`, inside `withOrg`',
      '',
      '```',
      result.withRls.text,
      '```',
    );
  }

  return `${lines.join('\n')}\n`;
}
