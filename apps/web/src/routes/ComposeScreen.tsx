/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Composing an assessment from a role (`H-179`, docs/18 §2.2).
 *
 * ## The screen that makes the button mean something
 *
 * "Compose an assessment" has been an inert control on the Roles screen since that screen
 * existed. This is what it does: shows the paper a role produces, says whether the bank can
 * supply it, and saves it.
 *
 * ## It opens with an answer, not with a form
 *
 * A role already decides which skills matter, how much each is worth and at what difficulty —
 * so the paper is computed before the recruiter touches anything, and the two dials are there
 * to adjust an answer rather than to produce one. A wizard that opened empty would be asking
 * the recruiter for four judgements the role has already made.
 *
 * ## Infeasible is shown, and saving is refused
 *
 * A rule asking for six where the bank holds four is rendered with both numbers, and the
 * shortfall named. **Save stays disabled** — not because the screen is being protective, but
 * because the server refuses it: the draw will not short-draw at attempt start (ADR-004), so
 * an infeasible assessment does not degrade, it fails for the first candidate to open the
 * link. A disabled control with no explanation is a dead end, so the reason sits beside it and
 * the way out — publish more questions for these skills — is a link.
 *
 * ## Nothing here ranks anybody
 *
 * Every number is about the bank. No candidate exists yet at this point in the flow.
 */

import { Alert, Button, Field, Input, Skeleton, Table } from '@assaybank/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useState, type ReactNode } from 'react';

import { useApi } from '../api/api.js';
import { JobRoleIdSchema } from '@assaybank/contracts';

import {
  assessmentPlanQuery,
  createAssessmentRequest,
  rulesOf,
  shortfallOf,
  type PlannedRule,
} from '../api/assessments.js';
import { PageBar } from '../app/PageBar.js';
import { toDisplayEnvelope } from '../app/ErrorBoundary.js';

/** How long a paper is allowed to be. Mirrors `MAX_QUESTION_COUNT` in the contract. */
const MAX_QUESTIONS = 100;

/** Props for {@link ComposeScreen}. */
export interface ComposeScreenProps {
  /** Which role to compose for. From the URL. */
  roleId: string;
}

/** A number the user is typing, which is briefly not a number. */
function asCount(raw: string): number | undefined {
  const value = Number.parseInt(raw, 10);
  return Number.isInteger(value) && value >= 1 && value <= MAX_QUESTIONS ? value : undefined;
}

/** One rule, with what it asks for set against what the bank holds. */
function RuleRow({ rule }: { rule: PlannedRule }): ReactNode {
  const short = shortfallOf(rule);
  const band =
    rule.min_difficulty === rule.max_difficulty
      ? `difficulty ${String(rule.min_difficulty)}`
      : `difficulty ${String(rule.min_difficulty)}–${String(rule.max_difficulty)}`;

  return (
    <tr className={short > 0 ? 'ab-compose__short' : undefined}>
      <th scope="row">
        <span className="ab-compose__skill">{rule.skill_name}</span>
        <span className="ab-compose__band">{band}</span>
      </th>
      <td className="ab-table__numeric">{rule.pick_count}</td>
      <td className="ab-table__numeric">{rule.available}</td>
      <td className="ab-compose__verdict">
        {short > 0 ? (
          // Both numbers are already in the two columns beside this; what this adds is the
          // arithmetic nobody should have to do, which is how many are missing.
          <span className="ab-compose__missing">{short} short</span>
        ) : (
          <span className="ab-compose__ok">Enough</span>
        )}
      </td>
    </tr>
  );
}

