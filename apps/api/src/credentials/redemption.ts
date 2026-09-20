/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `POST /candidate/redeem` — the one exchange that turns an invitation into a credential.
 *
 * A candidate has no account (docs/03-API-spec.md §1). They present the token that was
 * mailed to them, exactly once, and receive an attempt token scoped to exactly one
 * attempt. Everything about the shape of this module follows from the three properties
 * that exchange has to have.
 *
 * ## 1. Single use, decided by the database rather than by this code
 *
 * The sitting allowance lives in `invitations.max_attempts`, and the sittings taken are
 * `attempts` rows pointing back at the invitation. The gateway locks the invitation row
 * (`SELECT … FOR UPDATE`) and counts inside that lock, so the check and the insert are
 * one transaction: docs/14 `H-165` — *"the redeem count is checked against `max_attempts`
 * in the same transaction that creates the attempt, so concurrent redemptions cannot both
 * succeed."* Two browser tabs racing produce one attempt and one refusal, not two
 * attempts, and no amount of application-level counting achieves that.
 *
 * With the schema default of `max_attempts = 1`, that is exactly "redeemed once, refused
 * on replay". A larger allowance means a larger allowance; it does not mean a second
 * chance at a fresh draw, because each sitting is its own attempt row with its own
 * materialised question set (ADR-004).
 *
 * **Resumption is deliberately not here.** `H-139` also anticipates a candidate whose
 * browser died mid-attempt re-presenting the invitation and resuming rather than
 * consuming a second sitting. That is a P3 behaviour: it needs an attempt that has been
 * *started*, and in P1 nothing starts one. Building the strict rule first is the right
 * order — a credential exchange can always be loosened later, and a redemption that
 * turned out to be reusable cannot be tightened once tokens are in inboxes.
 *
 * ## 2. The comparison is timing-safe
 *
 * The presented plaintext is never compared to anything. It is hashed with
 * `TOKEN_PEPPER` and the *hash* is used as an index key, and then — this is the part
 * that is easy to leave out — the row that came back is confirmed with `verifyToken`,
 * which goes through `crypto.timingSafeEqual` and does not stop at the first differing
 * byte. The index lookup narrows; the constant-time comparison decides. Without the
 * second step the only comparison in the path would be a B-tree descent, whose timing is
 * a function of the stored keys.
 *
 * ## 3. Every refusal is the same refusal
 *
 * Expired, not yet open, already redeemed, never existed, wrong assessment state: all of
 * them are `404 not_found` with the same message and no details (docs/14 `H-146`). The
 * reason goes to the log and to a metric label. See `refusal.ts`.
 *
 * ## Why the database work is behind a port
 *
 * The policy above — the window, the allowance, the confirmation, the order the checks
 * run in — is the part that decides whether somebody sits an assessment, and it is worth
 * testing exhaustively in a millisecond rather than expensively against a container. The
 * gateway is the transaction boundary and nothing else: it locks, it counts, it inserts,
 * it audits. Both are tested — the policy against a fake, the gateway against a real
 * PostgreSQL with real row-level security.
 */

import { type Clock, hashToken, verifyToken } from '@assaybank/auth';
import type {
  AssessmentId,
  AttemptId,
  CandidateId,
  InvitationId,
  OrgId,
} from '@assaybank/contracts';
import {
  counter,
  histogram,
  type CounterMetric,
  type HistogramMetric,
} from '@assaybank/observability';

import { mintAttemptToken } from './attempt-token.js';
import type { CredentialKeys } from './keys.js';
import { refuse, type Refusal } from './refusal.js';

/** How the invitation reached the candidate. A closed set: it is a metric label. */
export const INVITATION_CHANNELS = ['email', 'link'] as const;

/** One of {@link INVITATION_CHANNELS}. */
export type InvitationChannel = (typeof INVITATION_CHANNELS)[number];

