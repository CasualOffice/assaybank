/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';

import { OrgIdSchema, type OrgId } from '@assaybank/contracts';

import {
  OIDC_ORG_COOKIE_NAME,
  OIDC_ORG_COOKIE_TTL_SECONDS,
  clearOidcOrgCookie,
  oidcOrgCookie,
  readCookie,
  verifyOidcOrgCookie,
} from './oidc-org-cookie.js';

const SECRET = 'a-session-secret-long-enough-for-a-test-0123456789';
const ORG: OrgId = OrgIdSchema.parse('4a1c9e70-2b83-4d51-8f6a-0c7d5e91b204');
const OTHER_ORG: OrgId = OrgIdSchema.parse('9f3d81b2-6c47-4e05-9a1d-73b5e0c82f61');
const STATE = 'ebvQXt2hhBlfdfxOmosK5vcrYTISUgYR';

/** The `name=value` pair a browser would send back, from a `Set-Cookie`. */
const asRequestCookie = (setCookie: string): string => setCookie.split(';', 1)[0] ?? '';

describe('oidcOrgCookie', () => {
  it('carries the attributes the threat model requires of it', () => {
    const cookie = oidcOrgCookie({ secret: SECRET, orgId: ORG, state: STATE, secure: true });

    expect(cookie).toContain(`__Secure-${OIDC_ORG_COOKIE_NAME}=`);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    // Lax rather than Strict: the callback is a top-level GET navigation from the identity
    // provider's origin, which Strict would not send the cookie on at all.
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain(`Max-Age=${OIDC_ORG_COOKIE_TTL_SECONDS}`);
    // Scoped to the one route that reads it.
    expect(cookie).toContain('Path=/api/v1/auth/oidc/callback');
  });

  it('drops the Secure attribute and the host prefix together, never one alone', () => {
    // A `__Secure-` name without the attribute is rejected by browsers outright, so the
    // two have to move as a pair.
    const cookie = oidcOrgCookie({ secret: SECRET, orgId: ORG, state: STATE, secure: false });
    expect(cookie).toContain(`${OIDC_ORG_COOKIE_NAME}=`);
    expect(cookie).not.toContain('__Secure-');
    expect(cookie).not.toContain('Secure');
  });

  it('does not put the organisation in the cookie unsigned', () => {
    const cookie = oidcOrgCookie({ secret: SECRET, orgId: ORG, state: STATE, secure: true });
    const value = asRequestCookie(cookie).split('=')[1] ?? '';
    // The id is there — it has to be, it is what the callback needs — but it is followed
    // by a digest, so it cannot be replaced with another organisation's.
    expect(value.startsWith(`${ORG}.`)).toBe(true);
    expect(value.length).toBeGreaterThan(ORG.length + 32);
  });
});

describe('verifyOidcOrgCookie', () => {
  const roundTrip = (options: {
    orgId?: OrgId;
    state?: string;
    verifyState?: string | undefined;
    secret?: string;
    secure?: boolean;
  }): OrgId | undefined => {
    const secure = options.secure ?? true;
    const setCookie = oidcOrgCookie({
      secret: SECRET,
      orgId: options.orgId ?? ORG,
      state: options.state ?? STATE,
      secure,
    });
    return verifyOidcOrgCookie({
      secret: options.secret ?? SECRET,
      cookieHeader: asRequestCookie(setCookie),
      state: 'verifyState' in options ? options.verifyState : (options.state ?? STATE),
      secure,
    });
  };

  it('recovers the organisation it was issued for', () => {
    expect(roundTrip({})).toBe(ORG);
    expect(roundTrip({ secure: false })).toBe(ORG);
  });

  it('refuses a cookie minted for a different flow (docs/14 H-124)', () => {
    // The binding to `state` is what stops a cookie captured from one sign-in being
    // replayed against another.
    expect(roundTrip({ verifyState: 'a-different-state' })).toBeUndefined();
  });

  it('refuses a cookie signed with a different secret', () => {
    expect(roundTrip({ secret: 'not-the-session-secret-at-all-0123456789' })).toBeUndefined();
  });

  it('refuses a cookie whose organisation was swapped for another', () => {
    const setCookie = oidcOrgCookie({ secret: SECRET, orgId: ORG, state: STATE, secure: true });
    const signature = (asRequestCookie(setCookie).split('.')[1] ?? '').trim();
    const forged = `__Secure-${OIDC_ORG_COOKIE_NAME}=${OTHER_ORG}.${signature}`;

    expect(
      verifyOidcOrgCookie({ secret: SECRET, cookieHeader: forged, state: STATE, secure: true }),
    ).toBeUndefined();
  });

  it('refuses every shape of absence identically', () => {
    for (const cookieHeader of [
      undefined,
      '',
      'unrelated=1',
      `__Secure-${OIDC_ORG_COOKIE_NAME}=`,
      `__Secure-${OIDC_ORG_COOKIE_NAME}=nodot`,
      `__Secure-${OIDC_ORG_COOKIE_NAME}=not-a-uuid.deadbeef`,
    ]) {
      expect(
        verifyOidcOrgCookie({ secret: SECRET, cookieHeader, state: STATE, secure: true }),
      ).toBeUndefined();
    }
  });

  it('refuses a callback with no state at all', () => {
    expect(roundTrip({ verifyState: undefined })).toBeUndefined();
    expect(roundTrip({ verifyState: '' })).toBeUndefined();
  });

  it('will not accept a non-secure cookie when secure cookies are expected', () => {
    // The names differ, so a downgrade to the unprefixed cookie is not merely discouraged
    // by the browser — it is unreadable here.
    const setCookie = oidcOrgCookie({ secret: SECRET, orgId: ORG, state: STATE, secure: false });
    expect(
      verifyOidcOrgCookie({
        secret: SECRET,
        cookieHeader: asRequestCookie(setCookie),
        state: STATE,
        secure: true,
      }),
    ).toBeUndefined();
  });
});

describe('clearOidcOrgCookie', () => {
  it('expires the cookie on the same name and path it was set with', () => {
    const set = oidcOrgCookie({ secret: SECRET, orgId: ORG, state: STATE, secure: true });
    const clear = clearOidcOrgCookie(true);

    // A Set-Cookie that differs by one attribute clears nothing.
    const name = (cookie: string): string => cookie.split('=', 1)[0] ?? '';
    expect(name(clear)).toBe(name(set));
    expect(clear).toContain('Path=/api/v1/auth/oidc/callback');
    expect(clear).toContain('Max-Age=0');
  });
});

describe('readCookie', () => {
  it('finds a cookie among others and keeps a value containing "="', () => {
    expect(readCookie('a=1; target=x=y=z; b=2', 'target')).toBe('x=y=z');
  });

  it('does not match a cookie whose name merely ends with the one asked for', () => {
    expect(readCookie('not-target=1', 'target')).toBeUndefined();
  });

  it('answers undefined for no header at all', () => {
    expect(readCookie(undefined, 'target')).toBeUndefined();
  });
});
