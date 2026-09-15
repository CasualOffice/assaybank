/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import * as auth from './index.js';

describe('@assaybank/auth', () => {
  it('names itself with the workspace name declared in package.json', () => {
    expect(auth.WORKSPACE_NAME).toBe('@assaybank/auth');
  });

  it('exposes the whole surface through src/index.ts and nothing through a submodule', () => {
    // docs/17 §2: a package exports through one file. Naming the surface here means a
    // symbol cannot quietly disappear from it during a refactor, which for this package
    // would mean a consumer reaching into `src/` and binding to an internal.
    for (const symbol of [
      'generateToken',
      'hashToken',
      'verifyToken',
      'issueAttemptToken',
      'verifyAttemptToken',
      'issueWsTicket',
      'verifyWsTicket',
      'can',
      'assertCan',
      'PERMISSIONS',
      'AuthError',
      'systemClock',
      'fixedClock',
    ]) {
      expect(auth).toHaveProperty(symbol);
    }
  });

  it('reads no wall clock: every expiry in this package comes from an injected Clock', () => {
    // ADR-006 makes the clock a correctness boundary. `systemClock` is the single
    // permitted reader, and a composition root passes it in; anything else calling
    // Date.now() would make an expiry path that cannot be tested deterministically.
    const sources = [
      'attempt-token.ts',
      'ws-ticket.ts',
      'token.ts',
      'permissions.ts',
      'envelope.ts',
      'crypto.ts',
      'errors.ts',
      'index.ts',
    ];

    for (const name of sources) {
      const source = readFileSync(fileURLToPath(new URL(name, import.meta.url)), 'utf8');
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

      expect(code, `${name} must not read the wall clock`).not.toMatch(/Date\.now\(\)/);
      expect(code, `${name} must not construct a bare new Date()`).not.toMatch(/new Date\(\s*\)/);
    }
  });
});
