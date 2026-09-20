/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Reading a line-delimited dataset into bank items (`H-032`).
 *
 * One reader for HumanEval, MBPP and LBPP, driven by the descriptors in `spec.ts`. Every one
 * of them is a coding question graded by unit tests, which is what ADR-024 exists for: each
 * assertion becomes one test case carrying its own source, and the per-case `weight` that was
 * already there gives partial credit over assertions.
 *
 * ## A bad row costs the file nothing
 *
 * docs/03 §4 says an import reports per-row errors, and a dataset is exactly where that earns
 * its keep: these files are thousands of rows, some of them malformed, and failing the upload
 * on row 1,847 wastes the other 1,846. Every refusal here is an `ItemProblem` with the row's
 * position and the field that was wrong, and the reader keeps going.
 *
 * ## Everything imports as a draft
 *
 * Nothing published, ever. An imported question has had no human read it, its difficulty is a
 * declared guess rather than a measurement, and publishing is the irreversible act (ADR-003).
 * A bank that filled itself with published questions would be a bank nobody reviewed.
 */

import { type QuestionKind, type QuestionStatus } from '@assaybank/contracts';

import { type BankItem, type BankTestCase, type ItemProblem } from '../bank-item.js';
import { type ReadResult, UnreadableDocumentError } from '../bank-document.js';
import { dedent, splitAssertions } from './assertions.js';
import { DATASET_SPECS, type DatasetSpec, type JsonlDataset } from './spec.js';

/** Execution limits for an imported question. Conservative, and the same for every dataset. */
const LIMITS = { timeLimitMs: 5_000, memoryKb: 262_144 } as const;

/**
 * The difficulty an imported question gets when the caller names none.
 *
 * Three, the middle of the scale, and deliberately not computed. There is no signal in one of
 * these rows that maps to a five-point scale, and deriving one from prompt length or solution
 * length would be a number that looks measured and is not — which is worse than an obvious
 * placeholder, because somebody would trust it. `question_stats` replaces it with an observed
 * p-value once a version has 30 responses (FR-5), and that is the number that means something.
 */
const IMPORTED_DIFFICULTY = 3;

/**
 * The item's `ref`, which is not the same thing as its `external_ref`.
 *
 * `external_ref` is provenance and keeps the dataset's own `dataset/id` verbatim — docs/05 §2
 * makes it the auditable record of where a question came from, and `H-032` requires it
 * preserved. `ref` is the item's key *inside an interchange file*, and in a QTI package it
 * becomes a file name, so it is restricted to characters a file name can hold and must start
 * alphanumeric — a ref of `..` would be a path traversal in somebody's unzip.
 *
 * So the slashes that belong in one are replaced in the other, rather than one field being
 * made to do both jobs badly.
 */
function refFrom(prefix: string, id: string): string {
  const safe = `${prefix}-${id}`.replace(/[^A-Za-z0-9._-]/gu, '-').replace(/^[^A-Za-z0-9]+/u, '');
  return safe.slice(0, 200);
}

