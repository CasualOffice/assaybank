/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The WebSocket ticket (docs/03-API-spec.md §1, CODE-GRAPH `collab` → `auth`).
 *
 * A browser cannot set an `Authorization` header on a WebSocket handshake, so the
 * credential has to travel in the URL — where it lands in proxy logs, browser history and
 * `Referer`. The answer is a credential worth almost nothing if it leaks: it names one
 * session, lives sixty seconds, and is accepted once.
 *
 * **Separate from the attempt token, deliberately.** They are different secrets for
 * different surfaces; a ticket leaked from a URL must not be an attempt credential, and
 * a stolen attempt token must not open a socket.
 *
 * **Checked before the upgrade completes, not after** (P0 step 10). `apps/collab`
 * verifies locally against the signature, with no call back to the API — an interview
 * must not stop working because the API tier is mid-deploy.
 *
 * **Single use is the caller's replay store, and this format makes it cheap.** A
 * signature cannot notice that it has been seen before; only state can. Every ticket
 * carries a nonce, so two tickets minted for the same session in the same millisecond are
 * different strings, and the verifier can key a sixty-second replay entry on
 * `hashToken(ticket, pepper)` — no parsing, no extra identifier, and the stored key is
 * not itself a usable credential.
 */

import { randomBytes } from 'node:crypto';

import { type SessionId, SessionIdSchema } from '@assaybank/contracts';
import { z } from 'zod';

import { type Clock, systemClock } from './clock.js';
import { openEnvelope, sealEnvelope } from './envelope.js';
import { AuthError } from './errors.js';
import { err, ok, type Result } from './result.js';

/** The purpose tag, covered by the signature. Assaybank WebSocket ticket, version 1. */
export const WS_TICKET_PREFIX = 'abwt1';

/** How long a ticket is accepted after it was issued. Sixty seconds, per docs/03 §1. */
export const WS_TICKET_TTL_SECONDS = 60;

/**
 * How far in the future an `issued_at` may sit before the ticket is refused.
 *
 * Tickets are minted by the API and verified by collab, which are different processes and
 * possibly different hosts. A second or two of NTP drift must not refuse a legitimate
 * interview; a ticket dated next week is a manipulated clock and must.
 */
export const WS_TICKET_CLOCK_SKEW_SECONDS = 5;

/** What a ticket asserts: one session, and when it was minted. */
export type WsTicket = {
  /** The single live interview session this ticket admits the holder to. */
  sessionId: SessionId;
  /** When the server minted it. The sixty seconds are counted from here. */
  issuedAt: Date;
};

/** The on-the-wire claim set. `n` is the nonce that makes every ticket distinct. */
const WsTicketClaimsSchema = z.object({
  v: z.literal(1),
  p: z.literal('ws'),
  sid: SessionIdSchema,
  iat: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  n: z.string().min(1).max(64),
});

/** Bytes of nonce. Enough that two tickets never collide; short enough for a URL. */
const NONCE_BYTES = 12;

/**
 * Mints a ticket for one session.
 *
 * Two call forms, because the minting site knows the session and the clock while a test
 * or a re-issue path may already hold the exact `issuedAt` it wants:
 *
 * ```ts
 * issueWsTicket(sessionId, secret, clock);          // server mints "now"
 * issueWsTicket({ sessionId, issuedAt }, secret);   // caller supplies the instant
 * ```
 *
 * `issuedAt` is always a server instant in both forms. Nothing a client sends reaches it.
 */
export function issueWsTicket(ticket: WsTicket, secret: string): string;
export function issueWsTicket(sessionId: SessionId, secret: string, clock: Clock): string;
export function issueWsTicket(
  subject: WsTicket | SessionId,
  secret: string,
  clock: Clock = systemClock,
): string {
  const ticket: WsTicket =
    typeof subject === 'string' ? { sessionId: subject, issuedAt: clock.now() } : subject;

  return sealEnvelope(
    WS_TICKET_PREFIX,
    {
      v: 1,
      p: 'ws',
      sid: ticket.sessionId,
      iat: ticket.issuedAt.getTime(),
      n: randomBytes(NONCE_BYTES).toString('base64url'),
    },
    secret,
  );
}

/**
 * Authenticates a ticket and returns the session it admits the holder to.
 *
 * Signature, then claims, then age — and age is measured against the injected `clock`,
 * so the sixty-second window is a deterministic assertion in a test rather than a sleep.
 *
 * This function does **not** enforce single use: it is pure, and single use is state. The
 * caller records the ticket (see this module's header) and refuses a second presentation
 * before it ever gets here.
 */
export function verifyWsTicket(
  ticket: string,
  secret: string,
  clock: Clock,
): Result<WsTicket, AuthError> {
  const opened = openEnvelope(ticket, WS_TICKET_PREFIX, secret);
  if (!opened.ok) {
    return err(opened.error);
  }

  const parsed = WsTicketClaimsSchema.safeParse(opened.value);
  if (!parsed.success) {
    return err(new AuthError('claims_invalid'));
  }

  const issuedAt = new Date(parsed.data.iat);
  const ageMs = clock.now().getTime() - issuedAt.getTime();

  if (ageMs < -WS_TICKET_CLOCK_SKEW_SECONDS * 1000) {
    return err(new AuthError('not_yet_valid'));
  }

  if (ageMs >= WS_TICKET_TTL_SECONDS * 1000) {
    return err(new AuthError('expired'));
  }

  return ok({ sessionId: parsed.data.sid, issuedAt });
}
