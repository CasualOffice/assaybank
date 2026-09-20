/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The console's half of the double-submit token (`H-153`).
 *
 * The cookie reader is tested against the strings a browser actually produces, because the
 * failure this module can have is silent: a reader that does not find the cookie returns
 * `undefined`, the client sends no header, and every mutation is refused with `forbidden` —
 * a screen that looks like a permissions bug and is not.
 */

import { CSRF_COOKIE_NAME, CSRF_COOKIE_NAME_INSECURE, CSRF_HEADER } from '@assaybank/contracts';
import { describe, expect, it } from 'vitest';

import { ApiClient, type FetchLike } from './client.js';
import { csrfToken, readCookie } from './csrf.js';

describe('reading the token out of document.cookie', () => {
  it('finds the host-prefixed cookie', () => {
    expect(csrfToken(`${CSRF_COOKIE_NAME}=abc.def`)).toBe('abc.def');
  });

  it('finds it among the others a browser sends, in any position', () => {
    const jar = `theme=dark; ${CSRF_COOKIE_NAME}=abc.def; locale=en-GB`;
    expect(csrfToken(jar)).toBe('abc.def');
  });

  it('prefers the host-prefixed spelling when a browser holds both', () => {
    // A tier that changed scheme could leave the unprefixed one behind. The one with the
    // stronger promise behind it is the one to send.
    const jar = `${CSRF_COOKIE_NAME_INSECURE}=old.value; ${CSRF_COOKIE_NAME}=new.value`;
    expect(csrfToken(jar)).toBe('new.value');
  });

  it('falls back to the unprefixed spelling where there is no https', () => {
    expect(csrfToken(`${CSRF_COOKIE_NAME_INSECURE}=abc.def`)).toBe('abc.def');
  });

  it('answers undefined for a signed-out console rather than throwing', () => {
    expect(csrfToken('')).toBeUndefined();
    expect(csrfToken('theme=dark')).toBeUndefined();
  });

  it('does not match a cookie whose name merely ends with ours', () => {
    // `evil-__Host-assaybank.csrf_token` is not a cookie a browser would accept, but a
    // reader written with `includes` would take it, and the rule is that the reader is
    // exact rather than that the browser is trusted to be.
    expect(readCookie(`evil-${CSRF_COOKIE_NAME}=planted`, CSRF_COOKIE_NAME)).toBeUndefined();
  });

  it('keeps a value containing "=", which a base64 token can', () => {
    expect(readCookie('k=a=b=c', 'k')).toBe('a=b=c');
  });
});

describe('the client echoes the token (H-153)', () => {
  /** A `fetch` that records the headers it was handed. */
  function recordingFetch(): { fetch: FetchLike; headers: () => Record<string, string> } {
    let seen: Record<string, string> = {};
    return {
      headers: () => seen,
      fetch: (_input, init) => {
        seen = (init?.headers ?? {}) as Record<string, string>;
        return Promise.resolve(new Response(null, { status: 204 }));
      },
    };
  }

  const client = (fetch: FetchLike, token: string | undefined) =>
    new ApiClient({ baseUrl: '/api/v1', fetch, csrfToken: () => token });

  it('sends the header on a POST', async () => {
    const { fetch, headers } = recordingFetch();
    await client(fetch, 'abc.def').requestVoid('/auth/logout', { method: 'POST' });

    expect(headers()[CSRF_HEADER]).toBe('abc.def');
  });

  it('sends it on PATCH and DELETE too, not only POST', async () => {
    for (const method of ['PATCH', 'DELETE'] as const) {
      const { fetch, headers } = recordingFetch();
      await client(fetch, 'abc.def').requestVoid('/questions/q_1', { method });
      expect(headers()[CSRF_HEADER]).toBe('abc.def');
    }
  });

  it('does not send it on a GET', async () => {
    // A `GET` must not change state, so it needs no token — and a token on a `GET` is a
    // token in a URL-shaped request log, a browser cache and a `Referer`.
    const { fetch, headers } = recordingFetch();
    await client(fetch, 'abc.def').request('/auth/me', {
      schema: { parse: () => undefined },
    });

    expect(headers()[CSRF_HEADER]).toBeUndefined();
  });

  it('omits the header rather than sending an empty one when there is no token', async () => {
    // A signed-out console. The server decides whether the absence matters; sending an
    // empty string would present a token that is simply wrong instead of absent.
    const { fetch, headers } = recordingFetch();
    await client(fetch, undefined).requestVoid('/auth/logout', { method: 'POST' });

    expect(CSRF_HEADER in headers()).toBe(false);
  });

  it('reads the token again on every request, so a sign-out is not outlived', async () => {
    let current: string | undefined = 'first';
    const { fetch, headers } = recordingFetch();
    const instance = new ApiClient({ baseUrl: '/api/v1', fetch, csrfToken: () => current });

    await instance.requestVoid('/a', { method: 'POST' });
    expect(headers()[CSRF_HEADER]).toBe('first');

    current = 'second';
    await instance.requestVoid('/b', { method: 'POST' });
    expect(headers()[CSRF_HEADER]).toBe('second');
  });
});
