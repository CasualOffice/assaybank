/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Moving a bank out of one organisation and into another, through the database (M0 exit).
 *
 * The codecs in `../interchange/` prove a file round-trips. This proves the thing the exit
 * criterion actually asks: that a bank read out of Postgres and written back into an empty
 * organisation is the same bank. The file format is incidental to that; both are exercised.
 *
 * ## Import is per item, and goes through the API's own write path
 *
 * One transaction per question (code-graph `bank.jobs`: "an import is transactional per question;
 * a malformed row is skipped and reported, never partially written"). Each uses the repositories
 * `apps/api` uses — `createQuestion`, `createVersion`, `publishVersion`, `setQuestionSkills` —
 * and the item has already passed the kind rule at each version's stage, so an import cannot
 * create a question the API would have refused.
 *
 * The lifecycle is restored rather than replayed: a `published` item is written as published
 * without passing through `review`. That is safe only because `checkBankItem` has established the
 * status and the published flags agree; it is recorded in the audit row as an import, not as a
 * review somebody performed.
 *
 * ## Skills are resolved by key, never created
 *
 * A key the importing organisation cannot see — its own or a global skill — fails the item by name.
 * Creating it silently would be the taxonomy rot ADR-009 names: an import from a bank that spells
 * it `Python` would add a second Python. The person importing maps or creates it and re-runs.
 */

import {
  PaginationQuerySchema,
  QuestionIdSchema,
  type OrgId,
  type QuestionId,
  type SkillId,
  type UserId,
} from '@assaybank/contracts';
import {
  createQuestion,
  createVersion,
  getQuestionWithCurrentVersion,
  listQuestions,
  listSkills,
  listVersions,
  publishVersion,
  setQuestionSkills,
  setQuestionStatus,
  withOrg,
  writeAudit,
  type Database,
  type DbTransaction,
} from '@assaybank/db';

import type { BankItem, BankVersion, ItemProblem } from '../interchange/bank-item.js';
import { toBankVersion, toVersionContent } from '../interchange/records.js';

const PAGE = PaginationQuerySchema.parse({}).limit;

export interface ExportFilter {
  readonly skillId?: SkillId | undefined;
  readonly status?: BankItem['status'] | undefined;
}

/** Every version of a question, oldest first. `listVersions` pages newest first. */
async function allVersions(tx: DbTransaction, questionId: QuestionId): Promise<BankVersion[]> {
  const versions: BankVersion[] = [];
  let cursor: string | undefined;
  do {
    const page = await listVersions(tx, questionId, { limit: PAGE, cursor });
    versions.push(...page.rows.map(toBankVersion));
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  // By number, not by creation instant: two versions written in one transaction share an
  // instant, and the number is the order the history actually has.
  return versions.sort((a, b) => a.version_no - b.version_no);
}

/**
 * The organisation's bank, oldest question first, archived questions excluded.
 *
 * Refs are positional (`q-00001`), because a ref is a handle within one file and a question id
 * must not cross. Skills are sorted by key, so the same bank exports the same bytes whatever
 * order its tags were written in.
 */
export async function exportBank(
  db: Database,
  orgId: OrgId,
  filter: ExportFilter = {},
): Promise<BankItem[]> {
  return withOrg(db, orgId, async (tx) => {
    const keyById = new Map((await listSkills(tx, {})).map((s) => [s.id, s.key]));

    const summaries = [];
    let cursor: string | undefined;
    do {
      const page = await listQuestions(tx, {
        limit: PAGE,
        cursor,
        skill_id: filter.skillId,
        status: filter.status,
      });
      summaries.push(...page.rows);
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    summaries.reverse();

    const items: BankItem[] = [];
    for (const [index, summary] of summaries.entries()) {
      const question = await getQuestionWithCurrentVersion(tx, summary.id);
      if (question === undefined) continue; // archived between the page and this read
      const versions = await allVersions(tx, question.id);
      if (versions.length === 0) continue; // a question with no content yet has nothing to move

      items.push({
        ref: `q-${String(index + 1).padStart(5, '0')}`,
        kind: question.kind,
        status: question.status,
        source_license: question.source_license,
        external_ref: question.external_ref,
        skills: question.skills
          .flatMap((s) => {
            const key = keyById.get(s.skill_id);
            return key === undefined ? [] : [{ key, weight: s.weight }];
          })
          .sort((a, b) => a.key.localeCompare(b.key)),
        versions,
      });
    }
    return items;
  });
}

export interface ImportRequest {
  readonly orgId: OrgId;
  /** The member of staff who asked for the import. Every created question is audited to them. */
  readonly requestedBy: UserId;
  /**
   * Applied to items that carry no licence of their own. docs/05 §2: an import without one is
   * refused, so the request must name it; an item's own licence always wins.
   */
  readonly sourceLicense: string;
  /** Skills added to every imported question, in addition to its own. */
  readonly defaultSkillIds?: readonly SkillId[] | undefined;
}

export interface ImportOutcome {
  readonly created: readonly {
    readonly index: number;
    readonly ref: string;
    readonly questionId: QuestionId;
  }[];
  readonly problems: readonly ItemProblem[];
}

export const IMPORT_AUDIT_ACTION = 'question.import';

class ItemRefusal extends Error {
  constructor(readonly problem: ItemProblem) {
    super(problem.message);
  }
}

/** The skill id for each key this organisation can see, preferring its own over a global one. */
async function skillIdsByKey(tx: DbTransaction): Promise<Map<string, SkillId>> {
  const skills = await listSkills(tx, {});
  const byKey = new Map<string, SkillId>();
  // Globals first, so an organisation's own skill with the same key overwrites the global one.
  for (const skill of [...skills].sort(
    (a, b) => Number(a.orgId !== null) - Number(b.orgId !== null),
  )) {
    byKey.set(skill.key, skill.id as SkillId);
  }
  return byKey;
}

async function importOne(
  db: Database,
  request: ImportRequest,
  entry: { readonly index: number; readonly item: BankItem },
  at: Date,
): Promise<QuestionId> {
  const { index, item } = entry;
  return withOrg(db, request.orgId, async (tx) => {
    const byKey = await skillIdsByKey(tx);
    const unknown = item.skills.filter((s) => !byKey.has(s.key)).map((s) => s.key);
    if (unknown.length > 0) {
      throw new ItemRefusal({
        index,
        ref: item.ref,
        path: 'skills',
        message: `no skill with key ${unknown.map((k) => JSON.stringify(k)).join(', ')} in this organisation; create or merge it, then import again`,
      });
    }

    const question = await createQuestion(tx, {
      orgId: request.orgId,
      kind: item.kind,
      authorId: request.requestedBy,
      sourceLicense: item.source_license ?? request.sourceLicense,
      externalRef: item.external_ref ?? undefined,
    });

    for (const [i, version] of item.versions.entries()) {
      // A millisecond apart, so the history lists in the order it was written; one shared
      // instant would leave `GET /questions/{id}/versions` to order them by random id.
      const stamp = new Date(at.getTime() + i);
      const written = await createVersion(tx, question.id, toVersionContent(version), {
        createdBy: request.requestedBy,
        at: stamp,
      });
      if (version.published) {
        await publishVersion(tx, question.id, written.version_no, stamp);
      }
    }
    if (item.status !== 'draft') {
      await setQuestionStatus(tx, question.id, item.status);
    }

    const skills = new Map<SkillId, number>();
    for (const s of item.skills) {
      const id = byKey.get(s.key);
      if (id !== undefined) skills.set(id, s.weight);
    }
    for (const id of request.defaultSkillIds ?? []) {
      if (!skills.has(id)) skills.set(id, 1);
    }
    await setQuestionSkills(
      tx,
      question.id,
      [...skills].map(([skillId, weight]) => ({ skillId, weight })),
    );

    await writeAudit(tx, {
      orgId: request.orgId,
      actor: { kind: 'staff', userId: request.requestedBy },
      action: IMPORT_AUDIT_ACTION,
      entityType: 'question',
      entityId: question.id,
      after: {
        ref: item.ref,
        kind: item.kind,
        status: item.status,
        source_license: item.source_license ?? request.sourceLicense,
        external_ref: item.external_ref,
        versions: item.versions.length,
        published_versions: item.versions.filter((v) => v.published).length,
      },
      at,
    });

    return QuestionIdSchema.parse(question.id);
  });
}

/**
 * Imports items one transaction at a time. A refused item rolls back alone and is reported; an
 * unexpected error is reported against its item too, so one bad row never costs the file.
 */
export async function importBankItems(
  db: Database,
  request: ImportRequest,
  items: readonly { readonly index: number; readonly item: BankItem }[],
  now: () => Date,
): Promise<ImportOutcome> {
  const created: { index: number; ref: string; questionId: QuestionId }[] = [];
  const problems: ItemProblem[] = [];

  for (const entry of items) {
    try {
      const questionId = await importOne(db, request, entry, now());
      created.push({ index: entry.index, ref: entry.item.ref, questionId });
    } catch (error) {
      if (error instanceof ItemRefusal) {
        problems.push(error.problem);
      } else {
        problems.push({
          index: entry.index,
          ref: entry.item.ref,
          path: '',
          // The message only: a driver error can quote row data, and this lands in a job
          // record staff read, not in a log.
          message: 'the item could not be written; nothing from it was saved',
        });
      }
    }
  }
  return { created, problems };
}
