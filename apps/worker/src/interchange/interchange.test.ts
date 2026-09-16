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

import { ALL, EXACT, FIXTURES, MARKUP, NASTY } from '../../test/fixtures/bank-items.js';
import { checkBankItem, type BankItem } from './bank-item.js';
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
    expect(needsEncoding(MARKUP)).toBe(false);
    expect(needsEncoding('plain\ttext\n')).toBe(false);
    // Not in the fixtures, because a bank cannot store it, but XML must still carry it exactly.
    expect(needsEncoding(String.fromCharCode(0xd83d))).toBe(true);
  });

  it('refuses text a question bank cannot store, naming the field', () => {
    const base = FIXTURES.subjective;
    const first = base.versions[0];
    if (first === undefined) throw new Error('fixture has no version');
    const withNul = { ...base, versions: [{ ...first, prompt_md: `a${String.fromCharCode(0)}b` }] };
    const checked = checkBankItem(withNul, 0);
    expect('problems' in checked && checked.problems.map((p) => p.path)).toEqual([
      'versions/0/prompt_md',
    ]);
    const loneSurrogate = { ...base, source_license: String.fromCharCode(0xd83d) };
    expect('problems' in checkBankItem(loneSurrogate, 0)).toBe(true);
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
