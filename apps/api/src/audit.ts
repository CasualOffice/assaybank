/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The audit log, wired to a request — P1 step 5.
 *
 * `@assaybank/db` owns the writer and guarantees the hard part: `writeAudit` accepts a
 * transaction and never a pool, so an audit row can only be written in the same
 * transaction as the action it records. This module supplies the four things a request
 * knows that the database layer does not — which organisation, which actor, from which
 * address, at which instant — and puts the whole thing in one call:
 *
 * ```ts
 * app.post('/attempts/:id/void', { config: requirePermission('attempt.void') },
 *   async (request) =>
 *     request.audited(
 *       { action: 'attempt.void', entityType: 'attempt', entityId: id, reason: body.reason },
 *       async (tx, entry) => {
 *         const before = await loadAttempt(tx, id);
 *         const after = await voidAttempt(tx, id);
 *         entry.amend({ before, after });
 *         return after;
 *       },
 *     ),
 * );
 * ```
 *
 * One transaction opens, `app.current_org` is set inside it from the principal (ADR-010),
 * the handler's work runs against it, the audit row is appended, and the transaction
 * commits. If anything in the middle throws, the work and the record roll back together
 * and history does not claim an action that never happened.
 *
 * **Why the record is written after the work rather than before.** `withElevated` writes
 * its row first, because what it is recording is the moment the elevation was taken.
 * Here the thing being recorded is a change, and the change's `after` state — the new
 * score, the id of the row just created — does not exist until the work has run. Both
 * are inside the same transaction, so the ordering makes no difference to atomicity;
 * {@link AuditEntry.amend} is how the handler contributes what it learned.
 *
 * **Not the logger.** docs/12 §9 and docs/17 §9: the audit log is a domain record kept
 * for seven years in Postgres, not telemetry. The one log line emitted here carries the
 * audit row's id and nothing from its payload — it is a pointer from a trace to the
 * record, so support can get from a quoted `request_id` to the row, and it is explicitly
 * not a second copy of it.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';

import type { Principal } from '@assaybank/auth';
import { ApiError } from '@assaybank/contracts';
import {
  AuditReasonRequiredError,
  isAuditableAddress,
  prepareAuditEntry,
  withOrg,
  writeAudit,
  type AuditActor,
  type AuditPayload,
  type Database,
  type DbTransaction,
} from '@assaybank/db';

import { currentPrincipal } from './principal.js';

/** What the route knows before the work runs. */
export interface AuditSpec {
  /** `attempt.void`, `question.publish`. Lowercase and dotted; the writer enforces it. */
  readonly action: string;
  /** The kind of thing being acted on: `attempt`, `question_version`. */
  readonly entityType: string;
  /** Which one, when it is known up front. A creation supplies it through `amend`. */
  readonly entityId?: string | null | undefined;
  /**
   * Why, for the actions that require it (FR-21, FR-25). Pass the request body's
   * `reason` straight through: a missing or blank one becomes `validation_failed` before
   * any work is done, which is what docs/06 §"M4" asks for.
   */
  readonly reason?: string | null | undefined;
  /** State before the change, when the route already has it. */
  readonly before?: AuditPayload | null | undefined;
  /** State after the change, when the route already knows it. */
  readonly after?: AuditPayload | null | undefined;
}

/** The parts of a spec the work is allowed to fill in once it knows them. */
export type AuditAmendment = Pick<AuditSpec, 'entityId' | 'reason' | 'before' | 'after'>;

/** The handle the work uses to contribute what it learned. */
export interface AuditEntry {
  /**
   * Merges `patch` into the entry that will be written when the work returns.
   *
   * Last call wins per field, and a field left out is left alone. Call it as many times
   * as is convenient; nothing is written until the work has returned, so an amendment
   * made halfway through a handler that then throws is discarded with everything else.
   */
  amend(patch: AuditAmendment): void;
}

/** The work an audited action performs, inside the transaction the record shares. */
export type AuditedWork<T> = (tx: DbTransaction, entry: AuditEntry) => Promise<T>;

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * Runs `work` in an organisation-scoped transaction and appends one `audit_log` row
     * to the same transaction. See the module comment.
     *
     * @throws `ApiError.unauthenticated` when the request has no principal, and
     * `ApiError.validationFailed` when the action requires a reason and none was given.
     */
    audited<T>(spec: AuditSpec, work: AuditedWork<T>): Promise<T>;
  }
}

/** Options for {@link registerAudit}. */
export interface AuditOptions {
  /** The connection handle. Boot's, or a test's pointed at a container. */
  readonly db: Database;
  /**
   * The clock (ADR-006, docs/17 §8). `audit_log.at` comes from here rather than from
   * `now()` in SQL, so a test can assert on the recorded instant.
   */
  readonly now?: (() => Date) | undefined;
}

/**
 * The actor an `audit_log` row records for this principal.
 *
 * The mapping lives in this workspace rather than in `@assaybank/db` because a
 * `Principal` is an authentication concept and the database package has no business
 * knowing about sessions. It is total over both kinds on purpose: adding a third kind of
 * principal would be a compile error here, which is the right place to be told that a new
 * sort of caller has no defined representation in the audit trail.
 */
