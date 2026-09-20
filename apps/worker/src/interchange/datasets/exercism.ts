/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Reading an Exercism track into bank items (`H-032`, docs/05 §2).
 *
 * The fourth M0 dataset, and the one that is not a file. Exercism distributes a track as a
 * repository: one directory per exercise, holding the instructions, a stub, a reference
 * solution and a `unittest` file. So this reads a zip rather than lines, which is why it is
 * its own module — `jsonl.ts` and its descriptors have nothing to say about a directory tree.
 *
 * ```
 * exercises/practice/two-fer/
 *   .docs/instructions.md     the question
 *   .meta/example.py          the reference solution, in a dot-directory so it is not the stub
 *   two_fer.py                what the candidate starts from
 *   two_fer_test.py           unittest, one method per behaviour
 * ```
 *
 * ## The unit of a case is a test method
 *
 * ADR-024's unit is the smallest independently runnable, independently scorable check. For
 * the JSONL datasets that is a bare `assert`; here it is a `unittest` method, which is what
 * the framework discovers and what `setUp` runs before. Each case is emitted as a module the
 * harness can run on its own: the file's imports, the class header, and one method.
 *
 * ## A missing piece is a skipped exercise, not a failed import
 *
 * A track has directories that are not exercises — `.github`, tooling, a `concept` tree whose
 * shape differs — and an exercise mid-rewrite may have no example solution. None of those is
 * a reason to refuse the other hundred and forty. Anything that looks like an exercise and is
 * incomplete becomes a per-row problem naming the file that was missing; anything that does
 * not look like an exercise at all is ignored in silence.
 */

import { type QuestionKind, type QuestionStatus } from '@assaybank/contracts';

import { type BankItem, type BankTestCase, type ItemProblem } from '../bank-item.js';
import { type ReadResult, UnreadableDocumentError } from '../bank-document.js';
import { splitTestMethods } from './assertions.js';

/** Exercism's exercises are MIT, per docs/05 §2. Not the uploader's to relabel. */
export const EXERCISM_LICENCE = 'MIT';

/** Matches `[anything/]exercises/practice/<slug>/<rest>`, tolerating a repo-name wrapper. */
const EXERCISE_PATH = /(?:^|\/)exercises\/(?:practice|concept)\/([a-z0-9][a-z0-9-]*)\/(.+)$/u;

/** Execution limits, matching the JSONL importers. */
const LIMITS = { timeLimitMs: 5_000, memoryKb: 262_144 } as const;

/** The middle of the scale. See `jsonl.ts` for why this is declared and not computed. */
const IMPORTED_DIFFICULTY = 3;

/** The files of one exercise, by their path within its directory. */
interface Exercise {
  readonly slug: string;
  readonly files: Map<string, string>;
}

/** Groups a zip's entries by exercise, ignoring everything that is not inside one. */
function exercisesIn(entries: Map<string, string>): Exercise[] {
  const bySlug = new Map<string, Map<string, string>>();

  for (const [path, content] of entries) {
    const match = EXERCISE_PATH.exec(path);
    if (match === null) continue;
    const slug = match[1];
    const rest = match[2];
    if (slug === undefined || rest === undefined) continue;
    const files = bySlug.get(slug) ?? new Map<string, string>();
    files.set(rest, content);
    bySlug.set(slug, files);
  }

  // Sorted, so an import is deterministic: the checkpoint an interrupted job resumes at is a
  // position in this list, and a list that reordered between runs would resume at a different
  // exercise (invariant 17).
  return [...bySlug.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([slug, files]) => ({ slug, files }));
}

/** The first file whose path matches, or null. */
function find(files: Map<string, string>, test: (path: string) => boolean): string | null {
  for (const [path, content] of files) if (test(path)) return content;
  return null;
}

/** The stub: a `.py` at the exercise root that is neither a test nor inside a dot-directory. */
function stubOf(files: Map<string, string>): string | null {
  return find(
    files,
    (path) => path.endsWith('.py') && !path.includes('/') && !path.endsWith('_test.py'),
  );
}

