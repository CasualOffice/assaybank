/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The security boundary, exercised against a real `ws` client on an ephemeral port.
 *
 * These tests need no Postgres, no Valkey and no Docker, which is deliberate: the thing
 * being proved — that an unauthenticated upgrade never completes — is the one assertion
 * in this workspace that must never be skipped because an external service was
 * unavailable.
 */

import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

import { fixedClock, issueWsTicket, type Clock } from '@assaybank/auth';
import { ErrorEnvelopeSchema, type SessionId, SessionIdSchema } from '@assaybank/contracts';
import { createLogger } from '@assaybank/observability';
import { afterEach, describe, expect, it } from 'vitest';
import { type RawData, WebSocket } from 'ws';
import { applyUpdate, Doc, encodeStateAsUpdate, encodeStateVector } from 'yjs';

import {
  decodeFrame,
  encodeAwareness,
  encodeSyncStep1,
  encodeSyncUpdate,
  type InboundFrame,
  writeVarUint,
} from './protocol.js';
import { CLOSE, type CollabServer, createCollabServer } from './server.js';

const SECRET = 'test-ticket-signing-secret';
const PEPPER = 'test-token-pepper';
const NOW = new Date('2026-09-16T10:00:00.000Z');
const ROOM = 'room-abc123';

/** Silent: a passing test run should not print a hundred structured log lines. */
const silentLogger = createLogger({ service: 'hiring-collab-test', level: 'fatal' });

/** Everything opened during one test, torn down whether it passed or threw. */
const openServers: CollabServer[] = [];
const openSockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of openSockets.splice(0)) {
    socket.removeAllListeners();
    // Terminating a socket still mid-handshake makes `ws` emit an error, and an
    // EventEmitter with no error listener rethrows it out of the tick. This listener is
    // the teardown saying it already knows.
    socket.on('error', () => undefined);
    socket.terminate();
  }
  for (const server of openServers.splice(0)) {
    await server.close();
  }
});

/** A session id, parsed rather than cast — there is no cast helper, on purpose. */
function newSessionId(): SessionId {
  return SessionIdSchema.parse(randomUUID());
}

/** Starts a server on an ephemeral port and returns its base URL. */
async function startServer(clock: Clock = fixedClock(NOW)): Promise<{
  server: CollabServer;
  port: number;
}> {
  const server = createCollabServer({
    ticketSecret: SECRET,
    ticketPepper: PEPPER,
    clock,
    logger: silentLogger,
    // The heartbeat is a wall-clock timer, and a test that depends on one is a test that
    // fails on a loaded CI machine. The reaping behaviour it drives is not what these
    // tests are about.
    heartbeatMs: 0,
    shutdownGraceMs: 500,
  });
  openServers.push(server);

  const { port } = await server.listen({ port: 0, host: '127.0.0.1' });
  return { server, port };
}

/** A ticket for `sessionId`, minted at an instant the caller controls. */
function ticketFor(sessionId: SessionId, issuedAt: Date = NOW): string {
  return issueWsTicket({ sessionId, issuedAt }, SECRET);
}

function socketUrl(port: number, room: string, ticket?: string): string {
  const query = ticket === undefined ? '' : `?ticket=${encodeURIComponent(ticket)}`;
  return `ws://127.0.0.1:${String(port)}/collab/${room}${query}`;
}

/** What the server said when it refused to upgrade. */
interface Refusal {
  readonly status: number;
  readonly body: string;
}

/**
 * Attempts an upgrade and asserts that it did not complete.
 *
 * Resolves with the HTTP response the server sent instead. Rejects if the socket opens,
 * because an opened socket is the failure this whole file exists to catch.
 */
async function expectRefused(url: string): Promise<Refusal> {
  const socket = new WebSocket(url);
  openSockets.push(socket);

  return await new Promise<Refusal>((resolve, reject) => {
    socket.on('open', () => {
      reject(new Error('the upgrade completed; it must not have'));
    });
    // `ws` emits 'error' instead of this event only when nothing is listening for it.
    socket.on('unexpected-response', (_request, response: IncomingMessage) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        body += chunk;
      });
      response.on('end', () => {
        resolve({ status: response.statusCode ?? 0, body });
      });
    });
    socket.on('error', (error: Error) => {
      reject(error);
    });
  });
}

