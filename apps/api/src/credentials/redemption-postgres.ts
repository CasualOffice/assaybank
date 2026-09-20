/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The redemption gateway, against PostgreSQL. The transaction boundary, and nothing else.
 *
 * ## Two transactions, and why it cannot be one
 *
 * A redemption arrives with no organisation. ADR-010 makes every tenant read depend on
 * `app.current_org`, and `app_current_org()` is `NULL` until something sets it — which
 * denies rather than admits, correctly, and which is exactly why the first lookup cannot
 * be an ordinary query. So:
 *
 * 1. **Route.** `invitation_org_for_token(hash)` — a `SECURITY DEFINER` function added by
 *    migration `0005_invitation_lookup`, granted to `hiring_app` alone, returning one
 *    column. It is called inside `withOrg(PLATFORM_ORG_ID, …)`: the nil organisation owns
 *    no rows by construction (migration `0003`), so this transaction runs the ordinary
 *    request path — real pool checkout, real `set_config`, real policies — while being
 *    structurally incapable of reading a tenant row through any of them.
 * 2. **Redeem.** Everything else, inside `withOrg(org, …)` with the policies in force. If
 *    step 1 were wrong, or raced with a revocation, step 2 reads nothing and the
 *    redemption is refused in the ordinary way. The routing lookup is a hint; the
 *    authorisation is the policy.
 *
 * ## The lock is the single-use mechanism
 *
 * `SELECT … FOR UPDATE OF i` on the invitation serialises every redemption of that one
 * invitation. The sittings are counted *after* the lock is held and the attempt is
 * inserted *before* it is released, so two concurrent redemptions cannot both see
 * `sittings_taken = 0` (docs/14 `H-165`). The alternative — a unique constraint on
 * `(invitation_id)` in `attempts` — would forbid the multi-sitting invitations
 * `max_attempts` exists to express.
 *
 * ## The audit row is written by the same transaction
 *
 * Through `writeAudit`, which takes a transaction and nothing else. An attempt that
 * commits has an audit row; a redemption that rolls back has neither. That is the P1
 * property, and it is obtained by construction rather than by remembering to call
 * something afterwards.
 */

import { type Clock } from '@assaybank/auth';
import {
  AssessmentIdSchema,
  AttemptIdSchema,
  CandidateIdSchema,
  InvitationIdSchema,
  OrgIdSchema,
  type AttemptId,
  type OrgId,
} from '@assaybank/contracts';
import {
  PLATFORM_ORG_ID,
  withOrg,
  writeAudit,
  type Database,
  type DbTransaction,
} from '@assaybank/db';
import { sql } from 'drizzle-orm';

import { optionalDate, requireCount, requireDate } from './driver-values.js';
import type {
  CreateAttemptInput,
  LockedInvitation,
  RedemptionAuditInput,
  RedemptionGateway,
  RedemptionTransaction,
} from './redemption.js';

/**
 * The audit action a redemption records.
 *
 * `candidate.` prefixed because the actor has no user row — a candidate has no account
 * (docs/03 §1) — and `packages/db`'s audit writer uses the prefix to tell "a candidate
 * did this" from "nobody recorded who did this". The attempt id lands in the payload
 * under the writer's own key, which is what identifies the actor.
 */
export const REDEMPTION_AUDIT_ACTION = 'candidate.invitation_redeem';

/** The entity a redemption is about: the attempt it created. */
export const REDEMPTION_AUDIT_ENTITY = 'attempt';

/**
 * One row of the locked-invitation query, exactly as the driver returns it.
 *
 * A type alias rather than an interface: the driver's row type is constrained to
 * `Record<string, unknown>`, and only an alias gets the implicit index signature that
 * satisfies it.
 */
type InvitationRow = {
  readonly invitation_id: string;
  readonly org_id: string;
  readonly token_hash: string;
  readonly opens_at: Date | null;
  readonly expires_at: Date;
  readonly max_attempts: number;
  readonly sent_at: Date | null;
  readonly candidate_id: string | null;
  readonly assessment_id: string;
  readonly assessment_name: string;
  readonly duration_seconds: number;
  readonly status: string;
  readonly version_no: number;
  readonly allow_back_nav: boolean;
  readonly sittings_taken: number;
  readonly section_count: number;
};

/** Turns a row into the policy's input, branding every identifier on the way through. */
function toLockedInvitation(row: InvitationRow): LockedInvitation {
  return {
    invitationId: InvitationIdSchema.parse(row.invitation_id),
    orgId: OrgIdSchema.parse(row.org_id),
    tokenHash: row.token_hash,
    candidateId: row.candidate_id === null ? undefined : CandidateIdSchema.parse(row.candidate_id),
    opensAt: optionalDate(row.opens_at, 'opens_at'),
    expiresAt: requireDate(row.expires_at, 'expires_at'),
    maxAttempts: requireCount(row.max_attempts, 'max_attempts'),
    sittingsTaken: requireCount(row.sittings_taken, 'sittings_taken'),
    sentAt: optionalDate(row.sent_at, 'sent_at'),
    assessment: {
      id: AssessmentIdSchema.parse(row.assessment_id),
      name: row.assessment_name,
      durationSeconds: requireCount(row.duration_seconds, 'duration_seconds'),
      status: row.status,
      versionNo: requireCount(row.version_no, 'version_no'),
      allowBackNav: row.allow_back_nav,
      sectionCount: requireCount(row.section_count, 'section_count'),
    },
  };
}

