/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Roles, and whether the bank can measure them (`H-178`, docs/18 §2.1–2.2).
 *
 * ## Why this screen exists, and why it is the first one the flow needs
 *
 * Before this, the console's answer to "we are hiring a senior backend engineer" was a list
 * of four thousand questions and a **New question** button. Every judgement was the
 * recruiter's: which skills matter, whether the bank covers them, at what difficulty, and
 * whether there is enough to give two candidates different papers. The system has the data
 * to answer all four and was not being asked.
 *
 * So the screen is not a list of roles. It is the answer to one question per role — *can we
 * assess this yet* — and where the answer is no, it names the skill and offers the thing
 * that fixes it. A recruiter should never have to browse the bank to find out that a role is
 * unassessable; the bank is the implementation detail of this screen, not its subject.
 *
 * ## The three verdicts, and why "thin" is separate from "blocked"
 *
 * **Blocked** is a required skill with nothing published in its band: the assessment cannot
 * be composed at all. **Thin** is a skill with something but not much — composable, and a
 * different problem: with four questions for a skill, two candidates sitting "different"
 * papers see mostly the same ones, and the comparison between them is weaker than it looks
 * (docs/18 §3.2). Collapsing the two into one warning would hide the second behind the
 * urgency of the first, and the second is the one that quietly makes a score mean less.
 *
 * **Ready** says so plainly. A screen that only ever warns teaches people to ignore it.
 */

import { Alert, Badge, Button, EmptyState, Skeleton, Table } from '@assaybank/ui';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { type ReactNode } from 'react';

import { useApi } from '../api/api.js';
import {
  bandLabel,
  roleCoverageQuery,
  rolesQuery,
  verdictFor,
  type JobRoleView,
  type SkillCoverage,
} from '../api/roles.js';
import { PageBar } from '../app/PageBar.js';
import { toDisplayEnvelope } from '../app/ErrorBoundary.js';

/** The difficulty levels, in the order a distribution is read. */
const LEVELS = ['1', '2', '3', '4', '5'] as const;

/**
 * The coverage of one skill, as a row.
 *
 * The distribution is rendered as counts per level rather than as a bar, because the useful
 * question is "how many at the difficulty this role needs" and a bar answers "what is the
 * shape" — which nobody is asking. The in-band levels are marked, so the eye goes to the two
 * columns that decide feasibility rather than to the tallest one.
 */
function SkillRow({ skill }: { skill: SkillCoverage }): ReactNode {
  const min = skill.min_difficulty ?? 1;
  const max = skill.max_difficulty ?? 5;
  const blocked = skill.is_required && skill.in_band === 0;

  return (
    <tr>
      <th scope="row" className="ab-roles__skill">
        <span className="ab-roles__skill-name">{skill.skill_name}</span>
        <span className="ab-roles__skill-meta">
          <code className="ab-roles__key">{skill.skill_key}</code> · {bandLabel(skill)}
        </span>
      </th>
      <td>
        {skill.is_required ? (
          <Badge tone="neutral" label="Requirement">
            Required
          </Badge>
        ) : (
          <span className="ab-roles__optional">Optional</span>
        )}
      </td>
      <td className="ab-table__numeric">{skill.weight}</td>
      <td className="ab-table__numeric">
        {blocked ? (
          <Badge tone="danger" label="In band">
            None
          </Badge>
        ) : (
          skill.in_band
        )}
      </td>
      {LEVELS.map((level) => {
        const inBand = Number(level) >= min && Number(level) <= max;
        const count = skill.by_difficulty[level] ?? 0;
        return (
          <td
            key={level}
            className={
              inBand ? 'ab-table__numeric ab-roles__in-band' : 'ab-table__numeric ab-roles__out'
            }
          >
            {count === 0 ? <span className="ab-roles__zero">—</span> : count}
          </td>
        );
      })}
    </tr>
  );
}