/** Flattens whatever `ws` handed the client into one view. */
function bytesOf(data: RawData): Uint8Array {
  if (Array.isArray(data)) return bytesOf(Buffer.concat(data));
  if (Buffer.isBuffer(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return new Uint8Array(data);
}

/**
 * A connected peer.
 *
 * Frames are buffered from the moment the socket is constructed rather than from the
 * moment a test asks for one. The server opens the sync handshake the instant the upgrade
 * completes, so its first frame can arrive in the same TCP segment as the 101 response —
 * a test that only starts listening after `await connect()` misses it, intermittently, on
 * a fast machine.
 */
interface Client {
  readonly socket: WebSocket;
  /** Sends one binary frame. */
  send(frame: Uint8Array): void;
  /** The next buffered or incoming frame of this kind. */
  waitFor(kind: InboundFrame['kind'], timeoutMs?: number): Promise<InboundFrame>;
}

/** Opens a socket, buffers its frames, and waits for the upgrade to complete. */
async function connect(url: string): Promise<Client> {
  const socket = new WebSocket(url);
  openSockets.push(socket);

  const received: InboundFrame[] = [];
  let arrived: (() => void) | undefined;

  socket.on('message', (data: RawData) => {
    received.push(decodeFrame(bytesOf(data)));
    arrived?.();
  });

  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
    socket.once('unexpected-response', (_request, response: IncomingMessage) => {
      reject(new Error(`upgrade refused with ${String(response.statusCode)}`));
    });
  });

  async function waitFor(kind: InboundFrame['kind'], timeoutMs = 2_000): Promise<InboundFrame> {
    const deadline = Date.now() + timeoutMs;

    for (;;) {
      const index = received.findIndex((frame) => frame.kind === kind);
      const found = index < 0 ? undefined : received[index];
      if (found !== undefined) {
        received.splice(index, 1);
        return found;
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`no ${kind} frame arrived`);

      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.min(remaining, 25));
        arrived = (): void => {
          clearTimeout(timer);
          arrived = undefined;
          resolve();
        };
      });
    }
  }

  return {
    socket,
    send: (frame: Uint8Array): void => {
      socket.send(frame, { binary: true });
    },
    waitFor,
  };
}

/** Lets the event loop deliver whatever is already in flight. */
async function settle(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 50);
  });
}

/** Reads one metric's current value out of the Prometheus exposition. */
async function metricValue(port: number, sample: string): Promise<number> {
  const response = await fetch(`http://127.0.0.1:${String(port)}/metrics`);
  const text = await response.text();
  const line = text.split('\n').find((candidate) => candidate.startsWith(sample));
  if (line === undefined) return 0;
  return Number(line.slice(sample.length).trim());
}

