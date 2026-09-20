/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * QTI 2.1 content packages — moving items into and out of other assessment tools (H-033).
 *
 * ## What goes where
 *
 * Standard QTI 2.1 carries everything QTI can express, so another tool reads a real item rather
 * than an opaque blob: the prompt, the explanation and per-option rationale as `modalFeedback`,
 * choices as a `choiceInteraction` with `correctResponse`, per-option score overrides as a
 * `mapping`, and exact or case-insensitive short-answer keys as `mapEntry` rows.
 *
 * What QTI has no construct for goes in the package manifest, in each resource's `<metadata>`,
 * under the namespace {@link ASSAYBANK_NS}: the kind (QTI cannot tell `true_false` from a
 * two-option `mcq_single`), lifecycle, difficulty, timing, scoring, skills, licence provenance,
 * the coding spec and test cases, and answer keys that are regular expressions or numeric
 * tolerances. IMS Content Packaging permits foreign metadata there, and a tool that does not know
 * the namespace ignores it.
 *
 * ## The one limit, stated
 *
 * A QTI item is one version. A package carries each question's served version — the last
 * published one, or the last of all when none is published — so a QTI round trip is lossless
 * for that version's content and imports it as version 1. The version history crosses in the
 * JSON bank document, not here.
 *
 * ## Foreign packages
 *
 * An item with no Assaybank metadata is read best-effort: a `choiceInteraction` becomes
 * `mcq_single` or `mcq_multi`, a `textEntryInteraction` becomes `short_answer`, an
 * `extendedTextInteraction` becomes `subjective`, all as unpublished drafts. Difficulty is not in
 * QTI and is never guessed — the importer must supply a default or the item is refused by name.
 */

import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';

import {
  checkBankItem,
  servedOrLatest,
  type BankAnswerKey,
  type BankCodingSpec,
  type BankItem,
  type BankOption,
  type BankTestCase,
  type BankVersion,
  type ItemProblem,
} from './bank-item.js';
import {
  attr,
  attrs,
  child,
  children,
  MalformedXmlError,
  needsEncoding,
  optionalText,
  parseXml,
  text,
  textElement,
  type XmlElement,
} from './xml.js';

export const QTI_NS = 'http://www.imsglobal.org/xsd/imsqti_v2p1';
export const IMSCP_NS = 'http://www.imsglobal.org/xsd/imscp_v1p1';
export const ASSAYBANK_NS = 'urn:assaybank:bank:v1';
export const QTI_ITEM_TYPE = 'imsqti_item_xmlv2p1';
export const MANIFEST_PATH = 'imsmanifest.xml';

const MATCH_CORRECT = 'http://www.imsglobal.org/question/qti_v2p1/rptemplates/match_correct';
const MAP_RESPONSE = 'http://www.imsglobal.org/question/qti_v2p1/rptemplates/map_response';

const CHOICE_KINDS = new Set(['mcq_single', 'mcq_multi', 'true_false']);

const itemPath = (ref: string): string => `items/${ref}.xml`;
const choiceId = (index: number): string => `C${String(index + 1)}`;

// ---------------------------------------------------------------------------- writing

/**
 * Which answer keys QTI's `mapping` can carry: exact or case-insensitive, no tolerance, and a
 * pattern not already mapped — `mapKey` must be unique, and a second key for the same string
 * would be ambiguous — and a pattern that can live in an attribute. `mapKey` is an attribute, and a
 * parser normalises tabs and newlines in attributes to spaces. The rest travel in the extension,
 * with their position.
 */
function partitionAnswerKeys(keys: readonly BankAnswerKey[]): {
  mapped: { position: number; key: BankAnswerKey }[];
  extended: { position: number; key: BankAnswerKey }[];
} {
  const mapped: { position: number; key: BankAnswerKey }[] = [];
  const extended: { position: number; key: BankAnswerKey }[] = [];
  const seen = new Set<string>();
  keys.forEach((key, position) => {
    const mappable =
      (key.match_type === 'exact' || key.match_type === 'ci') &&
      key.tolerance === null &&
      !/[\t\n]/u.test(key.pattern) &&
      !needsEncoding(key.pattern) &&
      !seen.has(key.pattern);
    if (mappable) {
      seen.add(key.pattern);
      mapped.push({ position, key });
    } else {
      extended.push({ position, key });
    }
  });
  return { mapped, extended };
}

