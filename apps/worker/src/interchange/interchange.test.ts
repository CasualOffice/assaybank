/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Round trips for the two bank formats, over every question kind (M0 exit, H-033, H-034).
 *
 * "Lossless" is asserted as `toStrictEqual`, so an `undefined` where there was a `null`, a `-0`
 * where there was a `0`, or a key present on one side only is a failure. The fixture text is
 * chosen to break XML specifically: carriage returns (normalised by any conforming parser), a NUL
 * and an unpaired surrogate (not representable in XML 1.0 at all), CDATA terminators, markup that
 * must stay text, and whitespace at both ends of a value.
 */

import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';

import { QUESTION_KINDS } from '@assaybank/contracts';

import { checkBankItem, type BankItem, type BankVersion } from './bank-item.js';
import {
  buildBankDocument,
  readBankDocument,
  serialiseBankDocument,
  UnreadableDocumentError,
} from './bank-document.js';
import {
  MANIFEST_PATH,
  PACKAGE_LIMITS,
  readQtiPackage,
  unzipPackage,
  UnreadablePackageError,
  writeQtiPackage,
  zipPackage,
} from './qti.js';
import { needsEncoding } from './xml.js';

/** Built from char codes so no control character sits literally in this source file. */
const NUL = String.fromCharCode(0);
const CR = String.fromCharCode(13);
const LONE_SURROGATE = String.fromCharCode(0xd83d);
const NASTY = `  leading and trailing  ${CR}\nline two\ttab ]]> <script>&amp;</script> "q" 'a' é 🚀 ${NUL}${LONE_SURROGATE}\n`;
const MARKUP = '<div class="assaybank-prompt">not a real element</div> & &lt;';

const EXACT = new Date('2026-10-20T09:00:00.000Z');

function version(overrides: Partial<BankVersion>): BankVersion {
  return {
    version_no: 1,
    published: true,
    locale: 'en',
    prompt_md: `Prompt ${MARKUP}`,
    explanation_md: null,
    difficulty: 3,
    est_seconds: 120,
    max_score: 1,
    negative_score: 0,
    options: [],
    coding_spec: null,
    test_cases: [],
    answer_keys: [],
    ...overrides,
  };
}

function item(
  kind: BankItem['kind'],
  versions: BankVersion[],
  extra: Partial<BankItem> = {},
): BankItem {
  return {
    ref: `q-${kind}`,
    kind,
    status: versions.some((v) => v.published) ? 'published' : 'draft',
    source_license: null,
    external_ref: null,
    skills: [],
    versions,
    ...extra,
  };
}

