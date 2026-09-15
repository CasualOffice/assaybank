/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';

import { newTraceId, REQUEST_ID_PATTERN, requestIdFor } from './request-context.js';

describe('newTraceId', () => {
  it('produces a W3C-shaped trace id', () => {
    expect(newTraceId()).toMatch(/^[0-9a-f]{32}$/u);
  });

  it('does not repeat', () => {
    // Two requests sharing an id makes a support lookup return the wrong candidate's
    // trace, which is worse than having no id at all.
    const ids = new Set(Array.from({ length: 1000 }, () => newTraceId()));
    expect(ids.size).toBe(1000);
  });
});

describe('requestIdFor', () => {
  it('is the trace id behind the docs/12 §5.3 prefix', () => {
    const traceId = newTraceId();
    const requestId = requestIdFor(traceId);

    expect(requestId).toBe(`req_${traceId}`);
    expect(requestId).toMatch(REQUEST_ID_PATTERN);
  });
});