/**
 * docs/12 §"invitations_redeemed_total": the numerator of the redemption rate, whose
 * denominator is `invitations_sent_total`. A collapse in the ratio is almost always mail
 * delivery rather than candidate disinterest, and it is the only way to detect a silent
 * SMTP failure.
 */
export const invitationsRedeemedTotal: CounterMetric<'channel'> = counter<'channel'>({
  name: 'invitations_redeemed_total',
  help: 'Invitations successfully redeemed for an attempt token, by delivery channel.',
  labelNames: ['channel'],
  labelValues: { channel: INVITATION_CHANNELS },
});

/**
 * docs/12 §"invitation_redemption_delay_seconds": sent → redeemed, which feeds the PRD
 * §10 "invite to score < 24h median" metric. Buckets span a minute to a fortnight,
 * because that is the range this actually takes.
 */
export const invitationRedemptionDelaySeconds: HistogramMetric<'channel'> = histogram<'channel'>({
  name: 'invitation_redemption_delay_seconds',
  help: 'Seconds between an invitation being sent and being redeemed.',
  labelNames: ['channel'],
  labelValues: { channel: INVITATION_CHANNELS },
  buckets: [60, 300, 1_800, 3_600, 21_600, 86_400, 259_200, 604_800, 1_209_600],
});

/** What a candidate may be told about the assessment they are about to sit. */
export interface AssessmentFacts {
  readonly id: AssessmentId;
  readonly name: string;
  /** The budget `deadline_at` will be computed from at start (ADR-006). */
  readonly durationSeconds: number;
  /** `draft` | `review` | `published` | `retired`. Only `published` may be sat. */
  readonly status: string;
  /** Pinned onto the attempt, so a re-grade knows which version was sat. */
  readonly versionNo: number;
  /** Whether the candidate may navigate back to an answered question. */
  readonly allowBackNav: boolean;
  /** How many sections it has. A count, never the sections themselves. */
  readonly sectionCount: number;
}

/**
 * One invitation, read under a row lock inside the redemption transaction.
 *
 * Every field here is either a policy input or an audit input. Notably absent: the
 * candidate's name, their email, and anything about the assessment's content. The
 * redemption decision does not need them, so this type cannot carry them into a
 * response by accident.
 */
export interface LockedInvitation {
  readonly invitationId: InvitationId;
  readonly orgId: OrgId;
  /** The stored hash, for the constant-time confirmation. */
  readonly tokenHash: string;
  /** Resolved through the invitation's application. Absent means the invitation is unusable. */
  readonly candidateId: CandidateId | undefined;
  /** The assessment window opens here, when one is set. */
  readonly opensAt: Date | undefined;
  readonly expiresAt: Date;
  /** How many sittings this invitation grants. Schema default: one. */
  readonly maxAttempts: number;
  /** How many have already been taken, counted inside the lock. */
  readonly sittingsTaken: number;
  /** When it was mailed, if it was. Decides the `channel` label and the delay metric. */
  readonly sentAt: Date | undefined;
  readonly assessment: AssessmentFacts;
}

/** The attempt row a redemption creates. */
export interface CreateAttemptInput {
  readonly invitationId: InvitationId;
  readonly candidateId: CandidateId;
  readonly assessmentId: AssessmentId;
  readonly assessmentVersion: number;
  readonly at: Date;
}

/** What a redemption records in `audit_log`, in the same transaction. */
export interface RedemptionAuditInput {
  readonly attemptId: AttemptId;
  readonly invitationId: InvitationId;
  /** Which sitting this was: 1 for the first. */
  readonly sitting: number;
  readonly maxAttempts: number;
  /** The client address, for the security-incident runbook. */
  readonly ip: string | undefined;
  readonly at: Date;
}

/**
 * The write side of the redemption transaction.
 *
 * Handed to the callback of {@link RedemptionGateway.withLockedInvitation}, and valid
 * only inside it: both methods run in the transaction that holds the invitation's lock,
 * so the attempt and its audit row commit together or not at all.
 */
