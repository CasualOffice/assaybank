/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The first screen after signing in (`H-191`, docs/18 §1).
 *
 * ## What it replaced, and why that mattered more than it looks
 *
 * A placeholder with a skeleton and an alert reading "Built in P2". Everything behind it
 * worked — the bank, the roles, the coverage report — and the first thing anyone saw on
 * signing in was a sketch of a screen. That is the single clearest way for a working system
 * to read as a prototype, and it was costing the product more than any styling.
 *
 * ## It answers one question, not four
 *
 * Not a grid of counters. A counter tells you a number and leaves the judgement with you,
 * which is the manual work this console is supposed to be removing. The screen leads with
 * **the one thing to do next**, decided in `dashboard-guidance.ts` from the same data the
 * panels below show, and the panels are then the evidence for that sentence rather than four
 * things competing to be read first.
 *
 * The ordering of the rules is a product judgement and lives in that module with a test per
 * rule, because a product judgement expressed as nested ternaries inside JSX is one nobody
 * ever revisits.
 *
 * ## Two panels, and why not more
 *
 * **Roles** — can the bank measure what you are hiring for. This is the question the whole
 * flow hangs off: an assessment is composed from a role, so a role the bank cannot cover is
 * work that cannot start.
 *
 * **Review queue** — questions somebody has finished and nobody has published. It is the
 * only queue in the system today with a person waiting at the other end.
 *
 * There is deliberately no "recent activity" and no attempt statistics. Neither exists yet —
 * attempts arrive in P3 — and a dashboard that shows an empty panel for something that has
 * never been built is the placeholder problem again in a smaller box.
 *
 * ## Nothing here ranks anybody
 *
 * Every number on this screen is about the *bank*: how many questions cover a skill, how many
 * are waiting for review. No candidate is scored, ordered or recommended, and there is no
 * model anywhere in it (ADR-011, invariant 4). The distinction is worth naming on the screen
 * most likely to grow a "top candidates" panel one day.
 */

