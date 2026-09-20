/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The console's HTTP client.
 *
 * It exists to make one rule from docs/17 §3 impossible to get wrong on the client side:
 * **clients branch on `code`, never on `message`.** The `code` is a closed union defined
 * in `@assaybank/contracts` and is part of the API contract; the `message` is prose for a
 * human that may be reworded, shortened or translated at any time without that being a
 * breaking change. A screen that does `if (error.message.includes('expired'))` is a screen
 * that breaks silently the day somebody improves the wording.
 *
 * The client makes the right thing the easy thing rather than merely documenting it:
 *
 * - {@link ApiRequestError} exposes `code`, `status`, `requestId` and `details` as typed
 *   properties, and the prose is `displayMessage` — a name that reads wrong in a
 *   condition, which is the point.
 * - `Error.message` is `"API request failed: <code>"`, so even the value somebody reaches
 *   for by habit carries the code and not the server's prose.
 * - Every failure becomes an {@link ApiRequestError}. A network failure, a 502 from a
 *   proxy with an HTML body, a JSON body that is not an envelope — all of them arrive as
 *   `internal` rather than as a `TypeError` from three layers down, because a screen that
 *   has to handle two shapes of failure handles one of them badly.
 *
 * Responses are parsed at the edge (docs/17 §1) by a parser the caller supplies, typed
 * structurally so this module — and therefore the console bundle — does not take a direct
 * dependency on zod for what is a one-method interface.
 */

import {
  type ErrorCode,
  type ErrorDetails,
  type ErrorEnvelope,
  ErrorEnvelopeSchema,
  INTERNAL_ERROR_MESSAGE,
} from '@assaybank/contracts';

/** The HTTP methods the console uses. `PUT` is whole-collection replacement only. */
export type ApiMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

/**
 * Anything that parses an unknown payload into `T`, or throws.
 *
 * Structural on purpose: every zod schema satisfies it, and so does a hand-written
 * narrowing function, and neither this module nor a caller has to import a validation
 * library to name the type.
 */
export interface ResponseParser<T> {
  parse: (input: unknown) => T;
}

/** The shape of `fetch` this client needs. Injected so tests need no network and no DOM. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Construction options for {@link ApiClient}. */
export interface ApiClientOptions {
  /** Base URL of the API, e.g. `/api/v1` or `https://api.example.com/api/v1`. */
  readonly baseUrl: string;
  /** The `fetch` to use. Defaults to the global one. */
  readonly fetch?: FetchLike;
}

/** Per-request options. */
export interface RequestOptions<T> {
  /**
   * Parses the success body. Required: an unparsed response is an untyped response.
   *
   * Named for what it is rather than for the method it carries, so the call site reads
   * `{ schema }` and a zod schema drops straight in.
   */
  readonly schema: ResponseParser<T>;
  /** HTTP method. `GET` by default. */
  readonly method?: ApiMethod;
  /** JSON request body. Serialised with `JSON.stringify`. */
  readonly body?: unknown;
  /** Query parameters. `undefined` values are omitted rather than sent as "undefined". */
  readonly query?: Readonly<Record<string, string | number | boolean | undefined>>;
  /**
   * Replay key for a mutating request (docs/03 §2). Recruiters double-click and networks
   * retry, and the server replays the original response rather than acting twice.
   */
  readonly idempotencyKey?: string;
  /** Abort signal, so a query can be cancelled when a component unmounts. */
  readonly signal?: AbortSignal;
}

/** Distinguishes an `ApiRequestError` across module realms, the way `ApiError` does. */
const API_REQUEST_ERROR_MARKER: unique symbol = Symbol.for('assaybank.web.ApiRequestError');

/**
 * A request that did not succeed.
 *
 * Branch on `code`. `displayMessage` is for rendering and nothing else.
 */
export class ApiRequestError extends Error {
  /** @see API_REQUEST_ERROR_MARKER */
  readonly [API_REQUEST_ERROR_MARKER] = true;

  override readonly name: string = 'ApiRequestError';

  /** The stable code from the closed union in `@assaybank/contracts`. Branch on this. */
  readonly code: ErrorCode;

  /** The HTTP status, or `0` when the request never reached a server. */
  readonly status: number;

  /** The trace id, so a support ticket resolves to a trace (docs/12, docs/17 §9). */
  readonly requestId: string;

  /** Authored, machine-readable context — `{ deadline_at }` and the like. */
  readonly details: ErrorDetails | undefined;

  /** The server's prose, for rendering to a human. Never branch on it. */
  readonly displayMessage: string;

  /** The envelope as received, for the error boundary to render. */
  readonly envelope: ErrorEnvelope;

  constructor(envelope: ErrorEnvelope, status: number, options?: { cause?: unknown }) {
    // Deliberately not the server's prose: the value somebody reaches for out of habit
    // should carry the thing they are allowed to branch on.
    super(
      `API request failed: ${envelope.error.code}`,
      options?.cause === undefined ? {} : { cause: options.cause },
    );

    this.envelope = envelope;
    this.code = envelope.error.code;
    this.status = status;
    this.requestId = envelope.error.request_id;
    this.details = envelope.error.details;
    this.displayMessage = envelope.error.message;
  }

  /** True when `value` is an `ApiRequestError`, including from another copy of this module. */
  static is(value: unknown): value is ApiRequestError {
    return typeof value === 'object' && value !== null && API_REQUEST_ERROR_MARKER in value;
  }
}

/**
 * The envelope served for anything that is not a recognisable one.
 *
 * A proxy's HTML error page, a truncated body, a CORS failure: all of them become
 * `internal` with the fixed message from the contract, because the alternative is a screen
 * rendering whatever a piece of infrastructure decided to say.
 */
