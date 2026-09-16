/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The audit log writer — P1 step 5.
 *
 * ## The one property this module exists to guarantee
 *
 * {@link writeAudit} takes a {@link DbTransaction}, never a {@link Database}. That is the
 * whole design, expressed as a signature: the only way to obtain a transaction in this
 * package is from inside `withOrg` or `withElevated`, so an audit row can only ever be
 * written **in the same transaction as the action it records**. If that transaction rolls
 * back the row rolls back with it; if it commits, the row committed.
 *
 * The alternative — a writer that takes the pool and opens its own transaction — records
 * what the application *believed* happened. Those two records differ exactly when it
 * matters: a void that raised a constraint violation after the audit row was written
 * leaves history claiming an attempt was voided that is still sitting there live. There
 * is deliberately no overload of {@link writeAudit} that accepts a `Database`, because a
 * convenience that writes out-of-band would be reached for under deadline pressure and
 * would silently degrade the record for everything written after it.
 *
 * ## A domain record, not telemetry
 *
 * docs/12 §9 and docs/17 §9: the audit log lives in Postgres, is queryable with SQL, and
 * is retained for seven years. It is never routed through the logger, never sampled,
 * never the source of an alert. The test docs/12 offers is *"would you be comfortable if
 * this record vanished in 30 days?"* — and if the answer is no, it is not a log line.
 *
 * ## Append-only, enforced by the database
 *
 * Two mechanisms, both outside this file, because a rule enforced only by the code that
 * happens to be calling is not enforced:
 *
 * - Migration 0002 revokes `UPDATE` and `DELETE` on `audit_log` from both application
 *   roles. Neither `apps/api` nor `apps/worker` can express a rewrite.
 * - Migration 0004 puts a statement-level trigger on the table that rejects `UPDATE`,
 *   `DELETE` and `TRUNCATE` from **every** role including the owner, and marks it
 *   `ENABLE ALWAYS` so it survives `session_replication_role = 'replica'`.
 *
 * ## Where the reason lives, and why it is not a column
 *
 * `audit_log` has no `reason` column — see `docs/hiring_platform_schema.sql` §10, which
 * this schema reproduces exactly. The reason therefore goes into the `after` payload
 * under the key `reason`, which is the shape `withElevated` has been writing since P1
 * step 1 and the shape the dispute runbook (docs/12 §"score dispute", step 4) reads back.
 * Migration 0004 turns that convention into a `CHECK` constraint, so an action that
 * requires a reason cannot be recorded without one even by a hand-written `INSERT` from
 * `psql`. {@link REASON_REQUIRED_ACTIONS} and that constraint are the same list, and
 * `tests/audit.test.ts` fails if they ever stop being.
 */

import { isIP } from 'node:net';

import { sql } from 'drizzle-orm';

import { UuidSchema, type AttemptId, type OrgId, type UserId } from '@assaybank/contracts';

import type { DbTransaction } from './client.js';

/**
 * The key in the `after` payload that carries the reason.
 *
 * Exported because three things have to agree on it — this writer, the `CHECK` in
 * migration 0004, and the runbook queries in docs/12 — and a string literal repeated in
 * three places is a string literal that will eventually be two.
 */
export const AUDIT_REASON_KEY = 'reason';

/**
 * The key in the `after` payload that carries the attempt a candidate acted under.
 *
 * `actor_user_id` is null for a candidate — candidates have no account (docs/03 §1) — so
 * without this the row would say only "not a member of staff". See {@link AuditActor}.
 */
export const AUDIT_ACTOR_ATTEMPT_KEY = 'actor_attempt_id';

/** Keys the writer owns. A caller payload using one of them is refused, not overwritten. */
const RESERVED_PAYLOAD_KEYS: readonly string[] = [AUDIT_REASON_KEY, AUDIT_ACTOR_ATTEMPT_KEY];

