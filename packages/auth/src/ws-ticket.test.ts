/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { AttemptIdSchema, OrgIdSchema, SessionIdSchema } from '@assaybank/contracts';
import { describe, expect, it } from 'vitest';

import { issueAttemptToken } from './attempt-token.js';
import { fixedClock } from './clock.js';
import type { AuthError } from './errors.js';
import type { Result } from './result.js';
import { hashToken } from './token.js';
import {
  WS_TICKET_CLOCK_SKEW_SECONDS,
  WS_TICKET_PREFIX,
  WS_TICKET_TTL_SECONDS,
  issueWsTicket,
  verifyWsTicket,
} from './ws-ticket.js';

const SECRET = 'a-local-development-ws-ticket-secret';
const OTHER_SECRET = 'some-other-deployments-ws-ticket-secret';
const PEPPER = 'a-local-development-token-pepper';

const SESSION = SessionIdSchema.parse('55555555-5555-4555-8555-555555555555');
const OTHER_SESSION = SessionIdSchema.parse('66666666-6666-4666-8666-666666666666');
const ATTEMPT = AttemptIdSchema.parse('11111111-1111-4111-8111-111111111111');
const ORG = OrgIdSchema.parse('33333333-3333-4333-8333-333333333333');

const ISSUED_AT = new Date('2026-09-21T09:00:00.000Z');

/** `ISSUED_AT` plus `seconds`, as a clock. */
function clockAt(seconds: number) {
  return fixedClock(new Date(ISSUED_AT.getTime() + seconds * 1000));
}

function reasonOf(result: Result<unknown, AuthError>): string {
  if (result.ok) {
    throw new Error('expected the ticket to be refused, but it verified');
  }
  return result.error.reason;
}

describe('issueWsTicket', () => {
  it('round-trips the session it was issued for', () => {
    const ticket = issueWsTicket({ sessionId: SESSION, issuedAt: ISSUED_AT }, SECRET);
    const result = verifyWsTicket(ticket, SECRET, clockAt(1));

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.sessionId).toBe(SESSION);
    expect(result.value.issuedAt.toISOString()).toBe(ISSUED_AT.toISOString());
  });

  it('accepts the minting call form, which takes the instant from the server clock', () => {
    const ticket = issueWsTicket(SESSION, SECRET, fixedClock(ISSUED_AT));
    const result = verifyWsTicket(ticket, SECRET, clockAt(1));

    expect(result.ok && result.value.issuedAt.toISOString()).toBe(ISSUED_AT.toISOString());
  });

  it('admits the holder to one session and no other', () => {
    const ticket = issueWsTicket({ sessionId: SESSION, issuedAt: ISSUED_AT }, SECRET);
    const result = verifyWsTicket(ticket, SECRET, clockAt(1));

    expect(result.ok && result.value.sessionId).toBe(SESSION);
    expect(result.ok && result.value.sessionId === OTHER_SESSION).toBe(false);
  });

  it('carries its purpose in the clear', () => {
    expect(
      issueWsTicket(SESSION, SECRET, fixedClock(ISSUED_AT)).startsWith(`${WS_TICKET_PREFIX}.`),
    ).toBe(true);
  });

  it('mints a different string every time, so a replay store can key on the ticket', () => {
    // Single use is state, not signature: collab records what it has seen. Two tickets
    // minted for the same session in the same millisecond must therefore not be equal,
    // or the second legitimate one would look like a replay of the first.
    const clock = fixedClock(ISSUED_AT);
    const seen = new Set<string>();

    for (let i = 0; i < 200; i += 1) {
      seen.add(hashToken(issueWsTicket(SESSION, SECRET, clock), PEPPER));
    }

    expect(seen.size).toBe(200);
  });
});

describe('a ticket lives sixty seconds, measured against the injected clock', () => {
  const ticket = issueWsTicket({ sessionId: SESSION, issuedAt: ISSUED_AT }, SECRET);

  it('is accepted the instant it is issued', () => {
    expect(verifyWsTicket(ticket, SECRET, clockAt(0)).ok).toBe(true);
  });

  it('is accepted a second before it lapses', () => {
    expect(verifyWsTicket(ticket, SECRET, clockAt(WS_TICKET_TTL_SECONDS - 1)).ok).toBe(true);
  });

  it('is refused at sixty seconds exactly', () => {
    expect(reasonOf(verifyWsTicket(ticket, SECRET, clockAt(WS_TICKET_TTL_SECONDS)))).toBe(
      'expired',
    );
  });

  it('is refused long afterwards', () => {
    expect(reasonOf(verifyWsTicket(ticket, SECRET, clockAt(3600)))).toBe('expired');
  });

  it('tolerates a couple of seconds of clock drift between the API and collab', () => {
    // Minted by one host, verified by another. NTP drift must not refuse an interview.
    expect(verifyWsTicket(ticket, SECRET, clockAt(-WS_TICKET_CLOCK_SKEW_SECONDS + 1)).ok).toBe(
      true,
    );
  });

  it('refuses a ticket dated meaningfully in the future', () => {
    const fromTheFuture = issueWsTicket(
      { sessionId: SESSION, issuedAt: new Date(ISSUED_AT.getTime() + 3_600_000) },
      SECRET,
    );

    expect(reasonOf(verifyWsTicket(fromTheFuture, SECRET, clockAt(0)))).toBe('not_yet_valid');
  });
});

describe('a forged or foreign ticket is refused', () => {
  const clock = clockAt(1);

  it('refuses a ticket signed with a different secret', () => {
    const ticket = issueWsTicket({ sessionId: SESSION, issuedAt: ISSUED_AT }, OTHER_SECRET);

    expect(reasonOf(verifyWsTicket(ticket, SECRET, clock))).toBe('signature_invalid');
  });

  it('refuses an attempt token presented as a ticket', () => {
    // The two credentials are separate on purpose: a ticket leaked from a URL must not
    // be an attempt credential, and a stolen attempt token must not open a socket.
    const attemptToken = issueAttemptToken(
      { attemptId: ATTEMPT, orgId: ORG, expiresAt: new Date(ISSUED_AT.getTime() + 3_600_000) },
      SECRET,
    );

    expect(reasonOf(verifyWsTicket(attemptToken, SECRET, clock))).toBe('wrong_purpose');
  });

  it.each([
    ['empty', ''],
    ['not an envelope', 'ticket'],
    ['two parts only', `${WS_TICKET_PREFIX}.eyJhIjoxfQ`],
  ])('refuses a %s credential as malformed', (_label, candidate) => {
    expect(reasonOf(verifyWsTicket(candidate, SECRET, clock))).toBe('malformed');
  });
});
