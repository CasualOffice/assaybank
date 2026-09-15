/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';

import { histogram, MetricCardinalityError } from '@assaybank/observability';

import {
  httpRequestDuration,
  httpRequestsTotal,
  routeClassOf,
  statusClassOf,
  UNMATCHED_ROUTE_CLASS,
} from './http-metrics.js';

describe('routeClassOf', () => {
  it('rewrites Fastify parameters into the documented template form', () => {
    expect(routeClassOf('/attempts/:id/answers')).toBe('/attempts/{id}/answers');
    expect(routeClassOf('/questions/:questionId/versions/:versionId')).toBe(
      '/questions/{questionId}/versions/{versionId}',
    );
  });

  it('rewrites a wildcard rather than leaving a bare star', () => {
    expect(routeClassOf('/files/*')).toBe('/files/{wildcard}');
  });

  it('folds an unmatched request to a constant', () => {
    // A scanner probing a thousand paths must not mint a thousand series (docs/12 §6).
    expect(routeClassOf(undefined)).toBe(UNMATCHED_ROUTE_CLASS);
    expect(routeClassOf('')).toBe(UNMATCHED_ROUTE_CLASS);
  });
});

describe('statusClassOf', () => {
  it('buckets a status into its class', () => {
    expect(statusClassOf(200)).toBe('2xx');
    expect(statusClassOf(204)).toBe('2xx');
    expect(statusClassOf(404)).toBe('4xx');
    expect(statusClassOf(503)).toBe('5xx');
  });

  it('treats anything outside 1xx–5xx as a server fault rather than a new series', () => {
    expect(statusClassOf(0)).toBe('5xx');
    expect(statusClassOf(999)).toBe('5xx');
  });
});

describe('metric declarations', () => {
  it('uses base-unit names', () => {
    expect(httpRequestDuration.name).toBe('http_request_duration_seconds');
    expect(httpRequestsTotal.name).toBe('http_requests_total');
  });

  it('could not have been labelled by the resolved path', () => {
    // The obvious wrong choice — one series per URL — is rejected at construction, which
    // is boot time and therefore a failed deploy rather than an outage of the tool you
    // diagnose outages with (docs/12 §6). Declaring `route_class` instead is not a
    // stylistic preference; the literal name `route` does not compile past this guard.
    for (const forbidden of ['route', 'path', 'url', 'attempt_id', 'org_id']) {
      expect(() => {
        histogram({
          name: 'unregistered_probe_seconds',
          help: 'never registered — the guard throws first.',
          labelNames: [forbidden],
        });
      }).toThrow(MetricCardinalityError);
    }
  });
});
