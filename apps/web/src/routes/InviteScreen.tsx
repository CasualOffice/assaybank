/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Inviting candidates to an assessment (`H-182`, docs/18 §2.4).
 *
 * ## Paste, do not fill in a form
 *
 * A recruiter arrives holding a list — out of a spreadsheet, a mail client, a message from a
 * hiring manager — and the job of this screen is to accept it in whatever shape it came. One
 * textarea, split on commas, semicolons, newlines and tabs, `Ada Lovelace <ada@x>` reduced to
 * the address. A form with a row per candidate would be the same work done forty times.
 *
 * The parsed count is shown before the button is pressed, because "12 addresses" against a
 * list somebody believes has 14 is the moment to notice, not after.
 *
 * ## The links are shown once and said to be shown once
 *
 * The server stores a peppered hash and cannot serve a link twice. So the response is
 * rendered, copyable, with that fact stated — and it is deliberately *not* put in the query
 * cache, where it would outlive this screen as a set of live credentials.
 *
 * Emailing them is `H-189` and is not built. Until it is, this screen is honest about that:
 * the links are here to be sent by whatever the recruiter already uses.
 *
 * ## Publishing is here because inviting without it produces broken links
 *
 * Redemption refuses an unpublished assessment, so a draft's invitations would all fail at
 * the candidate's end. Rather than let that happen and explain it afterwards, an unpublished
 * assessment shows the publish action instead of the invite form.
 */

import { Alert, Badge, Button, Field, Skeleton, Table } from '@assaybank/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';

import { useApi } from '../api/api.js';
import { assessmentsQuery } from '../api/assessments.js';
import {
  createInvitationsRequest,
  invitationsQuery,
  INVITATION_STATE_LABELS,
  parseEmails,
  publishAssessmentRequest,
  type InvitationState,
  type InvitationView,
} from '../api/invitations.js';
import { PageBar } from '../app/PageBar.js';
import { toDisplayEnvelope } from '../app/ErrorBoundary.js';
import type { CreateInvitationsResponse } from '@assaybank/contracts';

/** Props for {@link InviteScreen}. */
export interface InviteScreenProps {
  assessmentId: string;
}

/**
 * Colour repeats the word and never carries it (SC 1.4.1).
 *
 * `used` is a success because somebody sat the assessment, which is the outcome this whole
 * flow exists for. `expired` is a warning rather than a danger: a lapsed link is ordinary,
 * and calling it an error would put it alongside things that are actually wrong.
 */
const STATE_TONES: Readonly<Record<InvitationState, 'neutral' | 'info' | 'success' | 'warning'>> = {
  issued: 'neutral',
  sent: 'info',
  started: 'info',
  used: 'success',
  expired: 'warning',
};

function InvitationRow({ invitation }: { invitation: InvitationView }): ReactNode {
  return (
    <tr>
      <th scope="row">
        {invitation.email}
        {invitation.full_name === null ? null : (
          <span className="ab-invite__name"> · {invitation.full_name}</span>
        )}
      </th>
      <td>
        <Badge tone={STATE_TONES[invitation.state]} label="State">
          {INVITATION_STATE_LABELS[invitation.state]}
        </Badge>
      </td>
      <td className="ab-table__numeric">
        {invitation.sittings_taken} / {invitation.max_attempts}
      </td>
      <td className="ab-questions__nowrap">
        {new Date(invitation.expires_at).toLocaleDateString('en-GB', {
          day: 'numeric',
          month: 'short',
          year: 'numeric',
        })}
      </td>
    </tr>
  );
}

