/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';

import { domainError } from './errors.js';
import { err, isErr, isOk, mapResult, ok, unwrapOr, type Result } from './result.js';

describe('Result', () => {
  it('builds a success', () => {
    expect(ok(42)).toStrictEqual({ ok: true, value: 42 });
  });

  it('builds a failure', () => {
    const error = domainError('invalid_rule', 'nope');
    expect(err(error)).toStrictEqual({ ok: false, error });
  });

  it('narrows with isOk', () => {
    const result: Result<number, string> = ok(1);
    expect(isOk(result)).toBe(true);
    expect(isErr(result)).toBe(false);
    if (isOk(result)) {
      expect(result.value).toBe(1);
    }
  });

  it('narrows with isErr', () => {
    const result: Result<number, string> = err('boom');
    expect(isErr(result)).toBe(true);
    expect(isOk(result)).toBe(false);
    if (isErr(result)) {
      expect(result.error).toBe('boom');
    }
  });

  it('unwraps with a fallback', () => {
    expect(unwrapOr<number, string>(ok(7), 0)).toBe(7);
    expect(unwrapOr<number, string>(err('boom'), 0)).toBe(0);
  });

  it('maps a success and passes an error through', () => {
    expect(mapResult<number, number, string>(ok(2), (n) => n * 3)).toStrictEqual(ok(6));
    expect(mapResult<number, number, string>(err('boom'), (n) => n * 3)).toStrictEqual(err('boom'));
  });

  it('does not call the mapper on an error', () => {
    let called = false;
    mapResult<number, number, string>(err('boom'), (n) => {
      called = true;
      return n;
    });
    expect(called).toBe(false);
  });
});

describe('domainError', () => {
  it('omits details entirely when none are given', () => {
    const error = domainError('illegal_transition', 'no');
    expect(error).toStrictEqual({ code: 'illegal_transition', message: 'no' });
    expect('details' in error).toBe(false);
  });

  it('carries details when given', () => {
    const error = domainError('draw_infeasible', 'no', { pickCount: 3 });
    expect(error.details).toStrictEqual({ pickCount: 3 });
  });
});
