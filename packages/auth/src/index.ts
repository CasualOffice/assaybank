/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * @assaybank/auth — the security boundary.
 *
 * Two authentication domains that must not share a credential (docs/03-API-spec.md §1):
 * staff, who have accounts, sessions and permissions; and candidates, who have none of
 * those and hold a token scoped to exactly one attempt. This package owns the token
 * model and the permission check for both.
 *
 * ## What is here in P0, and why so early
 *
 * There is no attempt to scope a token to yet. The token model is built anyway, because
 * scope is the one property that cannot be added later: a credential that has been issued
 * without a scope is in somebody's browser, and every route that already accepts it now
 * has to keep accepting it. Designing the claim set before there is a consumer is the
 * cheap moment; retrofitting it after P3 is not a refactor, it is a revocation event.
 *
 * The permission set is here for the same reason. It is not invented — it is the seed in
 * docs/hiring_platform_schema.sql §13, copied exactly — so the API written in P1 checks
 * the keys the database will actually grant.
 *
 * ## The properties this package is responsible for
 *
 * - Bearer secrets are 256 bits of CSPRNG output, stored only as a peppered hash, and the
 *   plaintext is returned exactly once (docs/17 §7).
 * - Every comparison of a secret is timing-safe. No `===` on a digest, anywhere.
 * - An attempt token authorises one attempt and nothing else, and says so inside its own
 *   signature.
 * - WebSocket tickets are a separate credential with a sixty-second life, verified before
 *   the upgrade completes.
 * - Expiry is measured against an injected {@link Clock}. `Date.now()` does not appear in
 *   this package (ADR-006).
 * - A refusal tells the holder nothing about why (docs/14 T-011): every reason becomes
 *   the same `unauthenticated` envelope.
 * - A candidate principal is authorised for no staff permission, present or future.
 *
 * ## Staff sessions, and why they are not in this file
 *
 * P0 planned `createStaffSession`, `verifyStaffSession`, `startOidc` and `completeOidc`
 * to land here in P1. They did not, and deliberately so: the session is Better Auth's,
 * wired directly in `apps/api/src/auth/` against the tenancy spine, because docs/17
 * forbids wrapping a library used exactly once and there is no second session
 * implementation to abstract over (P1 plan, step 3; "the two ways this phase fails", #2).
 * A `createStaffSession` here would be four functions that each forward to one Better
 * Auth call, and the forwarding is where the subtle bugs would live.
 *
 * What *is* here is the part that is ours whoever manages the session: the password
 * hashing in `password.ts`, which the admin provisioning path and the login path both
 * need and which no library choice should be able to change silently.
 */

export type { Clock } from './clock.js';
export { fixedClock, systemClock } from './clock.js';

export { constantTimeEquals, hmacHex } from './crypto.js';

export type { Result } from './result.js';
export { err, ok } from './result.js';

export type { AuthErrorReason } from './errors.js';
export { AUTH_ERROR_REASONS, AuthError } from './errors.js';

export { MAX_CREDENTIAL_LENGTH } from './envelope.js';

export { TOKEN_BYTES, TOKEN_HASH_VERSION, generateToken, hashToken, verifyToken } from './token.js';

export {
  ARGON2ID_PREFIX,
  ARGON2_PARAMETERS,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  hashPassword,
  hashPasswordUnchecked,
  verifyPassword,
  verifyPasswordAgainstNothing,
} from './password.js';

export type { AttemptTokenClaims } from './attempt-token.js';
export { ATTEMPT_TOKEN_PREFIX, issueAttemptToken, verifyAttemptToken } from './attempt-token.js';

export type { WsTicket } from './ws-ticket.js';
export {
  WS_TICKET_CLOCK_SKEW_SECONDS,
  WS_TICKET_PREFIX,
  WS_TICKET_TTL_SECONDS,
  issueWsTicket,
  verifyWsTicket,
} from './ws-ticket.js';

export type {
  CandidatePrincipal,
  KnownPermission,
  Permission,
  Principal,
  StaffPrincipal,
} from './permissions.js';
export {
  PERMISSIONS,
  PERMISSION_DESCRIPTIONS,
  assertCan,
  can,
  isPermission,
} from './permissions.js';

/**
 * The workspace's own package name. Exported so a bootstrap can name itself in a log
 * line or a span resource without a second source of truth.
 */
export const WORKSPACE_NAME = '@assaybank/auth';
