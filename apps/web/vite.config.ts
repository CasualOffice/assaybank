/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The staff console's build.
//
// A separate build from apps/candidate, and that separation is the point (ADR-013): two
// applications means staff-only code, correct-answer handling and question-bank access
// cannot reach a candidate's browser through a bundler mistake. Nothing here may ever
// merge the two outputs.

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { port: 5173, strictPort: true },
  preview: { port: 5173, strictPort: true },
  build: { outDir: 'dist', sourcemap: true, emptyOutDir: true },
});