/** One valid item per kind, each carrying as much of what its kind allows as possible. */
const FIXTURES: Record<BankItem['kind'], BankItem> = {
  mcq_single: item(
    'mcq_single',
    [
      version({
        version_no: 1,
        prompt_md: 'first draft of the prompt',
        options: [
          { body_md: 'a', is_correct: true, score_delta: null, rationale_md: null },
          { body_md: 'b', is_correct: false, score_delta: null, rationale_md: null },
        ],
      }),
      version({
        version_no: 2,
        prompt_md: NASTY,
        explanation_md: NASTY,
        max_score: 2.5,
        negative_score: 0.25,
        options: [
          { body_md: NASTY, is_correct: false, score_delta: -0.5, rationale_md: '' },
          { body_md: MARKUP, is_correct: true, score_delta: null, rationale_md: NASTY },
          { body_md: '  spaced  ', is_correct: false, score_delta: 0.25, rationale_md: null },
        ],
      }),
    ],
    {
      source_license: 'CC-BY-4.0',
      external_ref: 'mbpp/11',
      skills: [
        { key: 'python', weight: 2 },
        { key: 'sql.window-functions', weight: 0.5 },
      ],
    },
  ),
  mcq_multi: item('mcq_multi', [
    version({
      options: [
        { body_md: 'one', is_correct: true, score_delta: null, rationale_md: null },
        { body_md: 'two', is_correct: true, score_delta: null, rationale_md: 'why two' },
        { body_md: 'three', is_correct: false, score_delta: null, rationale_md: null },
      ],
    }),
  ]),
  true_false: item('true_false', [
    version({
      locale: 'pt-BR',
      options: [
        { body_md: 'Verdadeiro', is_correct: false, score_delta: null, rationale_md: null },
        { body_md: 'Falso', is_correct: true, score_delta: null, rationale_md: null },
      ],
    }),
  ]),
  short_answer: item('short_answer', [
    version({
      answer_keys: [
        { match_type: 'regex', pattern: '^\\s*42\\s*$', tolerance: null, score: 1 },
        { match_type: 'exact', pattern: 'Forty-two', tolerance: null, score: 1 },
        { match_type: 'ci', pattern: 'forty two', tolerance: null, score: 0.5 },
        // A duplicate pattern cannot be a second mapEntry, so it must travel in the extension.
        { match_type: 'ci', pattern: 'Forty-two', tolerance: null, score: 0.75 },
        { match_type: 'numeric_tolerance', pattern: '42', tolerance: 0.01, score: 1 },
        // Tab and newline would be normalised in an attribute.
        { match_type: 'exact', pattern: 'forty\ttwo\nlines', tolerance: null, score: 0.1 },
        { match_type: 'exact', pattern: `with${CR}return`, tolerance: null, score: 0.1 },
        { match_type: 'exact', pattern: ' "quoted" & <tagged> ', tolerance: null, score: 0.2 },
      ],
    }),
  ]),
  coding: item('coding', [
    version({
      coding_spec: {
        allowed_languages: ['python', 'javascript'],
        starter_code: { python: 'def solve(n):\n    pass\n', javascript: '' },
        solution_code: { python: `def solve(n):${CR}\n    return n * 2${NUL}` },
        time_limit_ms: 2000,
        memory_limit_kb: 131_072,
        grading_mode: 'custom_checker',
        checker_code: NASTY,
        fixture_sql: null,
      },
      test_cases: [
        {
          label: 'sample',
          stdin: '2\n',
          expected_stdout: '4\n',
          args: null,
          is_sample: true,
          weight: 1,
        },
        {
          label: null,
          stdin: NASTY,
          expected_stdout: `4${CR}\n`,
          args: [],
          is_sample: false,
          weight: 2.5,
        },
        {
          label: MARKUP,
          stdin: '',
          expected_stdout: null,
          args: ['', ' a ', NASTY],
          is_sample: false,
          weight: 0.5,
        },
      ],
    }),
  ]),
  sql: item('sql', [
    version({
      coding_spec: {
        allowed_languages: ['postgresql'],
        starter_code: {},
        solution_code: {},
        time_limit_ms: 5000,
        memory_limit_kb: 262_144,
        grading_mode: 'test_cases',
        checker_code: null,
        fixture_sql: 'CREATE TABLE t (id int);\nINSERT INTO t VALUES (1), (2);',
      },
      test_cases: [
        {
          label: 'rows',
          stdin: 'SELECT count(*) FROM t;',
          expected_stdout: '2',
          args: null,
          is_sample: false,
          weight: 1,
        },
      ],
    }),
  ]),
  subjective: item('subjective', [version({ published: false, est_seconds: 900, max_score: 10 })], {
    status: 'review',
  }),
  system_design: item('system_design', [
    version({ explanation_md: '', prompt_md: 'Design a rate limiter.' }),
  ]),
};

const ALL = QUESTION_KINDS.map((kind) => FIXTURES[kind]);

describe('the fixtures', () => {
  it('cover every kind, and every one is a valid item — the round trips below are not vacuous', () => {
    expect(Object.keys(FIXTURES).sort()).toEqual([...QUESTION_KINDS].sort());
    for (const fixture of ALL) {
      const checked = checkBankItem(fixture, 0);
      expect('item' in checked, JSON.stringify(checked)).toBe(true);
    }
  });

  it('really do contain text XML cannot carry as-is', () => {
    expect(needsEncoding(NASTY)).toBe(true);
    expect(needsEncoding('plain\ttext\n')).toBe(false);
  });
});

