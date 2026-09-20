/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The console's half of the double-submit CSRF token (`H-153`, docs/14 T-017).
 *
 * The API mints a token when a session is established and puts it in a cookie that is
 * deliberately *not* `HttpOnly`. This module reads it back and the client echoes it in a
 * header. That round trip is the whole control: a cross-site page can cause the cookie to be
 * sent — that is what CSRF is — but it cannot read it, so it cannot produce the header.
 *
 * ## Read per request, never cached
 *
 * The token changes whenever the session does: signing out clears it, signing in mints a new
 * one, and `GET /auth/me` re-mints on every page load. A copy taken once at start-up is a
 * copy that is stale after the first sign-out, and the symptom is every mutation failing with
 * `forbidden` until the tab is reloaded. `document.cookie` is a synchronous property read,
 * so there is nothing to save by caching it.
 *
 * ## Why two names
 *
 * `__Host-assaybank.csrf_token` everywhere the deployment speaks https, which is every
 * deployed tier and `localhost` too. The unprefixed spelling exists for a test harness with
 * no scheme at all. The console cannot know which it is looking at, so it tries the prefixed
 * name first and falls back — and it must try the prefixed one first, because a browser that
 * has both should use the one with the stronger promise behind it.
 */

import { CSRF_COOKIE_NAME, CSRF_COOKIE_NAME_INSECURE } from '@assaybank/contracts';

/**
 * Reads a named cookie out of a `document.cookie` string.
 *
 * Deliberately tiny and deliberately not a parser: it splits on `;`, trims, and takes
 * everything after the first `=`. A value containing `=` therefore survives — which a base64
 * or hex token needs. It mirrors the server's `readCookie` in `apps/api`, which reads the
 * same cookies off the other end of the same wire.
 */
export function readCookie(source: string, name: string): string | undefined {
  for (const part of source.split(';')) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf('=');
    if (eq > 0 && trimmed.slice(0, eq) === name) return trimmed.slice(eq + 1);
  }
  return undefined;
}

/**
 * The token to echo, or `undefined` when there is none to echo.
 *
 * `undefined` is not an error and is not worth a warning: it is what a signed-out console
 * looks like, and the one request that legitimately has no token is the sign-in that is about
 * to create one. The server refuses a state-changing request that needs a token and lacks
 * one, which is the right place for that decision to be made — a client that decided for
 * itself whether a control applied would be a client somebody could decide differently for
 * with devtools open.
 *
 * `source` is injected so this is testable without a DOM. It defaults to `document.cookie`,
 * and to the empty string where there is no document — a server-rendered smoke test, or a
 * worker.
 */
export function csrfToken(source?: string): string | undefined {
  const cookies = source ?? (typeof document === 'undefined' ? '' : document.cookie);
  return readCookie(cookies, CSRF_COOKIE_NAME) ?? readCookie(cookies, CSRF_COOKIE_NAME_INSECURE);
}
