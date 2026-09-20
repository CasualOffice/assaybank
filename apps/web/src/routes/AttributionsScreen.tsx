/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Where the bank's content came from (`H-032`, docs/05 §2).
 *
 * ## This page is a legal obligation, not a report
 *
 * CC-BY-4.0 requires attribution "in any reasonable manner". docs/05 §2 decides what that means
 * for a hiring platform: an attributions page in the recruiter console, and the credit preserved
 * in every export. The export half has existed since the interchange formats were built. This is
 * the other half, and it is the reason `H-032` names it rather than leaving it to a later tidy-up
 * — an import that creates the obligation and not the page creates only the obligation.
 *
 * It deliberately does not require permission to export. Gating the record of what we owe behind
 * the ability to download the bank would hide it from most of the people who need to know.
 *
 * ## The second column is the one that matters over time
 *
 * docs/05 §2 is blunt: every importable dataset was built to benchmark language models, so every
 * one is in the training data of whatever a candidate might use — MBPP's measured contamination
 * is above 60%. Imported content is fine for filtering non-programmers and close to worthless
 * above that, and the target is that it becomes the minority of the *published* bank by month
 * six. That is a number somebody has to be able to see, so it is on the page rather than in the
 * document nobody reads.
 */

import { Alert, Button, EmptyState, Skeleton, Table } from '@assaybank/ui';
import { useQuery } from '@tanstack/react-query';
import { type ReactNode } from 'react';

import { useApi } from '../api/api.js';
import { attributionsQuery, obligationOf } from '../api/attributions.js';
import { toDisplayEnvelope } from '../app/ErrorBoundary.js';
import { PageBar } from '../app/PageBar.js';

export function AttributionsScreen(): ReactNode {
  const api = useApi();
  const query = useQuery(attributionsQuery(api));
  const rows = query.data?.data ?? [];
  const publishedFromSources = rows.reduce((total, row) => total + row.published, 0);

  return (
    <div className="ab-screen">
      <PageBar crumbs={[{ label: 'Question bank' }, { label: 'Attributions' }]} />

      <header className="ab-screen__header">
        <h1 className="ab-screen__title" id="page-heading" tabIndex={-1}>
          Attributions
        </h1>
        <p className="ab-screen__lede">
          Questions imported from a public dataset keep their licence, and several of those licences
          require credit. This page is that credit; every export carries the same information per
          question.
        </p>
      </header>

      {query.isError ? (
        <Alert tone="danger" title="Attributions could not be loaded" live="assertive">
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
        <div className="ab-roles__loading" aria-busy="true" aria-label="Loading attributions">
          <Skeleton height="1.5rem" width="16rem" />
          <Skeleton height="5rem" />
        </div>
      ) : null}

      {!query.isPending && !query.isError && rows.length === 0 ? (
        <EmptyState reason="empty" title="Nothing to credit">
          Every question in this bank was written in-house, so no third-party licence applies.
          Importing from a public dataset adds a row here automatically, and the licence travels
          with each question into every export.
        </EmptyState>
      ) : null}

      {rows.length > 0 ? (
        <>
          <Table
            caption="Licences this bank holds content under"
            captionHidden
            className="ab-attributions__table"
          >
            <thead>
              <tr>
                <th scope="col">Licence</th>
                <th scope="col">Source</th>
                <th scope="col" className="ab-table__numeric">
                  Questions
                </th>
                <th scope="col" className="ab-table__numeric">
                  Published
                </th>
                <th scope="col">Obligation</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={`${row.source_license}:${row.dataset ?? ''}`}>
                  <th scope="row" className="ab-attributions__licence">
                    {row.source_license}
                  </th>
                  <td>
                    {row.dataset === null ? (
                      <span className="ab-questions__none">No source recorded</span>
                    ) : (
                      <code className="ab-roles__key">{row.dataset}</code>
                    )}
                  </td>
                  <td className="ab-table__numeric">{row.questions}</td>
                  <td className="ab-table__numeric">{row.published}</td>
                  <td className="ab-attributions__obligation">
                    {obligationOf(row.source_license)}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>

          {publishedFromSources > 0 ? (
            <Alert tone="info" title="Imported content is for screening, not for senior roles">
              <p>
                {publishedFromSources} published question
                {publishedFromSources === 1 ? '' : 's'} came from a public dataset. Every one of
                those datasets was built to benchmark language models, so all of them are in the
                training data of whatever a candidate might be using — useful for filtering
                non-programmers, close to worthless above that. Questions written in-house should be
                the majority of a published bank.
              </p>
            </Alert>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