/** One row's string field, or null when it is absent or the wrong type. */
function str(row: Record<string, unknown>, field: string | undefined): string | null {
  if (field === undefined) return null;
  const value = row[field];
  if (typeof value === 'string') return value;
  // `task_id` is a number in MBPP and a string in HumanEval. Both are identifiers.
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

/** One row's array-of-strings field, or null. */
function list(row: Record<string, unknown>, field: string | undefined): string[] | null {
  if (field === undefined) return null;
  const value = row[field];
  if (!Array.isArray(value)) return null;
  // A type predicate rather than a cast: `every` with one narrows the array itself, so the
  // return needs no assertion and a mixed array cannot be waved through.
  const strings = (v: unknown[]): v is string[] => v.every((x) => typeof x === 'string');
  return strings(value) ? value : null;
}

/**
 * The assertions in a row, already one per entry, with the setup each needs.
 *
 * `block` datasets hand over one string to be split; `list` datasets hand over an array and
 * need no splitting at all — which is why the descriptor states which, rather than the reader
 * guessing from the runtime type and quietly accepting a dataset that changed shape.
 */
function assertionsOf(
  spec: DatasetSpec,
  row: Record<string, unknown>,
): { readonly codes: readonly string[]; readonly problem: string | null } {
  const setup = (str(row, spec.fields.setup) ?? '').trim();
  const prelude: string[] = [];
  if (setup !== '') prelude.push(setup);

  if (spec.fields.testsKind === 'list') {
    const tests = list(row, spec.fields.tests);
    if (tests === null)
      return { codes: [], problem: `${spec.fields.tests} is not a list of strings` };
    const extra = list(row, spec.fields.extraTests) ?? [];
    const all = [...tests, ...extra].map((t) => t.trim()).filter((t) => t !== '');
    return { codes: all.map((t) => [...prelude, t].join('\n')), problem: null };
  }

  const block = str(row, spec.fields.tests);
  if (block === null) return { codes: [], problem: `${spec.fields.tests} is missing` };

  const { preamble, assertions } = splitAssertions(dedent(block));
  if (preamble.trim() !== '') prelude.push(dedent(preamble).trimEnd());

  // HumanEval's assertions call `candidate`, and only `entry_point` says what that is. Without
  // the binding every assertion is a NameError, so it is emitted as part of each case rather
  // than assumed to be supplied by a harness nobody has written yet.
  const entry = str(row, spec.fields.entryPoint);
  if (entry !== null && entry.trim() !== '') prelude.push(`candidate = ${entry.trim()}`);

  return {
    codes: assertions.map((a) => [...prelude, dedent(a.code)].join('\n')),
    problem: null,
  };
}

/**
 * One row as a bank item, or the problems that stopped it.
 *
 * Returns problems rather than throwing, because one unreadable row is not an unreadable file.
 */
function itemFrom(
  spec: DatasetSpec,
  row: Record<string, unknown>,
  index: number,
  difficulty: number,
): { item: BankItem | null; problems: ItemProblem[] } {
  const problems: ItemProblem[] = [];
  const id = str(row, spec.fields.id);
  const externalRef = id === null ? null : `${spec.refPrefix}/${id}`;
  const ref = id === null ? null : refFrom(spec.refPrefix, id);

  const fail = (path: string, message: string): void => {
    problems.push({ index, ref, path, message });
  };

  const prompt = (str(row, spec.fields.prompt) ?? '').trim();
  // Verbatim, not trimmed: the import is a faithful copy of the dataset's source, and a
  // reference solution that differs from the published one by a byte is a re-grade nobody
  // can explain.
  const solution = str(row, spec.fields.solution) ?? '';
  const starter = str(row, spec.fields.starter) ?? '';

  if (id === null) fail(spec.fields.id, `${spec.fields.id} is missing; a row needs an identifier`);
  if (prompt === '')
    fail(spec.fields.prompt, `${spec.fields.prompt} is empty; there is no question without it`);
  if (solution.trim() === '')
    fail(
      spec.fields.solution,
      `${spec.fields.solution} is empty; a question with no reference solution cannot be reviewed`,
    );

  const { codes, problem } = assertionsOf(spec, row);
  if (problem !== null) fail(spec.fields.tests, problem);
  else if (codes.length === 0)
    fail(spec.fields.tests, 'no assertions found; there is nothing to grade against');

  if (problems.length > 0 || ref === null || externalRef === null) {
    return { item: null, problems };
  }

  // ADR-024: the first assertion is the worked example the prompt refers to, so it is the
  // sample; every other one is hidden. A problem with a single assertion imports it hidden —
  // a question graded only on a case the candidate can read is passed by reading it, and the
  // publish bar refuses it until somebody adds a second.
  const testCases: BankTestCase[] = codes.map((code, position) => ({
    label: `assertion ${String(position + 1)}`,
    stdin: '',
    expected_stdout: null,
    args: null,
    assertion_code: code,
    is_sample: codes.length > 1 && position === 0,
    weight: 1,
  }));

  return {
    item: {
      ref,
      kind: 'coding' satisfies QuestionKind as QuestionKind,
      // Never published. Nobody has read it, and publishing is irreversible (ADR-003).
      status: 'draft' satisfies QuestionStatus as QuestionStatus,
      source_license: spec.licence,
      external_ref: externalRef,
      skills: [],
      versions: [
        {
          version_no: 1,
          published: false,
          locale: 'en',
          prompt_md: promptFor(spec, prompt),
          explanation_md: null,
          difficulty,
          est_seconds: 900,
          max_score: 1,
          negative_score: 0,
          options: [],
          coding_spec: {
            allowed_languages: [spec.language],
            starter_code: starter.trim() === '' ? {} : { [spec.language]: starter },
            solution_code: { [spec.language]: solutionFor(spec, starter, solution) },
            time_limit_ms: LIMITS.timeLimitMs,
            memory_limit_kb: LIMITS.memoryKb,
            grading_mode: 'unit_tests',
            checker_code: null,
            fixture_sql: null,
          },
          test_cases: testCases,
          answer_keys: [],
        },
      ],
    },
    problems,
  };
}

/**
 * The prompt, as markdown.
 *
 * HumanEval's `prompt` is Python — a signature and a docstring — so it is fenced rather than
 * pasted as prose, which would render as one run-on paragraph with the indentation collapsed.
 * MBPP's and LBPP's are English sentences and are used as written.
 */
function promptFor(spec: DatasetSpec, prompt: string): string {
  if (spec.fields.prompt !== spec.fields.starter) return prompt;
  return [
    'Implement the function below.',
    '',
    '```python',
    prompt.replace(/\s+$/u, ''),
    '```',
  ].join('\n');
}

/**
 * The reference solution as a runnable file.
 *
 * HumanEval's `canonical_solution` is a function *body*: it only runs when appended to the
 * signature in `prompt`. MBPP's `code` is a whole module. Concatenating in the first case and
 * not the second is the one place the two genuinely differ, and the descriptor says which by
 * whether `starter` and `prompt` name the same field.
 */
function solutionFor(spec: DatasetSpec, starter: string, solution: string): string {
  const isBody = spec.fields.prompt === spec.fields.starter && starter.trim() !== '';
  return isBody ? `${starter.replace(/\s+$/u, '')}\n${solution}` : solution;
}

/**
 * Reads a dataset file.
 *
 * Throws only for a file that is not the thing at all — empty, or no readable row anywhere.
 * Everything else is a per-row problem.
 */
export function readJsonlDataset(
  dataset: JsonlDataset,
  text: string,
  options: { readonly defaultDifficulty?: number | undefined } = {},
): ReadResult {
  const spec = DATASET_SPECS[dataset];
  const difficulty = options.defaultDifficulty ?? IMPORTED_DIFFICULTY;

  const lines = text
    .replace(/\r\n?/gu, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');

  if (lines.length === 0) throw new UnreadableDocumentError('The file has no rows.');

  const items: { index: number; item: BankItem }[] = [];
  const problems: ItemProblem[] = [];
  let parsed = 0;

  lines.forEach((line, index) => {
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      problems.push({ index, ref: null, path: '', message: 'the line is not JSON' });
      return;
    }
    if (typeof row !== 'object' || row === null || Array.isArray(row)) {
      problems.push({ index, ref: null, path: '', message: 'a row is a JSON object' });
      return;
    }
    parsed += 1;

    const read = itemFrom(spec, row as Record<string, unknown>, index, difficulty);
    problems.push(...read.problems);
    if (read.item !== null) items.push({ index, item: read.item });
  });

  // Every line unparseable means this is not the file the caller said it was — a QTI package
  // uploaded as MBPP, say. That is worth a different answer from "1,847 bad rows", because the
  // fix is different: re-upload, not edit.
  if (parsed === 0) {
    throw new UnreadableDocumentError(
      `No row of this file is a JSON object. ${spec.name} is line-delimited JSON, one problem per line.`,
    );
  }

  return { items, problems };
}