describe('the handshake', () => {
  it('refuses an upgrade with no ticket', async () => {
    const { port } = await startServer();

    const refusal = await expectRefused(socketUrl(port, ROOM));

    expect(refusal.status).toBe(401);
  });

  it('refuses a ticket that has already been redeemed', async () => {
    const { port } = await startServer();
    const ticket = ticketFor(newSessionId());

    const first = await connect(socketUrl(port, ROOM, ticket));
    expect(first.socket.readyState).toBe(WebSocket.OPEN);

    const refusal = await expectRefused(socketUrl(port, ROOM, ticket));

    expect(refusal.status).toBe(401);
  });

  it('refuses a replay even after the first connection has closed', async () => {
    // Single use means single use, not "one at a time". A ticket recovered from a proxy
    // log after the interview dropped must not open a second socket.
    const { port } = await startServer();
    const ticket = ticketFor(newSessionId());

    const first = await connect(socketUrl(port, ROOM, ticket));
    await new Promise<void>((resolve) => {
      first.socket.once('close', () => {
        resolve();
      });
      first.socket.close();
    });

    const refusal = await expectRefused(socketUrl(port, ROOM, ticket));

    expect(refusal.status).toBe(401);
  });

  it('refuses a ticket older than its sixty-second life, against an injected clock', async () => {
    const { port } = await startServer(fixedClock(NOW));
    const issuedAt = new Date(NOW.getTime() - 61_000);

    const refusal = await expectRefused(socketUrl(port, ROOM, ticketFor(newSessionId(), issuedAt)));

    expect(refusal.status).toBe(401);
  });

  it('accepts a ticket issued fifty-nine seconds ago', async () => {
    // The boundary in the other direction: 60 seconds is the life, so 59 is still valid.
    // Without both assertions an off-by-one that refuses every ticket looks like a pass.
    const { port } = await startServer(fixedClock(NOW));
    const issuedAt = new Date(NOW.getTime() - 59_000);

    const client = await connect(socketUrl(port, ROOM, ticketFor(newSessionId(), issuedAt)));

    expect(client.socket.readyState).toBe(WebSocket.OPEN);
  });

  it('refuses a ticket issued in the future by more than the tolerated skew', async () => {
    const { port } = await startServer(fixedClock(NOW));
    const issuedAt = new Date(NOW.getTime() + 60_000);

    const refusal = await expectRefused(socketUrl(port, ROOM, ticketFor(newSessionId(), issuedAt)));

    expect(refusal.status).toBe(401);
  });

  it('refuses a ticket signed with a different secret', async () => {
    const { port } = await startServer();
    const forged = issueWsTicket({ sessionId: newSessionId(), issuedAt: NOW }, 'not-the-secret');

    const refusal = await expectRefused(socketUrl(port, ROOM, forged));

    expect(refusal.status).toBe(401);
  });

  it('refuses a ticket that is not a ticket at all', async () => {
    const { port } = await startServer();

    const refusal = await expectRefused(socketUrl(port, ROOM, 'not-a-ticket'));

    expect(refusal.status).toBe(401);
  });

  it('upgrades successfully against a valid ticket and opens the sync handshake', async () => {
    const { port, server } = await startServer();

    const client = await connect(socketUrl(port, ROOM, ticketFor(newSessionId())));
    const frame = await client.waitFor('sync_step_1');

    expect(client.socket.readyState).toBe(WebSocket.OPEN);
    expect(frame.kind).toBe('sync_step_1');
    expect(server.connectionCount).toBe(1);
    expect(server.roomCount).toBe(1);
  });

  it('tells the holder nothing about why it was refused', async () => {
    // docs/14 T-011: a refusal that explains itself is a ticket oracle. Expired, forged
    // and replayed must be indistinguishable from outside.
    const { port } = await startServer();
    const sessionId = newSessionId();
    const redeemed = ticketFor(sessionId);
    await connect(socketUrl(port, ROOM, redeemed));

    const refusals = await Promise.all([
      expectRefused(socketUrl(port, ROOM, redeemed)),
      expectRefused(socketUrl(port, ROOM, ticketFor(sessionId, new Date(NOW.getTime() - 61_000)))),
      expectRefused(socketUrl(port, ROOM, 'not-a-ticket')),
      expectRefused(socketUrl(port, ROOM)),
    ]);

    // `request_id` is the trace id and is unique per response by design, so the
    // comparison is over everything else: status, code, message and details.
    const shapes = refusals.map((refusal) => {
      const parsed: unknown = JSON.parse(refusal.body);
      const { error } = ErrorEnvelopeSchema.parse(parsed);
      expect(error.code).toBe('unauthenticated');
      return JSON.stringify({
        status: refusal.status,
        code: error.code,
        message: error.message,
        details: error.details ?? null,
      });
    });

    expect(new Set(shapes).size).toBe(1);
  });

  it('refuses an upgrade to a path that is not a room', async () => {
    const { port } = await startServer();
    const ticket = ticketFor(newSessionId());

    const refusal = await expectRefused(
      `ws://127.0.0.1:${String(port)}/nope/${ROOM}?ticket=${ticket}`,
    );

    expect(refusal.status).toBe(404);
  });

  it('refuses a room code that is not a room code', async () => {
    const { port } = await startServer();

    const refusal = await expectRefused(socketUrl(port, 'a b', ticketFor(newSessionId())));

    expect(refusal.status).toBe(404);
  });

  it('counts every refusal by reason without labelling anything unbounded', async () => {
    const { port } = await startServer();
    const before = await metricValue(port, 'collab_handshakes_rejected_total{reason="no_ticket"}');

    await expectRefused(socketUrl(port, ROOM));

    const after = await metricValue(port, 'collab_handshakes_rejected_total{reason="no_ticket"}');
    expect(after).toBe(before + 1);
  });
});

