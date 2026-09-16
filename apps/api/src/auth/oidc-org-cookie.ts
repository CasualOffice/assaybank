/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Carrying the organisation across the identity provider.
 *
 * `POST /auth/oidc/start` knows which organisation the sign-in is for — it resolved it,
 * or the deployment has only one. `GET /auth/oidc/callback` arrives minutes later from a
 * different site with nothing but `code` and `state`, and it needs the same organisation
 * before it can touch a single row: `staff_verifications` is a tenant table, so even
 * reading back the `state` Better Auth stored requires `app.current_org` to be set.
 *
 * So the organisation travels with the browser, in a cookie of our own, for the length of
 * the round trip.
 *
 * ## Why not Better Auth's `state`
 *
 * Because it is Better Auth's. The value is opaque to us, its format is theirs to change,
 * and the row holding it is one of the rows that cannot be read until the organisation is
 * known. Threading our tenant key through somebody else's parameter would couple our
 * tenancy to their serialisation.
 *
 * ## Why this cookie is safe to trust, and what it is not trusted for
 *
 * It is signed — `<orgId>.<hmac>` under `SESSION_SECRET` — so its contents cannot be
 * chosen by a page, and the signature covers **both** the organisation and the `state`
 * Better Auth minted for this particular flow. That binding is what makes it useless
 * outside the flow it was issued for: a cookie captured from one sign-in cannot be
 * replayed against another, because the `state` in the callback would not match the one
 * inside the signature.
 *
 * It is trusted for exactly one thing: naming which organisation's context to open. It
 * authorises nothing. If it named the wrong organisation, the `state` lookup would find
 * no row there and the callback would fail as a state mismatch — which is the same answer
 * a forged callback gets, and is the outcome docs/14 `H-124` asks for.
 *
 * `SameSite=Lax` is required rather than incidental: the callback is a top-level `GET`
 * navigation from the identity provider's origin, which is precisely the case `Lax`
 * allows and `Strict` does not. `HttpOnly` because no script has any use for it, and a
 * short `Max-Age` because an OIDC round trip is a minute's work and a stale one should
 * simply fail.
 */

import { constantTimeEquals, hmacHex } from '@assaybank/auth';
import { OrgIdSchema, type OrgId } from '@assaybank/contracts';

import { OIDC_CALLBACK_PATH } from './better-auth.js';

/**
 * Domain separation. Every HMAC in this codebase covers a constant naming what is being
 * signed, so a digest minted here can never be replayed as an attempt token or a ticket
 * even if the same secret is configured in two places by mistake.
 */
const COOKIE_DOMAIN = 'assaybank.oidc-org-cookie.v1';

/** The separator between the signed parts. A byte neither a uuid nor a state contains. */
const SEPARATOR = '\u001f';

/** The cookie's name, without the `__Secure-` prefix that `secure` adds. */
export const OIDC_ORG_COOKIE_NAME = 'assaybank.oidc_org';

/**
 * How long the round trip may take, in seconds.
 *
 * Ten minutes. Long enough for an identity provider to prompt for a second factor and for
 * the user to find their phone; short enough that a cookie left behind by an abandoned
 * sign-in is dead before anyone could think of using it. Better Auth's own `state` cookie
 * lives five minutes, so this is deliberately the *outer* bound of the two — expiring
 * first would turn a state mismatch into a confusing tenancy error.
 */
export const OIDC_ORG_COOKIE_TTL_SECONDS = 600;

/** The signed value: the organisation, bound to the flow's `state`. */
function sign(secret: string, orgId: OrgId, state: string): string {
  return hmacHex(secret, `${COOKIE_DOMAIN}${SEPARATOR}${orgId}${SEPARATOR}${state}`);
}

/**
 * The `Set-Cookie` header value for a flow that is about to begin.
 *
 * Serialised here rather than through a cookie library because the attributes are fixed
 * and there are six of them: a dependency that exists to concatenate a known string is a
 * dependency whose upgrades we would have to read.
 */
export function oidcOrgCookie(options: {
  readonly secret: string;
  readonly orgId: OrgId;
  readonly state: string;
  readonly secure: boolean;
}): string {
  const { secret, orgId, state, secure } = options;
  const name = secure ? `__Secure-${OIDC_ORG_COOKIE_NAME}` : OIDC_ORG_COOKIE_NAME;
  const value = `${orgId}.${sign(secret, orgId, state)}`;

  return [
    `${name}=${value}`,
    `Max-Age=${OIDC_ORG_COOKIE_TTL_SECONDS}`,
    // Scoped to the callback. The console never reads it and no other route needs it, so
    // narrowing the path narrows what a cross-site request can even cause to be sent.
    `Path=${OIDC_CALLBACK_PATH}`,
    'HttpOnly',
    ...(secure ? ['Secure'] : []),
    'SameSite=Lax',
  ].join('; ');
}

/** The expiring form, to clear the cookie once the flow has ended either way. */
export function clearOidcOrgCookie(secure: boolean): string {
  const name = secure ? `__Secure-${OIDC_ORG_COOKIE_NAME}` : OIDC_ORG_COOKIE_NAME;
  return `${name}=; Max-Age=0; Path=${OIDC_CALLBACK_PATH}; HttpOnly${
    secure ? '; Secure' : ''
  }; SameSite=Lax`;
}

/**
 * Reads a named cookie out of a `Cookie` header.
 *
 * Deliberately tiny and deliberately not a parser: it splits on `;`, trims, and takes
 * everything after the first `=`. A value containing `=` therefore survives, which the
 * base64 and hex values here need.
 */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined;
  for (const part of header.split(';')) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf('=');
    if (eq > 0 && trimmed.slice(0, eq) === name) return trimmed.slice(eq + 1);
  }
  return undefined;
}

/**
 * The organisation this callback belongs to, or `undefined`.
 *
 * `undefined` for a missing cookie, a malformed one, a bad signature, a signature minted
 * for a different `state`, and an organisation id that is not a uuid. All five are the
 * same answer on purpose: the caller turns every one of them into the same refusal, so
 * nothing about which check failed reaches the browser.
 *
 * The comparison is {@link constantTimeEquals}. The digest is not secret and the value is
 * not long-lived, so the timing channel here is thin — but a secret comparison written
 * with `===` is a habit, and this package's rule is that there are none.
 */
export function verifyOidcOrgCookie(options: {
  readonly secret: string;
  readonly cookieHeader: string | undefined;
  readonly state: string | undefined;
  readonly secure: boolean;
}): OrgId | undefined {
  const { secret, cookieHeader, state, secure } = options;
  if (state === undefined || state === '') return undefined;

  const name = secure ? `__Secure-${OIDC_ORG_COOKIE_NAME}` : OIDC_ORG_COOKIE_NAME;
  const raw = readCookie(cookieHeader, name);
  if (raw === undefined) return undefined;

  const dot = raw.indexOf('.');
  if (dot <= 0) return undefined;

  const parsed = OrgIdSchema.safeParse(raw.slice(0, dot));
  if (!parsed.success) return undefined;

  const expected = sign(secret, parsed.data, state);
  return constantTimeEquals(expected, raw.slice(dot + 1)) ? parsed.data : undefined;
}
