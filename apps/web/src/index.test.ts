/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { WORKSPACE_NAME } from './index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = join(HERE, '..');

const ENTRY = readFileSync(join(HERE, 'main.tsx'), 'utf8');
const INDEX_HTML = readFileSync(join(APP_ROOT, 'index.html'), 'utf8');

describe('@assaybank/web', () => {
  it('names itself with the workspace name declared in package.json', () => {
    expect(WORKSPACE_NAME).toBe('@assaybank/web');
  });
});

/**
 * The accessibility baseline is partly an *ordering* property of the entry point, and an
 * ordering property is not visible in any single component's test.
 *
 * These read the entry source rather than rendering it, which is unusual and is the honest
 * tool for the job: what has to be true is that `LiveRegionProvider` wraps the router
 * rather than sitting inside a screen. Rendering would prove it for one screen; reading the
 * one file that decides it proves it for all of them.
 */
describe('the entry point wires the baseline', () => {
  it('mounts the live regions above the router, not inside a screen', () => {
    const provider = ENTRY.indexOf('<LiveRegionProvider>');
    const routerProvider = ENTRY.indexOf('<RouterProvider');

    // docs/15 §5.1: a region added to the DOM at the moment its content changes is
    // frequently not announced at all, so the regions must exist and be empty before the
    // first screen renders.
    expect(provider).toBeGreaterThan(-1);
    expect(routerProvider).toBeGreaterThan(provider);
  });

  it('wraps everything in the root error boundary', () => {
    const boundary = ENTRY.indexOf('<RootErrorBoundary');
    const provider = ENTRY.indexOf('<LiveRegionProvider>');

    expect(boundary).toBeGreaterThan(-1);
    expect(provider).toBeGreaterThan(boundary);
  });

  it('imports the design system stylesheet, without which no control has a contrast guarantee', () => {
    expect(ENTRY).toContain("import '@assaybank/ui/styles.css'");
  });

  it('renders under StrictMode, so a double-invoked effect surfaces in development', () => {
    expect(ENTRY).toContain('<StrictMode>');
  });

  it('builds the query client per application rather than importing a singleton', () => {
    // A cache that outlives a sign-out is a cache that can show one user another user's
    // data, so P1 discards the client on a session change rather than pruning it.
    expect(ENTRY).toContain('createQueryClient()');
  });
});

describe('index.html', () => {
  it('declares the document language, which decides the screen reader’s voice', () => {
    expect(INDEX_HTML).toContain('<html lang="en">');
  });

  it('allows zoom rather than locking the viewport scale', () => {
    // SC 1.4.4 Resize Text: `user-scalable=no` or a `maximum-scale` is the one line that
    // makes a page fail it on every mobile browser at once.
    expect(INDEX_HTML).toContain('width=device-width, initial-scale=1');
    expect(INDEX_HTML).not.toContain('user-scalable=no');
    expect(INDEX_HTML).not.toContain('maximum-scale');
  });

  it('declares both colour schemes, so the browser does not flash a white canvas', () => {
    expect(INDEX_HTML).toContain('content="light dark"');
  });

  it('says something useful when scripts are blocked', () => {
    expect(INDEX_HTML).toContain('<noscript>');
  });
});
