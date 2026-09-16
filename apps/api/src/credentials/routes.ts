/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The two HTTP surfaces of the candidate credential model, and the hook that accepts the
 * credential they produce.
 *
 * ```
 * POST /api/v1/candidate/redeem        invitation token   → attempt token   (public)
 * POST /api/v1/sessions/{id}/ticket    staff session      → WebSocket ticket (interview.host)
 * ```
 *
 * ## Why one of them is public and the other is not
 *
 * Redemption is the moment a candidate obtains the only credential they will ever hold,
 * so requiring one would be circular — it is allow-listed in `authorisation.ts`'s
 * `PUBLIC_ROUTES` with that reason written down, and it is rate limited to the
 * documented 20 per address per hour (docs/03 §2), which is what bounds the enumeration
 * of `T-011` once entropy has made it pointless.
 *
 * The ticket route is the opposite: it is a staff action on a staff resource, and it
 * declares `interview.host`. That declaration does the candidate exclusion for free —
 * `can()` returns `false` for a candidate principal for every permission, including ones
 * invented later — so an attempt token presented here is refused by the authorisation
 * layer before this file's handler runs. The standing leak suite asserts exactly that,
 * over the whole route table rather than over this one route.
 *
 * ## The authentication hook does not refuse
 *
 * {@link registerCandidateAuthentication} turns a valid attempt token into a principal
 * and does nothing else. A missing, expired or forged bearer leaves `request.principal`
 * undefined and the request continues to the authorisation check, which answers `401` on
 * a route that needs an identity and lets a public route through. Refusing inside the
 * hook would mean this file deciding which routes need a credential, which is precisely
 * the decision `authorisation.ts` centralises so that it can be enumerated.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';

import type { Clock, StaffPrincipal } from '@assaybank/auth';
import { API_BASE_PATH, SessionIdSchema, type SessionId } from '@assaybank/contracts';
import { counter, type CounterMetric } from '@assaybank/observability';

import { requirePermission } from '../authorisation.js';
import { currentPrincipal, registerPrincipal, setPrincipal } from '../principal.js';
import { rateLimitFor } from '../rate-limit.js';
import { authenticateAttempt } from './attempt-token.js';
import type { CredentialKeys } from './keys.js';
import { recordRefusal, refuse, toApiError, type Refusal } from './refusal.js';
import { MAX_INVITATION_TOKEN_LENGTH, type RedemptionService } from './redemption.js';
import {
  toRedeemResponse,
  toTicketResponse,
  type RedeemResponse,
  type TicketResponse,
} from './responses.js';
import type { SessionGateway } from './sessions.js';
import type { WsTicketService } from './ws-ticket.js';

/** The path of the redemption endpoint, including the version prefix. */
export const REDEEM_PATH = `${API_BASE_PATH}/candidate/redeem`;

/** The path of the ticket endpoint, in Fastify's `:param` spelling. */
export const SESSION_TICKET_PATH = `${API_BASE_PATH}/sessions/:id/ticket`;

/**
 * docs/12 wants a ticket mint to be countable: a rate far above the number of interviews
 * running is either a reconnection storm or somebody collecting credentials, and the two
 * look identical in a request log.
 */
export const wsTicketsIssuedTotal: CounterMetric = counter({
  name: 'ws_tickets_issued_total',
  help: 'Single-use WebSocket tickets minted for interview sessions.',
});

/** Everything the credential routes need from the composition root. */
export interface CredentialRouteOptions {
  readonly redemption: RedemptionService;
  readonly tickets: WsTicketService;
  readonly sessions: SessionGateway;
  /** Injected. Renders `server_time`, and nothing else in this file reads a clock. */
  readonly clock: Clock;
}

/** What {@link registerCandidateAuthentication} needs. */
export interface CandidateAuthenticationOptions {
  readonly keys: Pick<CredentialKeys, 'attemptToken'>;
  readonly clock: Clock;
}

/**
 * The whole candidate credential flow, as `buildServer` takes it: the two routes' own
 * dependencies plus the key the authentication hook verifies with.
 *
 * One object rather than five parameters, because the five are constructed together at
 * the composition root and a partially wired flow — routes registered, hook missing — is
 * a server that mints credentials it will not accept.
 */
export interface CandidateCredentialServices extends CredentialRouteOptions {
  readonly keys: Pick<CredentialKeys, 'attemptToken'>;
}

/**
 * Installs the bearer-token authentication hook.
 *
 * `onRequest`, which Fastify runs before the `preValidation` hook that authorisation
 * uses, so the principal is in place before any route's declaration is enforced. The
 * ordering holds regardless of the order the two are registered in, because the phases
 * are ordered rather than the registrations.
 */
