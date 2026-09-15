/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { context } from '@opentelemetry/api';
import { describe, expect, it } from 'vitest';

import {
  activeTraceId,
  extractTraceContext,
  injectTraceContext,
  OTEL_CARRIER_KEY,
  runInJobSpan,
} from './trace-context.js';

const TRACEPARENT = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';

describe('extractTraceContext', () => {
  it('reports a missing carrier rather than throwing', () => {
    // A job with no `_otel` is processed normally. The metric — not an exception — is
    // what makes the broken trace visible (docs/12 §5.2 rule 3).
    const extracted = extractTraceContext({ submission_id: 's1' });
    expect(extracted.present).toBe(false);
    expect(extracted.context).toBeDefined();
  });

  it('reports a present carrier', () => {
    const extracted = extractTraceContext({
      submission_id: 's1',
      [OTEL_CARRIER_KEY]: { traceparent: TRACEPARENT },
    });
    expect(extracted.present).toBe(true);
  });

  it('accepts a tracestate alongside the traceparent', () => {
    const extracted = extractTraceContext({
      [OTEL_CARRIER_KEY]: { traceparent: TRACEPARENT, tracestate: 'vendor=value' },
    });
    expect(extracted.present).toBe(true);
  });

  it('treats a malformed carrier exactly like a missing one', () => {
    for (const carrier of [{}, { traceparent: '' }, { traceparent: 42 }, 'not an object', null]) {
      expect(extractTraceContext({ [OTEL_CARRIER_KEY]: carrier }).present).toBe(false);
    }
  });

  it('treats a payload that is not an object as a missing carrier', () => {
    expect(extractTraceContext(undefined).present).toBe(false);
    expect(extractTraceContext('a string').present).toBe(false);
    expect(extractTraceContext(7).present).toBe(false);
  });

  it('rejects a vendor propagation format, because W3C is the only one', () => {
    expect(extractTraceContext({ [OTEL_CARRIER_KEY]: { 'x-b3-traceid': 'abc' } }).present).toBe(
      false,
    );
  });
});

describe('injectTraceContext', () => {
  it('leaves the payload alone when nothing is recording', () => {
    // With no SDK registered the global propagator is a no-op. An empty `_otel` would be
    // indistinguishable from a broken one at the consumer, so nothing is added.
    const payload = { submission_id: 's1' };
    expect(injectTraceContext(payload)).toEqual(payload);
  });

  it('does not mutate the payload it is given', () => {
    const payload = { submission_id: 's1' };
    injectTraceContext(payload);
    expect(Object.keys(payload)).toEqual(['submission_id']);
  });
});

describe('runInJobSpan', () => {
  it('returns the handler’s result', async () => {
    const result = await runInJobSpan(
      context.active(),
      { queue: 'maintenance.cron', jobName: 'example.noop', jobId: 'j1', attempt: 1 },
      () => Promise.resolve('done'),
    );
    expect(result).toBe('done');
  });

  it('propagates a throw, so the retry and dead-letter path still sees it', async () => {
    await expect(
      runInJobSpan(
        context.active(),
        { queue: 'grading.submit', jobName: 'grade', jobId: 'j1', attempt: 3 },
        () => Promise.reject(new Error('boom')),
      ),
    ).rejects.toThrow('boom');
  });
});

describe('activeTraceId', () => {
  it('is undefined outside a recording span, and never the all-zero sentinel', () => {
    const traceId = activeTraceId();
    expect(traceId === undefined || /^[0-9a-f]{32}$/u.test(traceId)).toBe(true);
    expect(traceId).not.toBe('00000000000000000000000000000000');
  });
});
