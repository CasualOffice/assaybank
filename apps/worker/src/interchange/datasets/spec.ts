/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The datasets this platform will import, as data (`H-032`, docs/05 §2).
 *
 * ## Why a descriptor rather than an adapter per dataset
 *
 * The three JSONL datasets differ only in what their fields are called. HumanEval's problem
 * statement is `prompt`, MBPP's is `text`, LBPP's is `instruction`; the assertions are `test`,
 * `test_list` and `test_list` again. Writing three readers around that would be writing the
 * same reader three times, and the third would drift from the first.
 *
 * It also makes the part most likely to be wrong the part cheapest to fix. Field names are
 * checked against a file, and a file we have not seen yet is a guess — so a guess lives here,
 * in six lines of data, rather than distributed through a parser.
 *
 * ## The licence is not the uploader's to choose
 *
 * `ImportOptions.source_license` is what a staff member types when they upload their own bank
 * document. For a named dataset it is **not** a parameter: HumanEval is MIT because it is MIT,
 * and an import that accepted "proprietary" for it would put content in the bank whose real
 * terms nobody could reconstruct. docs/05 §2 is the source, and the licence travels on every
 * row and into every export.
 *
 * ## The contamination warning travels too
 *
 * docs/05 §2 is blunt about it: every dataset here was built to benchmark language models, so
 * every one of them is in the training data of every model a candidate might use — MBPP's
 * measured contamination is above 60%. That does not make them useless; it makes them useful
 * for entry-level screening and close to worthless above it. The warning is carried in
 * `caution` so the console can show it at the point somebody chooses a dataset, rather than
 * leaving it in a document they have not read.
 */

/** The datasets with a line-delimited JSON distribution. */
export const JSONL_DATASETS = ['humaneval', 'mbpp', 'lbpp'] as const;

export type JsonlDataset = (typeof JSONL_DATASETS)[number];

/** Where one piece of a question lives in a dataset's row. */
export interface FieldMap {
  /** The dataset's own identifier for the problem, used to build `external_ref`. */
  readonly id: string;
  /** The problem statement, as the dataset words it. */
  readonly prompt: string;
  /** The reference solution. Staff-only content, and never served (invariant 7). */
  readonly solution: string;
  /** Code the candidate starts from. Absent in datasets that give none. */
  readonly starter?: string;
  /**
   * The assertions. A string (one block to be split) or an array (already one per entry).
   * `kind` says which, because the two need different handling and guessing from the runtime
   * type would silently accept a dataset that changed shape.
   */
  readonly tests: string;
  readonly testsKind: 'block' | 'list';
  /** Setup code every assertion needs — imports, a fixture class. Prepended to each case. */
  readonly setup?: string;
  /** Further assertions, imported as extra hidden cases. MBPP's `challenge_test_list`. */
  readonly extraTests?: string;
  /**
   * The function the assertions call, when the dataset states it separately.
   *
   * HumanEval's assertions call `candidate`, and `entry_point` names what `candidate` is. An
   * assertion is unrunnable without that binding, so the reader emits it as a prelude.
   */
  readonly entryPoint?: string;
}

export interface DatasetSpec {
  readonly key: JsonlDataset;
  /** What a person calls it. Used in the attributions list and in a problem message. */
  readonly name: string;
  /**
   * The licence, from docs/05 §2. Not a parameter.
   *
   * CC-BY-4.0 carries an attribution obligation that is real: an attributions page in the
   * console and the credit preserved in every export. The JSON bank document's header already
   * carries an `attributions` list for exactly this.
   */
  readonly licence: string;
  /** `humaneval/HumanEval/0`. Namespaced, so two datasets cannot collide on a bare id. */
  readonly refPrefix: string;
  /** The language its solutions are written in. All three are Python. */
  readonly language: string;
  /** What docs/05 §2 says about using it, carried to where somebody chooses it. */
  readonly caution: string;
  readonly fields: FieldMap;
}

/**
 * Difficulty is not in any of these files, so it is declared per dataset.
 *
 * An honest default beats a computed one: there is no signal in a HumanEval row that maps to a
 * five-point scale, and inventing one from prompt length or solution length would be a number
 * that looks measured and is not. `ImportOptions.default_difficulty` overrides it, and
 * `question_stats` replaces it with a measured p-value once a version has 30 responses (FR-5),
 * which is the point at which the declared value stops mattering.
 */
export const DATASET_SPECS: Readonly<Record<JsonlDataset, DatasetSpec>> = Object.freeze({
  humaneval: {
    key: 'humaneval',
    name: 'HumanEval',
    licence: 'MIT',
    refPrefix: 'humaneval',
    language: 'python',
    caution:
      'Built to benchmark language models, so it is in the training data of every model a ' +
      'candidate might use. Useful for filtering non-programmers; close to worthless against ' +
      'an AI assistant (docs/05 §2).',
    fields: {
      id: 'task_id',
      // HumanEval's `prompt` is the signature and docstring together: it is both the question
      // and the code the candidate starts from, which is why it appears twice below.
      prompt: 'prompt',
      starter: 'prompt',
      solution: 'canonical_solution',
      tests: 'test',
      testsKind: 'block',
      entryPoint: 'entry_point',
    },
  },
  mbpp: {
    key: 'mbpp',
    name: 'MBPP',
    licence: 'CC-BY-4.0',
    refPrefix: 'mbpp',
    language: 'python',
    caution:
      'CC-BY-4.0: credit is required, and is preserved on every row and in every export. ' +
      'Measured contamination above 60% against public sources (docs/05 §2).',
    fields: {
      id: 'task_id',
      prompt: 'text',
      solution: 'code',
      tests: 'test_list',
      testsKind: 'list',
      setup: 'test_setup_code',
      extraTests: 'challenge_test_list',
    },
  },
  lbpp: {
    key: 'lbpp',
    name: 'LBPP',
    licence: 'Apache-2.0',
    refPrefix: 'lbpp',
    language: 'python',
    caution:
      'Apache-2.0: a NOTICE obligation. Written to be harder than MBPP and more recent, so ' +
      'less contaminated — but it is still a published benchmark (docs/05 §2).',
    fields: {
      id: 'task_id',
      prompt: 'instruction',
      solution: 'completion',
      starter: 'signature',
      tests: 'test_list',
      testsKind: 'list',
      setup: 'test_setup',
    },
  },
});