/**
 * One exercise as a bank item.
 *
 * `null` with no problems means "this directory is not an exercise" — a tooling folder that
 * happened to sit under the path. `null` with problems means "this is an exercise and
 * something it needs is missing", which is worth telling somebody about.
 */
function itemFrom(
  exercise: Exercise,
  index: number,
  difficulty: number,
): { item: BankItem | null; problems: ItemProblem[] } {
  const { slug, files } = exercise;
  const ref = `exercism-${slug}`;
  const problems: ItemProblem[] = [];
  const fail = (path: string, message: string): void => {
    problems.push({ index, ref, path, message });
  };

  const instructions = find(files, (p) => p === '.docs/instructions.md');
  const example = find(files, (p) => p === '.meta/example.py' || p === '.meta/exemplar.py');
  const tests = find(files, (p) => p.endsWith('_test.py') && !p.includes('/'));

  // Nothing at all that looks like an exercise: not our business, and not an error.
  if (instructions === null && example === null && tests === null) {
    return { item: null, problems: [] };
  }

  if (instructions === null) fail('.docs/instructions.md', 'the exercise has no instructions');
  if (example === null) fail('.meta/example.py', 'the exercise has no reference solution');
  if (tests === null) fail(`${slug}_test.py`, 'the exercise has no test file');
  if (problems.length > 0) return { item: null, problems };

  const { preamble, className, methods } = splitTestMethods(tests ?? '');
  if (methods.length === 0) {
    fail(`${slug}_test.py`, 'no test methods found; there is nothing to grade against');
    return { item: null, problems };
  }

  // Each case is a runnable module: the file's imports, the class it belongs to, and one
  // method. The class header is rebuilt rather than sliced out, because a test file
  // occasionally carries a decorator or a docstring between the two that belongs to neither.
  const header =
    className === null
      ? 'class ImportedTest(unittest.TestCase):'
      : `class ${className}(unittest.TestCase):`;
  const testCases: BankTestCase[] = methods.map((method, position) => ({
    label: method.name,
    stdin: '',
    expected_stdout: null,
    args: null,
    assertion_code: [preamble, '', header, method.code].join('\n').trim(),
    // The first behaviour is the worked example; the rest are hidden (ADR-024).
    is_sample: methods.length > 1 && position === 0,
    weight: 1,
  }));

  const stub = stubOf(files);

  return {
    item: {
      ref,
      kind: 'coding' satisfies QuestionKind as QuestionKind,
      status: 'draft' satisfies QuestionStatus as QuestionStatus,
      source_license: EXERCISM_LICENCE,
      external_ref: `exercism/${slug}`,
      skills: [],
      versions: [
        {
          version_no: 1,
          published: false,
          locale: 'en',
          // Exercism's instructions are already markdown, which is the one dataset that needs
          // no shaping at all.
          prompt_md: (instructions ?? '').trim(),
          explanation_md: null,
          difficulty,
          est_seconds: 1_200,
          max_score: 1,
          negative_score: 0,
          options: [],
          coding_spec: {
            allowed_languages: ['python'],
            starter_code: stub === null ? {} : { python: stub },
            solution_code: { python: example ?? '' },
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

/** Reads an Exercism track from an unzipped package. */
export function readExercismTrack(
  entries: Map<string, string>,
  options: { readonly defaultDifficulty?: number | undefined } = {},
): ReadResult {
  const difficulty = options.defaultDifficulty ?? IMPORTED_DIFFICULTY;
  const exercises = exercisesIn(entries);

  if (exercises.length === 0) {
    throw new UnreadableDocumentError(
      'No exercises found. An Exercism track holds them under exercises/practice/<slug>/.',
    );
  }

  const items: { index: number; item: BankItem }[] = [];
  const problems: ItemProblem[] = [];

  exercises.forEach((exercise, index) => {
    const read = itemFrom(exercise, index, difficulty);
    problems.push(...read.problems);
    if (read.item !== null) items.push({ index, item: read.item });
  });

  if (items.length === 0 && problems.length === 0) {
    throw new UnreadableDocumentError(
      'Every directory under exercises/ is missing its instructions, solution and tests. ' +
        'This does not look like an Exercism track.',
    );
  }

  return { items, problems };
}
