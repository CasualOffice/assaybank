/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The dataset importers (`H-032`).
 *
 * The fixtures are shaped like the real files rather than minimised, because the things that
 * break an importer are the things a minimal fixture removes: a docstring containing the word
 * `assert`, an assertion spanning three lines, a `task_id` that is a number in one dataset and
 * a string in another.
 */

import { describe, expect, it } from 'vitest';

import { checkBankItem } from '../bank-item.js';
import { UnreadableDocumentError } from '../bank-document.js';
import { dedent, splitAssertions, splitTestMethods } from './assertions.js';
import { readExercismTrack } from './exercism.js';
import { readJsonlDataset } from './jsonl.js';
import { DATASET_SPECS } from './spec.js';

/** A HumanEval row, in its real shape: prompt is signature + docstring, test is a `check`. */
const HUMANEVAL = {
  task_id: 'HumanEval/0',
  prompt:
    'from typing import List\n\n\ndef has_close_elements(numbers: List[float], threshold: float) -> bool:\n' +
    '    """ Check whether any two numbers are closer than the threshold.\n' +
    '    >>> has_close_elements([1.0, 2.0, 3.0], 0.5)\n    False\n    """\n',
  entry_point: 'has_close_elements',
  canonical_solution:
    '    for i, a in enumerate(numbers):\n        for b in numbers[i + 1:]:\n' +
    '            if abs(a - b) < threshold:\n                return True\n    return False\n',
  test:
    'METADATA = {"author": "hendrycks"}\n\n\ndef check(candidate):\n' +
    '    assert candidate([1.0, 2.0, 3.9, 4.0], 0.3) == True\n' +
    '    assert candidate([1.0, 2.0, 3.9, 4.0], 0.05) == False\n' +
    '    assert candidate(\n        [1.0, 2.0],\n        1.5,\n    ) == True\n',
};

/** An MBPP row: `text` is English, `test_list` is already one assertion per entry. */
const MBPP = {
  task_id: 601,
  text: 'Write a function to find the longest chain which can be formed from the given set of pairs.',
  code: 'class Pair(object):\n    def __init__(self, a, b):\n        self.a = a\n        self.b = b\n',
  test_list: [
    'assert max_chain_length([Pair(5, 24), Pair(15, 25)], 2) == 2',
    'assert max_chain_length([Pair(1, 2), Pair(3, 4)], 2) == 2',
  ],
  test_setup_code: 'from collections import namedtuple',
  challenge_test_list: ['assert max_chain_length([], 0) == 0'],
};

const line = (row: unknown): string => JSON.stringify(row);

describe('splitAssertions', () => {
  it('splits at a statement boundary, not at a line that looks like one', () => {
    const block = [
      'def check(candidate):',
      '    """ the word assert appears in this docstring',
      '    assert this line is prose',
      '    """',
      '    assert candidate(1) == 2',
      '    assert candidate(3) == 4',
    ].join('\n');

    const { assertions } = splitAssertions(block);

    // Two, not four. The docstring's two lines are inside a string and are not statements.
    expect(assertions).toHaveLength(2);
    expect(assertions[0]?.code.trim()).toBe('assert candidate(1) == 2');
  });

  it('keeps a multi-line assertion together', () => {
    const block = [
      'assert f(',
      '    [1, 2, 3],',
      '    key=lambda x: x,',
      ') == [1, 2, 3]',
      'assert g() == 1',
    ].join('\n');

    const { assertions } = splitAssertions(block);

    expect(assertions).toHaveLength(2);
    expect(assertions[0]?.code).toContain('key=lambda');
    expect(assertions[0]?.code).toContain(') == [1, 2, 3]');
  });

  it('does not split inside a bracket, even on a line that starts with assert', () => {
    // A contrived but legal shape: the scanner must not treat a continuation as a statement.
    const block = ['assert sorted([', '    1, 2,', ']) == [1, 2]'].join('\n');

    expect(splitAssertions(block).assertions).toHaveLength(1);
  });

  it('returns what precedes the first assertion as preamble', () => {
    const { preamble, assertions } = splitAssertions('import math\n\nassert math.floor(1.5) == 1');

    expect(preamble.trim()).toBe('import math');
    expect(assertions).toHaveLength(1);
  });

  it('ignores a comment, which cannot contain a statement', () => {
    const { assertions } = splitAssertions('# assert this is a comment\nassert f() == 1');

    expect(assertions).toHaveLength(1);
  });

  it('dedents by the common indent of non-blank lines only', () => {
    expect(dedent('    a\n\n    b')).toBe('a\n\nb');
  });
});