/**
 * The actions that may not be recorded without a reason.
 *
 * - `attempt.void` — FR-25, and docs/06 §"M4": a void without a reason is
 *   `validation_failed`, with one it is an audit row naming the actor.
 * - `score.override` — FR-21. The before and after scores both survive, and so does the
 *   sentence explaining why a human disagreed with the grader.
 * - `attempt.regrade` — docs/03 §8 takes `{reason}` on the endpoint; the re-grade creates
 *   a new grading run rather than mutating one, and the audit row is what ties the two
 *   scores to a decision.
 *
 * Every `job.` action is reason-required too, but by prefix rather than by enumeration —
 * see {@link requiresReason}. ADR-010 grants the background role `BYPASSRLS`, and the
 * reason is the entire counterweight: an elevation nobody can explain afterwards is the
 * thing that turns an incident into an unanswerable question.
 */
export const REASON_REQUIRED_ACTIONS = [
  'attempt.void',
  'attempt.regrade',
  'score.override',
] as const satisfies readonly string[];

/** One of the enumerated reason-requiring actions. */
export type ReasonRequiredAction = (typeof REASON_REQUIRED_ACTIONS)[number];

/** The prefix every background-job action carries (`withElevated`, ADR-010). */
export const JOB_ACTION_PREFIX = 'job.';

/** The prefix every candidate-performed action carries. See {@link AuditActor}. */
export const CANDIDATE_ACTION_PREFIX = 'candidate.';

/**
 * `entity.verb`, lowercase, at least one dot. The dot is what makes `GET /audit-log`'s
 * `?action=` filter and the `action LIKE 'job.%'` predicates in 0004 meaningful.
 */
const ACTION_PATTERN = /^[a-z][a-z0-9]*(?:[_-][a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:[_-][a-z0-9]+)*)+$/;

/** `attempt`, `question_version`, `system`. Lowercase snake case, matching table names. */
const ENTITY_TYPE_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

/**
 * Payload keys whose *name* says the value is a secret.
 *
 * An audit row is kept for seven years, so a token that lands in one is a token that
 * outlives every rotation policy the organisation has. The check is on the key rather
 * than the value because key names are chosen by the developer writing the call, which
 * makes this a static property of the code: it fails the first time the route is
 * exercised, in development, not at 03:00 eighteen months later.
 */
const SECRET_KEY_PATTERN = /password|passwd|secret|token|credential|api[_-]?key|private[_-]?key|authorization|cookie|pepper/i;

/** The longest `action` this writer will record. */
export const MAX_ACTION_LENGTH = 100;

/** The longest `entity_type` this writer will record. */
export const MAX_ENTITY_TYPE_LENGTH = 64;

/**
 * The longest reason. Long enough for a paragraph explaining a decision to a tribunal,
 * short enough that it cannot be used as a file upload.
 */
export const MAX_REASON_LENGTH = 2000;

/**
 * The combined `before` + `after` JSON budget, in bytes.
 *
 * docs/17 §10 wants a cost ceiling on everything. Without one, "record the before state"
 * on a table with a `text` column is an unbounded row in a table that is never pruned.
 */
export const MAX_PAYLOAD_BYTES = 65_536;

/** How deeply the writer will walk a payload looking for reserved and secret keys. */
const MAX_PAYLOAD_DEPTH = 12;

/**
 * Who performed the action.
 *
 * Three kinds, and the two without a user row are told apart by the action prefix rather
 * than by a column, because `audit_log` has no `actor_kind`:
 *
 * | kind | `actor_user_id` | action prefix |
 * |---|---|---|
 * | `staff` | the user's id | anything but `job.` or `candidate.` |
 * | `candidate` | `NULL` — candidates have no account (docs/03 §1) | `candidate.` |
 * | `job` | `NULL` — a machine did it (ADR-010) | `job.` |
 *
 * The prefix rules are enforced, not documented-and-hoped-for: a null `actor_user_id` on
 * a row whose action gives no hint is a row that says "nobody recorded who did this",
 * which is worse than no row at all because it looks like a record.
 */
export type AuditActor =
  | { readonly kind: 'staff'; readonly userId: UserId }
  | { readonly kind: 'candidate'; readonly attemptId: AttemptId }
  | { readonly kind: 'job' };

/** A structured payload written to `before` or `after`. */
export type AuditPayload = Record<string, unknown>;