function responseDeclaration(item: BankItem, version: BankVersion): string {
  if (CHOICE_KINDS.has(item.kind)) {
    const cardinality = item.kind === 'mcq_multi' ? 'multiple' : 'single';
    const correct = version.options
      .map((option, i) => (option.is_correct ? `<value>${choiceId(i)}</value>` : ''))
      .join('');
    const overrides = version.options
      .map((option, i) =>
        option.score_delta === null
          ? ''
          : `<mapEntry${attrs({ mapKey: choiceId(i), mappedValue: option.score_delta })}/>`,
      )
      .join('');
    return (
      `<responseDeclaration${attrs({ identifier: 'RESPONSE', cardinality, baseType: 'identifier' })}>` +
      (correct === '' ? '' : `<correctResponse>${correct}</correctResponse>`) +
      (overrides === '' ? '' : `<mapping defaultValue="0">${overrides}</mapping>`) +
      `</responseDeclaration>`
    );
  }
  if (item.kind === 'short_answer') {
    const { mapped } = partitionAnswerKeys(version.answer_keys);
    const entries = mapped
      .map(({ key }) =>
        textElement('mapEntry', '', {
          mapKey: key.pattern,
          mappedValue: key.score,
          caseSensitive: key.match_type === 'exact',
        }),
      )
      .join('');
    return (
      `<responseDeclaration${attrs({ identifier: 'RESPONSE', cardinality: 'single', baseType: 'string' })}>` +
      (entries === '' ? '' : `<mapping defaultValue="0">${entries}</mapping>`) +
      `</responseDeclaration>`
    );
  }
  return `<responseDeclaration${attrs({ identifier: 'RESPONSE', cardinality: 'single', baseType: 'string' })}/>`;
}

function interaction(item: BankItem, version: BankVersion): string {
  if (CHOICE_KINDS.has(item.kind)) {
    const maxChoices = item.kind === 'mcq_multi' ? 0 : 1;
    const choices = version.options
      .map(
        (option, i) =>
          `<simpleChoice${attrs({ identifier: choiceId(i) })}>` +
          textElement('div', option.body_md, { class: 'assaybank-option' }) +
          `</simpleChoice>`,
      )
      .join('');
    return `<choiceInteraction${attrs({ responseIdentifier: 'RESPONSE', shuffle: true, maxChoices })}>${choices}</choiceInteraction>`;
  }
  if (item.kind === 'short_answer') {
    return `<p><textEntryInteraction${attrs({ responseIdentifier: 'RESPONSE' })}/></p>`;
  }
  return `<extendedTextInteraction${attrs({ responseIdentifier: 'RESPONSE' })}/>`;
}

function responseProcessing(item: BankItem, version: BankVersion): string {
  if (CHOICE_KINDS.has(item.kind)) {
    const mapped = version.options.some((o) => o.score_delta !== null);
    return `<responseProcessing${attrs({ template: mapped ? MAP_RESPONSE : MATCH_CORRECT })}/>`;
  }
  if (item.kind === 'short_answer') {
    return `<responseProcessing${attrs({ template: MAP_RESPONSE })}/>`;
  }
  // Subjective, system design, coding and SQL are scored outside QTI: by a person, or by running
  // code against test cases no QTI processor would know how to execute.
  return '';
}

