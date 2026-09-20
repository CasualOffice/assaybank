/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Publishing an assessment and inviting candidates to it (`H-182`, docs/03 §5–6).
 *
 * ```
 * POST /assessments/{id}/publish       → draft becomes sittable
 * POST /assessments/{id}/invitations   → links, served once
 * GET  /assessments/{id}/invitations   → who was invited, and where they got to
 * ```
 *
 * ## Publish re-checks feasibility, because the bank moved
 *
 * Composition checked that the bank could supply the paper *at the time it was composed*, and
 * said so explicitly as a snapshot. Between then and now a question can be retired, and
 * publishing is the act that lets somebody sit it — so the check runs again here against the
 * bank as it is. The same refusal, with the same shortfalls.
 *
 * It also refuses an assessment with no rules at all. Redemption calls that
 * `invitation_incomplete` and refuses the candidate, which is the worst possible moment to
 * discover it.
 *
 * ## The link exists once
 *
 * `generateToken` produces the plaintext and its peppered hash; the hash is stored and the
 * plaintext goes into this one response. Nothing can read it back — the list endpoint does
 * not serve it, the log does not carry it, and a database dump is not a set of live
 * credentials. A link that is lost is reissued rather than recovered.
 *
 * ## Re-inviting somebody who already holds a live link does nothing
 *
 * Pasting the same forty addresses twice is a thing that happens, and the second paste must
 * not hand twenty people a second sitting. An address with a live invitation to this
 * assessment comes back in `skipped`, and the response says so rather than silently
 * issuing nothing.
 */

import type { FastifyInstance } from 'fastify';

import { generateToken } from '@assaybank/auth';
import {
  ApiError,
  ASSESSMENT_INVITATIONS_PATH,
  ASSESSMENT_PUBLISH_PATH,
  AssessmentParamsSchema,
  InvitationIdSchema,
  CreateInvitationsSchema,
  DEFAULT_INVITATION_DAYS,
  parseRequestPart,
  type CreateInvitationsResponse,
  type InvitationListResponse,
  type InvitationState,
  type InvitationView,
  type IssuedInvitation,
} from '@assaybank/contracts';
import {
  applicationFor,
  assessmentPublishState,
  assessmentRules,
  countAvailable,
  createInvitation,
  listInvitations,
  liveInvitedEmails,
  publishAssessment,
  upsertCandidate,
  withOrg,
  type Database,
  type DbTransaction,
} from '@assaybank/db';

import { currentPrincipal } from '../principal.js';
import { fastifyPath } from '../paths.js';
import { rateLimitFor } from '../rate-limit.js';
import { requirePermission } from '../authorisation.js';

export const ASSESSMENT_PUBLISH_ROUTE = fastifyPath(ASSESSMENT_PUBLISH_PATH);
export const ASSESSMENT_INVITATIONS_ROUTE = fastifyPath(ASSESSMENT_INVITATIONS_PATH);

export const ASSESSMENT_PUBLISH_ACTION = 'assessment.publish';
export const INVITATION_CREATE_ACTION = 'invitation.create';
const ASSESSMENT_ENTITY = 'assessment';

/** What these routes need beyond the database. */
export interface InvitationServices {
  readonly db: Database;
  /** `TOKEN_PEPPER`. Without it no invitation could be redeemed, so the routes are absent. */
  readonly tokenPepper: string;
  /** `CANDIDATE_PUBLIC_URL`. Where the link points; never derived from a `Host` header. */
  readonly candidateUrl: string;
  readonly now: () => Date;
}

function staffOnly(request: Parameters<typeof currentPrincipal>[0]) {
  const principal = currentPrincipal(request);
  if (principal.kind !== 'staff') throw ApiError.unauthenticated();
  return principal;
}

/** Where one invitation has got to, from the columns rather than from a stored status. */
export function invitationState(
  row: {
    expiresAt: string;
    sentAt: string | null;
    sittingsTaken: number;
    maxAttempts: number;
  },
  now: Date,
): InvitationState {
  // Used before expired: somebody who sat the assessment and then let the link lapse has
  // used it, and reporting that as "expired" would read as though they never turned up.
  if (row.sittingsTaken >= row.maxAttempts) return 'used';
  if (new Date(row.expiresAt).getTime() <= now.getTime()) return 'expired';
  if (row.sittingsTaken > 0) return 'started';
  return row.sentAt === null ? 'issued' : 'sent';
}

/** Rules that the bank cannot currently supply, with both numbers. */
async function shortfalls(
  tx: DbTransaction,
  assessmentId: string,
): Promise<{ needed: number; available: number; skill_id: string }[]> {
  const rules = await assessmentRules(tx, assessmentId);
  const out = [];

  for (const rule of rules) {
    const skillId = rule.skillIds[0];
    if (skillId === undefined) continue;

    const available = await countAvailable(tx, {
      skillId,
      kinds: rule.kinds,
      minDifficulty: rule.minDifficulty,
      maxDifficulty: rule.maxDifficulty,
    });
    if (available < rule.pickCount) {
      out.push({ skill_id: skillId, needed: rule.pickCount, available });
    }
  }

  return out;
}

