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
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
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
});