describe('HumanEval', () => {
  const read = readJsonlDataset('humaneval', line(HUMANEVAL));
  const item = read.items[0]?.item;
  const version = item?.versions[0];

  it('reads the row', () => {
    expect(read.problems).toEqual([]);
    // `external_ref` keeps the dataset's own `dataset/id` — it is the provenance docs/05 §2
    // requires auditable. `ref` is the item's key inside an interchange file, and in a QTI
    // package that is a file name, so its slashes are replaced.
    expect(item?.external_ref).toBe('humaneval/HumanEval/0');
    expect(item?.ref).toBe('humaneval-HumanEval-0');
  });

  it('carries the licence docs/05 §2 gives it, not one the uploader chose', () => {
    expect(item?.source_license).toBe('MIT');
  });

  it('imports as a draft, because nobody has read it', () => {
    expect(item?.status).toBe('draft');
    expect(version?.published).toBe(false);
  });

  it('is graded by unit tests, one assertion per case (ADR-024)', () => {
    expect(version?.coding_spec?.grading_mode).toBe('unit_tests');
    expect(version?.test_cases).toHaveLength(3);
    expect(version?.test_cases.every((c) => (c.assertion_code ?? '') !== '')).toBe(true);
  });

  it('binds `candidate`, without which every assertion is a NameError', () => {
    // The dataset's assertions call `candidate`; only `entry_point` says what that is.
    expect(version?.test_cases[0]?.assertion_code).toContain('candidate = has_close_elements');
  });

  it('carries the block preamble onto every case', () => {
    expect(version?.test_cases[1]?.assertion_code).toContain('METADATA');
  });

  it('shows the first assertion and hides the rest', () => {
    expect(version?.test_cases.map((c) => c.is_sample)).toEqual([true, false, false]);
  });

  it('builds a runnable solution, because canonical_solution is only a body', () => {
    const solution = version?.coding_spec?.solution_code['python'] ?? '';

    expect(solution).toContain('def has_close_elements');
    expect(solution).toContain('return False');
  });

  it('fences the prompt, which is Python rather than prose', () => {
    expect(version?.prompt_md).toContain('```python');
    expect(version?.prompt_md).toContain('def has_close_elements');
  });

  it('produces an item the importer accepts', () => {
    expect('problems' in checkBankItem(item, 0)).toBe(false);
  });
});

describe('MBPP', () => {
  const read = readJsonlDataset('mbpp', line(MBPP));
  const item = read.items[0]?.item;
  const version = item?.versions[0];

  it('reads a numeric task_id as an identifier', () => {
    expect(item?.external_ref).toBe('mbpp/601');
    expect(item?.ref).toBe('mbpp-601');
  });

  it('carries CC-BY-4.0, which is an attribution obligation', () => {
    expect(item?.source_license).toBe('CC-BY-4.0');
  });

  it('needs no splitting — the dataset is already one assertion per entry', () => {
    // Two from `test_list` and one from `challenge_test_list`.
    expect(version?.test_cases).toHaveLength(3);
  });

  it('prepends the setup every assertion needs', () => {
    expect(version?.test_cases[0]?.assertion_code).toContain('from collections import namedtuple');
    expect(version?.test_cases[0]?.assertion_code).toContain('max_chain_length');
  });

  it('uses the English text as the prompt, unfenced', () => {
    expect(version?.prompt_md).toBe(MBPP.text);
  });

  it('takes the code as a whole module rather than appending it to a signature', () => {
    expect(version?.coding_spec?.solution_code['python']).toBe(MBPP.code);
  });

  it('produces an item the importer accepts', () => {
    expect('problems' in checkBankItem(item, 0)).toBe(false);
  });
});

