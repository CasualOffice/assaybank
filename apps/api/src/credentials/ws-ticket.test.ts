/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The three properties of a ticket: one session, sixty seconds, one use.
 *
 * The third is the one that needs state and is therefore the one that can regress
 * silently, so it is asserted from four directions: a straight replay, a race, a replay
 * after the store has been told a different key, and the shape of what the store actually
 * holds — a peppered hash rather than the credential (docs/14 `T-013`, `H-122`).
 */

import { hashToken, issueAttemptToken, WS_TICKET_TTL_SECONDS } from '@assaybank/auth';
import { AttemptIdSchema, OrgIdSchema, SessionIdSchema } from '@assaybank/contracts';
import { describe, expect, it } from 'vitest';

import { deriveCredentialKeys } from './keys.js';
import { memorySingleUseStore } from './single-use.js';
import { createWsTicketService, TICKET_REPLAY_RETENTION_MS } from './ws-ticket.js';

const KEYS = deriveCredentialKeys({
  sessionSecret: 'a-session-secret-for-the-ticket-tests',
  tokenPepper: 'a-token-pepper-for-the-ticket-tests',
});

const SESSION = SessionIdSchema.parse('44444444-4444-4444-8444-444444444444');
const OTHER_SESSION = SessionIdSchema.parse('55555555-5555-4555-8555-555555555555');
const NOW = new Date('2026-10-12T09:00:00.000Z');

/** A service whose clock the test moves, sharing one replay store across the movement. */
function serviceAt(instant: { value: Date }): ReturnType<typeof createWsTicketService> {
  return createWsTicketService({
    signingKey: KEYS.wsTicket,
    pepper: KEYS.pepper,
    clock: { now: (): Date => instant.value },
    store: memorySingleUseStore({ now: (): Date => instant.value }),
  });
}

describe('issue', () => {
  it('mints a ticket that says it lives for sixty seconds', () => {
    const issued = serviceAt({ value: NOW }).issue(SESSION);

    expect(issued.expiresIn).toBe(WS_TICKET_TTL_SECONDS);
    expect(issued.expiresIn).toBe(60);
    expect(issued.ticket.length).toBeGreaterThan(0);
  });

  it('never mints the same ticket twice, even in the same millisecond', () => {
    const service = serviceAt({ value: NOW });

    const tickets = new Set(Array.from({ length: 8 }, () => service.issue(SESSION).ticket));

    // Every ticket carries a nonce. Without one, two tickets minted for one session in
    // one millisecond would be the same string, and claiming either would spend both.
    expect(tickets.size).toBe(8);
  });
});

