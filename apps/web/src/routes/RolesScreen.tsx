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
  type CoverageVerdict,
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
      <td className="ab-roles__requirement">
        {/* Quiet on both. A badge on every required row is a column of identical chips that
            the eye has to read past to reach the numbers, and "required" is the norm for a
            role's skills rather than the exception. The word carries it. */}
        {skill.is_required ? 'Required' : <span className="ab-roles__optional">Optional</span>}
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

/** The verdict as one line, tone as a rule down the edge. Shared shape with the dashboard. */
function RoleVerdictBand({ verdict }: { verdict: CoverageVerdict }): ReactNode {
  const blocked = verdict.blocked.length;
  const thin = verdict.thin.length;

  const [tone, label, title, text] =
    blocked > 0
      ? ([
          'danger',
          'Blocked',
          `${String(blocked)} required skill${blocked === 1 ? ' has' : 's have'} nothing published in band`,
          `No assessment can be composed until each has at least one: ${verdict.blocked
            .map((skill) => skill.skill_name)
            .join(', ')}.`,
        ] as const)
      : thin > 0
        ? ([
            'warning',
            'Thin',
            `${String(thin)} required skill${thin === 1 ? ' is' : 's are'} thin`,
            `Composable, but two candidates would see largely the same paper: ${verdict.thin
              .map((skill) => skill.skill_name)
              .join(', ')}.`,
          ] as const)
        : ([
            'success',
            'Ready',
            'The bank can measure every required skill',
            'Each one has published questions inside the difficulty band this role asks for.',
          ] as const);

  return (
    <section className={`ab-guide ab-guide--${tone}`} role="status">
      <p className="ab-guide__label">{label}</p>
      <div className="ab-guide__body">
        <h3 className="ab-guide__title">{title}</h3>
        <p className="ab-guide__text">{text}</p>
      </div>
    </section>
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
        {/* The action the verdict implies, and only that one.
         *
         * "Compose an assessment" was a disabled button and a promise for two days. It is a
         * link now, and it stays absent rather than disabled for a role the bank cannot fill:
         * offering it there would be offering a screen whose only outcome is a refusal. */}
        <div className="ab-roles__role-actions">
          {verdict.ready ? (
            <Link
              className="ab-button ab-button--primary"
              to="/roles/$roleId/compose"
              params={{ roleId: role.id }}
            >
              Compose an assessment
            </Link>
          ) : (
            <Link className="ab-button ab-button--secondary" to="/questions">
              Add questions
            </Link>
          )}
        </div>
      </header>

      {/* The same band the dashboard uses, not an `Alert`.
       *
       * Three roles meant three slabs — an amber one and a red one labelled "WARNING" and
       * "ERROR" — around 330px of shouting before any data. None of these is an error: they
       * are the system reporting, correctly, what the bank can measure. The table underneath
       * is the evidence and it is what the screen is for, so the verdict gets one line. */}
      <RoleVerdictBand verdict={verdict} />

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
