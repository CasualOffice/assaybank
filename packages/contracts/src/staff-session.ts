/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The staff session, as a client sees it (docs/03 §1).
 *
 * These shapes lived in `apps/api/src/auth/routes.ts` as interfaces, which was fine while the
 * server was the only thing that knew them. The console now has to ask who it is talking to
 * before it renders a screen (`H-177`), and a package may never import an app — so they move
 * here, which is where the rule in docs/17 §3a puts a response shape a front end parses.
 *
 * Moving them rather than copying them is the point: two definitions of a login body drift,
 * and the one that drifts is the one nobody is looking at.
 */

import { z } from 'zod';

import { Rfc3339Schema } from './primitives.js';

/** OpenAPI spellings; `apps/api` prefixes `API_BASE_PATH`. */
export const AUTH_LOGIN_PATH = '/auth/login';
export const AUTH_ME_PATH = '/auth/me';
export const AUTH_LOGOUT_PATH = '/auth/logout';
export const AUTH_OIDC_START_PATH = '/auth/oidc/start';

/**
 * The most password a login request may carry.
 *
 * A cost ceiling on an unauthenticated request rather than a rule about passwords: Argon2's
 * work grows with input length, so an unbounded field is a denial of service wearing a login
 * form. Matches `MAX_PASSWORD_LENGTH` in `packages/auth`.
 */
export const MAX_LOGIN_PASSWORD_LENGTH = 128;

export const LoginRequestSchema = z
  .strictObject({
    email: z.email().max(320),
    password: z.string().min(1).max(MAX_LOGIN_PASSWORD_LENGTH),
    /**
     * The organisation's slug. Optional, so the call documented in docs/03 §1 still works.
     *
     * It exists because `users` is unique on `(org_id, email)`: one address may legitimately
     * exist in two organisations, and the lookup refuses to choose between them. A console
     * served per-organisation sends its slug and the ambiguity never arises.
     */
    org: z.string().min(1).max(128).optional(),
  })
  .describe('A staff login. The organisation is optional and disambiguates a shared address.')
  .openapi('LoginRequest');

export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export const StaffProfileSchema = z
  .object({
    user: z.object({
      id: z.string(),
      email: z.string(),
      full_name: z.string(),
      timezone: z.string(),
    }),
    org: z.object({ id: z.string(), name: z.string(), slug: z.string() }),
    /**
     * What this user may do, per action rather than per role name.
     *
     * The console branches on these and never on a role, which is what makes a custom role
     * possible (FR-27) and what stops `if (role === 'admin')` appearing in a screen.
     */
    permissions: z.array(z.string()),
    /** ADR-006: the server owns the clock, and says so on every response. */
    server_time: Rfc3339Schema,
  })
  .describe('Who is signed in, which organisation they are in, and what they may do.')
  .openapi('StaffProfile');

export type StaffProfile = z.infer<typeof StaffProfileSchema>;