function internalEnvelope(requestId: string): ErrorEnvelope {
  return {
    error: { code: 'internal', message: INTERNAL_ERROR_MESSAGE, request_id: requestId },
  };
}

/** Reads the trace id a proxy or the API put on the response, if any. */
function requestIdOf(response: Pick<Response, 'headers'>): string {
  return response.headers.get('x-request-id') ?? '';
}

/** Appends the defined query parameters to a path. */
function withQuery(
  path: string,
  query: Readonly<Record<string, string | number | boolean | undefined>> | undefined,
): string {
  if (query === undefined) {
    return path;
  }

  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) {
      search.set(key, String(value));
    }
  }

  const serialised = search.toString();
  return serialised.length === 0 ? path : `${path}?${serialised}`;
}

/**
 * Codes the user can do something about by trying again.
 *
 * Exported as data so a screen decides retry policy by looking a code up rather than by
 * pattern-matching prose. `execution_unavailable` is here because docs/17 §0 rule 4 says
 * an infrastructure failure never scores anyone zero — it waits and is retried.
 */
export const RETRYABLE_ERROR_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'rate_limited',
  'execution_unavailable',
  'internal',
]);

/** True when retrying the same request could plausibly succeed. */
export function isRetryable(error: unknown): boolean {
  return ApiRequestError.is(error) && RETRYABLE_ERROR_CODES.has(error.code);
}

/**
 * A typed HTTP client for the staff console.
 *
 * It talks to the API and to nothing else — never to Postgres, never to Valkey, never to
 * the object store (CODE-GRAPH L5/L6, enforced by lint).
 */
export class ApiClient {
  readonly #baseUrl: string;
  readonly #fetch: FetchLike;

  constructor(options: ApiClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/u, '');
    this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  }

  /**
   * Performs a request that answers `204` and returns nothing.
   *
   * A separate method rather than a nullable schema: "this endpoint returns no body" is a
   * fact about the endpoint, and expressing it as a parser that accepts `undefined` would
   * let a body-returning endpoint be called this way and have its body silently dropped.
   */
  async requestVoid(path: string, options: Omit<RequestOptions<void>, 'schema'>): Promise<void> {
    await this.request<void>(path, {
      ...options,
      schema: {
        parse: (value: unknown): void => {
          if (value !== undefined) {
            throw new Error('expected no response body');
          }
        },
      },
    });
  }

  /**
   * Performs a request and parses the response, or throws an {@link ApiRequestError}.
   *
   * Nothing else escapes: the `catch` below converts a thrown `TypeError` from a failed
   * connection into the same envelope shape a 500 produces, so a caller has one failure
   * type to handle rather than two.
   */
  async request<T>(path: string, options: RequestOptions<T>): Promise<T> {
    const method = options.method ?? 'GET';
    const url = `${this.#baseUrl}${withQuery(path, options.query)}`;

    const headers: Record<string, string> = { accept: 'application/json' };
    if (options.body !== undefined) {
      headers['content-type'] = 'application/json';
    }
    if (options.idempotencyKey !== undefined) {
      headers['idempotency-key'] = options.idempotencyKey;
    }

    let response: Response;
    try {
      response = await this.#fetch(url, {
        method,
        headers,
        // The staff session is an HttpOnly cookie, so every request has to carry it. This is
        // already `fetch`'s default for a same-origin request — which the console always is
        // (docs/13) — and it is written out because a default that is load-bearing and
        // invisible is a default somebody removes.
        credentials: 'same-origin',
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    } catch (cause) {
      // The request never reached a server: DNS, TLS, CORS, offline, or an abort. There
      // is no envelope and no trace id, and the cause is kept for the console rather than
      // for the screen.
      throw new ApiRequestError(internalEnvelope(''), 0, { cause });
    }

    if (!response.ok) {
      throw await toRequestError(response);
    }

    if (response.status === 204) {
      return options.schema.parse(undefined);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (cause) {
      throw new ApiRequestError(internalEnvelope(requestIdOf(response)), response.status, {
        cause,
      });
    }

    return options.schema.parse(payload);
  }

  /** A `GET`. */
  async get<T>(
    path: string,
    schema: ResponseParser<T>,
    options?: Omit<RequestOptions<T>, 'schema' | 'method' | 'body'>,
  ): Promise<T> {
    return this.request(path, { ...options, schema, method: 'GET' });
  }

  /** A `POST`, which is a mutation and therefore takes an idempotency key. */
  async post<T>(
    path: string,
    body: unknown,
    schema: ResponseParser<T>,
    options?: Omit<RequestOptions<T>, 'schema' | 'method' | 'body'>,
  ): Promise<T> {
    return this.request(path, { ...options, schema, method: 'POST', body });
  }
}

/**
 * Turns a failed response into an {@link ApiRequestError}.
 *
 * The envelope is *parsed*, not cast. A 500 from a load balancer is text/html, a 502 from
 * a proxy is whatever that proxy felt like, and a bug could return a JSON object with a
 * `code` that is not in the union. All three become `internal`, which is the only answer
 * that cannot show a user something the API never meant to say.
 */
async function toRequestError(response: Response): Promise<ApiRequestError> {
  const fallbackRequestId = requestIdOf(response);

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (cause) {
    return new ApiRequestError(internalEnvelope(fallbackRequestId), response.status, { cause });
  }

  const parsed = ErrorEnvelopeSchema.safeParse(payload);
  if (!parsed.success) {
    return new ApiRequestError(internalEnvelope(fallbackRequestId), response.status);
  }

  const envelope = parsed.data;
  const requestId =
    envelope.error.request_id.length > 0 ? envelope.error.request_id : fallbackRequestId;

  return new ApiRequestError(
    { error: { ...envelope.error, request_id: requestId } },
    response.status,
  );
}