export interface RedemptionTransaction {
  createAttempt(input: CreateAttemptInput): Promise<AttemptId>;
  recordRedemption(input: RedemptionAuditInput): Promise<void>;
}

/** The database work a redemption needs. The transaction boundary, and nothing else. */
export interface RedemptionGateway {
  /**
   * Which tenant owns the invitation carrying this hash, if any.
   *
   * The redemption request arrives with no organisation — that is what makes it
   * special — so this is the one lookup that cannot be scoped by `app.current_org`.
   * See migration `0005_invitation_lookup` for how it is narrowed.
   */
  findOrgByTokenHash(tokenHash: string): Promise<OrgId | undefined>;

  /**
   * Opens a transaction scoped to `orgId`, locks the invitation with this hash, and runs
   * `fn` with it.
   *
   * Resolves to `undefined` — without calling `fn` — when the organisation holds no such
   * invitation, which is how a hash that resolved a moment ago but has since been revoked
   * comes back as an ordinary refusal rather than an exception.
   */
  withLockedInvitation<T>(
    orgId: OrgId,
    tokenHash: string,
    fn: (invitation: LockedInvitation, tx: RedemptionTransaction) => Promise<T>,
  ): Promise<T | undefined>;
}

/** What the route hands the service. */
export interface RedemptionRequest {
  /** The plaintext invitation token, exactly as the candidate presented it. */
  readonly token: string;
  /** `request.ip`. Recorded on the audit row; never echoed back. */
  readonly ip?: string | undefined;
}

/** A successful exchange. */
export interface Redemption {
  readonly attemptId: AttemptId;
  readonly orgId: OrgId;
  /** The bearer credential. Returned to the candidate once and never stored. */
  readonly attemptToken: string;
  /** When the credential expires. Server-computed (ADR-006). */
  readonly expiresAt: Date;
  /** Which sitting this was: 1 for the first. */
  readonly sitting: number;
  readonly assessment: AssessmentFacts;
}

/** Either the exchange, or the reason it did not happen. */
export type RedemptionOutcome =
  | { readonly ok: true; readonly redemption: Redemption }
  | { readonly ok: false; readonly refusal: Refusal };

/** What {@link createRedemptionService} needs. */
export interface RedemptionServiceOptions {
  readonly gateway: RedemptionGateway;
  /** The pepper and the attempt-token signing key. See `keys.ts`. */
  readonly keys: Pick<CredentialKeys, 'pepper' | 'attemptToken'>;
  /** Injected. Every window comparison below is against this, never `Date.now()`. */
  readonly clock: Clock;
}

/** The redemption service. One method, because there is one thing to do. */
export interface RedemptionService {
  redeem(request: RedemptionRequest): Promise<RedemptionOutcome>;
}

/** The longest plaintext this endpoint will hash. A token is 43 characters. */
export const MAX_INVITATION_TOKEN_LENGTH = 512;

/** `email` when the invitation was sent, `link` when it was handed over some other way. */
function channelOf(invitation: LockedInvitation): InvitationChannel {
  return invitation.sentAt === undefined ? 'link' : 'email';
}

