/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Node, not jsdom. jsdom is not on the ADR-001 approved dependency list, so component
// tests render with `react-dom/server` and assert on the accessible markup — the
// landmarks, the bypass block's position in DOM order, the aria wiring — and the router
// is asserted against its own route table with a memory history.
//
// The half those tests cannot reach — activating the skip link, tabbing the shell, running
// axe against a rendered route — is the `@axe-core/playwright` end-to-end suite of
// docs/15 §15.1, which needs a real browser to mean anything. If jsdom is later approved,
// this becomes environment: 'jsdom'.

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@assaybank/web',
    root: import.meta.dirname,
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'test/**/*.test.ts', 'test/**/*.test.tsx'],
  },
});