import { Alert, Badge, Button, EmptyState, Skeleton } from '@assaybank/ui';
import { useQueries, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { type ReactNode } from 'react';

import { useApi } from '../api/api.js';
import { questionsQuery } from '../api/questions.js';
import {
  roleCoverageQuery,
  rolesQuery,
  verdictFor,
  type JobRoleView,
  type SkillCoverage,
} from '../api/roles.js';
import { PageBar } from '../app/PageBar.js';
import { toDisplayEnvelope } from '../app/ErrorBoundary.js';
import { CoverageStrip } from './CoverageStrip.js';
import { guidanceFor, type RoleReadiness } from './dashboard-guidance.js';
import { DIFFICULTY_LABELS, KIND_LABELS } from './question-labels.js';

/** How many of the review queue the panel lists before it stops and links to the rest. */
const REVIEW_PREVIEW = 5;

/** The verdict as a badge: the word first, the colour repeating it (SC 1.4.1). */
function VerdictBadge({ entry }: { entry: RoleReadiness }): ReactNode {
  const verdict = entry.verdict;

  if (verdict === undefined) {
    return (
      <Badge tone="neutral" label="Coverage">
        Checking
      </Badge>
    );
  }
  if (!verdict.ready) {
    return (
      <Badge tone="danger" label="Coverage">
        Blocked
      </Badge>
    );
  }
  if (verdict.thin.length > 0) {
    return (
      <Badge tone="warning" label="Coverage">
        Thin
      </Badge>
    );
  }
  return (
    <Badge tone="success" label="Coverage">
      Ready
    </Badge>
  );
}

/**
 * The one line under a role: the consequence, not the data.
 *
 * It used to name the skills and their state, and the strip beneath now shows both with a
 * number against each — so the sentence was restating a table in prose and wrapping to two
 * lines to do it. What a bar cannot say is what the situation *means*, so that is all this
 * says now, in under a line.
 */
function verdictLine(entry: RoleReadiness): string {
  const verdict = entry.verdict;
  if (verdict === undefined) return 'Reading the bank…';

  if (!verdict.ready) {
    const n = verdict.blocked.length;
    return `No assessment can be composed: ${String(n)} required skill${n === 1 ? ' has' : 's have'} nothing in band.`;
  }
  if (verdict.thin.length > 0) {
    return 'Composable, but two candidates would see much the same paper.';
  }
  return 'Enough in every band to draw a different set per candidate.';
}

/** One row of the roles panel: the verdict, then the numbers it was reached from. */
function RoleRow({
  entry,
  skills,
}: {
  entry: RoleReadiness;
  skills: readonly SkillCoverage[];
}): ReactNode {
  return (
    <li className="ab-dash__role">
      <div className="ab-dash__role-head">
        <span className="ab-dash__role-title">{entry.role.title}</span>
        <VerdictBadge entry={entry} />
      </div>
      <p className="ab-dash__role-line">{verdictLine(entry)}</p>
      <CoverageStrip skills={skills} />
    </li>
  );
}

/** The dashboard. */
export function DashboardScreen(): ReactNode {
  const api = useApi();

  const roles = useQuery(rolesQuery(api));
  const review = useQuery(questionsQuery(api, { status: 'review' }));

  const roleList: readonly JobRoleView[] = roles.data?.data ?? [];

  // One coverage query per role, in parallel. `useQueries` rather than a component per row
  // holding its own `useQuery`, because the guidance sentence above needs every verdict at
  // once — a decision assembled from children's state would have to be lifted out of them
  // anyway, and lifting it here keeps the rendering a function of one derived list.
  const coverages = useQueries({
    queries: roleList.map((role) => roleCoverageQuery(api, role.id)),
  });

  const readiness: readonly RoleReadiness[] = roleList.map((role, index) => {
    const query = coverages[index];
    return {
      role,
      verdict: query?.data === undefined ? undefined : verdictFor(query.data),
    };
  });

  // The skills behind each verdict, for the strip. Kept beside `readiness` rather than
  // inside it because the guidance rules take a verdict and have no use for a distribution.
  const skillsByRole = new Map(
    roleList.map((role, index) => [role.id, coverages[index]?.data?.skills ?? []] as const),
  );

  const reviewRows = review.data?.data ?? [];
  const reviewHasMore = (review.data?.next_cursor ?? null) !== null;

  // Withheld until the first load settles, rather than rendered against a half-arrived
  // picture. "Start by saying what you are hiring for" shown to somebody who has eleven
  // roles, for the 200ms before the list lands, is worse than showing nothing.
  const settled =
    !roles.isPending && !review.isPending && coverages.every((query) => !query.isPending);

  const guidance = settled
    ? guidanceFor({
        roles: readiness,
        reviewCount: reviewRows.length,
        reviewHasMore,
      })
    : undefined;

  return (
    <div className="ab-screen">
      <PageBar crumbs={[{ label: 'Overview' }, { label: 'Dashboard' }]} />

      <header className="ab-screen__header">
        <h1 className="ab-screen__title" id="page-heading" tabIndex={-1}>
          Dashboard
        </h1>
        {/* The opening clause used to be "what needs attention, and what to do about it",
            which the band directly below now says — with the actual answer in it. What is
            left is the part nothing else on the screen carries. */}
        <p className="ab-screen__lede">
          The question bank measured against the roles you hire for. No candidate is scored, ordered
          or recommended here or anywhere else in this product.
        </p>
      </header>

      {roles.isError ? (
        <Alert tone="danger" title="Roles could not be loaded" live="assertive">
          <p>{toDisplayEnvelope(roles.error).error.message}</p>
          <p className="ab-screen__error-actions">
            <Button
              onClick={() => {
                void roles.refetch();
              }}
            >
              Try again
            </Button>
          </p>
        </Alert>
      ) : null}

      {guidance === undefined ? (
        <div
          className="ab-dash__guidance-loading"
          aria-busy="true"
          aria-label="Working out what needs attention"
        >
          <Skeleton height="1.25rem" width="22rem" />
          <Skeleton height="1rem" />
          <Skeleton height="1rem" width="70%" />
        </div>
      ) : (
        /* Not an `Alert`.
         *
         * It was one, and it read as an error page: a saturated slab taking a fifth of the
         * viewport to say that a role needs more questions. `Alert` is shared with the
         * candidate app, where loud is correct — somebody is under a timer and must not miss
         * it — so the component is right and the usage was wrong. This is a recommendation,
         * which is a different thing: a rule of colour down the edge, a line of text, and the
         * action. It carries `role="status"` rather than `alert`, for the same reason. */
        <section className={`ab-guide ab-guide--${guidance.tone}`} role="status">
          <p className="ab-guide__label">{guidance.label}</p>
          <div className="ab-guide__body">
            <h2 className="ab-guide__title">{guidance.title}</h2>
            <p className="ab-guide__text">{guidance.body}</p>
          </div>
          {guidance.action === undefined ? null : (
            <Link className="ab-button ab-button--primary ab-guide__action" to={guidance.action.to}>
              {guidance.action.label}
            </Link>
          )}
        </section>
      )}

      <div className="ab-dash__panels">
        <section className="ab-dash__panel" aria-labelledby="dash-roles">
          <header className="ab-dash__panel-head">
            <h2 className="ab-dash__panel-title" id="dash-roles">
              Roles
            </h2>
            <Link className="ab-dash__more" to="/roles">
              All roles
            </Link>
          </header>

          {roles.isPending ? (
            <div aria-busy="true" aria-label="Loading roles">
              <Skeleton height="3rem" />
              <Skeleton height="3rem" />
            </div>
          ) : roleList.length === 0 ? (
            <EmptyState
              reason="empty"
              title="No roles yet"
              action={
                <Link className="ab-button ab-button--primary" to="/roles">
                  Go to roles
                </Link>
              }
            >
              A role names the skills a job needs. It is what an assessment is composed from, so it
              is the first thing to define.
            </EmptyState>
          ) : (
            <ul className="ab-dash__roles">
              {readiness.map((entry) => (
                <RoleRow
                  key={entry.role.id}
                  entry={entry}
                  skills={skillsByRole.get(entry.role.id) ?? []}
                />
              ))}
            </ul>
          )}
        </section>

        <section className="ab-dash__panel" aria-labelledby="dash-review">
          <header className="ab-dash__panel-head">
            <h2 className="ab-dash__panel-title" id="dash-review">
              Waiting for review
            </h2>
            <Link className="ab-dash__more" to="/questions">
              The bank
            </Link>
          </header>

          {review.isPending ? (
            <div aria-busy="true" aria-label="Loading the review queue">
              <Skeleton height="2rem" />
              <Skeleton height="2rem" />
            </div>
          ) : review.isError ? (
            <Alert tone="danger" title="The review queue could not be loaded">
              <p>{toDisplayEnvelope(review.error).error.message}</p>
            </Alert>
          ) : reviewRows.length === 0 ? (
            <EmptyState reason="empty" title="Nothing is waiting">
              A question sent for review appears here until somebody publishes it. An empty queue is
              the good state, not a missing panel.
            </EmptyState>
          ) : (
            <>
              <ul className="ab-dash__queue">
                {reviewRows.slice(0, REVIEW_PREVIEW).map((row) => (
                  <li className="ab-dash__queue-item" key={row.id}>
                    <Link
                      className="ab-dash__queue-link"
                      to="/questions/$questionId"
                      params={{ questionId: row.id }}
                    >
                      {row.latest_prompt_excerpt ?? 'Untitled question'}
                    </Link>
                    <span className="ab-dash__queue-meta">
                      {KIND_LABELS[row.kind]}
                      {row.latest_difficulty === null
                        ? null
                        : ` · ${DIFFICULTY_LABELS[row.latest_difficulty] ?? String(row.latest_difficulty)}`}
                    </span>
                  </li>
                ))}
              </ul>

              {reviewRows.length > REVIEW_PREVIEW || reviewHasMore ? (
                <p className="ab-dash__queue-rest">
                  <Link to="/questions">
                    {reviewHasMore
                      ? 'More are waiting than fit here'
                      : `${String(reviewRows.length - REVIEW_PREVIEW)} more waiting`}
                  </Link>
                </p>
              ) : null}
            </>
          )}
        </section>
      </div>
    </div>
  );
}