/** Builds the service. */
export function createRedemptionService(options: RedemptionServiceOptions): RedemptionService {
  const { gateway, keys, clock } = options;

  return {
    async redeem(request: RedemptionRequest): Promise<RedemptionOutcome> {
      const presented = request.token.trim();

      // Bounded before anything expensive. An unauthenticated caller does not get to ask
      // this service to hash a megabyte (docs/17 §10).
      if (presented.length === 0 || presented.length > MAX_INVITATION_TOKEN_LENGTH) {
        return { ok: false, refusal: refuse('redeem', 'malformed') };
      }

      const tokenHash = hashToken(presented, keys.pepper);

      const orgId = await gateway.findOrgByTokenHash(tokenHash);
      if (orgId === undefined) {
        return { ok: false, refusal: refuse('redeem', 'no_such_invitation') };
      }

      // Filled inside the transaction, read after it commits. Metrics describe what
      // committed, not what was attempted — an increment inside the callback would
      // survive a rollback and quietly overstate the redemption rate.
      let delivery:
        | { readonly channel: InvitationChannel; readonly delaySeconds: number | undefined }
        | undefined;

      const outcome = await gateway.withLockedInvitation(
        orgId,
        tokenHash,
        async (invitation, tx): Promise<RedemptionOutcome> => {
          const now = clock.now();

          // Timing-safe confirmation of the row the index found. See the module comment:
          // the lookup narrows, this decides, and it does not short-circuit on the first
          // differing byte.
          if (!verifyToken(presented, invitation.tokenHash, keys.pepper)) {
            return { ok: false, refusal: refuse('redeem', 'hash_mismatch') };
          }

          if (invitation.opensAt !== undefined && now.getTime() < invitation.opensAt.getTime()) {
            return { ok: false, refusal: refuse('redeem', 'not_yet_open') };
          }

          // `>=`: an invitation whose expiry instant has exactly arrived is spent. The
          // boundary falls on the side that refuses.
          if (now.getTime() >= invitation.expiresAt.getTime()) {
            return { ok: false, refusal: refuse('redeem', 'expired') };
          }

          if (invitation.assessment.status !== 'published') {
            // A draft assessment can still be edited, and an attempt against something
            // that changes underneath it cannot be explained afterwards (ADR-003's logic,
            // applied to the assessment rather than to the question).
            return { ok: false, refusal: refuse('redeem', 'assessment_not_published') };
          }

          const candidateId = invitation.candidateId;
          if (candidateId === undefined) {
            // The invitation has no application, so there is nobody to create an attempt
            // for. A staff-side mistake, not an attack — but the candidate is still told
            // exactly what everyone else is told, and the reason goes to the log.
            return { ok: false, refusal: refuse('redeem', 'invitation_incomplete') };
          }

          if (invitation.sittingsTaken >= invitation.maxAttempts) {
            return {
              ok: false,
              refusal: refuse('redeem', 'already_redeemed', {
                sittings_taken: invitation.sittingsTaken,
                max_attempts: invitation.maxAttempts,
              }),
            };
          }

          const attemptId = await tx.createAttempt({
            invitationId: invitation.invitationId,
            candidateId,
            assessmentId: invitation.assessment.id,
            assessmentVersion: invitation.assessment.versionNo,
            at: now,
          });

          const sitting = invitation.sittingsTaken + 1;

          await tx.recordRedemption({
            attemptId,
            invitationId: invitation.invitationId,
            sitting,
            maxAttempts: invitation.maxAttempts,
            ip: request.ip,
            at: now,
          });

          const minted = mintAttemptToken(
            {
              attemptId,
              orgId: invitation.orgId,
              durationSeconds: invitation.assessment.durationSeconds,
            },
            keys.attemptToken,
            clock,
          );

          delivery = {
            channel: channelOf(invitation),
            delaySeconds:
              invitation.sentAt === undefined
                ? undefined
                : Math.max(0, (now.getTime() - invitation.sentAt.getTime()) / 1000),
          };

          return {
            ok: true,
            redemption: {
              attemptId,
              orgId: invitation.orgId,
              attemptToken: minted.token,
              expiresAt: minted.expiresAt,
              sitting,
              assessment: invitation.assessment,
            },
          };
        },
      );

      // `undefined` means the invitation vanished between the two statements — revoked
      // by staff, or erased — which is a refusal like any other.
      const resolved: RedemptionOutcome = outcome ?? {
        ok: false,
        refusal: refuse('redeem', 'no_such_invitation'),
      };

      if (resolved.ok && delivery !== undefined) {
        invitationsRedeemedTotal.inc({ channel: delivery.channel });
        if (delivery.delaySeconds !== undefined) {
          invitationRedemptionDelaySeconds.observe(
            { channel: delivery.channel },
            delivery.delaySeconds,
          );
        }
      }

      return resolved;
    },
  };
}
