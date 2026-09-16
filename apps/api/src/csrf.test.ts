/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * docs/14 T-017, as a decision table and then as a served response.
 *
 * The table is the part worth reading: every combination of method, cookie, `Origin` and
 * `Sec-Fetch-Site` with the answer beside it, so a reviewer can see that the permissive
 * cases are permissive for a stated reason rather than by omission.
 */

import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { API_BASE_PATH } from '@assaybank/contracts';

import {
  SAFE_FETCH_SITES,
  STATE_CHANGING_METHODS,
  csrfRejection,
  registerCsrfProtection,
} from './csrf.js';
import { registerErrorHandling } from './errors.js';
import { buildServer } from './server.js';
import { testConfig } from './test-support.js';

const CONSOLE = 'https://console.example.test';
const ALLOWED = [CONSOLE];

/** The four headers the check reads, as a request-shaped object. */
function request(parts: {
  method: string;
  cookie?: string;
  origin?: string;
  fetchSite?: string;
}): FastifyRequest {
  return {
    method: parts.method,
    headers: {
      ...(parts.cookie === undefined ? {} : { cookie: parts.cookie }),
      ...(parts.origin === undefined ? {} : { origin: parts.origin }),
      ...(parts.fetchSite === undefined ? {} : { 'sec-fetch-site': parts.fetchSite }),
    },
  } as unknown as FastifyRequest;
}

describe('the decision table', () => {
  const SESSION = '__Secure-assaybank.session_token=abc';

  const cases: {
    name: string;
    parts: Parameters<typeof request>[0];
    expected: string | undefined;
  }[] = [
    {
      name: 'a GET is never refused, because a GET must not change state anyway',
      parts: { method: 'GET', cookie: SESSION, origin: 'https://evil.test' },
      expected: undefined,
    },
    {
      name: 'the CORS preflight carries no credentials by definition',
      parts: { method: 'OPTIONS', origin: 'https://evil.test' },
      expected: undefined,
    },
    {
      name: 'a POST with no cookie has no ambient credential to forge with',
      parts: { method: 'POST', origin: 'https://evil.test' },
      expected: undefined,
    },
    {
      name: 'a cookie-bearing POST from the console is allowed',
      parts: { method: 'POST', cookie: SESSION, origin: CONSOLE, fetchSite: 'same-origin' },
      expected: undefined,
    },
    {
      name: 'a cookie-bearing POST from a hostile page is refused',
      parts: { method: 'POST', cookie: SESSION, origin: 'https://evil.test' },
      expected: 'origin',
    },
    {
      name: 'a cross-site fetch is refused even when it sends no Origin',
      parts: { method: 'POST', cookie: SESSION, fetchSite: 'cross-site' },
      expected: 'fetch_site',
    },
    {
      name: 'a same-site subdomain is refused: same site is not the same origin',
      parts: { method: 'POST', cookie: SESSION, fetchSite: 'same-site' },
      expected: 'fetch_site',
    },
    {
      name: 'a top-level navigation the user began is allowed',
      parts: { method: 'POST', cookie: SESSION, fetchSite: 'none' },
      expected: undefined,
    },
    {
      name: 'a non-browser client with a cookie and no metadata is allowed through',
      parts: { method: 'POST', cookie: SESSION },
      expected: undefined,
    },
    {
      name: 'PATCH is checked, not only POST',
      parts: { method: 'PATCH', cookie: SESSION, origin: 'https://evil.test' },
      expected: 'origin',
    },
    {
      name: 'DELETE is checked',
      parts: { method: 'DELETE', cookie: SESSION, origin: 'https://evil.test' },
      expected: 'origin',
    },
    {
      name: 'a lower-cased method is still a method',
      parts: { method: 'post', cookie: SESSION, origin: 'https://evil.test' },
      expected: 'origin',
    },
  ];

  for (const { name, parts, expected } of cases) {
    it(name, () => {
      expect(csrfRejection(request(parts), ALLOWED)).toBe(expected);
    });
  }

  it('checks exactly the state-changing methods', () => {
    expect([...STATE_CHANGING_METHODS].sort()).toEqual(['DELETE', 'PATCH', 'POST', 'PUT']);
    expect([...SAFE_FETCH_SITES].sort()).toEqual(['none', 'same-origin']);
  });
});

describe('the hook, on a built server', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  const build = (): FastifyInstance => {
    const instance = buildServer({ config: testConfig(), logger: false });
    instance.after(() => {
      instance.post(`${API_BASE_PATH}/probe`, () => ({ ok: true }));
    });
    app = instance;
    return instance;
  };

  it('refuses a cross-origin mutation with the standard forbidden envelope', async () => {
    const response = await build().inject({
      method: 'POST',
      url: `${API_BASE_PATH}/probe`,
      headers: { cookie: 'a=1', origin: 'https://evil.test' },
    });

    expect(response.statusCode).toBe(403);
    const body = response.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe('forbidden');
    // Nothing about the origin, the allow-list or the route reaches the client.
    expect(body.error.message).not.toContain('evil.test');
    expect(JSON.stringify(body)).not.toContain('console.example.test');
  });

  it('refuses before the route exists, so an unknown path is no way around it', async () => {
    const response = await build().inject({
      method: 'POST',
      url: '/no-such-route',
      headers: { cookie: 'a=1', origin: 'https://evil.test' },
    });

    // `onRequest` runs before routing, so this is 403 rather than the 404 an unmatched
    // path would otherwise get. A forged request should not learn the route table either.
    expect(response.statusCode).toBe(403);
  });

  it('lets the console through', async () => {
    // A bare instance rather than `buildServer`: on the real server every route must also
    // declare a permission or appear in the public allow-list, so a throwaway probe route
    // is refused by the authorisation layer with the same 403 the CSRF hook produces, and
    // the two would be indistinguishable. Here there is only one hook that can refuse.
    const instance = Fastify({ logger: false });
    registerErrorHandling(instance);
    registerCsrfProtection(instance, { allowedOrigins: ALLOWED });
    instance.post('/probe', () => ({ ok: true }));
    app = instance;

    const response = await instance.inject({
      method: 'POST',
      url: '/probe',
      headers: { cookie: 'a=1', origin: 'https://console.example.test' },
    });

    expect(response.statusCode).toBe(200);
  });

  it('refuses a hostile origin on that same bare instance, so the pass above means something', async () => {
    const instance = Fastify({ logger: false });
    registerErrorHandling(instance);
    registerCsrfProtection(instance, { allowedOrigins: ALLOWED });
    instance.post('/probe', () => ({ ok: true }));
    app = instance;

    const response = await instance.inject({
      method: 'POST',
      url: '/probe',
      headers: { cookie: 'a=1', origin: 'https://evil.test' },
    });

    expect(response.statusCode).toBe(403);
  });

  it('still carries the request id on a refusal', async () => {
    const response = await build().inject({
      method: 'POST',
      url: `${API_BASE_PATH}/probe`,
      headers: { cookie: 'a=1', origin: 'https://evil.test' },
    });

    expect(response.headers['x-request-id']).toMatch(/^req_[0-9a-f]{32}$/u);
    expect(response.json<{ error: { request_id: string } }>().error.request_id).toBe(
      response.headers['x-request-id'],
    );
  });
});
