/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Publishing an assessment and inviting candidates (`H-182`, docs/03 §5–6).
 *
 * ## The issued links are not cached
 *
 * `createInvitationsRequest` returns the only copy of each link that will ever exist, so the
 * response is handed to the component and never written into the query cache. A cache entry
 * holding live credentials would outlive the screen, survive a navigation, and be readable by
 * anything else that can reach the client — for a value the server itself refuses to serve
 * twice.
 */

import {
  ASSESSMENT_INVITATIONS_PATH,
  ASSESSMENT_PUBLISH_PATH,
  CreateInvitationsResponseSchema,
  InvitationListResponseSchema,
  PublishedAssessmentSchema,
  type CreateInvitations,
  type CreateInvitationsResponse,
  type InvitationListResponse,
  type InvitationState,
  type InvitationView,
  type PublishedAssessment,
} from '@assaybank/contracts';
import { queryOptions } from '@tanstack/react-query';

import { type ApiClient } from './client.js';

export type { InvitationState, InvitationView };

/** Who has been invited to one assessment — `GET /assessments/{id}/invitations`. */
export function invitationsQuery(client: ApiClient, assessmentId: string) {
  return queryOptions<InvitationListResponse>({
    queryKey: ['assessments', assessmentId, 'invitations'],
    queryFn: ({ signal }) =>
      client.request(ASSESSMENT_INVITATIONS_PATH.replace('{id}', assessmentId), {
        schema: InvitationListResponseSchema,
        signal,
      }),
    // A candidate starting the assessment changes a row here, and a recruiter watching a
    // drive wants to see that without reloading. Ten seconds is often enough to feel live
    // and rare enough not to poll the server for a screen nobody is looking at.
    staleTime: 10_000,
  });
}

/** Makes the assessment sittable — `POST /assessments/{id}/publish`. */
export function publishAssessmentRequest(
  client: ApiClient,
  assessmentId: string,
): Promise<PublishedAssessment> {
  return client.post(
    ASSESSMENT_PUBLISH_PATH.replace('{id}', assessmentId),
    {},
    PublishedAssessmentSchema,
  );
}

/** Issues the links — `POST /assessments/{id}/invitations`. Served once, never cached. */
export function createInvitationsRequest(
  client: ApiClient,
  assessmentId: string,
  body: CreateInvitations,
): Promise<CreateInvitationsResponse> {
  return client.post(
    ASSESSMENT_INVITATIONS_PATH.replace('{id}', assessmentId),
    body,
    CreateInvitationsResponseSchema,
  );
}

/**
 * Splits a pasted block into addresses.
 *
 * Commas, semicolons, newlines and tabs, because a recruiter pastes out of a spreadsheet, a
 * mail client or a chat message and each of those separates differently. Angle-bracket
 * display names — `Ada Lovelace <ada@x>` — keep only the address, which is the form every
 * mail client produces on copy.
 *
 * Deduplicated case-insensitively here as well as on the server: telling somebody their list
 * had eleven addresses when they pasted twelve is more useful before they press the button
 * than after.
 */
export function parseEmails(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  for (const piece of raw.split(/[,;\n\t]+/u)) {
    const bracketed = /<([^>]+)>/u.exec(piece);
    const value = (bracketed?.[1] ?? piece).trim();
    if (value === '') continue;

    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }

  return out;
}

/** The words the console uses for an invitation's state. */
export const INVITATION_STATE_LABELS: Readonly<Record<InvitationState, string>> = {
  issued: 'Link issued',
  sent: 'Sent',
  started: 'Started',
  used: 'Completed',
  expired: 'Expired',
};