export function registerCandidateAuthentication(
  app: FastifyInstance,
  options: CandidateAuthenticationOptions,
): void {
  registerPrincipal(app);

  app.addHook('onRequest', (request, _reply, done) => {
    const header = request.headers.authorization;
    if (header === undefined) {
      done();
      return;
    }

    const authenticated = authenticateAttempt(header, {
      signingKey: options.keys.attemptToken,
      clock: options.clock,
    });

    if (authenticated.ok) {
      setPrincipal(request, authenticated.principal);
    } else if (authenticated.refusal.reason !== 'absent') {
      // `absent` here means "an Authorization header that is not a Bearer token" — a
      // staff session scheme, say. Not this hook's business, and not worth a metric.
      recordRefusal(request.log, authenticated.refusal);
    }

    done();
  });
}

/** Refuses the request with the uniform envelope, after recording what really happened. */
function deny(request: FastifyRequest, refusal: Refusal): never {
  recordRefusal(request.log, refusal);
  throw toApiError(refusal);
}

/** The body of `POST /candidate/redeem`, as JSON Schema for Fastify's validator. */
const redeemBodySchema = {
  type: 'object',
  required: ['token'],
  additionalProperties: false,
  properties: {
    token: { type: 'string', minLength: 1, maxLength: MAX_INVITATION_TOKEN_LENGTH },
  },
} as const;

/** The params of `POST /sessions/{id}/ticket`. A UUID, checked before the handler runs. */
const sessionParamsSchema = {
  type: 'object',
  required: ['id'],
  additionalProperties: false,
  properties: {
    id: {
      type: 'string',
      pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
    },
  },
} as const;

/** The shape Fastify hands the handler once the body schema has passed. */
interface RedeemBody {
  readonly token: string;
}

/** The shape Fastify hands the handler once the params schema has passed. */
interface SessionParams {
  readonly id: string;
}

/**
 * Registers both routes.
 *
 * Called from inside `server.ts`'s deferred `app.after` block, for the reason recorded
 * there: `@fastify/rate-limit` applies itself through an `onRoute` hook, and a route
 * added before that hook exists is silently unlimited.
 */
export function registerCredentialRoutes(
  app: FastifyInstance,
  options: CredentialRouteOptions,
): void {
  const { redemption, tickets, sessions, clock } = options;

  app.post<{ Body: RedeemBody; Reply: RedeemResponse }>(
    REDEEM_PATH,
    {
      // The one row of the docs/03 §2 limits table that is keyed on the address, because
      // at this point in the request there is no principal to key on and there never
      // will be one before the credential is issued.
      config: { ...rateLimitFor('token_redemption') },
      schema: { body: redeemBodySchema },
    },
    async (request, reply): Promise<RedeemResponse> => {
      const outcome = await redemption.redeem({ token: request.body.token, ip: request.ip });

      if (!outcome.ok) {
        // Every refusal is the same 404 (docs/14 H-120). The reason is in the log line
        // this call writes, under the request id the candidate can quote to support.
        deny(request, outcome.refusal);
      }

      request.log.info(
        {
          event: 'candidate.invitation_redeemed',
          attempt_id: outcome.redemption.attemptId,
          org_id: outcome.redemption.orgId,
          sitting: outcome.redemption.sitting,
        },
        'invitation redeemed for an attempt token',
      );

      void reply.code(200);
      return toRedeemResponse(outcome.redemption, clock.now());
    },
  );

  app.post<{ Params: SessionParams; Reply: TicketResponse }>(
    SESSION_TICKET_PATH,
    {
      config: {
        ...rateLimitFor('staff_api'),
        ...requirePermission('interview.host'),
      },
      schema: { params: sessionParamsSchema },
    },
    async (request, reply): Promise<TicketResponse> => {
      // The authorisation hook has already established that there is a principal and
      // that it holds `interview.host`; a candidate principal holds no permission at all
      // and never reaches this line. Re-reading it here is not a second check, it is how
      // the handler learns which organisation to scope the lookup to.
      const principal = currentPrincipal(request);
      if (principal.kind !== 'staff') {
        deny(request, refuse('ws_ticket', 'wrong_principal'));
      }
      const staff: StaffPrincipal = principal;

      const sessionId: SessionId = SessionIdSchema.parse(request.params.id);
      const session = await sessions.findSession(staff.orgId, sessionId);

      if (session === undefined) {
        // Absent, or another tenant's. One answer for both (docs/14 H-128, ADR-010).
        deny(request, refuse('ws_ticket', 'no_such_session', { session_id: sessionId }));
      }

      if (session.endedAt !== undefined || session.status === 'ended') {
        deny(request, refuse('ws_ticket', 'session_ended', { session_id: sessionId }));
      }

      const issued = tickets.issue(sessionId);
      wsTicketsIssuedTotal.inc();

      request.log.info(
        {
          event: 'interview.ticket_issued',
          session_id: sessionId,
          org_id: staff.orgId,
          user_id: staff.userId,
          expires_in: issued.expiresIn,
        },
        'websocket ticket issued',
      );

      // 200 rather than 201: nothing addressable was created. The ticket *is* the
      // response, it lives sixty seconds, and there is no URL a Location header could
      // point at — a 201 would promise a resource that does not exist.
      void reply.code(200);
      return toTicketResponse(issued, sessionId, clock.now());
    },
  );
}
