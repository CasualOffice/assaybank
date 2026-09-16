/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The candidate credential model — P1 step 6.
 *
 * ```
 *   invitation token  ──POST /candidate/redeem──▶  attempt token   (one attempt, nothing else)
 *   staff session     ──POST /sessions/{id}/ticket──▶  WS ticket   (one session, 60s, once)
 * ```
 *
 * What lives behind this barrel, and why each piece is separate:
 *
 * | module | what it owns |
 * |---|---|
 * | `keys.ts` | one configured secret → a distinct signing key per surface |
 * | `refusal.ts` | why a credential was refused, and the fact that the caller is never told |
 * | `attempt-token.ts` | token life, header parsing, header → `CandidatePrincipal` |
 * | `redemption.ts` | the redemption *policy*: window, allowance, constant-time confirmation |
 * | `redemption-postgres.ts` | the redemption *transaction*: the lock, the insert, the audit row |
 * | `driver-values.ts` | one copy of how a driver row is narrowed into a domain value |
 * | `single-use.ts` | "accepted exactly once", as one atomic check-and-set |
 * | `ws-ticket.ts` | mint, verify, spend |
 * | `sessions.ts` | does this interview session exist in this tenant, and is it running |
 * | `responses.ts` | the candidate-facing serialisers, typed to their audience |
 * | `routes.ts` | the two endpoints, and the hook that accepts the credential they mint |
 *
 * The split that matters is the third and fourth rows. The policy decides whether
 * somebody sits an assessment and is exhaustively testable in milliseconds against a
 * fake; the transaction is where single use is actually enforced, by a row lock, and is
 * tested against a real PostgreSQL with real row-level security. Neither test would
 * catch the other's bugs, which is exactly why they are two modules.
 */

export { CREDENTIAL_PURPOSES, deriveCredentialKey, deriveCredentialKeys } from './keys.js';
export type { CredentialKeys, CredentialPurpose } from './keys.js';

export {
  candidateCredentialRefusedTotal,
  errorCodeFor,
  REASON_FROM_AUTH,
  recordRefusal,
  refuse,
  REFUSAL_REASONS,
  REFUSAL_SURFACES,
  toApiError,
} from './refusal.js';
export type { Refusal, RefusalLog, RefusalReason, RefusalSurface } from './refusal.js';

export {
  ATTEMPT_TOKEN_START_WINDOW_SECONDS,
  ATTEMPT_TOKEN_TAIL_SECONDS,
  attemptTokenLifeSeconds,
  authenticateAttempt,
  BEARER_SCHEME,
  bearerCredential,
  MAX_ATTEMPT_TOKEN_LIFE_SECONDS,
  mintAttemptToken,
} from './attempt-token.js';
export type {
  AttemptAuthOptions,
  AttemptTokenSubject,
  CandidateAuthentication,
  IssuedAttemptToken,
} from './attempt-token.js';

export {
  createRedemptionService,
  INVITATION_CHANNELS,
  invitationRedemptionDelaySeconds,
  invitationsRedeemedTotal,
  MAX_INVITATION_TOKEN_LENGTH,
} from './redemption.js';
export type {
  AssessmentFacts,
  CreateAttemptInput,
  InvitationChannel,
  LockedInvitation,
  Redemption,
  RedemptionAuditInput,
  RedemptionGateway,
  RedemptionOutcome,
  RedemptionRequest,
  RedemptionService,
  RedemptionServiceOptions,
  RedemptionTransaction,
} from './redemption.js';

export {
  createPostgresRedemptionGateway,
  REDEMPTION_AUDIT_ACTION,
  REDEMPTION_AUDIT_ENTITY,
} from './redemption-postgres.js';
export type { PostgresRedemptionGatewayOptions } from './redemption-postgres.js';

export {
  memorySingleUseStore,
  SINGLE_USE_NAMESPACE,
  singleUseKey,
  valkeySingleUseStore,
} from './single-use.js';
export type {
  ClaimOutcome,
  ObservableSingleUseStore,
  SetIfAbsentClient,
  SingleUseStore,
} from './single-use.js';

export { createWsTicketService, TICKET_REPLAY_RETENTION_MS } from './ws-ticket.js';
export type {
  IssuedWsTicket,
  TicketClaim,
  WsTicketService,
  WsTicketServiceOptions,
} from './ws-ticket.js';

export { createPostgresSessionGateway } from './sessions.js';
export type { SessionAvailability, SessionGateway } from './sessions.js';

export { toRedeemResponse, toTicketResponse } from './responses.js';
export type { CandidateAssessmentSummary, RedeemResponse, TicketResponse } from './responses.js';

export {
  REDEEM_PATH,
  SESSION_TICKET_PATH,
  registerCandidateAuthentication,
  registerCredentialRoutes,
  wsTicketsIssuedTotal,
} from './routes.js';
export type {
  CandidateAuthenticationOptions,
  CandidateCredentialServices,
  CredentialRouteOptions,
} from './routes.js';
