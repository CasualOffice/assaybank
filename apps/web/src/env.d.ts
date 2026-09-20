/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The build-time environment this bundle may read.
 *
 * Declared here rather than by referencing `vite/client`, so the set is closed: every
 * variable the console can read is listed in one place, and `import.meta.env.VITE_ANYTHING`
 * is a type error rather than `undefined` at runtime in production.
 *
 * Only `VITE_`-prefixed values reach the bundle — Vite's rule, and a good one: a variable
 * without the prefix cannot be leaked into client JavaScript by a typo. Nothing secret
 * belongs here regardless; this bundle is public (docs/14 §5.5).
 */

interface ImportMetaEnv {
  /** Where the API is, when it is not same-origin. Development uses Vite's proxy instead. */
  readonly VITE_API_BASE_URL?: string;
  readonly DEV: boolean;
  readonly PROD: boolean;
  readonly MODE: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
