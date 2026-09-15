/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Properties of the model that hold for every table, asserted once instead of reviewed
 * forty times.
 *
 * Each of these is a rule from docs/17 §4 that is cheap to state and expensive to notice
 * the absence of: a naive timestamp, a float where a score belongs, a camelCase column
 * that only breaks when someone writes raw SQL. None of them needs a database, so they
 * run on every machine, every time.
 */

import { getTableColumns, getTableName, is } from 'drizzle-orm';
import { PgTable, type PgColumn } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import {
  answers,
  attempts,
  auditLog,
  organizations,
  questionVersions,
  questions,
  schema,
  testCases,
} from './index.js';

const tables = Object.values(schema).filter((value) => is(value, PgTable));

/**
 * Every column of every table, tagged with its table name so a failure names the offender
 * rather than just its count. `getTableColumns` is generic over the exact table, so the
 * parameter is narrowed to the base type before the call — otherwise the values widen to
 * `any` and the assertions below stop being assertions.
 */
const columnsOf = (table: PgTable): PgColumn[] => Object.values(getTableColumns(table));

const everyColumn = (): { table: string; column: PgColumn }[] =>
  tables.flatMap((table) =>
    columnsOf(table).map((column) => ({ table: getTableName(table), column })),
  );

const SNAKE_CASE = /^[a-z][a-z0-9_]*$/;

describe('the schema object', () => {
  it('holds the forty tables of docs/hiring_platform_schema.sql and nothing else', () => {
    // 40 is the number infra/postgres/init/03-rls.sql accounts for. If this changes, the
    // isolation model changed too, and both must be revisited in the same commit.
    expect(tables).toHaveLength(40);
    expect(Object.values(schema)).toHaveLength(40);
  });

  it('names every table and column in snake_case', () => {
    for (const table of tables) {
      expect(getTableName(table)).toMatch(SNAKE_CASE);
    }
    for (const { table, column } of everyColumn()) {
      expect(column.name, `${table}.${column.name}`).toMatch(SNAKE_CASE);
    }
  });
});

describe('column types', () => {
  it('uses timestamptz for every point in time, never a naive timestamp', () => {
    // docs/17 §4. ADR-006 makes the clock a correctness boundary: a naive timestamp is a
    // deadline that moves when the server's timezone does.
    const naive = everyColumn()
      .filter(({ column }) => /^timestamp(\(\d+\))?$/.test(column.getSQLType()))
      .map(({ table, column }) => `${table}.${column.name}`);
    expect(naive).toEqual([]);
  });

  it('uses numeric for every score, weight and percentage, never a float', () => {
    // docs/17 §4: money and scores as numeric, never float. A float score is a score that
    // does not reproduce on a re-grade.
    const floats = everyColumn()
      .filter(({ column }) => ['real', 'double precision'].includes(column.getSQLType()))
      .map(({ table, column }) => `${table}.${column.name}`);
    expect(floats).toEqual([]);

    expect(attempts.rawScore.getSQLType()).toBe('numeric(8, 2)');
    expect(answers.finalScore.getSQLType()).toBe('numeric(6, 2)');
    expect(questionVersions.maxScore.getSQLType()).toBe('numeric(6, 2)');
  });

  it('types every tenant key as uuid', () => {
    const wrong = everyColumn()
      .filter(({ column }) => column.name === 'org_id' && column.getSQLType() !== 'uuid')
      .map(({ table }) => table);
    expect(wrong).toEqual([]);
  });

  it('uses citext for the two email columns, so uniqueness means what a human means', () => {
    expect(schema.users.email.getSQLType()).toBe('citext');
    expect(schema.candidates.email.getSQLType()).toBe('citext');
  });
});

describe('the invariants the schema itself can carry', () => {
  it('keeps the served question set pointing at a version, not a question (ADR-004)', () => {
    // The materialised row references question_versions. Referencing `questions` would
    // mean a re-grade reads whatever the current version happens to be, which is exactly
    // the re-roll ADR-004 forbids.
    const columns = Object.values(getTableColumns(schema.attemptQuestions)).map((c) => c.name);
    expect(columns).toContain('question_version_id');
    expect(columns).not.toContain('question_id');
  });

  it('gives attempts a server-computed deadline column and no client-supplied one', () => {
    const columns = Object.values(getTableColumns(attempts)).map((c) => c.name);
    expect(columns).toContain('deadline_at');
    // ADR-006: there is no column a client could write to extend its own deadline.
    expect(columns).not.toContain('deadline_extension');
    expect(columns).not.toContain('client_deadline_at');
  });

  it('holds no column that could store a computed integrity verdict (ADR-007)', () => {
    // integrity_flag records what a human concluded. A column named for an automatic
    // decision would invite one.
    const proctorColumns = [
      ...Object.values(getTableColumns(schema.proctorEvents)),
      ...Object.values(getTableColumns(schema.proctorMedia)),
    ].map((c) => c.name);
    for (const forbidden of ['verdict', 'auto_void', 'rejected', 'score_penalty']) {
      expect(proctorColumns).not.toContain(forbidden);
    }
  });

  it('records the runtime identity of every execution, so a score reproduces', () => {
    const columns = Object.values(getTableColumns(schema.submissions));
    const byName = new Map(columns.map((c) => [c.name, c]));
    expect(byName.get('language')?.notNull).toBe(true);
    expect(byName.get('language_version')?.notNull).toBe(true);
    expect(byName.has('runtime_image')).toBe(true);
  });

  it('marks the one test-case column that decides candidate visibility', () => {
    const isSample = Object.values(getTableColumns(testCases)).find((c) => c.name === 'is_sample');
    expect(isSample?.notNull).toBe(true);
    // FR-12: every other case is hidden content. That is a serialiser rule, not a column
    // rule — the column only says which rows are eligible to be shown at all.
    expect(Object.values(getTableColumns(testCases)).map((c) => c.name)).toContain(
      'expected_stdout',
    );
  });

  it('keeps audit_log free of a foreign key on org_id, so it outlives erasure', () => {
    // GDPR erasure removes the candidate, not the record that the candidate's attempt was
    // voided. A cascade here would delete the evidence along with the subject.
    expect(getTableColumns(auditLog).orgId.notNull).toBe(true);
    expect(getTableName(auditLog)).toBe('audit_log');
  });

  it('keys the tenancy root on id rather than org_id', () => {
    const columns = Object.values(getTableColumns(organizations)).map((c) => c.name);
    expect(columns).toContain('id');
    expect(columns).not.toContain('org_id');
  });

  it('lets a question name its current version without duplicating content', () => {
    expect(Object.values(getTableColumns(questions)).map((c) => c.name)).toContain(
      'current_version_id',
    );
    // The version is where prompt text lives; questions carries identity only.
    expect(Object.values(getTableColumns(questions)).map((c) => c.name)).not.toContain('prompt_md');
  });
});