/** One role, with the verdict first and the detail under it. */
function RoleCoverage({ role }: { role: JobRoleView }): ReactNode {
  const api = useApi();
  const query = useQuery(roleCoverageQuery(api, role.id));

  if (query.isPending) {
    return (
      <section className="ab-roles__role" aria-busy="true" aria-label={`Loading ${role.title}`}>
        <Skeleton height="1.25rem" width="14rem" />
        <Skeleton height="3rem" />
        <Skeleton height="6rem" />
      </section>
    );
  }

  if (query.isError) {
    return (
      <Alert tone="danger" title={`Coverage for ${role.title} could not be loaded`}>
        <p>{toDisplayEnvelope(query.error).error.message}</p>
      </Alert>
    );
  }

  const coverage = query.data;
  const verdict = verdictFor(coverage);
  const required = coverage.skills.filter((skill) => skill.is_required).length;

  return (
    <section className="ab-roles__role" aria-labelledby={`role-${role.id}`}>
      <header className="ab-roles__role-header">
        <div>
          <h2 className="ab-roles__role-title" id={`role-${role.id}`}>
            {role.title}
          </h2>
          <p className="ab-roles__role-meta">
            <code className="ab-roles__key">{role.code}</code>
            {role.seniority === null ? null : <> · {role.seniority}</>}
            {role.family === null ? null : <> · {role.family}</>}
            {' · '}
            {required} required skill{required === 1 ? '' : 's'}
          </p>
        </div>

        {/* The action the verdict implies, and only that one. Offering "Compose an
            assessment" beside a role that cannot be assessed is offering a button that
            produces an error message.

            The one that works is a link, and the one that does not says why rather than
            being a greyed rectangle. A disabled control with no explanation is a dead end
            somebody clicks twice and then stops trusting. */}
        <div className="ab-roles__role-actions">
          {verdict.ready ? (
            <>
              <Button tone="primary" disabled>
                Compose an assessment
              </Button>
              <p className="ab-roles__pending">Arrives with the assessment engine (P3).</p>
            </>
          ) : (
            <Link className="ab-button ab-button--secondary" to="/questions">
              Add questions
            </Link>
          )}
        </div>
      </header>

      {verdict.blocked.length > 0 ? (
        <Alert
          tone="danger"
          title={`${String(verdict.blocked.length)} required skill${
            verdict.blocked.length === 1 ? ' has' : 's have'
          } no published question in band`}
        >
          <p>
            An assessment for this role cannot be composed until each has at least one.{' '}
            {verdict.blocked.map((skill) => skill.skill_name).join(', ')}.
          </p>
        </Alert>
      ) : verdict.thin.length > 0 ? (
        <Alert
          tone="warning"
          title={`${String(verdict.thin.length)} required skill${
            verdict.thin.length === 1 ? ' is' : 's are'
          } thin`}
        >
          <p>
            An assessment can be composed, but with this few questions two candidates will see
            largely the same ones — which makes comparing them weaker than it looks.{' '}
            {verdict.thin.map((skill) => skill.skill_name).join(', ')}.
          </p>
        </Alert>
      ) : (
        <Alert tone="success" title="The bank can measure every required skill">
          <p>
            Every required skill has published questions inside the difficulty band this role asks
            for.
          </p>
        </Alert>
      )}

      <Table caption={`Skill coverage for ${role.title}`} captionHidden className="ab-roles__table">
        <thead>
          <tr>
            <th scope="col">Skill</th>
            <th scope="col">Requirement</th>
            <th scope="col" className="ab-table__numeric">
              Weight
            </th>
            <th scope="col" className="ab-table__numeric">
              In band
            </th>
            {LEVELS.map((level) => (
              <th key={level} scope="col" className="ab-table__numeric">
                {/* The heading is a number, so it needs a word for anyone who arrives at the
                    column without having read the one beside it. */}
                <span className="ab-visually-hidden">Difficulty </span>
                {level}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {coverage.skills.map((skill) => (
            <SkillRow key={skill.skill_id} skill={skill} />
          ))}
        </tbody>
      </Table>
    </section>
  );
}

/** The roles screen. */
export function RolesScreen(): ReactNode {
  const api = useApi();
  const query = useQuery(rolesQuery(api));
  const roles = query.data?.data ?? [];

  return (
    <div className="ab-screen">
      <PageBar crumbs={[{ label: 'Hiring' }, { label: 'Roles' }]}>
        <Button tone="primary" disabled>
          New role
        </Button>
      </PageBar>

      <header className="ab-screen__header">
        <h1 className="ab-screen__title" id="page-heading" tabIndex={-1}>
          Roles
        </h1>
        <p className="ab-screen__lede">
          What you are hiring for, and whether the question bank can measure it. A role is a set of
          skills with a weight and a difficulty band; an assessment is composed from those rather
          than assembled by hand.
        </p>
      </header>

      {query.isError ? (
        <Alert tone="danger" title="Roles could not be loaded" live="assertive">
          <p>{toDisplayEnvelope(query.error).error.message}</p>
          <p className="ab-screen__error-actions">
            <Button
              onClick={() => {
                void query.refetch();
              }}
            >
              Try again
            </Button>
          </p>
        </Alert>
      ) : null}

      {query.isPending ? (
        <div className="ab-roles__loading" aria-busy="true" aria-label="Loading roles">
          <Skeleton height="1.5rem" width="18rem" />
          <Skeleton height="4rem" />
          <Skeleton height="4rem" />
        </div>
      ) : null}

      {!query.isPending && !query.isError && roles.length === 0 ? (
        <EmptyState
          reason="empty"
          title="No roles yet"
          action={
            <Button tone="primary" disabled>
              New role
            </Button>
          }
        >
          A role names the skills a job needs, each with a weight and a difficulty band. It is what
          an assessment is composed from, and what the bank is measured against — so this is the
          first thing to define, before any question is written.
        </EmptyState>
      ) : null}

      {roles.map((role) => (
        <RoleCoverage key={role.id} role={role} />
      ))}
    </div>
  );
}
