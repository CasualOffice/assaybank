/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Build configuration for the candidate bundle (ADR-013).
 *
 * This is the file that decides what a candidate's browser receives, so two settings
 * below are security decisions rather than preferences and are annotated as such.
 */

import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv, type Plugin } from 'vite';

import { contentSecurityPolicy, type CspOptions } from './src/csp.js';

/**
 * Injects the Content-Security-Policy into the page as a `<meta http-equiv>`.
 *
 * In the page rather than only in a response header so that the policy travels with the
 * bundle: it applies in `vite dev`, in `vite preview`, behind any static host, and in
 * production, and cannot be lost by a proxy nobody configured. `infra/caddy/Caddyfile`
 * adds the header form for `frame-ancestors`, which a meta tag cannot express.
 */
function contentSecurityPolicyTag(options: CspOptions): Plugin {
  return {
    name: 'assaybank:csp',
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        return {
          html,
          tags: [
            {
              tag: 'meta',
              attrs: {
                'http-equiv': 'Content-Security-Policy',
                content: contentSecurityPolicy(options),
              },
              injectTo: 'head-prepend',
            },
          ],
        };
      },
    },
  };
}

export default defineConfig(({ mode }) => {
  // Vite's loader rather than `process.env`, which docs/17 §12 keeps inside
  // `packages/config`. The candidate app is served from its own hostname and talks to the
  // API on another, so unlike the console this value is normally set in a deployed tier.
  const env = loadEnv(mode, import.meta.dirname, '');

  return {
    plugins: [
      react(),
      contentSecurityPolicyTag({
        dev: mode !== 'production',
        apiOrigin: env['VITE_API_PUBLIC_URL'],
        collabOrigin: env['VITE_COLLAB_PUBLIC_URL'],
      }),
    ],
    // :5174 in development, :3001 in production, on an origin separate from apps/web.
    // Separate origins are part of the decision: the staff console and the candidate
    // runner do not share a document, a storage partition or a service worker scope.
    server: { port: 5174, strictPort: true },
    preview: { port: 5174, strictPort: true },
    build: {
      outDir: 'dist',
      emptyOutDir: true,
      /*
       * No source maps in the candidate bundle.
       *
       * A source map republishes the original TypeScript — identifiers, comments, file
       * layout, everything a reviewer wrote about why a thing is the way it is — to anyone
       * who opens devtools on an internet-facing origin. That is a larger disclosure than
       * the minified bundle it maps, and it is one `curl` away whether or not the browser
       * asks for it.
       *
       * The staff console can afford maps; it sits behind a session. This one does not.
       * Production debugging here uses the trace id in the error envelope (P0 step 4),
       * which resolves a support ticket to a server-side trace without shipping the
       * client's source to the person who filed it.
       */
      sourcemap: false,
    },
  };
});