export function auditActorFor(principal: Principal): AuditActor {
  return principal.kind === 'staff'
    ? { kind: 'staff', userId: principal.userId }
    : { kind: 'candidate', attemptId: principal.attemptId };
}

/**
 * Turns the writer's refusals into the responses docs/03 §2 defines.
 *
 * Exactly one of them crosses to the client: a reason-requiring action with no reason is
 * `validation_failed`, naming the field, because that is a caller mistake the caller can
 * fix (docs/06 §"M4"). Every other `AuditEntryError` is a programming mistake — a
 * malformed action, a payload carrying something that looks like a credential — and is
 * rethrown untouched so the global handler serves it as `internal` with no detail.
 */
function asApiError(error: unknown): unknown {
  if (error instanceof AuditReasonRequiredError) {
    return ApiError.validationFailed(
      'This action requires a reason.',
      {
        details: {
          fields: [{ field: 'body/reason', rule: 'required' }],
          action: error.action,
        },
        cause: error,
      },
    );
  }
  return error;
}

/**
 * The client address to record, or `null` when there is not one worth believing.
 *
 * `server.ts` sets `trustProxy` on every deployed tier, which makes `request.ip` the
 * left-most `X-Forwarded-For` entry — **text a client chose**, not an address Fastify
 * validated (`proxy-addr` splits the header and returns the token unparsed). It goes into
 * an `inet` column, so without this a request carrying `X-Forwarded-For: nonsense` would
 * abort the transaction its own action is running in: the void would roll back and the
 * caller would get a 500, on demand, for any audited route.
 *
 * So the header value is used only when it parses as an address. Otherwise the socket's
 * own address is tried, and failing that the column is left null. The address is
 * evidence for the security-incident runbook (docs/12 §"scope"), and evidence that is
 * merely absent is recoverable from the access log — an action that refused to happen is
 * not, and the record of who did what matters more than the address they did it from.
 */
export function auditClientAddress(request: FastifyRequest): string | null {
  const forwarded = request.ip;
  if (isAuditableAddress(forwarded)) return forwarded;

  const socket = request.socket.remoteAddress;
  if (socket !== undefined && isAuditableAddress(socket)) return socket;

  return null;
}

/** Merges an amendment over a spec, leaving untouched anything the patch omits. */
function merge(spec: AuditSpec, patch: AuditAmendment): AuditSpec {
  return {
    ...spec,
    ...(patch.entityId === undefined ? {} : { entityId: patch.entityId }),
    ...(patch.reason === undefined ? {} : { reason: patch.reason }),
    ...(patch.before === undefined ? {} : { before: patch.before }),
    ...(patch.after === undefined ? {} : { after: patch.after }),
  };
}

/**
 * Installs {@link FastifyRequest.audited} on `app`.
 *
 * A plain function on the instance rather than an `app.register` plugin, for the reason
 * given in server.ts: a plugin is an encapsulation context, and a decorator declared
 * inside one is invisible to routes outside it.
 */
export function registerAudit(app: FastifyInstance, options: AuditOptions): void {
  const { db } = options;
  const now = options.now ?? ((): Date => new Date());

  if (app.hasRequestDecorator('audited')) return;

  app.decorateRequest(
    'audited',
    async function audited<T>(
      this: FastifyRequest,
      spec: AuditSpec,
      work: AuditedWork<T>,
    ): Promise<T> {
      const principal: Principal = currentPrincipal(this);
      const actor = auditActorFor(principal);
      const at = now();
      // Parsed, not passed through: on a deployed tier `request.ip` is the X-Forwarded-For
      // value, which is client-controlled text. See auditClientAddress.
      const ip = auditClientAddress(this);

      let entry: AuditSpec = spec;

      // Validated before the transaction opens, so a void with no reason costs nothing
      // and answers 422 rather than doing the work and rolling it back. The same
      // validation runs again inside writeAudit against the amended entry — this pass is
      // an early exit, not the guarantee.
      try {
        prepareAuditEntry({ ...entry, orgId: principal.orgId, actor, ip, at });
      } catch (error: unknown) {
        throw asApiError(error);
      }

      const handle: AuditEntry = {
        amend(patch: AuditAmendment): void {
          entry = merge(entry, patch);
        },
      };

      const { result, auditId } = await withOrg(db, principal.orgId, async (tx) => {
        const value = await work(tx, handle);
        try {
          const id = await writeAudit(tx, { ...entry, orgId: principal.orgId, actor, ip, at });
          return { result: value, auditId: id };
        } catch (error: unknown) {
          // Thrown inside the transaction, so the work rolls back with it: an action
          // that cannot be recorded does not take effect.
          throw asApiError(error);
        }
      });

      // A pointer from the trace to the record, not a copy of it. No reason, no payload:
      // a reason is written by a human about a candidate, and docs/12 §7.2 keeps that out
      // of a log that is shipped, sampled and kept for thirty days.
      this.log.info(
        { event: 'audit.recorded', audit_id: auditId, action: entry.action, entity_type: entry.entityType },
        'audit entry committed',
      );

      return result;
    },
  );
}
