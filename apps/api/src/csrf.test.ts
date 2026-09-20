/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * docs/14 T-017, as a decision table and then as a served response.
 *
 * The table is the part worth reading: every combination of method, cookie, `Origin` and
 * `Sec-Fetch-Site` with the answer beside it, so a reviewer can see that the permissive
 * cases are permissive for a stated reason rather than by omission.
 *
 * The first table exercises the origin half alone — `token` unset, which is what an instance
 * issuing no staff sessions looks like. The second adds the double-submit half (`H-153`) and
 * is a separate table on purpose: the two controls are independent, and a test that only
 * ever ran them together could not tell which one refused a request.
 */

import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { API_BASE_PATH } from '@assaybank/contracts';

import { mintCsrfToken } from './auth/csrf-token.js';
import {
  SAFE_FETCH_SITES,
  STATE_CHANGING_METHODS,
  TOKEN_EXEMPT_PATHS,
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
  const SESSION = '__Host-assaybank.session_token=abc';

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
      expect(csrfRejection(request(parts), { allowedOrigins: ALLOWED })).toBe(expected);
    });
  }

  it('checks exactly the state-changing methods', () => {
    expect([...STATE_CHANGING_METHODS].sort()).toEqual(['DELETE', 'PATCH', 'POST', 'PUT']);
    expect([...SAFE_FETCH_SITES].sort()).toEqual(['none', 'same-origin']);
  });
});