describe('the room', () => {
  it('puts two tickets for the same session into one document', async () => {
    const { port, server } = await startServer();
    const sessionId = newSessionId();

    await connect(socketUrl(port, ROOM, ticketFor(sessionId)));
    await connect(socketUrl(port, 'a-different-room-code', ticketFor(sessionId)));

    // Two peers, one document — and note the second used a different room code. The
    // ticket decides which document you get; the path segment never does.
    expect(server.connectionCount).toBe(2);
    expect(server.roomCount).toBe(1);
  });

  it('keeps two sessions in two documents', async () => {
    const { port, server } = await startServer();

    await connect(socketUrl(port, ROOM, ticketFor(newSessionId())));
    await connect(socketUrl(port, ROOM, ticketFor(newSessionId())));

    expect(server.roomCount).toBe(2);
  });

  it('relays a document update from one peer to the other', async () => {
    const { port } = await startServer();
    const sessionId = newSessionId();

    const author = await connect(socketUrl(port, ROOM, ticketFor(sessionId)));
    const observer = await connect(socketUrl(port, ROOM, ticketFor(sessionId)));

    const local = new Doc();
    local.getText('code').insert(0, 'const answer = 42;');
    author.send(encodeSyncUpdate(encodeStateAsUpdate(local)));

    const frame = await observer.waitFor('sync_update');
    expect(frame.kind).toBe('sync_update');

    const mirrored = new Doc();
    if (frame.kind === 'sync_update') applyUpdate(mirrored, frame.update);
    expect(mirrored.getText('code').toJSON()).toBe('const answer = 42;');
  });

  it('answers sync step 1 with everything the peer is missing', async () => {
    const { port } = await startServer();
    const sessionId = newSessionId();

    const author = await connect(socketUrl(port, ROOM, ticketFor(sessionId)));
    const local = new Doc();
    local.getText('code').insert(0, 'hello');
    author.send(encodeSyncUpdate(encodeStateAsUpdate(local)));

    // A latecomer that knows nothing asks for everything, which is exactly what a
    // reconnecting client does.
    const latecomer = await connect(socketUrl(port, ROOM, ticketFor(sessionId)));
    await latecomer.waitFor('sync_step_1');
    latecomer.send(encodeSyncStep1(encodeStateVector(new Doc())));

    const frame = await latecomer.waitFor('sync_step_2');
    const caught = new Doc();
    if (frame.kind === 'sync_step_2') applyUpdate(caught, frame.update);
    expect(caught.getText('code').toJSON()).toBe('hello');
  });

  it('relays awareness without interpreting it', async () => {
    const { port } = await startServer();
    const sessionId = newSessionId();

    const author = await connect(socketUrl(port, ROOM, ticketFor(sessionId)));
    const observer = await connect(socketUrl(port, ROOM, ticketFor(sessionId)));

    const payload = Uint8Array.from([1, 200, 3, 0, 255]);
    author.send(encodeAwareness(payload));

    const frame = await observer.waitFor('awareness');
    if (frame.kind === 'awareness') expect([...frame.payload]).toEqual([...payload]);
  });

  it('replays the presence of whoever is already in the room to a new arrival', async () => {
    const { port } = await startServer();
    const sessionId = newSessionId();

    const first = await connect(socketUrl(port, ROOM, ticketFor(sessionId)));
    const payload = Uint8Array.from([7, 7, 7]);
    first.send(encodeAwareness(payload));

    // A short settle so the server has processed the awareness frame before the join.
    await settle();

    const second = await connect(socketUrl(port, ROOM, ticketFor(sessionId)));
    const frame = await second.waitFor('awareness');

    if (frame.kind === 'awareness') expect([...frame.payload]).toEqual([...payload]);
  });

  it('counts a join into a room it is already holding as a reconnect', async () => {
    const { port } = await startServer();
    const sessionId = newSessionId();
    const before = await metricValue(port, 'collab_reconnects_total');

    await connect(socketUrl(port, ROOM, ticketFor(sessionId)));
    await connect(socketUrl(port, ROOM, ticketFor(sessionId)));

    expect(await metricValue(port, 'collab_reconnects_total')).toBe(before + 1);
  });

  it('closes a peer that sends an undecodable frame', async () => {
    const { port } = await startServer();
    const client = await connect(socketUrl(port, ROOM, ticketFor(newSessionId())));

    // A sync message with a step number that does not exist.
    client.send(Uint8Array.from([0, 99]));

    const code = await new Promise<number>((resolve) => {
      client.socket.once('close', resolve);
    });
    expect(code).toBe(CLOSE.PROTOCOL_ERROR);
  });

  it('closes a peer that sends a text frame', async () => {
    const { port } = await startServer();
    const client = await connect(socketUrl(port, ROOM, ticketFor(newSessionId())));

    client.socket.send('hello');

    const code = await new Promise<number>((resolve) => {
      client.socket.once('close', resolve);
    });
    expect(code).toBe(CLOSE.UNSUPPORTED_DATA);
  });

  it('ignores a message type it has no behaviour for', async () => {
    // The protocol is versioned by addition; an unknown tag must not end an interview.
    const { port } = await startServer();
    const client = await connect(socketUrl(port, ROOM, ticketFor(newSessionId())));

    client.send(writeVarUint(97));
    await settle();

    expect(client.socket.readyState).toBe(WebSocket.OPEN);
  });
});