/**
 * The write side, bound to one open transaction.
 *
 * Created inside `withLockedInvitation` and discarded when it returns, so there is no
 * object a caller could hold onto and use after the lock was released.
 */
function transactionFor(tx: DbTransaction, orgId: OrgId): RedemptionTransaction {
  return {
    async createAttempt(input: CreateAttemptInput): Promise<AttemptId> {
      // `status` is left to the column default (`created`) rather than written here: the
      // attempt lifecycle belongs to the state machine in core-domain, and a second place
      // that names an initial status is a second place that can disagree with it.
      const inserted = await tx.execute<{ id: string }>(sql`
        INSERT INTO attempts (
          org_id, invitation_id, candidate_id, assessment_id, assessment_version, created_at
        )
        VALUES (
          ${orgId}::uuid,
          ${input.invitationId}::uuid,
          ${input.candidateId}::uuid,
          ${input.assessmentId}::uuid,
          ${input.assessmentVersion},
          ${input.at.toISOString()}::timestamptz
        )
        RETURNING id::text AS id
      `);

      const first = inserted[0];
      if (first === undefined) {
        throw new Error('the attempt INSERT returned no row, so no attempt can be assumed');
      }
      return AttemptIdSchema.parse(first.id);
    },

    async recordRedemption(input: RedemptionAuditInput): Promise<void> {
      await writeAudit(tx, {
        orgId,
        actor: { kind: 'candidate', attemptId: input.attemptId },
        action: REDEMPTION_AUDIT_ACTION,
        entityType: REDEMPTION_AUDIT_ENTITY,
        entityId: input.attemptId,
        after: {
          invitation_id: input.invitationId,
          sitting: input.sitting,
          max_attempts: input.maxAttempts,
        },
        ip: input.ip ?? null,
        at: input.at,
      });
    },
  };
}

/** What {@link createPostgresRedemptionGateway} needs. */
export interface PostgresRedemptionGatewayOptions {
  readonly db: Database;
  /**
   * Injected for symmetry with the rest of the flow. Nothing in this module reads it
   * today — every instant it writes is one the policy computed — and it is taken anyway
   * so that a gateway-level `now()` can never creep in as a default (ADR-006).
   */
  readonly clock: Clock;
}

/** Builds the gateway. */
export function createPostgresRedemptionGateway(
  options: PostgresRedemptionGatewayOptions,
): RedemptionGateway {
  const { db } = options;

  return {
    async findOrgByTokenHash(tokenHash: string): Promise<OrgId | undefined> {
      const rows = await withOrg(db, PLATFORM_ORG_ID, async (tx) =>
        tx.execute<{ org_id: string | null }>(sql`
          SELECT public.invitation_org_for_token(${tokenHash}) AS org_id
        `),
      );

      const first = rows[0];
      if (first === undefined || first.org_id === null) return undefined;
      return OrgIdSchema.parse(first.org_id);
    },

    async withLockedInvitation<T>(
      orgId: OrgId,
      tokenHash: string,
      fn: (invitation: LockedInvitation, tx: RedemptionTransaction) => Promise<T>,
    ): Promise<T | undefined> {
      return withOrg(db, orgId, async (tx) => {
        // The lock, and the facts the policy decides on. `FOR UPDATE OF i` locks the
        // invitation alone — the assessment and the application are read, not claimed,
        // and locking them would serialise every redemption of every invitation that
        // shares an assessment, which during a campus drive is all of them.
        const rows = await tx.execute<InvitationRow>(sql`
          SELECT i.id::text            AS invitation_id,
                 i.org_id::text        AS org_id,
                 i.token_hash          AS token_hash,
                 i.opens_at            AS opens_at,
                 i.expires_at          AS expires_at,
                 i.max_attempts        AS max_attempts,
                 i.sent_at             AS sent_at,
                 app.candidate_id::text AS candidate_id,
                 a.id::text            AS assessment_id,
                 a.name                AS assessment_name,
                 a.duration_seconds    AS duration_seconds,
                 a.status::text        AS status,
                 a.version_no          AS version_no,
                 a.allow_back_nav      AS allow_back_nav
            FROM invitations AS i
            JOIN assessments AS a ON a.id = i.assessment_id
            LEFT JOIN applications AS app ON app.id = i.application_id
           WHERE i.token_hash = ${tokenHash}
             FOR UPDATE OF i
        `);

        const row = rows[0];
        if (row === undefined) return undefined;

        // Counted after the lock is held, which is what makes the check and the insert
        // one decision. Two statements rather than sub-selects in the query above:
        // PostgreSQL will not lock rows in a query carrying aggregates at the same level,
        // and a lock silently dropped is the whole guarantee silently dropped.
        const counts = await tx.execute<{ sittings_taken: number; section_count: number }>(sql`
          SELECT (
                   SELECT count(*)::int FROM attempts AS t WHERE t.invitation_id = ${row.invitation_id}::uuid
                 ) AS sittings_taken,
                 (
                   SELECT count(*)::int FROM assessment_sections AS s WHERE s.assessment_id = ${row.assessment_id}::uuid
                 ) AS section_count
        `);

        const count = counts[0];
        if (count === undefined) {
          throw new Error('the sitting count returned no row; refusing to redeem blind');
        }

        const invitation = toLockedInvitation({
          ...row,
          sittings_taken: count.sittings_taken,
          section_count: count.section_count,
        });

        return fn(invitation, transactionFor(tx, orgId));
      });
    },
  };
}