/** One version of one question as a QTI 2.1 `assessmentItem`. */
export function writeQtiItem(item: BankItem, version: BankVersion): string {
  const feedback = [
    version.explanation_md === null
      ? ''
      : `<modalFeedback${attrs({ outcomeIdentifier: 'FEEDBACK', showHide: 'show', identifier: 'EXPLANATION' })}>` +
        textElement('div', version.explanation_md, { class: 'assaybank-explanation' }) +
        `</modalFeedback>`,
    ...version.options.map((option, i) =>
      option.rationale_md === null
        ? ''
        : `<modalFeedback${attrs({ outcomeIdentifier: 'FEEDBACK', showHide: 'show', identifier: `RATIONALE_${choiceId(i)}` })}>` +
          textElement('div', option.rationale_md, { class: 'assaybank-rationale' }) +
          `</modalFeedback>`,
    ),
  ].join('');

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<assessmentItem${attrs({
      xmlns: QTI_NS,
      identifier: `I-${item.ref}`,
      title: item.ref,
      adaptive: false,
      timeDependent: false,
      'xml:lang': version.locale,
    })}>` +
    responseDeclaration(item, version) +
    `<outcomeDeclaration${attrs({ identifier: 'SCORE', cardinality: 'single', baseType: 'float', normalMaximum: version.max_score })}><defaultValue><value>0</value></defaultValue></outcomeDeclaration>` +
    `<outcomeDeclaration${attrs({ identifier: 'FEEDBACK', cardinality: 'multiple', baseType: 'identifier' })}/>` +
    `<itemBody>` +
    textElement('div', version.prompt_md, { class: 'assaybank-prompt' }) +
    interaction(item, version) +
    `</itemBody>` +
    responseProcessing(item, version) +
    feedback +
    `</assessmentItem>\n`
  );
}

function codeFiles(tag: string, files: Readonly<Record<string, string>>): string {
  // Sorted, so the same spec writes the same bytes regardless of key insertion order.
  return Object.keys(files)
    .sort()
    .map(
      (language) =>
        `<ab:${tag}>` +
        textElement('ab:language', language) +
        textElement('ab:source', files[language] ?? '') +
        `</ab:${tag}>`,
    )
    .join('');
}

function writeCodingSpec(spec: BankCodingSpec): string {
  return (
    `<ab:coding-spec${attrs({ 'time-limit-ms': spec.time_limit_ms, 'memory-limit-kb': spec.memory_limit_kb, 'grading-mode': spec.grading_mode })}>` +
    spec.allowed_languages.map((l) => textElement('ab:allowed-language', l)).join('') +
    codeFiles('starter-code', spec.starter_code) +
    codeFiles('solution-code', spec.solution_code) +
    (spec.checker_code === null ? '' : textElement('ab:checker-code', spec.checker_code)) +
    (spec.fixture_sql === null ? '' : textElement('ab:fixture-sql', spec.fixture_sql)) +
    `</ab:coding-spec>`
  );
}

function writeTestCase(testCase: BankTestCase): string {
  return (
    `<ab:test-case${attrs({ 'is-sample': testCase.is_sample, weight: testCase.weight })}>` +
    (testCase.label === null ? '' : textElement('ab:label', testCase.label)) +
    textElement('ab:stdin', testCase.stdin) +
    (testCase.expected_stdout === null
      ? ''
      : textElement('ab:expected-stdout', testCase.expected_stdout)) +
    (testCase.args === null
      ? ''
      : `<ab:args>${testCase.args.map((a) => textElement('ab:arg', a)).join('')}</ab:args>`) +
    // Absent rather than empty when null, so a `test_cases`-mode question round-trips to a
    // package identical to the one it produced before ADR-024 added the field.
    (testCase.assertion_code === null
      ? ''
      : textElement('ab:assertion-code', testCase.assertion_code)) +
    `</ab:test-case>`
  );
}

/** The Assaybank metadata for one resource: everything QTI has no construct for. */
function writeExtension(item: BankItem, version: BankVersion): string {
  const { extended } = partitionAnswerKeys(version.answer_keys);
  return (
    `<ab:assaybank-item${attrs({
      kind: item.kind,
      status: item.status,
      published: version.published,
      difficulty: version.difficulty,
      'est-seconds': version.est_seconds,
      'max-score': version.max_score,
      'negative-score': version.negative_score,
    })}>` +
    (item.source_license === null ? '' : textElement('ab:source-license', item.source_license)) +
    (item.external_ref === null ? '' : textElement('ab:external-ref', item.external_ref)) +
    item.skills.map((s) => `<ab:skill${attrs({ key: s.key, weight: s.weight })}/>`).join('') +
    (version.coding_spec === null ? '' : writeCodingSpec(version.coding_spec)) +
    version.test_cases.map(writeTestCase).join('') +
    extended
      .map(
        ({ position, key }) =>
          `<ab:answer-key${attrs({
            position,
            'match-type': key.match_type,
            score: key.score,
            tolerance: key.tolerance ?? undefined,
          })}>` +
          textElement('ab:pattern', key.pattern) +
          `</ab:answer-key>`,
      )
      .join('') +
    `</ab:assaybank-item>`
  );
}

/**
 * The files of a QTI 2.1 content package for these items, in item order.
 *
 * Returned as a map rather than a zip so the structure can be asserted directly; {@link zipPackage}
 * produces the bytes.
 */
export function writeQtiPackage(items: readonly BankItem[]): Map<string, string> {
  const files = new Map<string, string>();
  const resources = items.map((item) => {
    const version = servedOrLatest(item);
    files.set(itemPath(item.ref), writeQtiItem(item, version));
    return (
      `<resource${attrs({ identifier: `R-${item.ref}`, type: QTI_ITEM_TYPE, href: itemPath(item.ref) })}>` +
      `<metadata>${writeExtension(item, version)}</metadata>` +
      `<file${attrs({ href: itemPath(item.ref) })}/>` +
      `</resource>`
    );
  });

  files.set(
    MANIFEST_PATH,
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<manifest${attrs({ xmlns: IMSCP_NS, 'xmlns:ab': ASSAYBANK_NS, identifier: 'MANIFEST-assaybank' })}>` +
      `<metadata><schema>QTIv2.1 Package</schema><schemaversion>1.0.0</schemaversion></metadata>` +
      `<organizations/>` +
      `<resources>${resources.join('')}</resources>` +
      `</manifest>\n`,
  );
  return files;
}

