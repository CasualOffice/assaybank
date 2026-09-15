/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The small amount of mutable state the server itself owns, decorated onto the Fastify
 * instance so a route reaches it through `app` rather than through a module-level
 * variable that two tests in the same process would share.
 */

import type { FastifyInstance } from 'fastify';

declare module 'fastify' {
  interface FastifyInstance {
    /** This server's own state. See {@link ServerState}. */
    assaybank: ServerState;
  }
}

/** Process-level state that health reporting and shutdown both read. */
export interface ServerState {
  /** The telemetry service name, echoed in the health payloads. */
  readonly service: string;
  /** When this instance was built, from the injected clock. */
  readonly startedAt: Date;
  /**
   * Set by the shutdown handler the moment SIGTERM arrives, before anything is closed.
   *
   * `/readyz` then answers 503 so the load balancer stops sending new requests, while
   * `/healthz` keeps answering 200 so the orchestrator does not kill the process in the
   * middle of draining — which is exactly how in-flight work gets lost (docs/13 §7).
   */
  draining: boolean;
}

/** Creates the state object and attaches it to the instance. */
export function attachState(app: FastifyInstance, service: string, startedAt: Date): ServerState {
  const state: ServerState = { service, startedAt, draining: false };
  app.decorate('assaybank', state);
  return state;
}
