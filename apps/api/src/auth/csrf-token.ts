/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The double-submit half of docs/14 T-017 / `H-153`.
 *
 * `../csrf.ts` refuses a state-changing request whose `Origin` is not one of ours. That is
 * the half that needs no client cooperation, and it stops the attack. This is the half that
 * does not depend on the browser volunteering a header: a value only same-origin script can
 * read, echoed back in a header only same-origin script can set.
 *
 * Both halves, because each covers the other's failure. Origin checking evaporates entirely
 * if a browser stops sending `Origin` or a proxy strips it; a bare double-submit token
 * evaporates if anything can write the victim's cookies. Neither failure takes both.
 *
 * ## Signed, and bound to the session
 *
 * The token is `<nonce>.<hmac>`, where the HMAC covers the nonce **and the session
 * identifier it was minted for**, under `SESSION_SECRET`. A plain random double-submit value
 * only proves "whoever sent this header could also read a cookie". Binding it to the session
 * proves something stronger and more useful: this token was issued to *this* session. A
 * token captured from one session, or minted for an attacker's own, does not verify against
 * a victim's — which is the case that defeats an unsigned scheme wherever an attacker can
 * get a cookie written at all.
 *
 * The session identifier is used as an opaque string. Nothing here parses it, and nothing
 * here can authenticate anybody: this file decides whether a request may change state, never
 * who is making it.
 *
 * ## Why the cookie is readable by script
 *
 * Because script has to read it — that is the mechanism, not an oversight. It is the one
 * cookie in this system that is not `HttpOnly`, and it is safe to be so because it carries
 * no authority: holding it authenticates nothing, and it is useless without the session
 * cookie it is bound to, which stays `HttpOnly`.
 *
 * Its `__Host-` prefix is load-bearing rather than decorative. A double-submit token a
 * sibling subdomain could write is a token an attacker could also echo in a header, which is
 * a scheme that proves nothing. See `cookie-names.ts`.
 */

import { randomBytes } from 'node:crypto';

import { constantTimeEquals, hmacHex } from '@assaybank/auth';
import { CSRF_COOKIE_NAME, CSRF_COOKIE_NAME_INSECURE } from '@assaybank/contracts';

import { SESSION_TTL_SECONDS } from './better-auth.js';

/**
 * Domain separation. Every HMAC in this codebase covers a constant naming what is being
 * signed, so a digest minted here can never be replayed as an attempt token, a WebSocket
 * ticket or an OIDC organisation cookie even if the same secret were configured twice.
 */
const TOKEN_DOMAIN = 'assaybank.csrf-token.v1';

/** The separator between signed parts. A byte neither a nonce nor a session token contains. */
const SEPARATOR = '\u001f';

/** Bytes of randomness in the nonce. 16 is 128 bits, which is not guessable. */
const NONCE_BYTES = 16;

/** The cookie's name for this deployment. */
export function csrfCookieName(secure: boolean): string {
  return secure ? CSRF_COOKIE_NAME : CSRF_COOKIE_NAME_INSECURE;
}

/** The signature over a nonce and the session it belongs to. */
function sign(secret: string, nonce: string, sessionToken: string): string {
  return hmacHex(secret, `${TOKEN_DOMAIN}${SEPARATOR}${nonce}${SEPARATOR}${sessionToken}`);
}

/**
 * Mints a token for a session.
 *
 * Fresh randomness on every call rather than a deterministic value per session. A token that
 * is a pure function of the session is one that can be recomputed by anybody who learns the
 * session identifier — which is a thing that leaks into proxy logs and `Referer` headers in
 * ways a session cookie, being `HttpOnly` and `SameSite`, does not.
 */
export function mintCsrfToken(secret: string, sessionToken: string): string {
  const nonce = randomBytes(NONCE_BYTES).toString('hex');
  return `${nonce}.${sign(secret, nonce, sessionToken)}`;
}

/**
 * Whether `token` was minted by us for `sessionToken`.
 *
 * `false` for a missing separator, an empty nonce and a wrong signature alike — the caller
 * turns all of them into one refusal, so nothing about which check failed reaches the
 * caller.
 */
export function verifyCsrfToken(
  secret: string,
  sessionToken: string,
  token: string | undefined,
): boolean {
  if (token === undefined) return false;

  const dot = token.indexOf('.');
  if (dot <= 0) return false;

  return constantTimeEquals(sign(secret, token.slice(0, dot), sessionToken), token.slice(dot + 1));
}

/**
 * The `Set-Cookie` value carrying a freshly minted token.
 *
 * `Max-Age` matches the session's, so the two expire together: a token outliving its session
 * would be a cookie the console reads, sends, and is refused for, with nothing on screen
 * explaining why.
 *
 * Serialised here rather than through a cookie library, for the reason `oidc-org-cookie.ts`
 * gives: a dependency that exists to concatenate six known strings is a dependency whose
 * upgrades we would have to read.
 */
export function csrfCookie(options: {
  readonly secret: string;
  readonly sessionToken: string;
  readonly secure: boolean;
}): string {
  const { secret, sessionToken, secure } = options;

  return [
    `${csrfCookieName(secure)}=${mintCsrfToken(secret, sessionToken)}`,
    `Max-Age=${SESSION_TTL_SECONDS}`,
    // Exactly `/`, which the `__Host-` prefix requires. No `HttpOnly`: see the module note.
    'Path=/',
    ...(secure ? ['Secure'] : []),
    'SameSite=Lax',
  ].join('; ');
}

/** The expiring form, so a logout leaves nothing behind. */
export function clearCsrfCookie(secure: boolean): string {
  return [
    `${csrfCookieName(secure)}=`,
    'Max-Age=0',
    'Path=/',
    ...(secure ? ['Secure'] : []),
    'SameSite=Lax',
  ].join('; ');
}