/** A fixed timestamp: two exports of the same bank are byte-identical zips. */
const ZIP_MTIME = new Date('1980-01-01T00:00:00Z');

export function zipPackage(files: ReadonlyMap<string, string>): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  for (const [path, content] of files) entries[path] = strToU8(content);
  return zipSync(entries, { level: 6, mtime: ZIP_MTIME });
}

// ---------------------------------------------------------------------------- reading

/** Limits on an uploaded archive. A zip is a compression ratio an attacker chooses. */
export const PACKAGE_LIMITS = {
  maxEntries: 20_000,
  maxEntryBytes: 16 * 1024 * 1024,
  maxTotalBytes: 256 * 1024 * 1024,
} as const;

export class UnreadablePackageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnreadablePackageError';
  }
}

/**
 * The text files of a zip, refusing it whole when it exceeds {@link PACKAGE_LIMITS}.
 *
 * Sizes are checked from the central directory before anything is inflated. The directory can
 * lie, so the inflated sizes are checked again afterwards.
 */
export function unzipPackage(bytes: Uint8Array): Map<string, string> {
  let entries = 0;
  let declared = 0;
  let raw: Record<string, Uint8Array>;
  try {
    raw = unzipSync(bytes, {
      filter: (file) => {
        entries += 1;
        declared += file.originalSize;
        if (entries > PACKAGE_LIMITS.maxEntries) {
          throw new UnreadablePackageError('The package has too many files.');
        }
        if (file.originalSize > PACKAGE_LIMITS.maxEntryBytes) {
          throw new UnreadablePackageError(`${file.name} is too large.`);
        }
        if (declared > PACKAGE_LIMITS.maxTotalBytes) {
          throw new UnreadablePackageError('The package is too large when extracted.');
        }
        return true;
      },
    });
  } catch (error) {
    if (error instanceof UnreadablePackageError) throw error;
    throw new UnreadablePackageError('The file is not a readable zip archive.');
  }

  const files = new Map<string, string>();
  let total = 0;
  for (const [path, content] of Object.entries(raw)) {
    total += content.byteLength;
    if (content.byteLength > PACKAGE_LIMITS.maxEntryBytes || total > PACKAGE_LIMITS.maxTotalBytes) {
      throw new UnreadablePackageError('The package is too large when extracted.');
    }
    files.set(path, strFromU8(content));
  }
  return files;
}

const MANIFEST_REPEATED = new Set([
  'resource',
  'file',
  'skill',
  'allowed-language',
  'starter-code',
  'solution-code',
  'test-case',
  'arg',
  'answer-key',
]);
const ITEM_REPEATED = new Set([
  'responseDeclaration',
  'outcomeDeclaration',
  'value',
  'mapEntry',
  'simpleChoice',
  'div',
  'p',
  'modalFeedback',
]);