/** One entry, as the caller describes it. */
export interface AuditEntry {
  /**
   * The tenant this row belongs to. `audit_log.org_id` is `NOT NULL` and carries an RLS
   * policy, so a row filed under the wrong organisation is a row the right one cannot
   * read. Use `PLATFORM_ORG_ID` only for work that genuinely acts for no single tenant.
   */
  readonly orgId: OrgId;
  /** Who did it. See {@link AuditActor}. */
  readonly actor: AuditActor;
  /** `attempt.void`, `question.publish`, `job.grade`. Lowercase, dotted. */
  readonly action: string;
  /** The kind of thing acted on: `attempt`, `question_version`, `system`. */
  readonly entityType: string;
  /** Which one, when the action is about a single row. A UUID. */
  readonly entityId?: string | null | undefined;
  /** State before the change. Omit where there was none (a creation). */
  readonly before?: AuditPayload | null | undefined;
  /**
   * State after the change. The writer adds {@link AUDIT_REASON_KEY} and, for a candidate
   * actor, {@link AUDIT_ACTOR_ATTEMPT_KEY}; supplying either yourself is an error rather
   * than an overwrite.
   */
  readonly after?: AuditPayload | null | undefined;
  /**
   * Why. Required for {@link REASON_REQUIRED_ACTIONS} and for every `job.` action;
   * permitted, and often worth recording, for anything else.
   */
  readonly reason?: string | null | undefined;
  /**
   * The client address, for the security-incident runbook (docs/12 §"scope").
   *
   * Parsed here with `net.isIP` before it is sent, for the same reason `entityId` is: it
   * lands in an `inet` column, so a value Postgres cannot parse aborts the transaction
   * the *action* is running in and the action is rolled back by a formatting mistake.
   * The caller supplies an address it has already established is one — `apps/api` does
   * that in `auditClientAddress`, because with `trustProxy` on `request.ip` is whatever
   * `X-Forwarded-For` said and is therefore client-controlled text, not an address.
   */
  readonly ip?: string | null | undefined;
  /**
   * When it happened, from the injected clock (ADR-006, docs/17 §8). Required rather
   * than defaulted to `now()`: a column that silently falls back to the wall clock is a
   * column no test can assert on, and this one is evidence.
   */
  readonly at: Date;
}

/**
 * The `audit_log` primary key, as text.
 *
 * `bigserial`, so the value does not fit a JavaScript number; it is returned as a string
 * rather than a `bigint` because the only things that do anything with it — a test, a
 * log line, a follow-up query — all want a string, and a `bigint` does not survive
 * `JSON.stringify`.
 */
export type AuditEntryId = string;

/**
 * An entry this writer refused to record.
 *
 * Refusing is deliberate. The alternative — writing the row with the bad part dropped —
 * produces a record that is present, looks complete, and is wrong, which is the one
 * outcome an audit log cannot afford. Because {@link writeAudit} runs inside the caller's
 * transaction, a throw here also rolls the action back: the action does not take effect
 * unless it can be recorded.
 */
export class AuditEntryError extends Error {
  override readonly name: string = 'AuditEntryError';

  /** The action the rejected entry named, for the log line. */
  readonly action: string;

  constructor(action: string, message: string) {
    super(message);
    this.action = action;
  }
}

/**
 * The specific refusal FR-21 and FR-25 are about: a voiding, an override or a re-grade
 * with no reason attached.
 *
 * Its own class because `apps/api` turns exactly this one into `validation_failed` with
 * the field named, per docs/06 §"M4" — every other {@link AuditEntryError} is a
 * programming mistake and becomes `internal`.
 */
export class AuditReasonRequiredError extends AuditEntryError {
  override readonly name: string = 'AuditReasonRequiredError';

  constructor(action: string) {
    super(
      action,
      `The action ${JSON.stringify(action)} may not be recorded without a reason. ` +
        'Voiding an attempt (FR-25), overriding a score (FR-21) and using the elevated ' +
        'background role (ADR-010) all affect a candidate or bypass a policy, and a ' +
        'record of one that does not say why cannot answer the question it exists for.',
    );
  }
}

/**
 * Is `value` an address PostgreSQL's `inet` will accept?
 *
 * `net.isIP` alone is not that question. It returns 6 for a zone-scoped link-local
 * address such as `fe80::1%lo0` — which `socket.remoteAddress` really does produce on a
 * host reached over IPv6 link-local — and `'fe80::1%lo0'::inet` is a syntax error, so
 * trusting `isIP` would leave exactly the failure this check exists to prevent: an
 * address that aborts the transaction the action is running in.
 *
 * Exported because `apps/api` has to ask the same question about `request.ip` one layer
 * earlier, and two spellings of "an address the column will take" is one spelling too
 * many.
 */
