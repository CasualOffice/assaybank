/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Single-use tickets against a real Valkey.
 *
 * docs/14 `T-013` is explicit that this is where the property lives: *"single-use is the
 * control, and it must be enforced atomically in Valkey — a check-then-delete race under
 * reconnection storms is how single-use quietly becomes multi-use."* An in-memory fake
 * cannot demonstrate that, because a single-threaded fake makes every implementation look
 * atomic. What is tested here is the real command against the real server:
 *
 * - a `SET … NX` that a second caller loses,
 * - thirty simultaneous claims producing exactly one winner,
 * - the key expiring on its own so the store cannot grow without bound,
 * - and the stored key being a peppered hash rather than the credential, which is what
 *   makes a Valkey dump worthless to whoever obtains it.
 */

import { Redis } from 'ioredis';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { fixedClock, hashToken, WS_TICKET_TTL_SECONDS } from '@assaybank/auth';
import { SessionIdSchema } from '@assaybank/contracts';

import { deriveCredentialKeys } from '../../src/credentials/keys.js';
import { SINGLE_USE_NAMESPACE, valkeySingleUseStore } from '../../src/credentials/single-use.js';
import { createWsTicketService } from '../../src/credentials/ws-ticket.js';

/** The image docker-compose.yml runs, so the command is tested against the real server. */
const VALKEY_IMAGE = 'valkey/valkey:8-alpine';

const BOOT_TIMEOUT_MS = 180_000;

const KEYS = deriveCredentialKeys({
  sessionSecret: 'an-integration-session-secret-for-tickets',
  tokenPepper: 'an-integration-token-pepper-for-tickets',
});

const SESSION = SessionIdSchema.parse('44444444-4444-4444-8444-444444444444');
const NOW = new Date('2026-10-12T09:00:00.000Z');

let container: StartedTestContainer;
let valkey: Redis;

beforeAll(async () => {
  container = await new GenericContainer(VALKEY_IMAGE).withExposedPorts(6379).start();
  valkey = new Redis({
    host: container.getHost(),
    port: container.getMappedPort(6379),
    maxRetriesPerRequest: 2,
  });
}, BOOT_TIMEOUT_MS);

afterAll(async () => {
  valkey?.disconnect();
  await container?.stop();
}, BOOT_TIMEOUT_MS);

/** A service sharing the container, with the clock frozen at `instant`. */
function serviceAt(instant: { value: Date }): ReturnType<typeof createWsTicketService> {
  return createWsTicketService({
    signingKey: KEYS.wsTicket,
    pepper: KEYS.pepper,
    clock: { now: (): Date => instant.value },
    store: valkeySingleUseStore(valkey),
  });
}

describe('the claim, against Valkey', () => {
  it('admits the first presentation of a ticket and refuses the second', async () => {
    const service = serviceAt({ value: NOW });
    const issued = service.issue(SESSION);

    const first = await service.claim(issued.ticket);
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.ticket.sessionId).toBe(SESSION);

    const second = await service.claim(issued.ticket);
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.refusal.reason).toBe('replayed');
  });

  it('admits exactly one of thirty simultaneous claims', async () => {
    // The reconnection storm of T-013, as thirty in-flight commands against one key.
    // `SET … NX` decides at the server, so there is no window between the check and the
    // write for a second connection to slip through.
    const service = serviceAt({ value: NOW });
    const issued = service.issue(SESSION);

    const claims = await Promise.all(
      Array.from({ length: 30 }, () => service.claim(issued.ticket)),
    );

    expect(claims.filter((claim) => claim.ok)).toHaveLength(1);
    expect(claims.filter((claim) => !claim.ok)).toHaveLength(29);
  });

  it('stores a peppered hash under the namespace, never the ticket', async () => {
    const service = serviceAt({ value: NOW });
    const issued = service.issue(SESSION);
    await service.claim(issued.ticket);

    const expected = `${SINGLE_USE_NAMESPACE}:${hashToken(issued.ticket, KEYS.pepper)}`;

    await expect(valkey.exists(expected)).resolves.toBe(1);
    // The credential itself is nowhere in the keyspace, so a dump yields nothing usable.
    await expect(valkey.exists(`${SINGLE_USE_NAMESPACE}:${issued.ticket}`)).resolves.toBe(0);
  });

  it('gives the entry an expiry, so the replay set cannot grow without bound', async () => {
    const service = serviceAt({ value: NOW });
    const issued = service.issue(SESSION);
    await service.claim(issued.ticket);

    const ttl = await valkey.pttl(
      `${SINGLE_USE_NAMESPACE}:${hashToken(issued.ticket, KEYS.pepper)}`,
    );

    expect(ttl).toBeGreaterThan(0);
    // The ticket's whole accepted life plus the tolerated skew, and not more: after that
    // the signature refuses it on age and remembering it buys nothing.
    expect(ttl).toBeLessThanOrEqual((WS_TICKET_TTL_SECONDS + 5) * 1000);
  });

  it('keeps two tickets for one session independent', async () => {
    const service = serviceAt({ value: NOW });
    const first = service.issue(SESSION);
    const second = service.issue(SESSION);

    await expect(service.claim(first.ticket)).resolves.toMatchObject({ ok: true });
    await expect(service.claim(second.ticket)).resolves.toMatchObject({ ok: true });
  });

  it('refuses an aged ticket against the injected clock, without writing to the store', async () => {
    const instant = { value: NOW };
    const service = serviceAt(instant);
    const issued = service.issue(SESSION);

    instant.value = new Date(NOW.getTime() + WS_TICKET_TTL_SECONDS * 1000);

    const claim = await service.claim(issued.ticket);
    expect(claim.ok).toBe(false);
    if (claim.ok) return;
    expect(claim.refusal.reason).toBe('expired');

    // Verification comes before the claim, so nothing unauthenticated — and nothing dead —
    // reaches the keyspace.
    await expect(
      valkey.exists(`${SINGLE_USE_NAMESPACE}:${hashToken(issued.ticket, KEYS.pepper)}`),
    ).resolves.toBe(0);
  });

  it('refuses a forged ticket without writing to the store', async () => {
    const before = await valkey.dbsize();

    const claim = await serviceAt({ value: NOW }).claim('abwt1.Zm9yZ2Vk.deadbeef');
    expect(claim.ok).toBe(false);

    await expect(valkey.dbsize()).resolves.toBe(before);
  });

  it('refuses a ticket minted under another deployment’s key', async () => {
    const elsewhere = createWsTicketService({
      signingKey: deriveCredentialKeys({
        sessionSecret: 'another-deployments-session-secret',
        tokenPepper: KEYS.pepper,
      }).wsTicket,
      pepper: KEYS.pepper,
      clock: fixedClock(NOW),
      store: valkeySingleUseStore(valkey),
    });

    const issued = elsewhere.issue(SESSION);
    const claim = await serviceAt({ value: NOW }).claim(issued.ticket);

    expect(claim.ok).toBe(false);
    if (claim.ok) return;
    expect(claim.refusal.reason).toBe('signature_invalid');
  });
});