/** Options for reading a package. Only foreign items use them. */
export interface ReadQtiOptions {
  /** Difficulty for an item with no Assaybank metadata. Absent means such items are refused. */
  readonly defaultDifficulty?: number;
}

export interface QtiReadResult {
  readonly items: readonly { readonly index: number; readonly item: BankItem }[];
  readonly problems: readonly ItemProblem[];
}

function numberAttr(node: XmlElement | undefined, name: string): number | undefined {
  const value = attr(node, name);
  if (value === undefined || value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function boolAttr(node: XmlElement | undefined, name: string): boolean | undefined {
  const value = attr(node, name);
  return value === 'true' ? true : value === 'false' ? false : undefined;
}

/** The text of the first `div` with this class, or of the node itself when it has none. */
function classedText(node: XmlElement | undefined, className: string): string | null {
  if (node === undefined) return null;
  const div = children(node, 'div').find((d) => attr(d, 'class') === className);
  return div === undefined ? null : text(div);
}

function readCodeFiles(nodes: readonly XmlElement[]): Record<string, string> {
  const files: Record<string, string> = {};
  for (const node of nodes) {
    const language = optionalText(node, 'language');
    if (language !== null) files[language] = optionalText(node, 'source') ?? '';
  }
  return files;
}

function readCodingSpec(node: XmlElement | undefined): BankCodingSpec | null {
  if (node === undefined) return null;
  return {
    allowed_languages: children(node, 'allowed-language').map(text),
    starter_code: readCodeFiles(children(node, 'starter-code')),
    solution_code: readCodeFiles(children(node, 'solution-code')),
    time_limit_ms: numberAttr(node, 'time-limit-ms') ?? Number.NaN,
    memory_limit_kb: numberAttr(node, 'memory-limit-kb') ?? Number.NaN,
    grading_mode: (attr(node, 'grading-mode') ?? '') as BankCodingSpec['grading_mode'],
    checker_code: optionalText(node, 'checker-code'),
    fixture_sql: optionalText(node, 'fixture-sql'),
  };
}

function readTestCase(node: XmlElement): BankTestCase {
  const args = child(node, 'args');
  return {
    label: optionalText(node, 'label'),
    stdin: optionalText(node, 'stdin') ?? '',
    expected_stdout: optionalText(node, 'expected-stdout'),
    args: args === undefined ? null : children(args, 'arg').map(text),
    assertion_code: optionalText(node, 'assertion-code'),
    is_sample: boolAttr(node, 'is-sample') ?? false,
    weight: numberAttr(node, 'weight') ?? Number.NaN,
  };
}

/** Rebuilds the answer keys in their original order: extension keys by position, mapped keys fill the gaps. */
function readAnswerKeys(itemXml: XmlElement, extension: XmlElement | undefined): BankAnswerKey[] {
  const response = children(itemXml, 'responseDeclaration').find(
    (d) => attr(d, 'identifier') === 'RESPONSE',
  );
  const mapped: BankAnswerKey[] = children(child(response, 'mapping'), 'mapEntry').map((entry) => ({
    match_type: attr(entry, 'caseSensitive') === 'false' ? 'ci' : 'exact',
    pattern: attr(entry, 'mapKey') ?? '',
    tolerance: null,
    score: numberAttr(entry, 'mappedValue') ?? Number.NaN,
  }));
  const extended = children(extension, 'answer-key').map((node) => ({
    position: numberAttr(node, 'position') ?? Number.NaN,
    key: {
      match_type: (attr(node, 'match-type') ?? '') as BankAnswerKey['match_type'],
      pattern: optionalText(node, 'pattern') ?? '',
      tolerance: numberAttr(node, 'tolerance') ?? null,
      score: numberAttr(node, 'score') ?? Number.NaN,
    },
  }));

  const total = mapped.length + extended.length;
  const keys: BankAnswerKey[] = [];
  const byPosition = new Map(extended.map((e) => [e.position, e.key]));
  let next = 0;
  for (let position = 0; position < total; position += 1) {
    const fromExtension = byPosition.get(position);
    if (fromExtension !== undefined) {
      keys.push(fromExtension);
    } else {
      const fromMapping = mapped[next];
      next += 1;
      if (fromMapping !== undefined) keys.push(fromMapping);
    }
  }
  return keys;
}

function readOptions(itemXml: XmlElement): BankOption[] {
  const body = child(itemXml, 'itemBody');
  const interactionNode = child(body, 'choiceInteraction');
  const response = children(itemXml, 'responseDeclaration').find(
    (d) => attr(d, 'identifier') === 'RESPONSE',
  );
  const correct = new Set(children(child(response, 'correctResponse'), 'value').map(text));
  const deltas = new Map(
    children(child(response, 'mapping'), 'mapEntry').map((e) => [
      attr(e, 'mapKey') ?? '',
      numberAttr(e, 'mappedValue') ?? Number.NaN,
    ]),
  );
  const feedback = new Map(
    children(itemXml, 'modalFeedback').map((f) => [attr(f, 'identifier') ?? '', f]),
  );

  return children(interactionNode, 'simpleChoice').map((choice) => {
    const id = attr(choice, 'identifier') ?? '';
    const rationale = feedback.get(`RATIONALE_${id}`);
    return {
      body_md: classedText(choice, 'assaybank-option') ?? text(choice).trim(),
      is_correct: correct.has(id),
      score_delta: deltas.get(id) ?? null,
      rationale_md:
        rationale === undefined
          ? null
          : (classedText(rationale, 'assaybank-rationale') ?? text(rationale)),
    };
  });
}

/**
 * A foreign item's prompt, best effort: the interaction's own `prompt`, then the body's paragraphs
 * and divisions, joined by blank lines. Inline markup inside them is not reconstructed.
 */
function foreignPrompt(root: XmlElement): string {
  const body = child(root, 'itemBody');
  const parts = [
    ...['choiceInteraction', 'extendedTextInteraction'].map((name) =>
      optionalText(child(body, name), 'prompt'),
    ),
    ...children(body, 'p').map(text),
    ...children(body, 'div').map(text),
  ]
    .map((part) => part?.trim() ?? '')
    .filter((part) => part !== '');
  return parts.join('\n\n');
}

function foreignKind(itemXml: XmlElement): BankItem['kind'] | undefined {
  const body = child(itemXml, 'itemBody');
  const choice = child(body, 'choiceInteraction');
  if (choice !== undefined)
    return numberAttr(choice, 'maxChoices') === 1 ? 'mcq_single' : 'mcq_multi';
  const inParagraph = children(body, 'p').some(
    (p) => child(p, 'textEntryInteraction') !== undefined,
  );
  if (inParagraph || child(body, 'textEntryInteraction') !== undefined) return 'short_answer';
  if (child(body, 'extendedTextInteraction') !== undefined) return 'subjective';
  return undefined;
}

/** Builds the candidate item for one resource; validation happens once, in `checkBankItem`. */
function candidateItem(
  resource: XmlElement,
  itemXml: XmlElement,
  options: ReadQtiOptions,
): { readonly candidate: unknown } | { readonly problem: string } {
  const root = child(itemXml, 'assessmentItem');
  if (root === undefined) return { problem: 'the item file has no assessmentItem' };

  const extension = child(child(resource, 'metadata'), 'assaybank-item');
  const identifier = attr(resource, 'identifier') ?? '';
  const ref = identifier.startsWith('R-') ? identifier.slice(2) : identifier;
  const kind = extension === undefined ? foreignKind(root) : attr(extension, 'kind');
  if (kind === undefined) return { problem: 'no interaction this importer understands' };

  const difficulty =
    extension === undefined ? options.defaultDifficulty : numberAttr(extension, 'difficulty');
  if (difficulty === undefined) {
    return {
      problem:
        'the item carries no difficulty, and QTI has no field for one; supply a default difficulty for foreign items',
    };
  }

  const published = extension === undefined ? false : (boolAttr(extension, 'published') ?? false);
  const scoreOutcome = children(root, 'outcomeDeclaration').find(
    (o) => attr(o, 'identifier') === 'SCORE',
  );
  const explanation = children(root, 'modalFeedback').find(
    (f) => attr(f, 'identifier') === 'EXPLANATION',
  );

  const version: BankVersion = {
    version_no: 1,
    published,
    locale: attr(root, 'lang') ?? 'en',
    prompt_md: classedText(child(root, 'itemBody'), 'assaybank-prompt') ?? foreignPrompt(root),
    explanation_md:
      explanation === undefined
        ? null
        : (classedText(explanation, 'assaybank-explanation') ?? text(explanation)),
    difficulty,
    est_seconds: numberAttr(extension, 'est-seconds') ?? 120,
    max_score: numberAttr(extension, 'max-score') ?? numberAttr(scoreOutcome, 'normalMaximum') ?? 1,
    negative_score: numberAttr(extension, 'negative-score') ?? 0,
    options: CHOICE_KINDS.has(kind) ? readOptions(root) : [],
    coding_spec: readCodingSpec(child(extension, 'coding-spec')),
    test_cases: children(extension, 'test-case').map(readTestCase),
    answer_keys: kind === 'short_answer' ? readAnswerKeys(root, extension) : [],
  };

  return {
    candidate: {
      ref,
      kind,
      status: extension === undefined ? 'draft' : attr(extension, 'status'),
      source_license: optionalText(extension, 'source-license'),
      external_ref: optionalText(extension, 'external-ref'),
      skills: children(extension, 'skill').map((s) => ({
        key: attr(s, 'key') ?? '',
        weight: numberAttr(s, 'weight') ?? Number.NaN,
      })),
      versions: [version],
    },
  };
}

/**
 * Reads a package's items. The manifest being unreadable refuses the package; anything wrong with
 * one item is reported against that item and the rest are read.
 */
export function readQtiPackage(
  files: ReadonlyMap<string, string>,
  options: ReadQtiOptions = {},
): QtiReadResult {
  const manifestText = files.get(MANIFEST_PATH);
  if (manifestText === undefined) {
    throw new UnreadablePackageError(`The package has no ${MANIFEST_PATH}.`);
  }
  let manifest: XmlElement;
  try {
    manifest = parseXml(manifestText, MANIFEST_REPEATED);
  } catch (error) {
    throw new UnreadablePackageError(
      `${MANIFEST_PATH} is not readable: ${error instanceof Error ? error.message : 'malformed'}`,
    );
  }

  const resources = children(child(child(manifest, 'manifest'), 'resources'), 'resource').filter(
    (r) => attr(r, 'type') === QTI_ITEM_TYPE,
  );

  const items: { index: number; item: BankItem }[] = [];
  const problems: ItemProblem[] = [];
  const seen = new Set<string>();

  resources.forEach((resource, index) => {
    const href = attr(resource, 'href') ?? '';
    const refGuess = (attr(resource, 'identifier') ?? '').replace(/^R-/u, '') || null;
    const fail = (message: string): void => {
      problems.push({ index, ref: refGuess, path: '', message });
    };

    // The href is only ever a key into the archive's own entries — never a filesystem path —
    // but a traversal-shaped one is still refused, so a package that tries is named as such.
    if (href === '' || href.startsWith('/') || href.split('/').includes('..')) {
      fail(`the resource points at an unacceptable path: ${JSON.stringify(href)}`);
      return;
    }
    const itemText = files.get(href);
    if (itemText === undefined) {
      fail(`the resource points at ${href}, which is not in the package`);
      return;
    }

    let itemXml: XmlElement;
    try {
      itemXml = parseXml(itemText, ITEM_REPEATED);
    } catch (error) {
      fail(error instanceof MalformedXmlError ? error.message : `${href} is not readable XML`);
      return;
    }

    const built = candidateItem(resource, itemXml, options);
    if ('problem' in built) {
      fail(built.problem);
      return;
    }
    const checked = checkBankItem(built.candidate, index);
    if ('problems' in checked) {
      problems.push(...checked.problems);
      return;
    }
    if (seen.has(checked.item.ref)) {
      problems.push({
        index,
        ref: checked.item.ref,
        path: 'ref',
        message: 'this ref is already used by an earlier item',
      });
      return;
    }
    seen.add(checked.item.ref);
    items.push({ index, item: checked.item });
  });

  return { items, problems };
}
