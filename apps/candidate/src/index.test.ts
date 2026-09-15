/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Workspace-level assertions about the shape of this bundle.
 *
 * ADR-013's guarantee is that "can a candidate see this?" has a mechanical answer —
 * inspect `apps/candidate`'s dependency closure — rather than being a judgement call.
 * This file makes that inspection a test rather than a review habit. It is the cheapest
 * of the three enforcement layers and the earliest to fail: a forbidden dependency is
 * caught the moment it is declared, before anyone has to build a bundle to find it.
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { CANDIDATE_ROUTE_PATHS, WORKSPACE_NAME } from './index';

interface PackageManifest {
  readonly name?: string;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
}

function manifest(): PackageManifest {
  const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
  return JSON.parse(raw) as PackageManifest;
}

/** The only internal packages a candidate bundle may link (CODE-GRAPH L5). */
const PERMITTED_INTERNAL_DEPENDENCIES = new Set(['@assaybank/contracts', '@assaybank/ui']);

describe('@assaybank/candidate', () => {
  it('names itself with the workspace name declared in package.json', () => {
    expect(WORKSPACE_NAME).toBe('@assaybank/candidate');
    expect(manifest().name).toBe(WORKSPACE_NAME);
  });
});

describe('the dependency closure (ADR-013)', () => {
  it('declares only contracts and ui as internal dependencies', () => {
    const pkg = manifest();
    const internal = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).filter((name) =>
      name.startsWith('@assaybank/'),
    );

    // db, auth, core-domain, grading and exec-adapter are the five packages that know
    // how to reach the bank, mint a token, resolve a draw, score an answer or execute
    // code. None of them may be in this graph — not gated, not lazy, absent.
    for (const name of internal) {
      expect(PERMITTED_INTERNAL_DEPENDENCIES.has(name), `${name} must not be a dependency`).toBe(
        true,
      );
    }
    expect(internal).toHaveLength(2);
  });

  it('wires the bundle content check to a package script', () => {
    const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
    const scripts = (JSON.parse(raw) as { scripts?: Record<string, string> }).scripts ?? {};

    // The check must run as part of the build, not as a thing somebody remembers.
    expect(scripts['check:bundle']).toContain('check-bundle.mjs');
    expect(scripts['build']).toContain('check:bundle');
  });
});

describe('the route list', () => {
  it('is the four routes CODE-GRAPH records for this application, and no others', () => {
    // `/bank`, `/reports`, `/admin` and `/candidates` live in apps/web, in a different
    // bundle on a different origin. Adding a fifth route here is an ADR-013 decision.
    expect([...CANDIDATE_ROUTE_PATHS]).toEqual(['/', '/t/$token', '/attempt', '/join/$roomCode']);
  });
});