describe('a bad row costs the file nothing', () => {
  it('reports the row and imports the others', () => {
    const text = [
      line(HUMANEVAL),
      line({ ...HUMANEVAL, task_id: 'HumanEval/1', prompt: '' }),
      line({ ...HUMANEVAL, task_id: 'HumanEval/2' }),
    ].join('\n');

    const read = readJsonlDataset('humaneval', text);

    expect(read.items).toHaveLength(2);
    expect(read.problems).toHaveLength(1);
    expect(read.problems[0]).toMatchObject({ index: 1, ref: 'humaneval-HumanEval-1' });
  });

  it('names the field, so the message is actionable', () => {
    const read = readJsonlDataset('mbpp', line({ ...MBPP, test_list: 'not a list' }));

    expect(read.problems[0]?.path).toBe('test_list');
    expect(read.problems[0]?.message).toContain('not a list of strings');
  });

  it('reports a row with no assertions rather than importing an ungradeable question', () => {
    const read = readJsonlDataset(
      'mbpp',
      line({ ...MBPP, test_list: [], challenge_test_list: [] }),
    );

    expect(read.items).toEqual([]);
    expect(read.problems[0]?.message).toContain('nothing to grade against');
  });

  it('reports a line that is not JSON without stopping', () => {
    const read = readJsonlDataset('humaneval', [line(HUMANEVAL), 'not json at all'].join('\n'));

    expect(read.items).toHaveLength(1);
    expect(read.problems[0]?.message).toBe('the line is not JSON');
  });
});

describe('a file that is not the thing at all', () => {
  it('refuses an empty file', () => {
    expect(() => readJsonlDataset('mbpp', '   \n\n')).toThrow(UnreadableDocumentError);
  });

  it('refuses a file with no readable row, and says what the format is', () => {
    // A QTI package uploaded as MBPP. The fix is re-uploading, not editing rows, so this is a
    // different answer from "1,847 bad rows" rather than 1,847 of the same problem.
    expect(() => readJsonlDataset('mbpp', '<?xml version="1.0"?>\n<manifest/>')).toThrow(
      /line-delimited JSON/u,
    );
  });
});

describe('a single-assertion problem', () => {
  it('imports its one case hidden, so it cannot be published until somebody adds another', () => {
    const read = readJsonlDataset(
      'mbpp',
      line({ ...MBPP, test_list: ['assert f() == 1'], challenge_test_list: [] }),
    );
    const version = read.items[0]?.item.versions[0];

    expect(version?.test_cases).toHaveLength(1);
    expect(version?.test_cases[0]?.is_sample).toBe(false);

    // A draft is fine; publishing is what the kind rule refuses, and the item is a draft.
    expect('problems' in checkBankItem(read.items[0]?.item, 0)).toBe(false);
  });
});

describe('the descriptors', () => {
  it.each(Object.values(DATASET_SPECS))(
    '$name declares a licence, a ref prefix and the caution docs/05 §2 gives it',
    (spec) => {
      expect(spec.licence.length).toBeGreaterThan(0);
      expect(spec.refPrefix.length).toBeGreaterThan(0);
      // The contamination warning is the thing a recruiter needs at the moment they choose a
      // dataset, not in a document they have not read.
      expect(spec.caution).toContain('docs/05');
    },
  );

  it('namespaces refs, so two datasets cannot collide on a bare id', () => {
    const prefixes = Object.values(DATASET_SPECS).map((s) => s.refPrefix);

    expect(new Set(prefixes).size).toBe(prefixes.length);
  });
});

/** One exercise, in the shape an Exercism track actually has. */
const TWO_FER = new Map<string, string>([
  [
    'python-main/exercises/practice/two-fer/.docs/instructions.md',
    '# Two Fer\n\nGive one, keep one.',
  ],
  [
    'python-main/exercises/practice/two-fer/.meta/example.py',
    'def two_fer(name="you"):\n    return f"One for {name}, one for me."\n',
  ],
  ['python-main/exercises/practice/two-fer/two_fer.py', 'def two_fer(name="you"):\n    pass\n'],
  [
    'python-main/exercises/practice/two-fer/two_fer_test.py',
    [
      'import unittest',
      '',
      'from two_fer import two_fer',
      '',
      '',
      'class TwoFerTest(unittest.TestCase):',
      '    def test_no_name_given(self):',
      '        self.assertEqual(two_fer(), "One for you, one for me.")',
      '',
      '    def test_a_name_given(self):',
      '        """ the word def appears in this docstring',
      '        def test_not_a_method(self): pass',
      '        """',
      '        self.assertEqual(two_fer("Alice"), "One for Alice, one for me.")',
      '',
      '    def test_another_name_given(self):',
      '        self.assertEqual(',
      '            two_fer("Bob"),',
      '            "One for Bob, one for me.",',
      '        )',
      '',
      '',
      'if __name__ == "__main__":',
      '    unittest.main()',
    ].join('\n'),
  ],
]);

