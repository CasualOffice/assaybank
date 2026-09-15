/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * @assaybank/collab — the y-websocket server holding one Yjs document per interview room.
 *
 * Owns: the document per room, awareness fan-out across instances over Valkey pub/sub,
 * and the periodic snapshot to Postgres every COLLAB_SNAPSHOT_INTERVAL_MS.
 *
 * A connection is accepted only against a valid, unexpired, single-use 60-second ticket,
 * and the ticket is checked before the WebSocket upgrade completes, not after (HLD §7).
 * It writes exactly two things — appends to session_events and the
 * interview_sessions.doc_state snapshot — resolves no permissions of its own beyond the
 * ticket, and never executes code.
 *
 * ## What this file is
 *
 * The composition root, and nothing else. It is the only place in this workspace that
 * reads `config`, builds the logger, starts telemetry and installs signal handlers.
 * Everything below it takes what it needs as an argument, which is what lets
 * {@link createCollabServer} be started twenty times in one test process against an
 * injected clock and an isolated metric registry.
 *
 * Importing this module starts nothing. The process boots only when it is the entry
 * point, so a test may import the exports without a socket appearing.
 *
 * ## P0 scope
 *
 * The Valkey fan-out and the Postgres snapshot named above are P5 and are absent here.
 * The security boundary and the lifecycle are P0, and they are in `server.ts`.
 */

import { fileURLToPath } from 'node:url';

import { systemClock } from '@assaybank/auth';
import { config } from '@assaybank/config';
import { createLogger, initTelemetry, shutdownTelemetry } from '@assaybank/observability';

import { createCollabServer, type CollabServer } from './server.js';

export {
  CLOSE,
  COLLAB_PATH_PREFIX,
  createCollabServer,
  DEFAULT_HEARTBEAT_MS,
  DEFAULT_SHUTDOWN_GRACE_MS,
  MAX_FRAME_BYTES,
  ROOM_CODE_PATTERN,
} from './server.js';
export type { CollabServer, CollabServerOptions, ListenAddress, ReadinessCheck } from './server.js';

export { collabMetrics, REJECTION_REASONS } from './metrics.js';
export type { CollabMetrics } from './metrics.js';

export { DEFAULT_ROOM_RETENTION_MS, Room, RoomRegistry } from './rooms.js';
export type { RoomPeer } from './rooms.js';

export { REPLAY_RETENTION_MS, TicketStore } from './ticket-store.js';
export type { ClaimOutcome, TicketStoreOptions } from './ticket-store.js';

export {
  decodeFrame,
  encodeAwareness,
  encodeSyncStep1,
  encodeSyncStep2,
  encodeSyncUpdate,
  MESSAGE_AWARENESS,
  MESSAGE_QUERY_AWARENESS,
  MESSAGE_SYNC,
  ProtocolError,
} from './protocol.js';
export type { InboundFrame } from './protocol.js';

/**
 * The workspace's own package name. Exported so a bootstrap can name itself in a log
 * line or a span resource without a second source of truth, and so this module has a
 * real export from the first commit.
 */
export const WORKSPACE_NAME = '@assaybank/collab';

/** The OpenTelemetry service name, matching `OTEL_SERVICE_NAME` in docker-compose.yml. */
export const SERVICE_NAME = 'hiring-collab';

/**
 * Boots the service from the validated environment and hands back the running server.
 *
 * Separate from {@link main} so that an operator script — or a future integration test
 * that wants the real configuration — can start the service without also inheriting the
 * signal handlers and the `process.exit`.
 */
export async function bootstrap(): Promise<CollabServer> {
  await initTelemetry(SERVICE_NAME);

  const log = createLogger({
    service: SERVICE_NAME,
    env: config.core.appEnv,
    level: config.core.logLevel,
    pretty: !config.core.isDeployedTier,
  });

  const server = createCollabServer({
    // The API signs tickets with SESSION_SECRET and this service verifies them locally.
    // A rotation therefore has to reach both tiers, which is why they are one variable
    // rather than two that can silently disagree (docs/13 §4.9).
    ticketSecret: config.secrets.sessionSecret,
    ticketPepper: config.secrets.tokenPepper,
    clock: systemClock,
    logger: log,
  });

  await server.listen({ port: config.collab.port });
  return server;
}

/**
 * The entry point.
 *
 * `SIGTERM` is what an orchestrator sends before it takes a pod away, and the whole
 * point of handling it is that every live interview gets `1001 going away` and reconnects
 * to the replacement, rather than a reset connection and a candidate watching an editor
 * stop responding mid-answer.
 */
export async function main(): Promise<void> {
  const server = await bootstrap();
  let stopping = false;

  const stop = (signal: NodeJS.Signals): void => {
    if (stopping) return;
    stopping = true;

    void (async (): Promise<void> => {
      try {
        await server.close();
        await shutdownTelemetry();
      } finally {
        // 128 + signal number is the conventional exit status for "terminated by signal".
        process.exit(signal === 'SIGINT' ? 130 : 143);
      }
    })();
  };

  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

/* c8 ignore start -- the entry-point guard is exercised by running the process, not by a unit test. */
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
/* c8 ignore stop */
