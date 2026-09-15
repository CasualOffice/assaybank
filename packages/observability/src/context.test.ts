/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';

import { currentContext, type RequestContext, withContext } from './context.js';

const ctx: RequestContext = {
  traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
  orgId: 'org_9f2b' as RequestContext['orgId'],
  userId: 'usr_221',
};

describe('withContext / currentContext', () => {
  it('is undefined outside a request, which callers must treat as normal', () => {
    expect(currentContext()).toBeUndefined();
  });

  it('exposes the context to everything the handler calls, however deep', () => {
    function deep(): RequestContext | undefined {
      return (() => currentContext())();
    }

    const seen = withContext(ctx, deep);
    expect(seen).toEqual(ctx);
  });

  it('returns what the function returns', () => {
    expect(withContext(ctx, () => 7)).toBe(7);
  });

  it('survives an await boundary', async () => {
    const seen = await withContext(ctx, async () => {
      await Promise.resolve();
      return currentContext()?.traceId;
    });
    expect(seen).toBe(ctx.traceId);
  });

  it('does not leak out of the call', () => {
    withContext(ctx, () => currentContext());
    expect(currentContext()).toBeUndefined();
  });

  it('nests, so a worker can re-root a job under its own trace', () => {
    const inner: RequestContext = { traceId: '0af7651916cd43dd8448eb211c80319c' };
    const seen = withContext(ctx, () => withContext(inner, () => currentContext()?.traceId));
    expect(seen).toBe(inner.traceId);
  });
});
