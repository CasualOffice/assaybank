/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Test environments, built from `.env.example` rather than from a hand-written literal.
 *
 * Every test therefore starts from the file an engineer actually copies to `.env`. A
 * test that passes against a fixture and fails against the committed example is the
 * drift this package exists to make impossible.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Absolute path to the repository's committed example environment. */
export const ENV_EXAMPLE_PATH = resolve(import.meta.dirname, '../../../.env.example');

/**
 * Parses a `.env`-format file. Deliberately minimal — `.env.example` is committed and
 * is plain `KEY=value`, and a parser that accepts more than the format would hide a
 * malformed line rather than report it.
 */
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) throw new Error(`.env line is not KEY=value: ${line}`);
    out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
}

/** The committed example environment, as a plain record. */
export function readEnvExample(): Record<string, string> {
  return parseDotenv(readFileSync(ENV_EXAMPLE_PATH, 'utf8'));
}

/**
 * `.env.example` with `overrides` applied. An override of `undefined` removes the
 * variable, which is how a test asks "what happens when this one is missing?".
 */
export function envWith(
  overrides: Readonly<Record<string, string | undefined>> = {},
): NodeJS.ProcessEnv {
  const env: Record<string, string | undefined> = { ...readEnvExample() };
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete env[name];
    } else {
      env[name] = value;
    }
  }
  return env;
}

/** A 64-character hex string — what `openssl rand -hex 32` produces. */
export const REAL_SECRET = 'a'.repeat(64);

/**
 * A plausible production environment: https everywhere, wss for collab, real-length
 * secrets, and no placeholder left over from the example file.
 */
export function productionEnv(
  overrides: Readonly<Record<string, string | undefined>> = {},
): NodeJS.ProcessEnv {
  return envWith({
    NODE_ENV: 'production',
    APP_ENV: 'production',
    API_PUBLIC_URL: 'https://api.assaybank.example',
    WEB_PUBLIC_URL: 'https://staff.assaybank.example',
    CANDIDATE_PUBLIC_URL: 'https://assess.assaybank.example',
    CORS_ALLOWED_ORIGINS: 'https://staff.assaybank.example,https://assess.assaybank.example',
    COLLAB_PUBLIC_URL: 'wss://collab.assaybank.example',
    DATABASE_URL: 'postgres://hiring_app:C4qFnR2wKpLs@db.internal:5432/hiring',
    DATABASE_JOB_URL: 'postgres://hiring_job:Zt7mVx1bQe9d@db.internal:5432/hiring',
    DATABASE_OWNER_URL: 'postgres://hiring_owner:Hs3pLk8wQz2v@db.internal:5432/hiring',
    S3_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
    S3_SECRET_ACCESS_KEY: `s3-${REAL_SECRET}`,
    SESSION_SECRET: REAL_SECRET,
    TOKEN_PEPPER: 'b'.repeat(64),
    ...overrides,
  });
}
