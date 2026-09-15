/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The collaboration service (P0 step 10, HLD §3.3, ADR-005).
 *
 * ## The one thing this file exists to get right
 *
 * **The ticket is verified before the upgrade completes, not after.** `wss` is built with
 * `noServer: true` and this module owns the `upgrade` event, so a request that fails
 * authentication is answered with a plain HTTP `401` and its socket is destroyed — no
 * WebSocket is ever constructed for it, no `connection` handler ever runs, and there is no
 * "authenticated" flag on a live socket that some later handler could forget to check.
 *
 * That is a structural choice rather than a stylistic one. A service that begins life
 * accepting unauthenticated upgrades and authenticating afterwards keeps the code path
 * that accepts them, and every feature added later has to remember the check. Here the
 * check is the only way in, and there is nothing to remember.
 *
 * ## What is enforced
 *
 * 1. The path must address `/collab/{room_code}`; anything else is a `404`.
 * 2. A `ticket` query parameter must be present; its absence is a `401`.
 * 3. The ticket must verify under the signing secret and be inside its sixty-second life,
 *    measured against the **injected clock** (ADR-006), never `Date.now()`.
 * 4. The ticket must not already have been redeemed ({@link TicketStore}).
 * 5. The document a connection joins is keyed by the session the ticket names, never by
 *    the room code in the path — see `rooms.ts`.
 *
 * Every one of those refusals is served as the same opaque `401` (or `404` for an
 * unknown path) with no explanation, because a refusal that explains itself is a ticket
 * oracle (docs/14 T-011). The reason survives as a metric label and a log field, which is
 * where an operator can see it and an attacker cannot.
 *
 * ## What is not here
 *
 * No document logic, no persistence, no Valkey fan-out — those are P5. What this file
 * does own, and owns now because retrofitting it is how outages happen, is the lifecycle:
 * the heartbeat that reaps a socket whose peer vanished without a close frame, the room
 * that survives a blinking network, the bounded frame size, and a shutdown that closes
 * every socket with `1001 going away` so clients reconnect to the replacement instance
 * instead of concluding the interview is over.
 */

import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';

import {
  type Clock,
  systemClock,
  verifyWsTicket,
  WS_TICKET_TTL_SECONDS,
  type WsTicket,
} from '@assaybank/auth';
import { ApiError } from '@assaybank/contracts';
import {
  createLogger,
  type Logger,
  metrics as defaultRegistry,
  metricsHandler,
  type MetricsRegistry,
} from '@assaybank/observability';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { applyUpdate, encodeStateAsUpdate, encodeStateVector } from 'yjs';

import { collabMetrics } from './metrics.js';
import {
  decodeFrame,
  encodeAwareness,
  encodeSyncStep1,
  encodeSyncStep2,
  encodeSyncUpdate,
  ProtocolError,
} from './protocol.js';
import { DEFAULT_ROOM_RETENTION_MS, type Room, type RoomPeer, RoomRegistry } from './rooms.js';
import { TicketStore } from './ticket-store.js';

/** The path a room is addressed at: `/collab/{room_code}?ticket=…` (docs/03 §"WebSocket"). */
export const COLLAB_PATH_PREFIX = '/collab';

/**
 * What a room code may look like.
 *
 * A short shareable join code (`interview_sessions.room_code`), so it is constrained to
 * characters that survive being read aloud, pasted into a chat window and logged. It is
 * validated but never trusted: it selects nothing — the ticket does that.
 */
export const ROOM_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{2,63}$/u;

/**
 * The largest frame this service will accept, in bytes.
 *
 * A Yjs update for a coding interview is kilobytes. One megabyte is generous by two
 * orders of magnitude and still bounds what an authenticated peer can make this process
 * allocate in a single frame; `ws` rejects anything larger before it reaches us.
 */
export const MAX_FRAME_BYTES = 1024 * 1024;

/** How often a socket is pinged to find out whether its peer is still there. */
export const DEFAULT_HEARTBEAT_MS = 30_000;

/** How long a socket is given to close politely during shutdown before it is cut. */
export const DEFAULT_SHUTDOWN_GRACE_MS = 5_000;

/**
 * Close codes this service sends. RFC 6455 §7.4.1, chosen deliberately: a client's
 * reconnect policy reads them, so `1001` and `1008` must not be confused.
 */