export function ComposeScreen({ roleId }: ComposeScreenProps): ReactNode {
  const api = useApi();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  // Held as strings, because that is what an input holds. A number in state would have to
  // decide what `''` means halfway through somebody typing "12".
  const [countInput, setCountInput] = useState('');
  const [nameInput, setNameInput] = useState('');
  const questionCount = asCount(countInput);

  const plan = useQuery(assessmentPlanQuery(api, roleId, { questionCount }));

  const save = useMutation({
    mutationFn: () =>
      createAssessmentRequest(api, {
        // Parsed rather than cast. The id came out of the URL, which is the one place a
        // value can be anything at all, and the brand exists to make that a decision rather
        // than an assumption (docs/17 §1).
        job_role_id: JobRoleIdSchema.parse(roleId),
        ...(nameInput.trim() === '' ? {} : { name: nameInput.trim() }),
        ...(questionCount === undefined ? {} : { question_count: questionCount }),
      }),
    onSuccess: async (created) => {
      // The list is now wrong, and the plan's `available` is unchanged — composing does not
      // consume questions. Only the list is invalidated.
      await queryClient.invalidateQueries({ queryKey: ['assessments'] });
      await navigate({ to: '/assessments', search: { created: created.id } });
    },
  });

  const rules = plan.data === undefined ? [] : rulesOf(plan.data);
  const shortfalls = rules.filter((rule) => shortfallOf(rule) > 0);
  const feasible = plan.data?.feasible ?? false;

  return (
    <div className="ab-screen">
      <PageBar
        crumbs={[{ label: 'Hiring' }, { label: 'Roles', to: '/roles' }, { label: 'Compose' }]}
      >
        <Button
          tone="primary"
          busy={save.isPending}
          disabled={!feasible || plan.isPending}
          onClick={() => {
            save.mutate();
          }}
        >
          Save assessment
        </Button>
      </PageBar>

      <header className="ab-screen__header">
        <h1 className="ab-screen__title" id="page-heading" tabIndex={-1}>
          {plan.data === undefined ? 'Compose an assessment' : plan.data.role_title}
        </h1>
        <p className="ab-screen__lede">
          The paper this role produces. Each required skill gets questions in proportion to its
          weight, inside the difficulty band the role asks for — change the role to change any of
          that, and it changes for every assessment composed from it.
        </p>
      </header>

      {plan.isError ? (
        <Alert tone="danger" title="This role’s plan could not be loaded" live="assertive">
          <p>{toDisplayEnvelope(plan.error).error.message}</p>
        </Alert>
      ) : null}

      {save.isError ? (
        <Alert tone="danger" title="The assessment was not saved" live="assertive">
          <p>{toDisplayEnvelope(save.error).error.message}</p>
        </Alert>
      ) : null}

      {plan.isPending ? (
        <div aria-busy="true" aria-label="Composing">
          <Skeleton height="3rem" />
          <Skeleton height="8rem" />
        </div>
      ) : plan.data === undefined ? null : (
        <>
          <section
            className={`ab-guide ab-guide--${feasible ? 'success' : 'danger'}`}
            role="status"
          >
            <p className="ab-guide__label">{feasible ? 'Ready' : 'Blocked'}</p>
            <div className="ab-guide__body">
              <h2 className="ab-guide__title">
                {feasible
                  ? `${String(plan.data.question_count)} questions, about ${String(
                      Math.round(plan.data.duration_seconds / 60),
                    )} minutes`
                  : `The bank is short for ${shortfalls.map((rule) => rule.skill_name).join(', ')}`}
              </h2>
              <p className="ab-guide__text">
                {feasible
                  ? 'Every candidate draws a different set from these rules, at the same difficulty.'
                  : 'This cannot be saved until each skill below has enough published questions in band. A paper the bank cannot fill does not shrink — it fails for the first candidate who opens it.'}
              </p>
            </div>
            {feasible ? null : (
              <Link className="ab-button ab-button--secondary ab-guide__action" to="/questions">
                Add questions
              </Link>
            )}
          </section>

          <div className="ab-compose__controls">
            <Field
              label="Questions"
              description={`Defaults to two per required skill. Up to ${String(MAX_QUESTIONS)}.`}
            >
              {(props) => (
                <Input
                  {...props}
                  type="number"
                  min={1}
                  max={MAX_QUESTIONS}
                  value={countInput}
                  placeholder={String(plan.data?.question_count ?? '')}
                  onChange={(event) => {
                    setCountInput(event.target.value);
                  }}
                />
              )}
            </Field>

            <Field label="Name" description="Defaults to the role’s title.">
              {(props) => (
                <Input
                  {...props}
                  value={nameInput}
                  placeholder={plan.data?.role_title ?? ''}
                  onChange={(event) => {
                    setNameInput(event.target.value);
                  }}
                />
              )}
            </Field>
          </div>

          <Table caption="What each skill contributes" captionHidden>
            <thead>
              <tr>
                <th scope="col">Skill</th>
                <th scope="col" className="ab-table__numeric">
                  Questions
                </th>
                <th scope="col" className="ab-table__numeric">
                  In the bank
                </th>
                <th scope="col">
                  <span className="ab-visually-hidden">Whether the bank has enough</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rules.map((rule) => (
                <RuleRow key={rule.skill_id} rule={rule} />
              ))}
            </tbody>
          </Table>
        </>
      )}
    </div>
  );
}
