/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import * as ui from './index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(HERE, '..');

describe('@assaybank/ui', () => {
  it('names itself with the workspace name declared in package.json', () => {
    expect(ui.WORKSPACE_NAME).toBe('@assaybank/ui');
  });

  it('exports the accessibility baseline every screen from P2 inherits', () => {
    // These four are the baseline named in P0 step 11: a skip link, a live-region
    // provider for announcements, the visually-hidden primitive that keeps information
    // out of colour alone, and the tokens the focus ring and the contrast rest on.
    expect(ui.SkipLink).toBeTypeOf('function');
    expect(ui.LiveRegionProvider).toBeTypeOf('function');
    expect(ui.useAnnounce).toBeTypeOf('function');
    expect(ui.VisuallyHidden).toBeTypeOf('function');
    expect(ui.SEMANTIC_TOKENS.length).toBeGreaterThan(0);
  });

  it('exports every component the design system claims to have', () => {
    for (const name of ['Alert', 'Button', 'Field', 'Input', 'Skeleton'] as const) {
      expect(ui[name], `${name} is missing from the public surface`).toBeTypeOf('function');
    }
  });

  it('publishes the stylesheets as subpath exports, since CSS does not survive tsc', () => {
    const manifest: unknown = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'));
    const exportsField = (manifest as { exports?: Record<string, unknown> }).exports ?? {};

    // A component library whose stylesheet cannot be imported renders unstyled, and an
    // unstyled control is a control with no contrast guarantee at all.
    expect(exportsField['./styles.css']).toBe('./src/styles/index.css');
    expect(exportsField['./theme.css']).toBe('./src/styles/theme.css');
  });

  it('imports no workspace package that could drag server code into a bundle', () => {
    const manifest: unknown = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'));
    const dependencies = (manifest as { dependencies?: Record<string, string> }).dependencies ?? {};
    const workspaceDeps = Object.keys(dependencies).filter((name) =>
      name.startsWith('@assaybank/'),
    );

    // CODE-GRAPH L5: contracts (types only) and markdown (pure, no I/O, no dependency of
    // its own), and nothing else. The candidate bundle must be incapable of carrying bank
    // access or correct-answer logic whatever a future refactor does, and that is a
    // build-graph guarantee rather than a review habit.
    //
    // Adding a name to this list is a layering change: say why in CODE-GRAPH.md's L5 rule
    // and in eslint.config.js, which enforces the same thing on imports, before here.
    expect(workspaceDeps.sort()).toEqual(['@assaybank/contracts', '@assaybank/markdown']);
  });
});
