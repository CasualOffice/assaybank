/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The words the console uses for the bank's enumerations.
 *
 * One place, because the list and the editor must agree: a question that reads "Coding" in the
 * table and `coding` in its editor is two products. The `Record<Enum, string>` types are the
 * enforcement — a kind added to the contract without a word here is a compile error, not a
 * recruiter looking at a database label.
 */

import type { BadgeTone } from '@assaybank/ui';
import type { QuestionKind, QuestionStatus } from '@assaybank/contracts';

/** Human wording for a kind. The enum value is a database label, not a word for a screen. */
export const KIND_LABELS: Readonly<Record<QuestionKind, string>> = {
  mcq_single: 'Multiple choice',
  mcq_multi: 'Multiple answer',
  true_false: 'True / false',
  short_answer: 'Short answer',
  coding: 'Coding',
  sql: 'SQL',
  subjective: 'Written',
  system_design: 'System design',
};

export const STATUS_LABELS: Readonly<Record<QuestionStatus, string>> = {
  draft: 'Draft',
  review: 'In review',
  published: 'Published',
  retired: 'Retired',
};

/**
 * Colour repeats the word; it never replaces it (SC 1.4.1).
 *
 * `published` is the only success: a published question is the only one a candidate can be
 * served. `retired` is a warning rather than a danger — withdrawing a question is a normal
 * act of bank maintenance (FR-4), not a failure.
 */
export const STATUS_TONES: Readonly<Record<QuestionStatus, BadgeTone>> = {
  draft: 'neutral',
  review: 'info',
  published: 'success',
  retired: 'warning',
};

/** The difficulty band, as a word. A bare "4" means nothing without the scale beside it. */
export const DIFFICULTY_LABELS: Readonly<Record<number, string>> = {
  1: 'Introductory',
  2: 'Easy',
  3: 'Moderate',
  4: 'Hard',
  5: 'Expert',
};
