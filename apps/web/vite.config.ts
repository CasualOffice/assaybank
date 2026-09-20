/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv, type Plugin } from 'vite';

import { contentSecurityPolicy, type CspOptions } from './src/csp.js';

// The staff console's build.
//
// A separate build from apps/candidate, and that separation is the point (ADR-013): two
// applications means staff-only code, correct-answer handling and question-bank access
// cannot reach a candidate's browser through a bundler mistake. Nothing here may ever
// merge the two outputs.

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
  // Vite's own loader, not `process.env`: docs/17 §12 keeps environment reading inside
  // `packages/config`, and this is the one file that legitimately needs a value before the
  // application exists to read one. `loadEnv` takes it from `.env.local`, which is ignored.
  const env = loadEnv(mode, import.meta.dirname, '');
  const devApiOrigin =
    env['VITE_DEV_API_ORIGIN'] ?? `http://localhost:${env['API_PORT'] ?? '8080'}`;

  return {
    plugins: [
      react(),
      tailwindcss(),
      // The console and the API are same-origin in every deployed tier, so the policy
      // needs no extra origin there; in development the proxy above makes that true too.
      contentSecurityPolicyTag({
        dev: mode !== 'production',
        apiOrigin: env['VITE_API_PUBLIC_URL'],
      }),
    ],
    server: {
      port: 5173,
      strictPort: true,
      // Development only. The console and the API are same-origin in every deployed
      // environment (docs/13), so the bundle asks for `/api/v1` and never learns an origin;
      // this proxy reproduces that during development without CORS, without credentialed
      // cross-origin requests, and without a second base URL to configure wrongly.
      proxy: {
        '/api': {
          target: devApiOrigin,
          changeOrigin: false,
        },
      },
    },
    // Preview serves the built bundle and needs the same hand-off to the API as dev, or the
    // one build anybody actually inspects before a release is the one that cannot load data.
    preview: {
      port: 5173,
      strictPort: true,
      proxy: {
        '/api': {
          target: devApiOrigin,
          changeOrigin: false,
        },
      },
    },
    build: { outDir: 'dist', sourcemap: true, emptyOutDir: true },
  };
});