describe('splitTestMethods', () => {
  const source = TWO_FER.get('python-main/exercises/practice/two-fer/two_fer_test.py') ?? '';

  it('finds one case per test method, not per assertion', () => {
    // ADR-024's unit is the smallest independently runnable check. For unittest that is the
    // method: it is what the framework discovers and what setUp runs before.
    const { methods } = splitTestMethods(source);

    expect(methods.map((m) => m.name)).toEqual([
      'test_no_name_given',
      'test_a_name_given',
      'test_another_name_given',
    ]);
  });

  it('is not fooled by a `def` inside a docstring', () => {
    expect(splitTestMethods(source).methods).toHaveLength(3);
  });

  it('keeps a call that spans several lines inside its method', () => {
    const last = splitTestMethods(source).methods[2];

    expect(last?.code).toContain('"One for Bob, one for me.",');
    expect(last?.code).toContain(')');
  });

  it('stops a method at the next top-level statement', () => {
    const last = splitTestMethods(source).methods[2];

    expect(last?.code).not.toContain('unittest.main()');
  });

  it('takes the imports as preamble and names the class', () => {
    const { preamble, className } = splitTestMethods(source);

    expect(preamble).toContain('from two_fer import two_fer');
    expect(className).toBe('TwoFerTest');
  });
});

describe('Exercism', () => {
  const read = readExercismTrack(TWO_FER);
  const item = read.items[0]?.item;
  const version = item?.versions[0];

  it('reads an exercise out of a track, through a repo-name wrapper directory', () => {
    expect(read.problems).toEqual([]);
    expect(item?.external_ref).toBe('exercism/two-fer');
    expect(item?.ref).toBe('exercism-two-fer');
  });

  it('carries MIT, which is what docs/05 §2 says Exercism is', () => {
    expect(item?.source_license).toBe('MIT');
  });

  it('uses the instructions as the prompt — they are already markdown', () => {
    expect(version?.prompt_md).toContain('# Two Fer');
  });

  it('takes the stub as starter code and .meta/example.py as the solution', () => {
    expect(version?.coding_spec?.starter_code['python']).toContain('pass');
    expect(version?.coding_spec?.solution_code['python']).toContain('One for {name}');
  });

  it('emits each case as a module the harness can run on its own', () => {
    const first = version?.test_cases[0]?.assertion_code ?? '';

    expect(first).toContain('from two_fer import two_fer');
    expect(first).toContain('class TwoFerTest(unittest.TestCase):');
    expect(first).toContain('def test_no_name_given');
    // One method per case, so the other two are not in this one.
    expect(first).not.toContain('def test_a_name_given');
  });

  it('shows the first behaviour and hides the rest', () => {
    expect(version?.test_cases.map((c) => c.is_sample)).toEqual([true, false, false]);
    expect(version?.test_cases.map((c) => c.label)).toEqual([
      'test_no_name_given',
      'test_a_name_given',
      'test_another_name_given',
    ]);
  });

  it('produces an item the importer accepts', () => {
    expect('problems' in checkBankItem(item, 0)).toBe(false);
  });
});

describe('an incomplete track', () => {
  it('reports an exercise missing its reference solution and imports the rest', () => {
    const entries = new Map(TWO_FER);
    entries.set('exercises/practice/bob/.docs/instructions.md', '# Bob');
    entries.set('exercises/practice/bob/bob_test.py', 'import unittest\n');

    const read = readExercismTrack(entries);

    expect(read.items).toHaveLength(1);
    expect(read.problems[0]).toMatchObject({ ref: 'exercism-bob', path: '.meta/example.py' });
  });

  it('ignores a directory that is not an exercise, in silence', () => {
    const entries = new Map(TWO_FER);
    entries.set('python-main/.github/workflows/ci.yml', 'name: CI');
    entries.set('python-main/bin/fetch-configlet', '#!/bin/sh');

    const read = readExercismTrack(entries);

    expect(read.items).toHaveLength(1);
    expect(read.problems).toEqual([]);
  });

  it('refuses a zip with no exercises at all, and says where they live', () => {
    expect(() => readExercismTrack(new Map([['readme.md', '# not a track']]))).toThrow(
      /exercises\/practice/u,
    );
  });

  it('imports exercises in a stable order, because a checkpoint is a position in it', () => {
    // Invariant 17: a retried job resumes at its checkpoint. If the order changed between
    // runs, the resume would land on a different exercise.
    const entries = new Map(TWO_FER);
    for (const [path, content] of TWO_FER) {
      entries.set(path.replace('two-fer', 'acronym').replace('two_fer', 'acronym'), content);
    }

    const refs = readExercismTrack(entries).items.map((i) => i.item.ref);

    expect(refs).toEqual(['exercism-acronym', 'exercism-two-fer']);
  });
});