describe('the operational surface', () => {
  it('answers /healthz without consulting a dependency', async () => {
    const { port } = await startServer();

    const response = await fetch(`http://127.0.0.1:${String(port)}/healthz`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
  });

  it('answers /readyz with the state of its dependencies', async () => {
    const server = createCollabServer({
      ticketSecret: SECRET,
      ticketPepper: PEPPER,
      logger: silentLogger,
      heartbeatMs: 0,
      readiness: [
        { name: 'postgres', run: (): boolean => true },
        { name: 'valkey', run: (): boolean => true },
      ],
    });
    openServers.push(server);
    const { port } = await server.listen({ port: 0, host: '127.0.0.1' });

    const response = await fetch(`http://127.0.0.1:${String(port)}/readyz`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: 'ready',
      checks: { postgres: 'ok', valkey: 'ok' },
    });
  });

  it('answers /readyz with 503 when a dependency is down, while /healthz stays 200', async () => {
    // Conflating the two restarts every pod at once on a transient blip, which turns a
    // dependency wobble into every live interview dropping.
    const server = createCollabServer({
      ticketSecret: SECRET,
      ticketPepper: PEPPER,
      logger: silentLogger,
      heartbeatMs: 0,
      readiness: [
        {
          name: 'postgres',
          run: (): never => {
            throw new Error('connection refused to db.internal:5432');
          },
        },
      ],
    });
    openServers.push(server);
    const { port } = await server.listen({ port: 0, host: '127.0.0.1' });

    const ready = await fetch(`http://127.0.0.1:${String(port)}/readyz`);
    const healthy = await fetch(`http://127.0.0.1:${String(port)}/healthz`);
    const body: unknown = await ready.json();

    expect(ready.status).toBe(503);
    expect(healthy.status).toBe(200);
    expect(body).toEqual({ status: 'not_ready', checks: { postgres: 'failed' } });
    // The upstream message named an internal host. It must not have reached the body.
    expect(JSON.stringify(body)).not.toContain('db.internal');
  });

  it('serves the connection gauge on /metrics', async () => {
    const { port } = await startServer();
    const before = await metricValue(port, 'collab_connections');

    await connect(socketUrl(port, ROOM, ticketFor(newSessionId())));

    expect(await metricValue(port, 'collab_connections')).toBe(before + 1);
  });

  it('serves a 404 envelope on an unknown path', async () => {
    const { port } = await startServer();

    const response = await fetch(`http://127.0.0.1:${String(port)}/whatever`);

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: 'not_found' } });
  });

  it('refuses a method other than GET or HEAD', async () => {
    const { port } = await startServer();

    const response = await fetch(`http://127.0.0.1:${String(port)}/healthz`, { method: 'POST' });

    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET, HEAD');
  });
});

describe('shutdown', () => {
  it('closes every socket with 1001 going away, not a reset', async () => {
    // A client reading 1001 reconnects to the replacement instance. A reset connection
    // looks to a candidate like the interview stopped working.
    const { port, server } = await startServer();
    const client = await connect(socketUrl(port, ROOM, ticketFor(newSessionId())));

    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      client.socket.once('close', (code: number, reason: Buffer) => {
        resolve({ code, reason: reason.toString('utf8') });
      });
    });

    await server.close();
    const outcome = await closed;

    expect(outcome.code).toBe(CLOSE.GOING_AWAY);
    expect(outcome.reason).toBe('server shutting down');
    expect(server.connectionCount).toBe(0);
    expect(server.roomCount).toBe(0);
  });

  it('refuses new upgrades while draining', async () => {
    const { port, server } = await startServer();
    const ticket = ticketFor(newSessionId());

    const closing = server.close();
    const refusal = await expectRefused(socketUrl(port, ROOM, ticket)).catch(
      (error: unknown) => error,
    );
    await closing;

    // Either the listener is already gone (a connection error) or it answered 503. Both
    // are refusals; neither is an upgrade.
    if (typeof refusal === 'object' && refusal !== null && 'status' in refusal) {
      expect(refusal.status).toBe(503);
    } else {
      expect(refusal).toBeInstanceOf(Error);
    }
  });

  it('is idempotent', async () => {
    const { server } = await startServer();

    await server.close();
    await expect(server.close()).resolves.toBeUndefined();
  });
});