export const CLOSE = Object.freeze({
  /** The server is going away: drained, redeployed, restarted. Reconnect. */
  GOING_AWAY: 1001,
  /** The peer sent a frame this service could not decode. */
  PROTOCOL_ERROR: 1002,
  /** The peer sent a text frame. This protocol is binary only. */
  UNSUPPORTED_DATA: 1003,
});

/** One dependency `/readyz` consults. */
export interface ReadinessCheck {
  /** Appears verbatim in the `/readyz` body, so it names a dependency, not a code path. */
  readonly name: string;
  /** True when the dependency is usable. Must not throw; a rejection counts as not ready. */
  run(): Promise<boolean> | boolean;
}

/** Everything {@link createCollabServer} needs, injected rather than read from the environment. */
export interface CollabServerOptions {
  /**
   * The secret WebSocket tickets are signed with — `SESSION_SECRET`, the same value the
   * API mints them under. Verification is local: there is deliberately no call back to the
   * API, so an interview does not stop working while the API tier is mid-deploy
   * (CODE-GRAPH.md, `collab` → `auth`).
   */
  readonly ticketSecret: string;
  /** `TOKEN_PEPPER`. Only the peppered hash of a redeemed ticket is ever stored. */
  readonly ticketPepper: string;
  /** Injected (ADR-006). Ticket expiry is a deterministic assertion, never a sleep. */
  readonly clock?: Clock | undefined;
  /** The service logger. One is built at boot and passed down. */
  readonly logger?: Logger | undefined;
  /** The registry `/metrics` serves. Tests pass their own so counters do not accumulate. */
  readonly registry?: MetricsRegistry | undefined;
  /** Dependencies `/readyz` consults. `/healthz` consults none of them, on purpose. */
  readonly readiness?: readonly ReadinessCheck[] | undefined;
  /** How long an emptied room keeps its document. */
  readonly roomRetentionMs?: number | undefined;
  /** How often a socket is pinged. Zero disables the heartbeat (tests). */
  readonly heartbeatMs?: number | undefined;
  /** How long shutdown waits for sockets to close before cutting them. */
  readonly shutdownGraceMs?: number | undefined;
}

/** The address a server ended up listening on. */
export interface ListenAddress {
  readonly host: string;
  readonly port: number;
}

/** The running service. */
export interface CollabServer {
  /** Binds. `port: 0` asks the kernel for an ephemeral port, which is what tests use. */
  listen(options?: { port?: number; host?: string }): Promise<ListenAddress>;
  /**
   * Drains: stops answering `/readyz`, refuses new upgrades, closes every socket with
   * `1001 going away`, then releases the documents and the listener.
   */
  close(): Promise<void>;
  /** Open authenticated connections. */
  readonly connectionCount: number;
  /** Documents held, including rooms retained briefly after their last peer left. */
  readonly roomCount: number;
}

/** Why a handshake was refused. Kept server-side; the holder is told none of it. */
interface Refusal {
  readonly status: 401 | 404 | 503;
  readonly reason: string;
}

/** A handshake that passed every check. */
interface Authorised {
  readonly ticket: WsTicket;
  readonly roomCode: string;
}

const STATUS_TEXT: Readonly<Record<number, string>> = Object.freeze({
  401: 'Unauthorized',
  404: 'Not Found',
  503: 'Service Unavailable',
});

/** Copies a view over a received buffer, so retaining it does not retain the whole frame. */
function copyBytes(view: Uint8Array): Uint8Array {
  return Uint8Array.prototype.slice.call(view);
}

