/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Test configuration for the candidate bundle.
 *
 * `environment: 'node'` is deliberate, not a gap. jsdom, happy-dom and
 * `@testing-library/react` are all absent from the approved dependency list in ADR-001,
 * and adding one is a licence decision rather than a test-harness convenience.
 *
 * That constraint turned out to be a useful design pressure. The components in this
 * workspace are pure and synchronous, so they render under `react-dom/server` in plain
 * Node, and everything stateful — the countdown clock, the connection state machine, the
 * announcement queue — is a framework-free class that needs no renderer at all. The
 * result is that the ADR-006 invariant ("the client clock is display only") is verified
 * by a test that does not depend on a DOM implementation's clock behaviour, which is a
 * stronger test than the one a jsdom harness would have produced.
 *
 * Behaviour that genuinely needs a browser — focus order, the skip link becoming visible
 * on focus, axe — belongs in the Playwright suite from P0 step 12, not here.
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@assaybank/candidate',
    root: import.meta.dirname,
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'test/**/*.test.ts', 'test/**/*.test.tsx'],
  },
});
