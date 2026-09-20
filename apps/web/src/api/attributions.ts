/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** What the bank owes credit for — `GET /questions/attributions` (`H-032`, docs/05 §2). */

import {
  AttributionListResponseSchema,
  QUESTIONS_ATTRIBUTIONS_PATH,
  type AttributionListResponse,
  type AttributionView,
} from '@assaybank/contracts';
import { queryOptions } from '@tanstack/react-query';

import { type ApiClient } from './client.js';

export type { AttributionView };

export function attributionsQuery(client: ApiClient) {
  return queryOptions<AttributionListResponse>({
    queryKey: ['questions', 'attributions'],
    queryFn: ({ signal }) =>
      client.request(QUESTIONS_ATTRIBUTIONS_PATH, {
        schema: AttributionListResponseSchema,
        signal,
      }),
    // It changes on import and on publish, neither of which is frequent, and it is read
    // rarely. A minute keeps it honest without a request per visit.
    staleTime: 60_000,
  });
}

/**
 * Whether a licence obliges us to credit it visibly.
 *
 * Every row here is non-proprietary — the server excludes in-house content — but the
 * obligations differ in kind, and a page that treated them as one would either overstate MIT
 * or understate CC-BY. CC-BY requires attribution in any reasonable manner, which docs/05 §2
 * reads as this page plus the credit in every export; MIT and Apache-2.0 require the notice to
 * travel with the copy, which the export does and this page reports.
 */
export function obligationOf(licence: string): string {
  if (licence.toUpperCase().startsWith('CC-BY')) {
    return 'Credit required wherever the content appears. This page is that credit, and every export carries it per item.';
  }
  if (licence.toUpperCase().startsWith('APACHE')) {
    return 'The notice travels with the copy. Preserved in every export.';
  }
  return 'The copyright notice travels with the copy. Preserved in every export.';
}