/** Normalises whatever `ws` handed us into a single flat view. */
function toBytes(data: RawData): Uint8Array {
  if (Array.isArray(data)) return toBytes(Buffer.concat(data));
  if (Buffer.isBuffer(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return new Uint8Array(data);
}

/**
 * One authenticated peer.
 *
 * It implements {@link RoomPeer} and nothing else is shared with the room, which is what
 * keeps `rooms.ts` free of sockets.
 */
class PeerConnection implements RoomPeer {
  /** Cleared on every heartbeat and set by the peer's `pong`. False twice means gone. */
  public alive = true;

  public constructor(
    public readonly socket: WebSocket,
    public readonly room: Room,
  ) {}

  public send(frame: Uint8Array): void {
    if (this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(frame, { binary: true }, () => {
      // The callback exists to swallow a send that lost its race with a close. An error
      // here is the socket's business and is reported through its own 'close' event.
    });
  }
}

/**
 * Builds the service. Nothing binds until {@link CollabServer.listen} is called, and
 * nothing here reads the environment — the composition root in `index.ts` does that.
 */
export function createCollabServer(options: CollabServerOptions): CollabServer {
  const clock: Clock = options.clock ?? systemClock;
  const log: Logger = options.logger ?? createLogger({ service: 'hiring-collab' });
  const registry: MetricsRegistry = options.registry ?? defaultRegistry;
  const metrics = collabMetrics(registry);
  const readiness: readonly ReadinessCheck[] = options.readiness ?? [];
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const shutdownGraceMs = options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;

  const tickets = new TicketStore({ pepper: options.ticketPepper, clock });
  const rooms = new RoomRegistry(options.roomRetentionMs ?? DEFAULT_ROOM_RETENTION_MS, (size) => {
    metrics.rooms.set(size);
  });

  const connections = new Set<PeerConnection>();
  let draining = false;
  let heartbeat: NodeJS.Timeout | undefined;

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
  const httpServer = createServer(handleHttp);

  // --- HTTP ------------------------------------------------------------------

  function json(res: ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(payload);
  }

  function notFound(res: ServerResponse): void {
    json(res, 404, ApiError.notFound().toEnvelope(randomBytes(16).toString('hex')));
  }

  /**
   * `/readyz` consults its dependencies; `/healthz` does not.
   *
   * Conflating the two means a transient Postgres blip restarts every collaboration pod
   * at once, which turns a dependency wobble into every live interview dropping (P0
   * step 8's rule, and it applies to every service, not only the API).
   */
  async function readyState(): Promise<{ ready: boolean; checks: Record<string, string> }> {
    if (draining) return { ready: false, checks: { lifecycle: 'draining' } };

    const results: Record<string, string> = {};
    let ready = true;

    for (const check of readiness) {
      let passed = false;
      try {
        passed = await check.run();
      } catch (error: unknown) {
        // The failure is logged in full and reported as a bare boolean: a readiness body
        // is unauthenticated, so it must never carry an upstream error message.
        log.warn({ event: 'collab.readiness_failed', check: check.name, err: error }, 'not ready');
      }
      results[check.name] = passed ? 'ok' : 'failed';
      if (!passed) ready = false;
    }

    return { ready, checks: results };
  }

  function handleHttp(req: IncomingMessage, res: ServerResponse): void {
    const method = req.method ?? 'GET';
    if (method !== 'GET' && method !== 'HEAD') {
      res.statusCode = 405;
      res.setHeader('Allow', 'GET, HEAD');
      res.end();
      return;
    }

    const path = new URL(req.url ?? '/', 'http://collab.invalid').pathname;

    switch (path) {
      case '/healthz':
        // Liveness only: this process is running and its event loop is turning.
        json(res, 200, { status: 'ok' });
        return;
      case '/readyz':
        void readyState().then(
          (state) => {
            json(res, state.ready ? 200 : 503, {
              status: state.ready ? 'ready' : 'not_ready',
              checks: state.checks,
            });
          },
          () => {
            json(res, 503, { status: 'not_ready', checks: {} });
          },
        );
        return;
      case '/metrics':
        metricsHandler(registry)(req, res);
        return;
      default:
        notFound(res);
        return;
    }
  }

  // --- the handshake ---------------------------------------------------------

  /**
   * Decides whether an upgrade may complete. Called before `handleUpgrade`, and the only
   * thing that can produce a live socket.
   */
  function authorise(req: IncomingMessage): Authorised | Refusal {
    if (draining) return { status: 503, reason: 'shutting_down' };

    const url = new URL(req.url ?? '/', 'http://collab.invalid');
    const segments = url.pathname.split('/').filter((segment) => segment.length > 0);
    const [prefix, roomCode] = segments;

    if (
      segments.length !== 2 ||
      `/${prefix ?? ''}` !== COLLAB_PATH_PREFIX ||
      roomCode === undefined ||
      !ROOM_CODE_PATTERN.test(roomCode)
    ) {
      return { status: 404, reason: 'unknown_path' };
    }

    const presented = url.searchParams.get('ticket');
    if (presented === null || presented.length === 0) {
      return { status: 401, reason: 'no_ticket' };
    }

    const verified = verifyWsTicket(presented, options.ticketSecret, clock);
    if (!verified.ok) {
      return { status: 401, reason: verified.error.reason };
    }

    // Single use is claimed only after the signature has verified, so an unauthenticated
    // caller cannot fill the replay store with strings of its own choosing.
    if (tickets.claim(presented) === 'replayed') {
      return { status: 401, reason: 'replayed' };
    }

    return { ticket: verified.value, roomCode };
  }

  function refuse(socket: Duplex, refusal: Refusal): void {
    metrics.handshakesRejected.inc({ reason: refusal.reason });

    const requestId = randomBytes(16).toString('hex');

    // 401 and 404 carry the standard envelope, so a client library that reads the body
    // gets the same shape it gets from the API. A drain carries none: `503` plus
    // `Retry-After` is the whole message, and inventing an error code for "come back in a
    // second" would mean widening the closed union in `@assaybank/contracts` for a
    // condition that is not an error.
    const error =
      refusal.status === 404
        ? ApiError.notFound()
        : refusal.status === 401
          ? ApiError.unauthenticated()
          : undefined;
    const body = error === undefined ? '' : JSON.stringify(error.toEnvelope(requestId));

    const headers = [
      `HTTP/1.1 ${String(refusal.status)} ${STATUS_TEXT[refusal.status] ?? 'Error'}`,
      'Connection: close',
      `Content-Length: ${String(Buffer.byteLength(body))}`,
    ];
    if (error !== undefined) headers.push('Content-Type: application/json; charset=utf-8');
    if (refusal.status === 503) headers.push('Retry-After: 1');

    log.info(
      { event: 'collab.handshake_refused', reason: refusal.reason, request_id: requestId },
      'websocket upgrade refused',
    );

    // The peer may already be gone; a write to a dead socket must not take the process out.
    socket.on('error', () => undefined);
    socket.end(`${headers.join('\r\n')}\r\n\r\n${body}`, () => {
      socket.destroy();
    });
  }

  httpServer.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const outcome = authorise(req);

    if ('status' in outcome) {
      refuse(socket, outcome);
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      accept(ws, outcome);
    });
  });

  // --- the connection lifecycle ----------------------------------------------

  function accept(ws: WebSocket, authorised: Authorised): void {
    // The document is keyed by the session the ticket names, never by the path segment
    // the client supplied. See rooms.ts for why that is the whole point.
    const room = rooms.acquire(authorised.ticket.sessionId);
    const peer = new PeerConnection(ws, room);

    const rejoined = rooms.attach(room, peer);
    connections.add(peer);
    metrics.connections.set(connections.size);
    metrics.handshakesAccepted.inc();
    if (rejoined) metrics.reconnects.inc();

    log.info(
      {
        event: 'collab.connected',
        room_code: authorised.roomCode,
        session_id: authorised.ticket.sessionId,
        rejoined,
        ticket_age_ms: clock.now().getTime() - authorised.ticket.issuedAt.getTime(),
      },
      'websocket connection accepted',
    );

    // The server opens the sync handshake, as a y-websocket peer is entitled to expect.
    peer.send(encodeSyncStep1(encodeStateVector(room.doc)));
    for (const [other, payload] of room.lastAwareness) {
      if (other !== peer) peer.send(encodeAwareness(payload));
    }

    ws.on('pong', () => {
      peer.alive = true;
    });

    ws.on('message', (data: RawData, isBinary: boolean) => {
      handleFrame(peer, data, isBinary);
    });

    ws.on('error', (error: Error) => {
      log.warn({ event: 'collab.socket_error', err: error }, 'websocket error');
    });

    ws.on('close', (code: number) => {
      connections.delete(peer);
      rooms.detach(room, peer);
      metrics.connections.set(connections.size);
      log.info(
        { event: 'collab.disconnected', room_code: authorised.roomCode, close_code: code },
        'websocket connection closed',
      );
    });
  }

  function handleFrame(peer: PeerConnection, data: RawData, isBinary: boolean): void {
    if (!isBinary) {
      metrics.framesDropped.inc({ reason: 'not_binary' });
      peer.socket.close(CLOSE.UNSUPPORTED_DATA, 'binary frames only');
      return;
    }

    const bytes = toBytes(data);

    try {
      const frame = decodeFrame(bytes);
      const room = peer.room;

      switch (frame.kind) {
        case 'sync_step_1':
          // "Send me what I am missing." The diff is computed against the peer's own
          // state vector, so a reconnecting client re-syncs in one round trip.
          peer.send(encodeSyncStep2(encodeStateAsUpdate(room.doc, frame.stateVector)));
          return;

        case 'sync_step_2':
        case 'sync_update':
          applyUpdate(room.doc, frame.update, peer);
          room.broadcast(encodeSyncUpdate(frame.update), peer);
          return;

        case 'awareness':
          // Presence is relayed, never interpreted. The last payload per peer is kept so
          // the next arrival learns who is already in the room without asking everyone.
          room.lastAwareness.set(peer, copyBytes(frame.payload));
          room.broadcast(encodeAwareness(frame.payload), peer);
          return;

        case 'query_awareness':
          for (const [other, payload] of room.lastAwareness) {
            if (other !== peer) peer.send(encodeAwareness(payload));
          }
          return;

        case 'ignored':
          // A newer client sending a tag this version has no behaviour for must not have
          // its interview terminated. Counted, not fatal.
          metrics.framesDropped.inc({ reason: 'undecodable' });
          return;
      }
    } catch (error: unknown) {
      metrics.framesDropped.inc({ reason: 'undecodable' });
      log.warn(
        {
          event: 'collab.frame_rejected',
          protocol_error: error instanceof ProtocolError,
          err: error,
        },
        'undecodable frame',
      );
      peer.socket.close(CLOSE.PROTOCOL_ERROR, 'undecodable frame');
    }
  }

  // --- heartbeat -------------------------------------------------------------

  function startHeartbeat(): void {
    if (heartbeatMs <= 0) return;

    const timer = setInterval(() => {
      for (const peer of connections) {
        if (!peer.alive) {
          // Two intervals with no pong: the peer is gone without a close frame, which is
          // what a laptop lid closing looks like. Terminating frees the room slot.
          peer.socket.terminate();
          continue;
        }
        peer.alive = false;
        peer.socket.ping();
      }
    }, heartbeatMs);

    timer.unref();
    heartbeat = timer;
  }

  // --- lifecycle -------------------------------------------------------------

  async function listen(listenOptions?: { port?: number; host?: string }): Promise<ListenAddress> {
    const port = listenOptions?.port ?? 0;
    const host = listenOptions?.host ?? '0.0.0.0';

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        reject(error);
      };
      httpServer.once('error', onError);
      httpServer.listen(port, host, () => {
        httpServer.removeListener('error', onError);
        resolve();
      });
    });

    startHeartbeat();

    const address: string | AddressInfo | null = httpServer.address();
    const bound: ListenAddress =
      address !== null && typeof address === 'object'
        ? { host: address.address, port: address.port }
        : { host, port };

    log.info(
      { event: 'collab.listening', port: bound.port, ticket_ttl_seconds: WS_TICKET_TTL_SECONDS },
      'collaboration service listening',
    );

    return bound;
  }

  async function close(): Promise<void> {
    if (draining) return;
    draining = true;

    if (heartbeat !== undefined) {
      clearInterval(heartbeat);
      heartbeat = undefined;
    }

    // Politely first: 1001 tells a client this instance is going away and it should
    // reconnect, rather than that the interview ended.
    const closing = [...connections].map(
      (peer) =>
        new Promise<void>((resolve) => {
          if (peer.socket.readyState === WebSocket.CLOSED) {
            resolve();
            return;
          }
          peer.socket.once('close', () => {
            resolve();
          });
          peer.socket.close(CLOSE.GOING_AWAY, 'server shutting down');
        }),
    );

    await Promise.race([
      Promise.all(closing),
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, shutdownGraceMs);
        timer.unref();
      }),
    ]);

    for (const peer of connections) peer.socket.terminate();
    connections.clear();
    metrics.connections.set(0);

    await new Promise<void>((resolve) => {
      wss.close(() => {
        resolve();
      });
    });

    await new Promise<void>((resolve) => {
      httpServer.close(() => {
        resolve();
      });
      // `close` waits for every open connection to end, and a keep-alive scrape holding
      // one would make shutdown hang for as long as the client felt like it.
      httpServer.closeAllConnections();
    });

    rooms.clear();
    tickets.clear();

    log.info({ event: 'collab.stopped' }, 'collaboration service stopped');
  }

  return {
    listen,
    close,
    get connectionCount(): number {
      return connections.size;
    },
    get roomCount(): number {
      return rooms.size;
    },
  };
}
