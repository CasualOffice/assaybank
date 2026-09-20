/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Assessments that have been composed (`H-179`, docs/18 §2.2).
 *
 * The page bar carries no "New assessment" button, deliberately. There is nothing on this
 * screen that could compose one — composition needs a role — so the control would be a
 * disabled rectangle at best and a dead end at worst. The empty state sends you to Roles,
 * which is where the flow actually begins.
 *
 * The list a recruiter lands on after saving, and the answer to "what have we already built
 * for this role". Deliberately thin: it is the far end of the compose flow, not the
 * assessment editor, and the editor is P3's.
 *
 * ## The empty state points backwards
 *
 * An assessment is composed *from a role*, so "no assessments yet" is not a prompt to create
 * one here — there is nothing on this screen to create one with. It sends you to Roles, which
 * is where the flow actually starts. An empty state whose action is the wrong action is worse
 * than one with none.
 *
 * ## What is not here yet, and is not pretended
 *
 * No invitations, no candidates, no results. Those are the stages after this one and they do
 * not exist; a row of greyed controls promising them would be the phase placeholder in a
 * smaller box.
 */

import { Alert, Badge, EmptyState, Skeleton, Table } from '@assaybank/ui';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { type ReactNode } from 'react';

import { useApi } from '../api/api.js';
import { assessmentsQuery, type AssessmentView } from '../api/assessments.js';
import { PageBar } from '../app/PageBar.js';
import { toDisplayEnvelope } from '../app/ErrorBoundary.js';

/** Props for {@link AssessmentsScreen}. */
export interface AssessmentsScreenProps {
  /** The assessment just composed, if the user arrived here by saving one. */
  created?: string | undefined;
}

/** Minutes, because nobody reads an assessment's length in seconds. */
function minutes(seconds: number): string {
  return `${String(Math.round(seconds / 60))} min`;
}

function AssessmentRow({
  assessment,
  isNew,
}: {
  assessment: AssessmentView;
  isNew: boolean;
}): ReactNode {
  return (
    <tr className={isNew ? 'ab-assessments__new' : undefined}>
      <th scope="row">
        {assessment.name}
        {isNew ? <span className="ab-assessments__just-saved"> · just saved</span> : null}
      </th>
      <td className="ab-table__numeric">{assessment.question_count}</td>
      <td className="ab-table__numeric">{minutes(assessment.duration_seconds)}</td>
      <td>
        {/* Draft is the norm for everything composed so far, so it reads as quiet text; a
            published assessment is the exception and keeps the badge (docs/17 §11b). */}
        {assessment.status === 'draft' ? (
          <span className="ab-questions__quiet">Draft</span>
        ) : (
          <Badge tone="success" label="Status">
            {assessment.status}
          </Badge>
        )}
      </td>
    </tr>
  );
}

export function AssessmentsScreen({ created }: AssessmentsScreenProps): ReactNode {
  const api = useApi();
  const query = useQuery(assessmentsQuery(api));
  const rows = query.data?.data ?? [];

  return (
    <div className="ab-screen">
      <PageBar crumbs={[{ label: 'Hiring' }, { label: 'Assessments' }]} />

      <header className="ab-screen__header">
        <h1 className="ab-screen__title" id="page-heading" tabIndex={-1}>
          Assessments
        </h1>
        <p className="ab-screen__lede">
          Composed from a role: the skills, the counts and the difficulty bands all come from what
          the role says it needs. Every candidate draws a different set from the same rules.
        </p>
      </header>

      {query.isError ? (
        <Alert tone="danger" title="Assessments could not be loaded" live="assertive">
          <p>{toDisplayEnvelope(query.error).error.message}</p>
        </Alert>
      ) : null}

      {query.isPending ? (
        <div aria-busy="true" aria-label="Loading assessments">
          <Skeleton height="2rem" />
          <Skeleton height="2rem" />
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          reason="empty"
          title="Nothing composed yet"
          action={
            <Link className="ab-button ab-button--primary" to="/roles">
              Go to roles
            </Link>
          }
        >
          An assessment is composed from a role, so that is where it starts. Pick the role you are
          hiring for and the paper follows from the skills it declares.
        </EmptyState>
      ) : (
        <Table caption="Assessments" captionHidden>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col" className="ab-table__numeric">
                Questions
              </th>
              <th scope="col" className="ab-table__numeric">
                Length
              </th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((assessment) => (
              <AssessmentRow
                key={assessment.id}
                assessment={assessment}
                isNew={assessment.id === created}
              />
            ))}
          </tbody>
        </Table>
      )}

      {rows.length > 0 ? (
        <p className="ab-screen__count">
          {rows.length} assessment{rows.length === 1 ? '' : 's'}. Inviting candidates to one arrives
          with the assessment engine.
        </p>
      ) : null}
    </div>
  );
}