describe('JSON bank document', () => {
  it('round-trips every kind, with its full version history, exactly', () => {
    const text = serialiseBankDocument(buildBankDocument(ALL, EXACT));
    const read = readBankDocument(text);
    expect(read.problems).toEqual([]);
    expect(read.items.map((i) => i.item)).toStrictEqual(ALL);
  });

  it('writes the same bytes for the same bank', () => {
    expect(serialiseBankDocument(buildBankDocument(ALL, EXACT))).toBe(
      serialiseBankDocument(buildBankDocument(ALL, EXACT)),
    );
  });

  it('carries attribution for licensed content in the header (docs/05 §2)', () => {
    const document = buildBankDocument(ALL, EXACT);
    expect(document.attributions).toEqual([
      { source_license: 'CC-BY-4.0', dataset: 'mbpp', items: 1 },
    ]);
  });

  it('refuses a document it cannot trust whole, and names why', () => {
    expect(() => readBankDocument('not json')).toThrow(UnreadableDocumentError);
    expect(() => readBankDocument('{"format":"other","format_version":1,"items":[]}')).toThrow(
      /format/u,
    );
    expect(() =>
      readBankDocument('{"format":"assaybank.bank","format_version":2,"items":[]}'),
    ).toThrow(/format_version 1/u);
  });

  it('skips a bad item, reports it by position and path, and keeps the rest', () => {
    const coding = FIXTURES.coding;
    const noHiddenCase: BankItem = {
      ...coding,
      ref: 'bad-coding',
      versions: coding.versions.map((v) => ({
        ...v,
        test_cases: v.test_cases.filter((t) => t.is_sample),
      })),
    };
    const text = JSON.stringify({
      format: 'assaybank.bank',
      format_version: 1,
      items: [FIXTURES.true_false, noHiddenCase, { ref: 'x', kind: 'nope' }, FIXTURES.true_false],
    });
    const read = readBankDocument(text);
    expect(read.items.map((i) => i.index)).toEqual([0]);
    expect(read.problems).toContainEqual(
      expect.objectContaining({ index: 1, ref: 'bad-coding', path: 'versions/0/test_cases' }),
    );
    expect(read.problems.some((p) => p.index === 2 && p.ref === 'x')).toBe(true);
    expect(read.problems).toContainEqual(
      expect.objectContaining({
        index: 3,
        path: 'ref',
        message: expect.stringMatching(/already used/u) as unknown,
      }),
    );
  });

  it('refuses lifecycle and content that disagree', () => {
    const lying = { ...FIXTURES.subjective, status: 'published' };
    const checked = checkBankItem(lying, 0);
    expect('problems' in checked && checked.problems[0]?.path).toBe('status');
  });
});