export function isAuditableAddress(value: string): boolean {
  return !value.includes('%') && isIP(value) !== 0;
}

/** Does this action require a reason? */
export function requiresReason(action: string): boolean {
  return (
    (REASON_REQUIRED_ACTIONS as readonly string[]).includes(action) ||
    action.startsWith(JOB_ACTION_PREFIX)
  );
}

/** The `actor_user_id` a given actor writes, and the prefix rule it must satisfy. */
function actorColumn(actor: AuditActor, action: string): UserId | null {
  switch (actor.kind) {
    case 'staff':
      if (action.startsWith(JOB_ACTION_PREFIX) || action.startsWith(CANDIDATE_ACTION_PREFIX)) {
        throw new AuditEntryError(
          action,
          `A staff actor may not record ${JSON.stringify(action)}: the ${JSON.stringify(
            JOB_ACTION_PREFIX,
          )} and ${JSON.stringify(CANDIDATE_ACTION_PREFIX)} prefixes are reserved for the ` +
            'rows whose actor_user_id is null, and are the only thing that tells those apart.',
        );
      }
      return actor.userId;

    case 'candidate':
      if (!action.startsWith(CANDIDATE_ACTION_PREFIX)) {
        throw new AuditEntryError(
          action,
          `A candidate actor must record a ${JSON.stringify(CANDIDATE_ACTION_PREFIX)} action. ` +
            'A candidate has no user row (docs/03 §1), so actor_user_id is null and the ' +
            'prefix is what distinguishes "a candidate did this" from "nobody recorded who did".',
        );
      }
      return null;

    case 'job':
      if (!action.startsWith(JOB_ACTION_PREFIX)) {
        throw new AuditEntryError(
          action,
          `A background job must record a ${JSON.stringify(JOB_ACTION_PREFIX)} action. ` +
            'ADR-010: actor_user_id is null for a job, so the prefix is the only thing ' +
            'separating "a machine did this" from "nobody recorded who did this".',
        );
      }
      return null;
  }
}

/** Walks a payload rejecting reserved keys, secret-shaped keys and runaway nesting. */
function inspectPayload(action: string, column: 'before' | 'after', value: unknown, depth = 0): void {
  if (depth > MAX_PAYLOAD_DEPTH) {
    throw new AuditEntryError(
      action,
      `The ${column} payload nests deeper than ${String(MAX_PAYLOAD_DEPTH)} levels. An audit ` +
        'payload is a description of a change, not a serialised object graph.',
    );
  }

  if (Array.isArray(value)) {
    for (const item of value) inspectPayload(action, column, item, depth + 1);
    return;
  }

  if (typeof value !== 'object' || value === null) return;

  for (const [key, nested] of Object.entries(value)) {
    if (depth === 0 && column === 'after' && RESERVED_PAYLOAD_KEYS.includes(key)) {
      throw new AuditEntryError(
        action,
        `The after payload may not set ${JSON.stringify(key)}: this writer owns it. ` +
          'Two values arriving for one key means one of them is silently discarded, and ' +
          'an audit record is the last place to guess which.',
      );
    }
    if (SECRET_KEY_PATTERN.test(key)) {
      throw new AuditEntryError(
        action,
        `The ${column} payload carries ${JSON.stringify(key)}, whose name says it is a ` +
          'secret. The audit log is retained for seven years (docs/12 §9), which is longer ' +
          'than any credential should live. Record an identifier, never the credential.',
      );
    }
    inspectPayload(action, column, nested, depth + 1);
  }
}

/**
 * Serialises a payload column, or `null` when there is nothing to write.
 *
 * Deliberately does **not** inspect: {@link prepareAuditEntry} inspects the caller's
 * payload *before* merging the writer's own keys into it, because inspecting afterwards
 * would find `reason` present and reject the writer's own work.
 */