describe('the double-submit token (H-153)', () => {
  const SECRET = 'example-session-secret-for-tests-only';
  const SESSION_VALUE = 'session-abc';
  const TOKEN = { secret: SECRET, secure: true };

  /** A console request: the session cookie, the token cookie, and the header echoing it. */
  function consoleRequest(parts: {
    method?: string;
    url?: string;
    session?: string | undefined;
    cookieToken?: string | undefined;
    headerToken?: string | undefined;
  }): FastifyRequest {
    const jar = [
      ...(parts.session === undefined ? [] : [`__Host-assaybank.session_token=${parts.session}`]),
      ...(parts.cookieToken === undefined
        ? []
        : [`__Host-assaybank.csrf_token=${parts.cookieToken}`]),
    ].join('; ');

    return {
      method: parts.method ?? 'POST',
      url: parts.url ?? `${API_BASE_PATH}/questions`,
      headers: {
        ...(jar === '' ? {} : { cookie: jar }),
        origin: CONSOLE,
        'sec-fetch-site': 'same-origin',
        ...(parts.headerToken === undefined ? {} : { 'x-csrf-token': parts.headerToken }),
      },
    } as unknown as FastifyRequest;
  }

  const decide = (request: FastifyRequest) =>
    csrfRejection(request, { allowedOrigins: ALLOWED, token: TOKEN });

  it('accepts a matching cookie and header signed for this session', () => {
    const minted = mintCsrfToken(SECRET, SESSION_VALUE);
    expect(
      decide(consoleRequest({ session: SESSION_VALUE, cookieToken: minted, headerToken: minted })),
    ).toBeUndefined();
  });

  it('refuses a session cookie with no token at all', () => {
    // The case that matters: a hostile page can make the browser send the session cookie,
    // and that is the whole of what it can do. It cannot read a cookie to echo.
    expect(decide(consoleRequest({ session: SESSION_VALUE }))).toBe('token');
  });

  it('refuses a cookie with no header — the browser sends the cookie by itself', () => {
    const minted = mintCsrfToken(SECRET, SESSION_VALUE);
    expect(decide(consoleRequest({ session: SESSION_VALUE, cookieToken: minted }))).toBe('token');
  });

  it('refuses a header with no cookie', () => {
    const minted = mintCsrfToken(SECRET, SESSION_VALUE);
    expect(decide(consoleRequest({ session: SESSION_VALUE, headerToken: minted }))).toBe('token');
  });

  it('refuses a header that does not match the cookie, even when both are valid', () => {
    // Two tokens this server really minted. Double submit means the two halves agree with
    // each other, not merely that each is well formed.
    expect(
      decide(
        consoleRequest({
          session: SESSION_VALUE,
          cookieToken: mintCsrfToken(SECRET, SESSION_VALUE),
          headerToken: mintCsrfToken(SECRET, SESSION_VALUE),
        }),
      ),
    ).toBe('token');
  });

  it('refuses a token minted for a different session', () => {
    // The property the signature buys. An attacker who can write a cookie into the victim's
    // browser — the classic defeat of an unsigned double submit — plants a pair that is
    // internally consistent and belongs to their own session, and it still does not verify.
    const attackers = mintCsrfToken(SECRET, 'session-attacker');
    expect(
      decide(
        consoleRequest({
          session: SESSION_VALUE,
          cookieToken: attackers,
          headerToken: attackers,
        }),
      ),
    ).toBe('token');
  });

  it('refuses a token signed under a different secret', () => {
    const forged = mintCsrfToken('example-some-other-secret', SESSION_VALUE);
    expect(
      decide(consoleRequest({ session: SESSION_VALUE, cookieToken: forged, headerToken: forged })),
    ).toBe('token');
  });

  it.each(['nonce-with-no-signature', '.only-a-signature', '', 'a.b.c'])(
    'refuses the malformed token %j',
    (malformed) => {
      expect(
        decide(
          consoleRequest({
            session: SESSION_VALUE,
            cookieToken: malformed,
            headerToken: malformed,
          }),
        ),
      ).toBe('token');
    },
  );

  it('asks nothing of a request that carries no session cookie', () => {
    // A cookie jar with no session in it is not an ambient staff credential. The request is
    // refused a moment later by the authorisation layer, which is where "who are you"
    // belongs — refusing it here would mean two components answering one question.
    expect(decide(consoleRequest({ cookieToken: 'anything', headerToken: 'anything' }))).toBe(
      undefined,
    );
  });

  it('asks nothing of a GET', () => {
    expect(decide(consoleRequest({ method: 'GET', session: SESSION_VALUE }))).toBeUndefined();
  });

  it('exempts the two routes that establish a credential rather than use one', () => {
    // A staff member whose session expired still holds the dead cookie and has no token.
    // Demanding one here would lock them out of the sign-in that fixes it.
    for (const path of TOKEN_EXEMPT_PATHS) {
      expect(decide(consoleRequest({ url: path, session: SESSION_VALUE }))).toBeUndefined();
    }
    expect([...TOKEN_EXEMPT_PATHS].sort()).toEqual([
      `${API_BASE_PATH}/auth/login`,
      `${API_BASE_PATH}/auth/oidc/start`,
    ]);
  });

  it('does not let a query string smuggle a route into the exemption', () => {
    expect(
      decide(
        consoleRequest({ url: `${API_BASE_PATH}/questions?x=/auth/login`, session: SESSION_VALUE }),
      ),
    ).toBe('token');
  });

  it('still refuses a hostile origin before it ever looks at a token', () => {
    // Order matters for the metric label and for the log line: a forged cross-origin
    // request is reported as an origin failure, not as a missing token.
    const minted = mintCsrfToken(SECRET, SESSION_VALUE);
    const hostile = {
      method: 'POST',
      url: `${API_BASE_PATH}/questions`,
      headers: {
        cookie: `__Host-assaybank.session_token=${SESSION_VALUE}; __Host-assaybank.csrf_token=${minted}`,
        origin: 'https://evil.test',
        'x-csrf-token': minted,
      },
    } as unknown as FastifyRequest;

    expect(decide(hostile)).toBe('origin');
  });

  it('uses the unprefixed cookie names where there is no https to prefix for', () => {
    const minted = mintCsrfToken(SECRET, SESSION_VALUE);
    const insecure = {
      method: 'POST',
      url: `${API_BASE_PATH}/questions`,
      headers: {
        cookie: `assaybank.session_token=${SESSION_VALUE}; assaybank.csrf_token=${minted}`,
        origin: CONSOLE,
        'x-csrf-token': minted,
      },
    } as unknown as FastifyRequest;

    expect(
      csrfRejection(insecure, {
        allowedOrigins: ALLOWED,
        token: { secret: SECRET, secure: false },
      }),
    ).toBeUndefined();
    // And the prefixed check does not see those cookies at all, so the two spellings are
    // genuinely distinct rather than both being accepted everywhere.
    expect(decide(insecure)).toBeUndefined();
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