describe('QTI 2.1 package', () => {
  /** What a QTI round trip must return: the served version, renumbered as the first. */
  const expected = (fixture: BankItem): BankItem => {
    const published = fixture.versions.filter((v) => v.published);
    const served = published[published.length - 1] ?? fixture.versions[fixture.versions.length - 1];
    if (served === undefined) throw new Error('fixture has no version');
    return { ...fixture, versions: [{ ...served, version_no: 1 }] };
  };

  it('round-trips every kind through a zip, exactly, for the served version', () => {
    const bytes = zipPackage(writeQtiPackage(ALL));
    const read = readQtiPackage(unzipPackage(bytes));
    expect(read.problems).toEqual([]);
    expect(read.items.map((i) => i.item)).toStrictEqual(ALL.map(expected));
  });

  it('produces byte-identical archives for the same bank', () => {
    expect(zipPackage(writeQtiPackage(ALL))).toEqual(zipPackage(writeQtiPackage(ALL)));
  });

  it('writes real QTI a foreign tool can read: choices, correct response and score mapping', () => {
    const files = writeQtiPackage([FIXTURES.mcq_single]);
    const xml = files.get('items/q-mcq_single.xml') ?? '';
    expect(xml).toContain(
      '<choiceInteraction responseIdentifier="RESPONSE" shuffle="true" maxChoices="1">',
    );
    expect(xml).toContain('<correctResponse><value>C2</value></correctResponse>');
    expect(xml).toContain('<mapEntry mapKey="C1" mappedValue="-0.5"/>');
    // No answer-key content is hidden in an Assaybank-only element inside the item itself.
    expect(xml).not.toContain('assaybank-item');
    expect(files.get(MANIFEST_PATH)).toContain('<ab:assaybank-item kind="mcq_single"');
  });

  it('keeps simple short-answer keys as standard mapEntry rows', () => {
    const xml = writeQtiPackage([FIXTURES.short_answer]).get('items/q-short_answer.xml') ?? '';
    expect(xml).toContain('mapKey="Forty-two" mappedValue="1" caseSensitive="true"');
    expect(xml).toContain('mapKey="forty two" mappedValue="0.5" caseSensitive="false"');
    expect(xml).not.toContain('forty\ttwo');
  });

  it('reports a missing item file, a traversal path and a DOCTYPE per item, and reads the rest', () => {
    const files = writeQtiPackage([FIXTURES.true_false, FIXTURES.mcq_multi, FIXTURES.subjective]);
    const manifest = (files.get(MANIFEST_PATH) ?? '')
      .replace('href="items/q-mcq_multi.xml"', 'href="../../etc/passwd"')
      .replace('<file href="items/q-mcq_multi.xml"/>', '');
    files.set(MANIFEST_PATH, manifest);
    files.set(
      'items/q-subjective.xml',
      `<!DOCTYPE x [<!ENTITY a "aaaa">]>${files.get('items/q-subjective.xml') ?? ''}`,
    );
    files.delete('items/q-true_false.xml');

    const read = readQtiPackage(files);
    expect(read.items).toEqual([]);
    expect(read.problems.map((p) => [p.index, p.ref])).toEqual([
      [0, 'q-true_false'],
      [1, 'q-mcq_multi'],
      [2, 'q-subjective'],
    ]);
    expect(read.problems[1]?.message).toMatch(/unacceptable path/u);
    expect(read.problems[2]?.message).toMatch(/DOCTYPE/u);
  });

  it('refuses a package with no manifest', () => {
    expect(() => readQtiPackage(new Map())).toThrow(UnreadablePackageError);
  });

  it('reads a foreign item as a draft, but never guesses its difficulty', () => {
    const foreignItem =
      '<?xml version="1.0"?><assessmentItem xmlns="http://www.imsglobal.org/xsd/imsqti_v2p1" identifier="x1" title="Capital" adaptive="false" timeDependent="false">' +
      '<responseDeclaration identifier="RESPONSE" cardinality="single" baseType="identifier"><correctResponse><value>B</value></correctResponse></responseDeclaration>' +
      '<itemBody><choiceInteraction responseIdentifier="RESPONSE" shuffle="false" maxChoices="1"><prompt>Capital of France?</prompt>' +
      '<simpleChoice identifier="A">Lyon</simpleChoice><simpleChoice identifier="B">Paris</simpleChoice></choiceInteraction></itemBody></assessmentItem>';
    const manifest =
      '<?xml version="1.0"?><manifest xmlns="http://www.imsglobal.org/xsd/imscp_v1p1" identifier="m"><organizations/><resources>' +
      '<resource identifier="capital-1" type="imsqti_item_xmlv2p1" href="capital.xml"><file href="capital.xml"/></resource></resources></manifest>';
    const files = new Map([
      [MANIFEST_PATH, manifest],
      ['capital.xml', foreignItem],
    ]);

    const refused = readQtiPackage(files);
    expect(refused.items).toEqual([]);
    expect(refused.problems[0]?.message).toMatch(/difficulty/u);

    const read = readQtiPackage(files, { defaultDifficulty: 2 });
    expect(read.problems).toEqual([]);
    const imported = read.items[0]?.item;
    expect(imported?.kind).toBe('mcq_single');
    expect(imported?.status).toBe('draft');
    expect(imported?.versions[0]?.published).toBe(false);
    expect(imported?.versions[0]?.prompt_md).toBe('Capital of France?');
    expect(imported?.versions[0]?.options.map((o) => [o.body_md, o.is_correct])).toEqual([
      ['Lyon', false],
      ['Paris', true],
    ]);
  });

  it('refuses an archive that declares a file larger than the limit, before inflating it', () => {
    const big = new Uint8Array(PACKAGE_LIMITS.maxEntryBytes + 1);
    const bomb = zipSync(
      { [MANIFEST_PATH]: strToU8('<manifest/>'), 'items/big.xml': big },
      { level: 9 },
    );
    expect(bomb.byteLength).toBeLessThan(100_000);
    expect(() => unzipPackage(bomb)).toThrow(/too large/u);
  });

  it('refuses bytes that are not a zip', () => {
    expect(() => unzipPackage(strToU8('definitely not a zip'))).toThrow(UnreadablePackageError);
  });
});