export function InviteScreen({ assessmentId }: InviteScreenProps): ReactNode {
  const api = useApi();
  const queryClient = useQueryClient();

  const [pasted, setPasted] = useState('');
  // Held here rather than in the cache: these are live credentials and the server will not
  // serve them again. See the note in `api/invitations.ts`.
  const [issued, setIssued] = useState<CreateInvitationsResponse | undefined>();

  const assessments = useQuery(assessmentsQuery(api));
  const invitations = useQuery(invitationsQuery(api, assessmentId));

  const assessment = assessments.data?.data.find((row) => row.id === assessmentId);
  const emails = parseEmails(pasted);

  const publish = useMutation({
    mutationFn: () => publishAssessmentRequest(api, assessmentId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['assessments'] });
    },
  });

  const invite = useMutation({
    mutationFn: () => createInvitationsRequest(api, assessmentId, { emails }),
    onSuccess: async (response) => {
      setIssued(response);
      setPasted('');
      await queryClient.invalidateQueries({
        queryKey: ['assessments', assessmentId, 'invitations'],
      });
    },
  });

  const published = assessment?.status === 'published';
  const rows = invitations.data?.data ?? [];

  return (
    <div className="ab-screen">
      <PageBar
        crumbs={[
          { label: 'Hiring' },
          { label: 'Assessments', to: '/assessments' },
          { label: 'Invite' },
        ]}
      >
        {published ? null : (
          <Button
            tone="primary"
            busy={publish.isPending}
            disabled={assessments.isPending}
            onClick={() => {
              publish.mutate();
            }}
          >
            Publish
          </Button>
        )}
      </PageBar>

      <header className="ab-screen__header">
        <h1 className="ab-screen__title" id="page-heading" tabIndex={-1}>
          {assessment?.name ?? 'Invite candidates'}
        </h1>
        <p className="ab-screen__lede">
          Each candidate gets a single-use link and draws their own set of questions from this
          assessment’s rules. Sending the links is not built yet — copy them from here.
        </p>
      </header>

      {publish.isError ? (
        <Alert tone="danger" title="This assessment was not published" live="assertive">
          <p>{toDisplayEnvelope(publish.error).error.message}</p>
        </Alert>
      ) : null}

      {invite.isError ? (
        <Alert tone="danger" title="No invitations were issued" live="assertive">
          <p>{toDisplayEnvelope(invite.error).error.message}</p>
        </Alert>
      ) : null}

      {assessments.isPending ? (
        <div aria-busy="true" aria-label="Loading the assessment">
          <Skeleton height="3rem" />
        </div>
      ) : !published ? (
        <section className="ab-guide ab-guide--warning" role="status">
          <p className="ab-guide__label">Draft</p>
          <div className="ab-guide__body">
            <h2 className="ab-guide__title">Publish this before inviting anybody</h2>
            <p className="ab-guide__text">
              An invitation to a draft cannot be redeemed, so every link would fail at the
              candidate’s end. Publishing re-checks that the bank can still supply the paper.
            </p>
          </div>
        </section>
      ) : (
        <>
          <div className="ab-invite__compose">
            <Field
              label="Email addresses"
              description="Paste a list — commas, semicolons or one per line. Duplicates are dropped."
            >
              {(props) => (
                <textarea
                  {...props}
                  className="ab-invite__paste"
                  rows={5}
                  value={pasted}
                  onChange={(event) => {
                    setPasted(event.target.value);
                  }}
                />
              )}
            </Field>

            <div className="ab-invite__actions">
              <p className="ab-invite__count">
                {emails.length === 0
                  ? 'No addresses yet.'
                  : `${String(emails.length)} address${emails.length === 1 ? '' : 'es'}.`}
              </p>
              <Button
                tone="primary"
                busy={invite.isPending}
                disabled={emails.length === 0}
                onClick={() => {
                  invite.mutate();
                }}
              >
                Create invitations
              </Button>
            </div>
          </div>

          {issued === undefined ? null : (
            <section className="ab-guide ab-guide--success" role="status">
              <p className="ab-guide__label">Issued</p>
              <div className="ab-guide__body">
                <h2 className="ab-guide__title">
                  {issued.issued.length} link{issued.issued.length === 1 ? '' : 's'}, shown once
                </h2>
                <p className="ab-guide__text">
                  Copy these now. The server keeps only a hash, so they cannot be shown again — a
                  lost link is reissued rather than recovered.
                  {issued.skipped.length > 0
                    ? ` ${String(issued.skipped.length)} address${
                        issued.skipped.length === 1 ? '' : 'es'
                      } already had a live invitation and ${
                        issued.skipped.length === 1 ? 'was' : 'were'
                      } skipped.`
                    : ''}
                </p>
              </div>
            </section>
          )}

          {issued === undefined || issued.issued.length === 0 ? null : (
            <ul className="ab-invite__links">
              {issued.issued.map((one) => (
                <li className="ab-invite__link" key={one.id}>
                  <span className="ab-invite__link-email">{one.email}</span>
                  {/* Selectable rather than behind a copy button: a button that silently
                      fails on an insecure origin or a denied permission leaves somebody with
                      nothing, and the text is the thing they actually need. */}
                  <code className="ab-invite__link-url">{one.url}</code>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {invitations.isPending ? null : rows.length === 0 ? (
        <p className="ab-screen__count">Nobody invited yet.</p>
      ) : (
        <>
          <Table caption="Invitations" captionHidden>
            <thead>
              <tr>
                <th scope="col">Candidate</th>
                <th scope="col">State</th>
                <th scope="col" className="ab-table__numeric">
                  Sittings
                </th>
                <th scope="col">Expires</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((invitation) => (
                <InvitationRow key={invitation.id} invitation={invitation} />
              ))}
            </tbody>
          </Table>
          <p className="ab-screen__count">
            {rows.length} invitation{rows.length === 1 ? '' : 's'}.
          </p>
        </>
      )}
    </div>
  );
}
