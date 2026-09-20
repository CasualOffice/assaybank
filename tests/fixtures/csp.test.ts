/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What both Content-Security-Policies must be true of, whatever else they say (T-038).
 *
 * The two apps own their own policies, because the candidate runner needs a WebSocket and
 * camera capture that the console must never have, and a single function taking flags to
 * express two different threat models would hide that rather than state it. What is shared is
 * the floor, and the floor is asserted here once instead of twice.
 *
 * The production/development split gets its own attention. Vite's dev server injects an
 * inline script preamble, so development must allow `'unsafe-inline'` — and the only thing
 * standing between that and a production build carrying the same relaxation is this file.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { cspDirectives as candidateDirectives } from '../../apps/candidate/src/csp.js';
import { cspDirectives as webDirectives } from '../../apps/web/src/csp.js';

const ROOT = resolve(import.meta.dirname, '../..');

const APPS = [
  { name: 'staff console', directives: webDirectives },
  { name: 'candidate runner', directives: candidateDirectives },
] as const;

describe.each(APPS)('$name', ({ directives }) => {
  const production = directives({ dev: false });
  const development = directives({ dev: true });

  it('starts from default-src none, so a new fetch destination is denied by default', () => {
    // The alternative, `default-src 'self'`, silently permits whatever resource type the
    // platform adds next — which is how a policy ends up allowing something nobody chose.
    expect(production['default-src']).toEqual(["'none'"]);
  });

  it('allows no inline or eval script in production', () => {
    expect(production['script-src']).toEqual(["'self'"]);
    expect(production['script-src']).not.toContain("'unsafe-inline'");
    expect(production['script-src']).not.toContain("'unsafe-eval'");
  });

  it('allows no inline style in production, and no style attribute in either', () => {
    expect(production['style-src']).toEqual(["'self'"]);
    // Separate from `style-src` on purpose: permitting an inline `style` attribute later
    // must not require reopening `<style>` blocks and stylesheet injection with it.
    expect(production['style-src-attr']).toEqual(["'none'"]);
    expect(development['style-src-attr']).toEqual(["'none'"]);
  });

  it('forbids plugins and forbids rewriting the page base', () => {
    // A `<base>` tag injected into the page turns every relative URL on it — every link,
    // every form, every asset — into somebody else's.
    expect(production['object-src']).toEqual(["'none'"]);
    expect(production['base-uri']).toEqual(["'none'"]);
  });

  it('differs from development in exactly four directives, each for a stated reason', () => {
    const names = new Set([...Object.keys(production), ...Object.keys(development)]);
    const differing = [...names].filter(
      (name) => JSON.stringify(production[name]) !== JSON.stringify(development[name]),
    );

    // Pinned as a list rather than as a rule, because the point is that somebody has to
    // come here and say why when it grows. `script-src` and `style-src` are Vite's inline
    // preamble and dev styles; `connect-src` is the HMR WebSocket; and
    // `upgrade-insecure-requests` is the one that runs the other way — production is
    // stricter than development, because a dev server is plain http on localhost.
    expect(differing.sort()).toEqual([
      'connect-src',
      'script-src',
      'style-src',
      'upgrade-insecure-requests',
    ]);
    expect(development['upgrade-insecure-requests']).toBeUndefined();
  });

  it('never carries frame-ancestors, which a meta tag cannot enforce', () => {
    // A browser ignores `frame-ancestors` in a `<meta http-equiv>` and warns. Shipping it
    // there would be a clickjacking defence that looks enforced and is not; the real one
    // is the header in infra/caddy/Caddyfile.
    expect(production['frame-ancestors']).toBeUndefined();
  });
});

describe('the built pages carry the policy', () => {
  // The source of truth above is only worth something if it reaches the HTML. These read
  // the committed `index.html` templates to confirm neither app hand-writes a competing
  // policy that the plugin would then duplicate.
  it.each(['apps/web/index.html', 'apps/candidate/index.html'])(
    '%s declares no policy of its own — the build injects it',
    (file) => {
      expect(readFileSync(resolve(ROOT, file), 'utf8')).not.toContain('Content-Security-Policy');
    },
  );
});

describe('the reverse proxy adds what a meta tag cannot', () => {
  const caddyfile = readFileSync(resolve(ROOT, 'infra/caddy/Caddyfile'), 'utf8');

  it('sets frame-ancestors none for both front ends', () => {
    expect(caddyfile).toContain('Content-Security-Policy "frame-ancestors \'none\'"');
  });
});
