/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The limits table from docs/03-API-spec.md §2, expressed once.
 *
 * | Scope | Limit |
 * |---|---|
 * | Staff API, per user | 600 / min |
 * | Candidate autosave, per attempt | 60 / min |
 * | Trial code runs, per attempt | 60 / hour |
 * | Submissions, per attempt question | 10 total |
 * | Token redemption, per IP | 20 / hour |
 *
 * **Four of those five are rate limits. One is not, and conflating them would be a
 * scoring bug.** "10 total" is a lifetime cap on a row, not a sliding window: a window
 * resets — on the hour, on a deploy, on a pod reschedule — and a reset window lets an
 * eleventh submission through for a question the candidate was told they had ten
 * attempts at. So {@link MAX_SUBMISSIONS_PER_ATTEMPT_QUESTION} is deliberately *not* a
 * `@fastify/rate-limit` entry; it is a count enforced transactionally against the
 * submissions table when that endpoint arrives in P4, where a concurrent double-submit
 * is refused by the database rather than by a per-process counter.
 *
 * **What P0 can and cannot key on.** Three of the four windows are per-principal — per
 * user, per attempt, per attempt question — and P0 has no authentication, so there is no
 * principal to key on yet. The global limiter therefore keys on the client address and
 * applies the staff ceiling, which is the loosest of the four and so cannot block
 * traffic that a correctly-keyed limiter would have allowed. Each route attaches its own
 * scope with {@link rateLimitFor} as it is written, and P1 replaces the key generator
 * with the authenticated principal.
 */

import rateLimitPlugin from '@fastify/rate-limit';
import type { RateLimitOptions, RateLimitPluginOptions } from '@fastify/rate-limit';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import { ApiError } from '@assaybank/contracts';
import { counter, type CounterMetric } from '@assaybank/observability';

/**
 * The five scopes of docs/03 §2, as docs/12 §4.6 labels them, plus one the table does not
 * have.
 *
 * `staff_login` is not in docs/03 §2. The table there covers authenticated traffic and the
 * one unauthenticated endpoint that existed when it was written — token redemption, at 20
 * per hour per address. Staff login is the second unauthenticated endpoint and it needs
 * its own ceiling, because the two are not the same kind of secret: a redemption token is
 * 256 bits of CSPRNG output and cannot be guessed at any rate, while a password is
 * whatever a recruiter chose and an attacker with a leaked credential list only needs a
 * few attempts per address. See {@link RATE_LIMITS} for the number and the reasoning.
 */
export const RATE_LIMIT_SCOPES = [
  'staff_api',
  'staff_login',
  'candidate_autosave',
  'trial_run',
  'submission',
  'token_redemption',
] as const;

/** One of the five documented limit scopes. */
export type RateLimitScope = (typeof RATE_LIMIT_SCOPES)[number];

declare module 'fastify' {
  interface FastifyContextConfig {
    /**
     * Which row of the docs/03 §2 table this route is governed by. Read by the 429
     * response builder so `http_rate_limited_total` can say *which* limit fired — a
     * spike on `candidate_autosave` is a client bug and a candidate losing work, and it
     * is indistinguishable from staff traffic without this label (docs/12 §4.6).
     */
    rateLimitScope?: RateLimitScope;
  }
}

/** A window from the table: how many requests, over what period. */
export interface RateLimitWindow {
  readonly max: number;
  /** A `@fastify/rate-limit` duration string, e.g. `'1 minute'`. */
  readonly timeWindow: string;
  /** What the window is counted per, once authentication exists. */
  readonly per: string;
}

/**
 * The four windowed limits. `submission` is absent on purpose — see the module comment.
 */
export const RATE_LIMITS: Readonly<Record<Exclude<RateLimitScope, 'submission'>, RateLimitWindow>> =
  Object.freeze({
    staff_api: { max: 600, timeWindow: '1 minute', per: 'staff user' },
    // Ten attempts per quarter of an hour, per client address. Stricter than token
    // redemption's 20 per hour because the secret is guessable: ten tries is more than a
    // human needs and far fewer than credential stuffing needs, and the window is short
    // enough that a locked-out recruiter is working again within one coffee rather than
    // filing a ticket. Keyed on the address rather than on the address and the email,
    // because the attack that matters is one address trying many accounts — password
    // spraying — and an email-keyed bucket would let it through unimpeded.
    staff_login: { max: 10, timeWindow: '15 minutes', per: 'client address' },
    candidate_autosave: { max: 60, timeWindow: '1 minute', per: 'attempt' },
    trial_run: { max: 60, timeWindow: '1 hour', per: 'attempt' },
    token_redemption: { max: 20, timeWindow: '1 hour', per: 'client address' },
  });

