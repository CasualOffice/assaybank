/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { ErrorEnvelopeSchema } from '@assaybank/contracts';
import { describe, expect, it, vi } from 'vitest';

import { ApiClient, ApiRequestError, type FetchLike, isRetryable } from './client.js';

/** Builds a `fetch` that returns one canned response and records what it was asked for. */
function stubFetch(response: Response): {
  fetch: FetchLike;
  calls: [string, RequestInit | undefined][];
} {
  const calls: [string, RequestInit | undefined][] = [];

  return {
    calls,
    fetch: (input, init) => {
      calls.push([input, init]);
      return Promise.resolve(response);
    },
  };
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

/** A parser in the structural shape the client asks for. */
const asRecord = {
  parse: (input: unknown): Record<string, unknown> => {
    if (typeof input !== 'object' || input === null) {
      throw new Error('expected an object');
    }
    return input as Record<string, unknown>;
  },
};

describe('ApiClient success path', () => {
  it('parses the body with the caller-supplied parser', async () => {
    const { fetch } = stubFetch(jsonResponse({ id: 'q_1', title: 'Two sum' }));
    const client = new ApiClient({ baseUrl: '/api/v1', fetch });

    await expect(client.get('/questions/q_1', asRecord)).resolves.toEqual({
      id: 'q_1',
      title: 'Two sum',
    });
  });

  it('propagates a parser failure rather than returning an unvalidated body', async () => {
    const { fetch } = stubFetch(jsonResponse({ nope: true }));
    const client = new ApiClient({ baseUrl: '/api/v1', fetch });

    // Parse at the edge (docs/17 §1): an unparsed response is an untyped response, and
    // this is the only error the client deliberately does not convert to an envelope,
    // because it is a bug in this bundle rather than a server failure.
    await expect(
      client.get('/questions/q_1', {
        parse: () => {
          throw new Error('schema mismatch');
        },
      }),
    ).rejects.toThrow('schema mismatch');
  });

  it('joins the base url and path without doubling the slash', async () => {
    const { fetch, calls } = stubFetch(jsonResponse({}));
    const client = new ApiClient({ baseUrl: '/api/v1/', fetch });

    await client.get('/questions', asRecord);

    expect(calls[0]?.[0]).toBe('/api/v1/questions');
  });

  it('omits undefined query parameters instead of sending the string "undefined"', async () => {
    const { fetch, calls } = stubFetch(jsonResponse({}));
    const client = new ApiClient({ baseUrl: '/api/v1', fetch });

    await client.get('/questions', asRecord, {
      query: { cursor: undefined, limit: 50, archived: false },
    });

    const url = calls[0]?.[0] ?? '';
    expect(url).toContain('limit=50');
    expect(url).toContain('archived=false');
    expect(url).not.toContain('cursor');
  });

  it('sends an Idempotency-Key on a mutation when one is given', async () => {
    const { fetch, calls } = stubFetch(jsonResponse({ ok: true }, { status: 201 }));
    const client = new ApiClient({ baseUrl: '/api/v1', fetch });

    await client.post('/questions', { title: 'Two sum' }, asRecord, {
      idempotencyKey: 'a0b1c2d3',
    });

    // docs/03 §2: recruiters double-click and networks retry, so the server replays the
    // original response rather than creating a second question.
    const headers = calls[0]?.[1]?.headers as Record<string, string> | undefined;
    expect(headers?.['idempotency-key']).toBe('a0b1c2d3');
    expect(headers?.['content-type']).toBe('application/json');
    expect(calls[0]?.[1]?.method).toBe('POST');
  });

  it('sends no content-type when there is no body', async () => {
    const { fetch, calls } = stubFetch(jsonResponse({}));
    const client = new ApiClient({ baseUrl: '/api/v1', fetch });

    await client.get('/questions', asRecord);

    const headers = calls[0]?.[1]?.headers as Record<string, string> | undefined;
    expect(headers?.['content-type']).toBeUndefined();
    expect(headers?.['accept']).toBe('application/json');
  });

  it('gives the parser undefined for a 204, rather than trying to read a body', async () => {
    const { fetch } = stubFetch(new Response(null, { status: 204 }));
    const client = new ApiClient({ baseUrl: '/api/v1', fetch });
    const parse = vi.fn(() => 'parsed');

    await expect(client.get('/questions/q_1', { parse })).resolves.toBe('parsed');
    expect(parse).toHaveBeenCalledWith(undefined);
  });
});

describe('ApiClient failure path', () => {
  it('turns an error envelope into an ApiRequestError carrying the code', async () => {
    const envelope = {
      error: {
        code: 'version_immutable',
        message: 'A published question version cannot be modified.',
        details: { question_version_id: 'qv_7' },
        request_id: '0af7651916cd43dd8448eb211c80319c',
      },
    };
    const { fetch } = stubFetch(jsonResponse(envelope, { status: 409 }));
    const client = new ApiClient({ baseUrl: '/api/v1', fetch });

    const error = await client.get('/questions/q_1', asRecord).catch((cause: unknown) => cause);

    expect(ApiRequestError.is(error)).toBe(true);
    const failure = error as ApiRequestError;
    expect(failure.code).toBe('version_immutable');
    expect(failure.status).toBe(409);
    expect(failure.requestId).toBe('0af7651916cd43dd8448eb211c80319c');
    expect(failure.details).toEqual({ question_version_id: 'qv_7' });
    expect(failure.displayMessage).toBe('A published question version cannot be modified.');
  });

  it('puts the code, not the server prose, in Error.message', async () => {
    const { fetch } = stubFetch(
      jsonResponse(
        { error: { code: 'forbidden', message: 'Nope, not allowed, mate.', request_id: 'r1' } },
        { status: 403 },
      ),
    );
    const client = new ApiClient({ baseUrl: '/api/v1', fetch });

    const error = await client.get('/x', asRecord).catch((cause: unknown) => cause);

    // docs/17 §3: clients branch on `code`; `message` may be reworded, translated or
    // shortened at any time. The value somebody reaches for by habit therefore carries
    // the code, and the prose is only reachable through a name that reads wrong in a
    // condition.
    expect((error as Error).message).toBe('API request failed: forbidden');
    expect((error as Error).message).not.toContain('mate');
  });

  it('serves a non-envelope JSON error body as internal', async () => {
    const { fetch } = stubFetch(jsonResponse({ message: 'gateway exploded' }, { status: 502 }));
    const client = new ApiClient({ baseUrl: '/api/v1', fetch });

    const error = (await client
      .get('/x', asRecord)
      .catch((cause: unknown) => cause)) as ApiRequestError;

    // A proxy's own JSON is not this API's contract, and rendering it would show a user
    // something the API never meant to say.
    expect(error.code).toBe('internal');
    expect(error.status).toBe(502);
    expect(error.displayMessage).not.toContain('gateway exploded');
  });

  it('serves an HTML error page as internal and keeps the trace id from the header', async () => {
    const { fetch } = stubFetch(
      new Response('<html><body>502 Bad Gateway</body></html>', {
        status: 502,
        headers: { 'content-type': 'text/html', 'x-request-id': 'trace-42' },
      }),
    );
    const client = new ApiClient({ baseUrl: '/api/v1', fetch });

    const error = (await client
      .get('/x', asRecord)
      .catch((cause: unknown) => cause)) as ApiRequestError;

    expect(error.code).toBe('internal');
    expect(error.requestId).toBe('trace-42');
    expect(error.displayMessage).not.toContain('Bad Gateway');
  });

  it('rejects an envelope whose code is not in the closed union', async () => {
    const { fetch } = stubFetch(
      jsonResponse(
        { error: { code: 'teapot', message: 'I am a teapot.', request_id: 'r2' } },
        { status: 418 },
      ),
    );
    const client = new ApiClient({ baseUrl: '/api/v1', fetch });

    const error = (await client
      .get('/x', asRecord)
      .catch((cause: unknown) => cause)) as ApiRequestError;

    // The envelope is parsed, not cast. A code outside the union would otherwise flow
    // into a screen's `switch` and match nothing, silently.
    expect(error.code).toBe('internal');
  });

  it('falls back to the header trace id when the envelope carries an empty one', async () => {
    const { fetch } = stubFetch(
      jsonResponse(
        { error: { code: 'not_found', message: 'No such question.', request_id: '' } },
        { status: 404, headers: { 'content-type': 'application/json', 'x-request-id': 'hdr-9' } },
      ),
    );
    const client = new ApiClient({ baseUrl: '/api/v1', fetch });

    const error = (await client
      .get('/x', asRecord)
      .catch((cause: unknown) => cause)) as ApiRequestError;

    expect(error.code).toBe('not_found');
    expect(error.requestId).toBe('hdr-9');
  });

  it('turns a transport failure into the same shape, with status 0', async () => {
    const cause = new TypeError('Failed to fetch');
    const client = new ApiClient({
      baseUrl: '/api/v1',
      fetch: () => Promise.reject(cause),
    });

    const error = (await client
      .get('/x', asRecord)
      .catch((thrown: unknown) => thrown)) as ApiRequestError;

    // One failure type for the caller. A screen that has to handle both an envelope and a
    // raw TypeError handles one of them badly.
    expect(ApiRequestError.is(error)).toBe(true);
    expect(error.code).toBe('internal');
    expect(error.status).toBe(0);
    expect(error.requestId).toBe('');
    expect(error.cause).toBe(cause);
  });

  it('turns a malformed success body into the same shape', async () => {
    const { fetch } = stubFetch(
      new Response('{not json', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const client = new ApiClient({ baseUrl: '/api/v1', fetch });

    const error = (await client
      .get('/x', asRecord)
      .catch((thrown: unknown) => thrown)) as ApiRequestError;

    expect(error.code).toBe('internal');
    expect(error.status).toBe(200);
  });

  it('produces an envelope the contract itself accepts', async () => {
    const { fetch } = stubFetch(jsonResponse({ nope: 1 }, { status: 500 }));
    const client = new ApiClient({ baseUrl: '/api/v1', fetch });

    const error = (await client
      .get('/x', asRecord)
      .catch((thrown: unknown) => thrown)) as ApiRequestError;

    // Whatever the client synthesises is still the one shape docs/03 §2 defines, so the
    // error boundary renders a synthesised failure and a served one identically.
    expect(ErrorEnvelopeSchema.safeParse(error.envelope).success).toBe(true);
  });

  it('recognises its own errors across module realms', () => {
    // `instanceof` is not enough in a monorepo that can load two copies of a module — the
    // same reasoning as ApiError in @assaybank/contracts.
    const impostor = { [Symbol.for('assaybank.web.ApiRequestError')]: true };

    expect(ApiRequestError.is(impostor)).toBe(true);
    expect(ApiRequestError.is(new Error('plain'))).toBe(false);
    expect(ApiRequestError.is(null)).toBe(false);
    expect(ApiRequestError.is('not_found')).toBe(false);
  });
});

/** Code, status, and whether trying the same request again could plausibly work. */
const RETRY_CASES: [string, number, boolean][] = [
  ['rate_limited', 429, true],
  ['execution_unavailable', 503, true],
  ['internal', 500, true],
  ['forbidden', 403, false],
  ['version_immutable', 409, false],
  ['validation_failed', 422, false],
];

describe('isRetryable', () => {
  it.each(RETRY_CASES)('%s is retryable: %s', async (code, status, expected) => {
    const { fetch } = stubFetch(
      jsonResponse({ error: { code, message: 'x', request_id: 'r' } }, { status }),
    );
    const client = new ApiClient({ baseUrl: '/api/v1', fetch });

    const error = await client.get('/x', asRecord).catch((thrown: unknown) => thrown);

    // Retry policy is decided by looking a code up, never by pattern-matching prose.
    expect(isRetryable(error)).toBe(expected);
  });

  it('is false for anything that is not an ApiRequestError', () => {
    expect(isRetryable(new Error('boom'))).toBe(false);
    expect(isRetryable(undefined)).toBe(false);
  });
});