export function registerInvitationRoutes(app: FastifyInstance, services: InvitationServices): void {
  const { db, now } = services;
  const read = { ...rateLimitFor('staff_api'), ...requirePermission('question.read') };
  const publish = { ...rateLimitFor('staff_api'), ...requirePermission('assessment.write') };
  const invite = { ...rateLimitFor('staff_api'), ...requirePermission('invite.send') };

  // --- POST /assessments/:id/publish -------------------------------------------
  app.post(ASSESSMENT_PUBLISH_ROUTE, { config: publish }, async (request) => {
    staffOnly(request);
    const { id } = parseRequestPart(AssessmentParamsSchema, request.params, 'params');

    return request.audited(
      { action: ASSESSMENT_PUBLISH_ACTION, entityType: ASSESSMENT_ENTITY, entityId: id },
      async (tx, entry) => {
        const state = await assessmentPublishState(tx, id);
        if (state === undefined) throw ApiError.notFound();

        if (state.status === 'published') {
          // Not an error to publish twice in the sense of a bug, but it is a conflict: the
          // caller believed it was still a draft, and something happened in between.
          throw ApiError.conflict('This assessment is already published.');
        }

        if (state.ruleCount === 0) {
          throw ApiError.validationFailed(
            'This assessment has no questions to draw, so nobody could sit it.',
          );
        }

        const missing = await shortfalls(tx, id);
        if (missing.length > 0) {
          // Re-checked here and not trusted from composition: a question retired since then
          // makes a paper that was feasible on Tuesday infeasible today, and publishing is
          // the act that lets somebody try to sit it.
          throw ApiError.validationFailed(
            'The bank can no longer supply this assessment. Publish more questions, or compose a smaller one.',
            { details: { shortfalls: missing } },
          );
        }

        const changed = await publishAssessment(tx, id);
        if (!changed) throw ApiError.conflict('This assessment is already published.');

        entry.amend({ after: { status: 'published' } });
        return { id, status: 'published' as const };
      },
    );
  });

  // --- POST /assessments/:id/invitations ---------------------------------------
  app.post(ASSESSMENT_INVITATIONS_ROUTE, { config: invite }, async (request, reply) => {
    staffOnly(request);
    const { id } = parseRequestPart(AssessmentParamsSchema, request.params, 'params');
    const body = parseRequestPart(CreateInvitationsSchema, request.body, 'body');

    const issuedAt = now();
    const expiresAt = new Date(
      issuedAt.getTime() + (body.expires_in_days ?? DEFAULT_INVITATION_DAYS) * 86_400_000,
    );

    const result = await request.audited(
      { action: INVITATION_CREATE_ACTION, entityType: ASSESSMENT_ENTITY, entityId: id },
      async (tx, entry): Promise<CreateInvitationsResponse> => {
        const principal = staffOnly(request);
        const state = await assessmentPublishState(tx, id);
        if (state === undefined) throw ApiError.notFound();

        if (state.status !== 'published') {
          // Redemption refuses an unpublished assessment outright, so issuing links for a
          // draft produces a set of URLs that every recipient finds broken — and the
          // recruiter learns about it from a candidate.
          throw ApiError.validationFailed(
            'Publish this assessment before inviting anybody: an invitation to a draft cannot be redeemed.',
          );
        }

        if (state.jobRoleId === null) {
          // An invitation hangs from an application, which hangs from an opening, which
          // needs a role. Nothing composes an assessment without one today.
          throw ApiError.validationFailed(
            'This assessment is not attached to a role, so there is nothing to invite anybody to.',
          );
        }

        const live = await liveInvitedEmails(tx, id, issuedAt);
        const issued: IssuedInvitation[] = [];
        const skipped: string[] = [];
        // Deduplicated within the request too: one paste containing an address twice is one
        // invitation, not two.
        const seen = new Set<string>();

        for (const email of body.emails) {
          const key = email.toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);

          if (live.has(key)) {
            skipped.push(email);
            continue;
          }

          const candidateId = await upsertCandidate(tx, { orgId: principal.orgId, email });
          const applicationId = await applicationFor(tx, {
            orgId: principal.orgId,
            candidateId,
            jobRoleId: state.jobRoleId,
            title: state.name,
          });

          const token = generateToken(services.tokenPepper);
          const invitationId = await createInvitation(tx, {
            orgId: principal.orgId,
            assessmentId: id,
            applicationId,
            tokenHash: token.hash,
            expiresAt,
            maxAttempts: body.max_attempts ?? 1,
            createdBy: principal.userId,
          });

          issued.push({
            id: invitationId,
            candidate_id: candidateId,
            email,
            // `/t/{token}` is the candidate app's redemption route. Built from the
            // configured public URL, never from a `Host` header — a header-derived link is
            // how a service is made to email somebody a link to an attacker's copy of it.
            url: `${services.candidateUrl.replace(/\/$/u, '')}/t/${token.plaintext}`,
            expires_at: expiresAt.toISOString(),
          } as IssuedInvitation);
        }

        // Counts, never addresses and never tokens: an audit row is read by people who do
        // not need the candidate list, and a token in one would be a credential at rest.
        entry.amend({ after: { issued: issued.length, skipped: skipped.length } });

        return { issued, skipped };
      },
    );

    return reply.code(201).send(result);
  });

  // --- GET /assessments/:id/invitations ----------------------------------------
  app.get(
    ASSESSMENT_INVITATIONS_ROUTE,
    { config: read },
    async (request): Promise<InvitationListResponse> => {
      const principal = staffOnly(request);
      const { id } = parseRequestPart(AssessmentParamsSchema, request.params, 'params');
      const at = now();

      const rows = await withOrg(db, principal.orgId, async (tx) => {
        if ((await assessmentPublishState(tx, id)) === undefined) throw ApiError.notFound();
        return listInvitations(tx, id);
      });

      return {
        assessment_id: id,
        data: rows.map((row): InvitationView => ({
          // Parsed rather than cast: these came from the database as plain text, and the
          // brand is what records that somebody checked.
          id: InvitationIdSchema.parse(row.id),
          email: row.email,
          full_name: row.fullName,
          state: invitationState(row, at),
          expires_at: row.expiresAt,
          sent_at: row.sentAt,
          sittings_taken: row.sittingsTaken,
          max_attempts: row.maxAttempts,
          created_at: row.createdAt,
        })),
      };
    },
  );
}