/**
 * "Submissions, per attempt question | 10 total" — a lifetime cap, enforced against the
 * submissions table inside the transaction that creates a submission, never by a window.
 */
export const MAX_SUBMISSIONS_PER_ATTEMPT_QUESTION = 10;

/** docs/12 §4.6 — is the limiter protecting the system or blocking real candidates? */
export const httpRateLimitedTotal: CounterMetric<'scope'> = counter<'scope'>({
  name: 'http_rate_limited_total',
  help: 'Requests refused by a rate limit, by the docs/03 §2 scope that refused them.',
  labelNames: ['scope'],
  labelValues: { scope: RATE_LIMIT_SCOPES },
});

/**
 * Operational routes are never rate limited.
 *
 * A limited `/healthz` is a self-inflicted outage: the orchestrator's probe fails, the
 * pod is killed, its traffic moves to the remaining pods, whose probes then fail too.
 * `/readyz` and `/metrics` are scraped on a fixed interval by infrastructure that has no
 * backoff and no way to read a `Retry-After`.
 */
export const UNLIMITED_ROUTES: ReadonlySet<string> = new Set([
  '/healthz',
  '/readyz',
  '/metrics',
  '/openapi.json',
]);

/**
 * The route-level configuration a handler attaches to opt into one of the documented
 * windows: `{ config: rateLimitFor('candidate_autosave') }`.
 */
export function rateLimitFor(scope: Exclude<RateLimitScope, 'submission'>): {
  rateLimit: RateLimitOptions;
  rateLimitScope: RateLimitScope;
} {
  const window = RATE_LIMITS[scope];
  return {
    rateLimit: { max: window.max, timeWindow: window.timeWindow },
    rateLimitScope: scope,
  };
}

function scopeOf(request: FastifyRequest): RateLimitScope {
  return request.routeOptions.config.rateLimitScope ?? 'staff_api';
}

/**
 * The plugin options. Registered globally so an endpoint added without thinking about
 * limits still has one, rather than having none.
 *
 * The 429 body is the standard envelope: `@fastify/rate-limit` *throws* whatever
 * `errorResponseBuilder` returns, so returning an {@link ApiError} routes it through the
 * one error handler in errors.ts and it cannot end up shaped differently from every
 * other failure. `Retry-After` is attached by the plugin before it throws.
 */
export function rateLimitOptions(): RateLimitPluginOptions {
  return {
    global: true,
    max: RATE_LIMITS.staff_api.max,
    timeWindow: RATE_LIMITS.staff_api.timeWindow,
    // The default store is per-process. With N replicas the effective ceiling is N×max,
    // which is acceptable for a ceiling whose job is to bound damage rather than to meter
    // usage; the shared Valkey store arrives in P1 alongside the authenticated key, so
    // that both halves of "600 per minute per user" become true at once.
    keyGenerator: (request: FastifyRequest): string => request.ip,
    allowList: (request: FastifyRequest): boolean =>
      UNLIMITED_ROUTES.has(request.routeOptions.url ?? ''),
    // A limiter that fails open on a store error is a limiter that disappears exactly
    // when the system is already unwell. It is still preferable to refusing every
    // request because the counter is unavailable — no infrastructure failure scores
    // anyone zero (docs/17 §0 rule 4).
    skipOnError: true,
    errorResponseBuilder: (request: FastifyRequest, context): ApiError => {
      httpRateLimitedTotal.inc({ scope: scopeOf(request) });
      return ApiError.rateLimited(undefined, {
        // Authored, bounded, and useful: the client is told when to come back rather
        // than having to parse prose. Nothing here is derived from user input.
        details: { retry_after_seconds: Math.ceil(context.ttl / 1000) },
      });
    },
  };
}

/**
 * Attaches the documented staff window to `app` as the default. Kept as a function so
 * server.ts reads as a list of decisions rather than as a wall of plugin options.
 */
export function registerRateLimit(app: FastifyInstance): void {
  void app.register(rateLimitPlugin, rateLimitOptions());
}
