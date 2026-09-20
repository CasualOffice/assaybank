/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What the staff cookies are called, in one place (docs/14 `H-149`).
 *
 * Three modules need the session cookie's name and they need the same one: `better-auth.ts`
 * tells the library what to mint, `routes.ts` reads the value back to bind a CSRF token to
 * it, and `../csrf.ts` looks for it to decide whether a request carries an ambient staff
 * credential at all. A name spelled twice is a control that stops working the day one of the
 * two is edited.
 *
 * ## `__Host-`, not `__Secure-`
 *
 * `H-149` asks for host-prefixed cookies. The two prefixes are not interchangeable:
 *
 * - `__Secure-` promises only that the cookie was set over https. Any host that can set a
 *   cookie for the registrable domain — `anything.customer.example`, including a forgotten
 *   marketing subdomain or one an attacker got hold of — can also set a `__Secure-` cookie
 *   that the API will then receive.
 * - `__Host-` additionally forbids `Domain` and requires `Path=/`, which confines the cookie
 *   to exactly the host that set it. A sibling subdomain cannot write it.
 *
 * That difference is the whole of the attack this prefix exists to stop, and it matters twice
 * here. It stops a subdomain planting a *session* cookie — forcing a victim into the
 * attacker's account, where the victim's work is then readable by its owner. And it is the
 * assumption the double-submit CSRF token rests on: a token an attacker can write into the
 * victim's browser is a token they can also echo in a header, which is a double-submit scheme
 * that proves nothing. See `@assaybank/contracts`' `CSRF_COOKIE_NAME`.
 *
 * Better Auth prepends `__Secure-` itself when `useSecureCookies` is on, and there is no
 * option to make it prepend `__Host-`. So the library's prefixing is turned off and the names
 * are supplied here in full, with `Secure` restored through `defaultCookieAttributes` — see
 * `better-auth.ts`. `path: '/'` and the absence of `crossSubDomainCookies` are what make the
 * prefix honest rather than merely present; a browser rejects the cookie outright if either
 * is wrong, so the two cannot drift apart unnoticed.
 *
 * ## The insecure spelling is a test harness, not an environment
 *
 * `secure: false` exists because `app.inject()` has no scheme and therefore no https for a
 * prefix to promise. Every deployed tier speaks https — which, to a browser, includes
 * `localhost` — so every deployed tier is prefixed.
 */

/** Namespaces these cookies away from anything else on the host. */
export const STAFF_COOKIE_PREFIX = 'assaybank';

/**
 * The cookies Better Auth mints, by its own internal name.
 *
 * All four, not only the session: `getCookies()` builds every one of them through the same
 * path, so naming three and forgetting the fourth would leave one cookie with the library's
 * default prefix and no test looking at it. `session_data` and `account_data` are the cookie
 * cache, which `better-auth.ts` disables — they are named anyway, because a configuration
 * that is turned off today is a configuration somebody turns on.
 */
export const BETTER_AUTH_COOKIES = [
  'session_token',
  'session_data',
  'account_data',
  'dont_remember',
] as const;

/** The name a `Set-Cookie` and a `Cookie` header both use for one of these. */
export function staffCookieName(base: string, secure: boolean): string {
  return secure ? `__Host-${STAFF_COOKIE_PREFIX}.${base}` : `${STAFF_COOKIE_PREFIX}.${base}`;
}

/** Where the session identifier lives. Nothing else authenticates a staff request. */
export function sessionCookieName(secure: boolean): string {
  return staffCookieName('session_token', secure);
}