function serialise(action: string, column: 'before' | 'after', payload: AuditPayload | null): string | null {
  if (payload === null || Object.keys(payload).length === 0) return null;

  let json: string;
  try {
    json = JSON.stringify(payload);
  } catch (_cause: unknown) {
    throw new AuditEntryError(
      action,
      `The ${column} payload could not be serialised to JSON. Audit payloads are plain ` +
        'data: no cycles, no class instances, no bigints.',
    );
  }

  // `undefined` values are dropped by JSON.stringify, and an object of nothing but
  // undefined serialises to "{}" — a payload that says nothing, filed as though it said
  // something. null is the honest column value for that.
  if (json === '{}') return null;
  return json;
}

/** Every column of the row about to be inserted, validated. Pure: no I/O, no clock. */
export interface PreparedAuditEntry {
  readonly orgId: OrgId;
  readonly actorUserId: UserId | null;
  readonly action: string;
  readonly entityType: string;
  readonly entityId: string | null;
  /** Already-serialised JSON, or `null`. */
  readonly before: string | null;
  /** Already-serialised JSON including the reason, or `null`. */
  readonly after: string | null;
  readonly ip: string | null;
  /** RFC 3339, UTC — what goes into the `timestamptz` parameter. */
  readonly at: string;
}

/**
 * Validates an entry and resolves it to columns, without touching the database.
 *
 * Separated from {@link writeAudit} so that every rule above is covered by a unit test
 * that needs no container, and so the one statement in `writeAudit` is nothing but the
 * `INSERT`. Exported for that reason and for `apps/api`, which validates a request's
 * reason before it starts doing work it would only roll back.
 *
 * @throws {AuditReasonRequiredError} for a reason-requiring action with no reason.
 * @throws {AuditEntryError} for anything else malformed.
 */
export function prepareAuditEntry(entry: AuditEntry): PreparedAuditEntry {
  const action = entry.action.trim();

  if (action.length === 0 || action.length > MAX_ACTION_LENGTH) {
    throw new AuditEntryError(
      entry.action,
      `An audit action must be between 1 and ${String(MAX_ACTION_LENGTH)} characters.`,
    );
  }
  if (!ACTION_PATTERN.test(action)) {
    throw new AuditEntryError(
      entry.action,
      `${JSON.stringify(action)} is not an audit action. Actions are lowercase, dotted ` +
        '`entity.verb` — `attempt.void`, `question.publish`, `job.deadline_sweep` — because ' +
        'GET /audit-log filters on them and 0004 constrains them by prefix.',
    );
  }

  const entityType = entry.entityType.trim();
  if (
    entityType.length === 0 ||
    entityType.length > MAX_ENTITY_TYPE_LENGTH ||
    !ENTITY_TYPE_PATTERN.test(entityType)
  ) {
    throw new AuditEntryError(
      action,
      `${JSON.stringify(entry.entityType)} is not an entity type. Use lowercase snake case ` +
        'naming the kind of thing acted on — `attempt`, `question_version`, `system`.',
    );
  }

  let entityId: string | null = null;
  if (entry.entityId !== undefined && entry.entityId !== null) {
    const parsed = UuidSchema.safeParse(entry.entityId);
    if (!parsed.success) {
      throw new AuditEntryError(
        action,
        'entityId must be a UUID. It is written to a uuid column, so a malformed one ' +
          'would fail mid-transaction and roll the action back for a formatting mistake.',
      );
    }
    entityId = parsed.data;
  }

  const rawReason = entry.reason ?? null;
  const reason = rawReason === null ? null : rawReason.trim();

  if (reason !== null && reason.length > MAX_REASON_LENGTH) {
    throw new AuditEntryError(
      action,
      `A reason may not exceed ${String(MAX_REASON_LENGTH)} characters.`,
    );
  }
  if ((reason === null || reason.length === 0) && requiresReason(action)) {
    throw new AuditReasonRequiredError(action);
  }

  const actorUserId = actorColumn(entry.actor, action);

  // Inspected first, merged second. The writer's own keys go on only after the caller's
  // payload has been found not to contain them, so "the writer owns these keys" is a
  // fact rather than a hope — and the inspection cannot trip over the writer's own work.
  const callerBefore = entry.before ?? null;
  const callerAfter = entry.after ?? null;
  if (callerBefore !== null) inspectPayload(action, 'before', callerBefore);
  if (callerAfter !== null) inspectPayload(action, 'after', callerAfter);

  const after: AuditPayload = { ...(callerAfter ?? {}) };
  if (reason !== null && reason.length > 0) {
    after[AUDIT_REASON_KEY] = reason;
  }
  if (entry.actor.kind === 'candidate') {
    after[AUDIT_ACTOR_ATTEMPT_KEY] = entry.actor.attemptId;
  }

  const beforeJson = serialise(action, 'before', callerBefore);
  const afterJson = serialise(action, 'after', after);

  const payloadBytes =
    Buffer.byteLength(beforeJson ?? '', 'utf8') + Buffer.byteLength(afterJson ?? '', 'utf8');
  if (payloadBytes > MAX_PAYLOAD_BYTES) {
    throw new AuditEntryError(
      action,
      `The before and after payloads total ${String(payloadBytes)} bytes, over the ` +
        `${String(MAX_PAYLOAD_BYTES)}-byte budget. Record the fields that changed, not the row.`,
    );
  }

  const at = entry.at;
  if (Number.isNaN(at.getTime())) {
    throw new AuditEntryError(action, 'at is not a valid instant.');
  }

  let ip: string | null = null;
  if (entry.ip !== undefined && entry.ip !== null && entry.ip !== '') {
    if (!isAuditableAddress(entry.ip)) {
      throw new AuditEntryError(
        action,
        'ip is not an IPv4 or IPv6 address. It is written to an inet column, so an ' +
          'unparseable one would abort the transaction the action is running in — which ' +
          'turns a mangled X-Forwarded-For header into a rolled-back action. Parse the ' +
          'client address before handing it over, and pass null when there is not one.',
      );
    }
    ip = entry.ip;
  }

  return {
    orgId: entry.orgId,
    actorUserId,
    action,
    entityType,
    entityId,
    before: beforeJson,
    after: afterJson,
    ip,
    at: at.toISOString(),
  };
}