describe('claim', () => {
  it('admits the holder to the session the ticket names', async () => {
    const instant = { value: NOW };
    const service = serviceAt(instant);
    const issued = service.issue(SESSION);

    const claim = await service.claim(issued.ticket);

    expect(claim.ok).toBe(true);
    if (!claim.ok) return;
    expect(claim.ticket.sessionId).toBe(SESSION);
    expect(claim.ticket.issuedAt.toISOString()).toBe(NOW.toISOString());
  });

  it('refuses a reused ticket', async () => {
    const instant = { value: NOW };
    const service = serviceAt(instant);
    const issued = service.issue(SESSION);

    await expect(service.claim(issued.ticket)).resolves.toMatchObject({ ok: true });

    const second = await service.claim(issued.ticket);
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.refusal).toMatchObject({ surface: 'ws_ticket', reason: 'replayed' });
  });

  it('admits exactly one of two connections racing with the same ticket', async () => {
    const instant = { value: NOW };
    const service = serviceAt(instant);
    const issued = service.issue(SESSION);

    const claims = await Promise.all([
      service.claim(issued.ticket),
      service.claim(issued.ticket),
      service.claim(issued.ticket),
    ]);

    expect(claims.filter((claim) => claim.ok)).toHaveLength(1);
  });

  it('still refuses the reuse for as long as the signature could have verified', async () => {
    const instant = { value: NOW };
    const service = serviceAt(instant);
    const issued = service.issue(SESSION);
    await service.claim(issued.ticket);

    // One millisecond short of the retention window. The ticket has expired on age by
    // now, so the refusal has switched reasons — but it is still a refusal, which is the
    // property. Nothing in the window between the two mechanisms admits it.
    instant.value = new Date(NOW.getTime() + TICKET_REPLAY_RETENTION_MS - 1);

    const late = await service.claim(issued.ticket);
    expect(late.ok).toBe(false);
  });

  it('spends a second ticket for the same session independently', async () => {
    const instant = { value: NOW };
    const service = serviceAt(instant);

    const first = service.issue(SESSION);
    const second = service.issue(SESSION);

    await expect(service.claim(first.ticket)).resolves.toMatchObject({ ok: true });
    // A reconnection asks for a new ticket; spending the first must not spend the second.
    await expect(service.claim(second.ticket)).resolves.toMatchObject({ ok: true });
  });

  it('refuses a ticket that has aged past sixty seconds, against the injected clock', async () => {
    const instant = { value: NOW };
    const service = serviceAt(instant);
    const issued = service.issue(SESSION);

    instant.value = new Date(NOW.getTime() + WS_TICKET_TTL_SECONDS * 1000 - 1);
    await expect(service.claim(issued.ticket)).resolves.toMatchObject({ ok: true });

    const later = serviceAt(instant);
    const fresh = later.issue(SESSION);
    instant.value = new Date(instant.value.getTime() + WS_TICKET_TTL_SECONDS * 1000);

    const expired = await later.claim(fresh.ticket);
    expect(expired.ok).toBe(false);
    if (expired.ok) return;
    expect(expired.refusal.reason).toBe('expired');
  });

  it('refuses an attempt token presented as a ticket', async () => {
    const service = serviceAt({ value: NOW });

    const attemptToken = issueAttemptToken(
      {
        attemptId: AttemptIdSchema.parse('11111111-1111-4111-8111-111111111111'),
        orgId: OrgIdSchema.parse('33333333-3333-4333-8333-333333333333'),
        expiresAt: new Date(NOW.getTime() + 3_600_000),
      },
      KEYS.attemptToken,
    );

    const claim = await service.claim(attemptToken);
    expect(claim.ok).toBe(false);
    if (claim.ok) return;
    expect(claim.refusal.reason).toBe('wrong_purpose');
  });

  it('refuses a forged ticket without touching the replay store', async () => {
    const instant = { value: NOW };
    const store = memorySingleUseStore({ now: (): Date => instant.value });
    const service = createWsTicketService({
      signingKey: KEYS.wsTicket,
      pepper: KEYS.pepper,
      clock: { now: (): Date => instant.value },
      store,
    });

    const forged = await service.claim('abwt1.ZmFrZQ.0000');
    expect(forged.ok).toBe(false);

    // Nothing unauthenticated reaches the store — otherwise anyone able to reach the
    // socket could fill it with arbitrary strings.
    expect(store.size).toBe(0);
  });

  it('stores a peppered hash rather than the ticket itself', async () => {
    const instant = { value: NOW };
    const store = memorySingleUseStore({ now: (): Date => instant.value });
    const service = createWsTicketService({
      signingKey: KEYS.wsTicket,
      pepper: KEYS.pepper,
      clock: { now: (): Date => instant.value },
      store,
    });

    const issued = service.issue(OTHER_SESSION);
    await service.claim(issued.ticket);

    // Claiming the hash directly is refused, which is only possible if the hash is the
    // key — and a dump of the store therefore yields no usable credential.
    await expect(store.claim(hashToken(issued.ticket, KEYS.pepper), 1000)).resolves.toBe(
      'replayed',
    );
    await expect(store.claim(issued.ticket, 1000)).resolves.toBe('claimed');
  });

  it('refuses a ticket signed with the attempt-token key', async () => {
    const instant = { value: NOW };
    const wrongKeyService = createWsTicketService({
      signingKey: KEYS.attemptToken,
      pepper: KEYS.pepper,
      clock: { now: (): Date => instant.value },
      store: memorySingleUseStore({ now: (): Date => instant.value }),
    });

    const issued = wrongKeyService.issue(SESSION);
    const claim = await serviceAt(instant).claim(issued.ticket);

    expect(claim.ok).toBe(false);
    if (claim.ok) return;
    expect(claim.refusal.reason).toBe('signature_invalid');
  });
});
