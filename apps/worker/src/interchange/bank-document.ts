/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The JSON bank document — Assaybank's own export format, and the lossless one (FR-29, G6).
 *
 * Open and documented (docs/03 §4 "Bulk"): a header naming the format and its version, an
 * attribution block, and the items. It carries a question's **whole version history**, which QTI
 * cannot, so it is the format for moving a bank between installations. QTI is the format for
 * moving items into someone else's tool.
 *
 * ## Attribution travels with the content
 *
 * CC-BY-4.0 requires credit "in any reasonable manner", and docs/05 §2 reads that as: preserved in
 * any export. Each item keeps its own `source_license` and `external_ref`, and the header adds an
 * `attributions` summary so a person opening the file sees the obligation without reading every
 * item. The summary is derived, so it cannot disagree with the items; on import it is ignored for
 * the same reason.
 *
 * ## Reading is per item
 *
 * A malformed document — not JSON, wrong format, a version this build does not know — is refused
 * whole, because nothing in it can be trusted to mean what it says. A malformed *item* is reported
 * with its position and skipped, and the rest import (docs/03 §4: per-row errors, never a failed
 * file).
 */

import { checkBankItem, type BankItem, type ItemProblem } from './bank-item.js';

export const BANK_FORMAT = 'assaybank.bank';
export const BANK_FORMAT_VERSION = 1;

export interface Attribution {
  readonly source_license: string;
  /** The dataset: the part of `external_ref` before the first `/`, or null when there is none. */
  readonly dataset: string | null;
  readonly items: number;
}

export interface BankDocument {
  readonly format: typeof BANK_FORMAT;
  readonly format_version: typeof BANK_FORMAT_VERSION;
  readonly exported_at: string;
  readonly attributions: readonly Attribution[];
  readonly items: readonly BankItem[];
}

/**
 * The licences an export must credit: every non-proprietary `source_license`, per dataset.
 *
 * Sorted by licence then dataset, so two exports of the same bank produce the same bytes.
 */
export function attributionsOf(items: readonly BankItem[]): Attribution[] {
  const counts = new Map<string, Attribution>();
  for (const item of items) {
    if (item.source_license === null || item.source_license === 'proprietary') continue;
    const dataset = item.external_ref?.split('/')[0] ?? null;
    const key = JSON.stringify([item.source_license, dataset]);
    const prior = counts.get(key);
    counts.set(key, {
      source_license: item.source_license,
      dataset,
      items: (prior?.items ?? 0) + 1,
    });
  }
  return [...counts.values()].sort(
    (a, b) =>
      a.source_license.localeCompare(b.source_license) ||
      (a.dataset ?? '').localeCompare(b.dataset ?? ''),
  );
}

export function buildBankDocument(items: readonly BankItem[], exportedAt: Date): BankDocument {
  return {
    format: BANK_FORMAT,
    format_version: BANK_FORMAT_VERSION,
    exported_at: exportedAt.toISOString(),
    attributions: attributionsOf(items),
    items,
  };
}

/** Two-space indented with a trailing newline: diffable, and stable for the same input. */
export function serialiseBankDocument(document: BankDocument): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

export interface ReadResult {
  /** Items that passed, with their position in the file. */
  readonly items: readonly { readonly index: number; readonly item: BankItem }[];
  readonly problems: readonly ItemProblem[];
}

/** Thrown for a document that cannot be read at all. Item problems are never thrown. */
export class UnreadableDocumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnreadableDocumentError';
  }
}

export function readBankDocument(text: string): ReadResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new UnreadableDocumentError('The file is not JSON.');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new UnreadableDocumentError('A bank document is a JSON object.');
  }
  const header = parsed as Record<string, unknown>;
  if (header['format'] !== BANK_FORMAT) {
    throw new UnreadableDocumentError(`The file does not declare "format": "${BANK_FORMAT}".`);
  }
  if (header['format_version'] !== BANK_FORMAT_VERSION) {
    // Refused rather than attempted: a later version may mean something different by a field
    // this reader recognises, and a silently wrong import is worse than a refusal.
    throw new UnreadableDocumentError(
      `This build reads format_version ${String(BANK_FORMAT_VERSION)}; the file declares ${JSON.stringify(header['format_version'])}.`,
    );
  }
  const rawItems = header['items'];
  if (!Array.isArray(rawItems)) {
    throw new UnreadableDocumentError('A bank document has an "items" array.');
  }

  return checkItems(rawItems);
}

/** Validates each item independently, and refuses a `ref` already used earlier in the file. */
export function checkItems(rawItems: readonly unknown[]): ReadResult {
  const items: { index: number; item: BankItem }[] = [];
  const problems: ItemProblem[] = [];
  const seen = new Set<string>();

  rawItems.forEach((raw, index) => {
    const checked = checkBankItem(raw, index);
    if ('problems' in checked) {
      problems.push(...checked.problems);
      return;
    }
    if (seen.has(checked.item.ref)) {
      problems.push({
        index,
        ref: checked.item.ref,
        path: 'ref',
        message: 'this ref is already used by an earlier item in the file',
      });
      return;
    }
    seen.add(checked.item.ref);
    items.push({ index, item: checked.item });
  });

  return { items, problems };
}
