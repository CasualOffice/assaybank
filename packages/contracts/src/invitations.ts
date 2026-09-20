/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Publishing an assessment and inviting candidates to it (`H-182`, docs/03 §5–6, docs/18 §2.4).
 *
 * ## Why publish is in this file
 *
 * Because an invitation to an unpublished assessment is not an invitation. Redemption refuses
 * one outright — `assessment_not_published` — so issuing links for a draft produces a set of
 * URLs that every recipient will find broken, and the recruiter will not find out until a
 * candidate emails them. The two belong together: publish is the act that makes an invitation
 * mean anything.
 *
 * ## The token is returned exactly once
 *
 * `invitations.token_hash` stores a peppered hash and nothing else, so the plaintext exists
 * only in the response to the request that created it. That is the same contract the attempt
 * token has, and it is what makes a leaked database insufficient to sit somebody's assessment.
 *
 * The consequence is a real one and is not worked around: a link that is lost cannot be
 * recovered, only reissued. An endpoint that could re-show a link would be an endpoint that
 * hands out credentials to anybody who can read the invitation list.
 */

import { z } from 'zod';

import { AssessmentIdSchema, CandidateIdSchema, InvitationIdSchema } from './ids.js';
import { Rfc3339Schema } from './primitives.js';

/** OpenAPI spellings; `apps/api` prefixes `API_BASE_PATH`. */
export const ASSESSMENT_PUBLISH_PATH = '/assessments/{id}/publish';
export const ASSESSMENT_INVITATIONS_PATH = '/assessments/{id}/invitations';

/**
 * How long an invitation is good for, when the caller does not say.
 *
 * Fourteen days. Long enough that somebody on annual leave is not excluded, short enough that
 * a link forwarded out of an inbox a year later is dead. It is a default rather than a rule
 * because the right answer depends on the drive: a campus round wants days, an executive
 * search wants weeks.
 */
export const DEFAULT_INVITATION_DAYS = 14;

/** The most invitations one request may issue. A bound on the work, not a product opinion. */
export const MAX_INVITATIONS_PER_REQUEST = 200;

/**
 * What `POST /assessments/{id}/publish` answers.
 *
 * Here rather than as an inline `z.object` in the console, because the console parses it and
 * docs/17 §3a puts a shape a front end parses in the contract — an app that declares its own
 * needs `zod` as a dependency and then holds a second definition of something this package
 * already owns.
 */
export const PublishedAssessmentSchema = z
  .object({ id: AssessmentIdSchema, status: z.string() })
  .describe('The assessment, now sittable.')
  .openapi('PublishedAssessment');

export type PublishedAssessment = z.infer<typeof PublishedAssessmentSchema>;

/** The body of `POST /assessments/{id}/invitations`. */
export const CreateInvitationsSchema = z
  .strictObject({
    /**
     * Who to invite, by address.
     *
     * A list rather than one per request, because inviting a cohort one HTTP call at a time
     * is how a recruiter ends up pasting forty addresses into forty forms. Addresses already
     * invited to this assessment are reported as such rather than silently issued a second
     * link — two live links for one person is two sittings nobody meant to allow.
     */
    emails: z.array(z.email().max(320)).min(1).max(MAX_INVITATIONS_PER_REQUEST),
    expires_in_days: z.number().int().min(1).max(365).optional(),
    /** Sittings this invitation permits. The schema default is 1. */
    max_attempts: z.number().int().min(1).max(10).optional(),
  })
  .describe('Invite candidates to an assessment. Addresses already invited are skipped.')
  .openapi('CreateInvitations');

export type CreateInvitations = z.infer<typeof CreateInvitationsSchema>;

/**
 * One invitation as it is issued — the only time the link is ever served.
 *
 * `url` carries the single-use token. It is not stored anywhere it can be read back, it is not
 * logged, and it is not in the list response.
 */
export const IssuedInvitationSchema = z
  .object({
    id: InvitationIdSchema,
    candidate_id: CandidateIdSchema,
    email: z.string(),
    /** The link to send. Served once, in this response, and never again. */
    url: z.string(),
    expires_at: Rfc3339Schema,
  })
  .describe('An invitation, with the link. The link is served here and nowhere else.')
  .openapi('IssuedInvitation');

export type IssuedInvitation = z.infer<typeof IssuedInvitationSchema>;

export const CreateInvitationsResponseSchema = z
  .object({
    issued: z.array(IssuedInvitationSchema),
    /** Addresses that already had a live invitation to this assessment. */
    skipped: z.array(z.string()),
  })
  .describe('What was issued, and which addresses already had a live invitation.')
  .openapi('CreateInvitationsResponse');

export type CreateInvitationsResponse = z.infer<typeof CreateInvitationsResponseSchema>;

/**
 * Where one invitation has got to.
 *
 * Derived on read rather than stored: every one of these is a function of columns that already
 * exist — `sent_at`, `expires_at`, and how many attempts reference the invitation — and a
 * stored status would be a second copy that drifts the first time an attempt is voided.
 */
export const INVITATION_STATES = ['issued', 'sent', 'started', 'used', 'expired'] as const;
export const InvitationStateSchema = z.enum(INVITATION_STATES);
export type InvitationState = (typeof INVITATION_STATES)[number];

export const InvitationSchema = z
  .object({
    id: InvitationIdSchema,
    email: z.string(),
    full_name: z.string().nullable(),
    state: InvitationStateSchema,
    expires_at: Rfc3339Schema,
    sent_at: Rfc3339Schema.nullable(),
    sittings_taken: z.number().int().min(0),
    max_attempts: z.number().int().min(1),
    created_at: Rfc3339Schema,
  })
  .describe('One invitation and where it has got to. Never the token.')
  .openapi('Invitation');

export type InvitationView = z.infer<typeof InvitationSchema>;

export const InvitationListResponseSchema = z
  .object({ assessment_id: AssessmentIdSchema, data: z.array(InvitationSchema) })
  .describe('Every invitation to one assessment.')
  .openapi('InvitationListResponse');

export type InvitationListResponse = z.infer<typeof InvitationListResponseSchema>;