/**
 * Appends one row to `audit_log`, **in the transaction it is given**.
 *
 * ```ts
 * await withOrg(db, principal.orgId, async (tx) => {
 *   const before = await loadAttempt(tx, attemptId);
 *   await voidAttempt(tx, attemptId);
 *   await writeAudit(tx, {
 *     orgId: principal.orgId,
 *     actor: { kind: 'staff', userId: principal.userId },
 *     action: 'attempt.void',
 *     entityType: 'attempt',
 *     entityId: attemptId,
 *     before,
 *     reason: body.reason,
 *     at: clock.now(),
 *   });
 * });
 * ```
 *
 * Either both statements commit or neither does. Nothing about that is enforced by
 * convention: it falls out of `tx` being the only thing this function accepts.
 *
 * The insert is parameterised in every position, including the ones that are already
 * known to be UUIDs (docs/17 §7 — no string interpolation into SQL, ever).
 *
 * @returns the new row's id, as text.
 * @throws {AuditReasonRequiredError} for a reason-requiring action with no reason.
 * @throws {AuditEntryError} for anything else malformed. Both roll the caller back.
 */
export async function writeAudit(tx: DbTransaction, entry: AuditEntry): Promise<AuditEntryId> {
  const row = prepareAuditEntry(entry);

  const inserted = await tx.execute<{ id: string }>(sql`
    INSERT INTO audit_log (
      org_id, actor_user_id, action, entity_type, entity_id, before, after, ip, at
    )
    VALUES (
      ${row.orgId}::uuid,
      ${row.actorUserId}::uuid,
      ${row.action},
      ${row.entityType},
      ${row.entityId}::uuid,
      ${row.before}::jsonb,
      ${row.after}::jsonb,
      ${row.ip}::inet,
      ${row.at}::timestamptz
    )
    RETURNING id::text AS id
  `);

  const first = inserted[0];
  if (first === undefined) {
    // Unreachable: a single-row INSERT ... RETURNING returns a row or throws. Spelled out
    // rather than swallowed with `?? ''` because "the audit row may or may not exist" is
    // not a state this system is allowed to continue from.
    throw new AuditEntryError(
      row.action,
      'The audit INSERT returned no row, so it cannot be assumed to have been written. ' +
        'Refusing to let the action it records commit.',
    );
  }
  return first.id;
}
