/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Node, not jsdom. jsdom is not on the ADR-001 approved dependency list, so component
// tests render with `react-dom/server` and assert on the accessible markup — the label
// associations, the aria-describedby targets, the roles and the DOM order that focus
// order follows. See src/test-support/markup.ts for what that can and cannot claim.
//
// The half those tests cannot reach — activating the skip link, tabbing through the
// shell, running axe — is the end-to-end suite of docs/15 §15.1, which needs a real
// browser to mean anything. If jsdom is later approved, this becomes
// environment: 'jsdom' and the markup helpers go away.

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@assaybank/ui',
    root: import.meta.dirname,
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'test/**/*.test.ts', 'test/**/*.test.tsx'],
  },
});
